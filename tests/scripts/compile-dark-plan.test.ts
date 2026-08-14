import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

describe("dark deployment blueprint", () => {
  test("enumerates isolated resources and never creates operation authority", () => {
    const result = spawnSync("bun", ["run", "scripts/compile-dark-plan.ts"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout) as Record<string, any>;
    expect(plan.performed).toBe(false);
    expect(plan.operation_ids_created).toBe(false);
    expect(plan.activation.required_dark_state).toBe("disabled/disabled");
    expect(plan.plan_sets).toHaveLength(2);
    expect(JSON.stringify(plan)).toContain("maildesk-cf-relay-db");
    expect(JSON.stringify(plan)).toContain("maildesk-cf-preview-db");
    expect(JSON.stringify(plan)).toContain("maildesk-cf.d1-preview-migrations-apply");
    expect(JSON.stringify(plan)).toContain("maildesk-cf-relay-dlq");
    expect(JSON.stringify(plan)).toContain("r2-put-bucket-lifecycle-configuration");
    expect(JSON.stringify(plan)).toContain("email-routing-settings-enable-email-routing-dns");
    expect(JSON.stringify(plan)).toContain("email-routing-routing-rules-update-catch-all-rule");
    expect(JSON.stringify(plan)).toContain("access-applications-get-an-access-application");
    expect(JSON.stringify(plan)).toContain("access-policies-list-access-app-policies");
    expect(JSON.stringify(plan)).toContain("workers.domains.update");
    expect(JSON.stringify(plan)).not.toContain("email-routing-catch-all-worker-rule");
    expect(JSON.stringify(plan)).not.toContain("access-application-and-policy-readback");
    expect(JSON.stringify(plan)).not.toMatch(/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/);
    expect(plan.explicit_exclusions).toContain("live inbound or outbound email probes");
    expect(JSON.stringify(plan)).not.toContain(["mlnavigator", "com"].join("."));
    expect(JSON.stringify(plan)).not.toContain(["windowdrop", "pro"].join("."));
  });

  test("binds every D1 migration to cfctl's prefixed content digest", () => {
    const pack = readFileSync(resolve(root, ".cfctl/operations/d1-migrations.toml"), "utf8");
    const migrations = [...pack.matchAll(/path = "([^"]+)"\nsha256 = "([^"]+)"/g)];
    expect(migrations).toHaveLength(16);
    for (const [, path, declared] of migrations) {
      const observed = `sha256:${createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex")}`;
      expect(declared).toBe(observed);
    }
    const parsed = Bun.TOML.parse(pack) as { operation: Array<Record<string, any>> };
    expect(parsed.operation.map((operation) => operation.id)).toEqual([
      "maildesk-cf.d1-migrations-apply",
      "maildesk-cf.d1-preview-migrations-apply",
    ]);
    for (const operation of parsed.operation) {
      expect(operation.migration).toHaveLength(8);
      expect(operation.assertion).toHaveLength(11);
    }
  });

  test("keeps the preview migration config D1-only", () => {
    const config = Bun.TOML.parse(
      readFileSync(resolve(root, "wrangler.d1-preview.toml"), "utf8"),
    ) as Record<string, any>;
    expect(config.main).toBeUndefined();
    expect(config.assets).toBeUndefined();
    expect(config.queues).toBeUndefined();
    expect(config.r2_buckets).toBeUndefined();
    expect(config.routes).toBeUndefined();
    expect(config.d1_databases).toHaveLength(1);
    expect(config.d1_databases[0].binding).toBe("DB");
    expect(config.d1_databases[0].database_id).toBe(config.d1_databases[0].preview_database_id);
    expect(config.d1_databases[0].migrations_dir).toBe("migrations");
  });

  test("keeps the preview D1 distinct from the production D1", () => {
    const desired = JSON.parse(readFileSync(resolve(root, "config/desired-state.example.json"), "utf8")) as Record<string, any>;
    desired.storage.d1_preview_database = desired.storage.d1_database;
    const path = desiredFixturePath("same-preview-d1");
    try {
      writeFileSync(resolve(root, path), JSON.stringify(desired));
      const result = spawnSync("bun", ["run", "scripts/compile-dark-plan.ts", "--desired-state", path], {
        cwd: root,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("storage.d1_preview_database must differ from storage.d1_database");
    } finally {
      rmSync(resolve(root, path), { force: true });
    }
  });

  test("rejects enabled, missing, or invalid relay activation modes", () => {
    const original = JSON.parse(readFileSync(resolve(root, "config/desired-state.example.json"), "utf8")) as Record<string, any>;
    const fixtures: Array<[string, (desired: Record<string, any>) => void]> = [
      ["enabled inbound", (desired) => (desired.operator_delivery.inbound_processing_mode = "enabled")],
      ["enabled reply", (desired) => (desired.operator_delivery.reply_processing_mode = "enabled")],
      ["missing inbound", (desired) => delete desired.operator_delivery.inbound_processing_mode],
      ["missing reply", (desired) => delete desired.operator_delivery.reply_processing_mode],
      ["invalid inbound", (desired) => (desired.operator_delivery.inbound_processing_mode = "preview")],
      ["invalid reply", (desired) => (desired.operator_delivery.reply_processing_mode = "preview")],
    ];
    try {
      for (const [name, mutate] of fixtures) {
        const desired = structuredClone(original);
        mutate(desired);
        const path = desiredFixturePath(name);
        writeFileSync(resolve(root, path), JSON.stringify(desired));

        const result = spawnSync("bun", ["run", "scripts/compile-dark-plan.ts", "--desired-state", path], {
          cwd: root,
          encoding: "utf8",
        });

        expect(result.status, name).not.toBe(0);
        expect(result.stdout, name).toBe("");
        expect(result.stderr, name).toContain("both equal disabled");
        rmSync(resolve(root, path), { force: true });
      }
    } finally {
      cleanupDesiredFixtures();
    }
  });

  test("rejects public Worker origins and desired-state drift from activation or UI Access config", () => {
    const original = JSON.parse(readFileSync(resolve(root, "config/desired-state.example.json"), "utf8")) as Record<string, any>;
    const cases: Array<[string, "relay_router" | "relay_outbound" | "routing_health", (config: string) => string, string]> = [
      [
        "router role entrypoint",
        "relay_router",
        (config) => config.replace('workers/mail-router/src/index.ts', 'workers/mail-outbound/src/index.ts'),
        "main must equal desired value workers/mail-router/src/index.ts",
      ],
      [
        "outbound role entrypoint",
        "relay_outbound",
        (config) => config.replace('workers/mail-outbound/src/index.ts', 'workers/mail-router/src/index.ts'),
        "main must equal desired value workers/mail-outbound/src/index.ts",
      ],
      [
        "health role entrypoint",
        "routing_health",
        (config) => config.replace('build/_worker.js', 'workers/mail-api/src/index.ts'),
        "main must equal desired value build/_worker.js",
      ],
      [
        "router workers dev",
        "relay_router",
        (config) => config.replace("workers_dev = false", "workers_dev = true"),
        "must set workers_dev = false",
      ],
      [
        "outbound workers dev",
        "relay_outbound",
        (config) => config.replace("workers_dev = false", "workers_dev = true"),
        "must set workers_dev = false",
      ],
      [
        "health workers dev",
        "routing_health",
        (config) => config.replace("workers_dev = false", "workers_dev = true"),
        "must set workers_dev = false",
      ],
      [
        "enabled router",
        "relay_router",
        (config) => config.replace('MAILDESK_INBOUND_RELAY_MODE = "disabled"', 'MAILDESK_INBOUND_RELAY_MODE = "enabled"'),
        "must exist, equal disabled, and match desired state",
      ],
      [
        "legacy and split switches",
        "relay_router",
        (config) => config.replace("[vars]", '[vars]\nMAILDESK_RELAY_PROCESSING_MODE = "disabled"'),
        "must not combine the legacy relay processing switch",
      ],
      [
        "desk-only UI",
        "routing_health",
        (config) => config.replace('MAILDESK_UI_ACCESS_SCOPE = "all_routes"', 'MAILDESK_UI_ACCESS_SCOPE = "desk_only"'),
        "must require Cloudflare Access for all_routes",
      ],
      [
        "preview UI",
        "routing_health",
        (config) => config.replace('MAILDESK_UI_AUTH_MODE = "access"', 'MAILDESK_UI_AUTH_MODE = "preview"'),
        "must require Cloudflare Access for all_routes",
      ],
      [
        "missing asset worker first",
        "routing_health",
        (config) => config.replace(/^run_worker_first\s*=\s*true\s*$/m, ""),
        "[assets] must set run_worker_first = true",
      ],
      [
        "false asset worker first",
        "routing_health",
        (config) => config.replace(/^run_worker_first\s*=\s*true\s*$/m, "run_worker_first = false"),
        "[assets] must set run_worker_first = true",
      ],
      [
        "preview D1 in production Worker",
        "routing_health",
        (config) => config.replace(
          /^database_id\s*=\s*"([^"]+)"$/m,
          'database_id = "$1"\npreview_database_id = "$1"',
        ),
        "must not bind preview_database_id in a production Worker config",
      ],
    ];
    const directory = mkdtempSync(join(tmpdir(), "maildesk-dark-config-"));

    try {
      for (const [name, role, mutate, expected] of cases) {
        const desired = structuredClone(original);
        const sourcePath = resolve(root, desired.workers[role].config);
        const roleDirectory = role === "relay_router"
          ? "mail-router"
          : role === "relay_outbound"
            ? "mail-outbound"
            : "routing-health";
        const relativePath = `wrangler.${roleDirectory}.review-${process.pid}-${name.toLowerCase().replaceAll(" ", "-")}.toml`;
        const absolutePath = resolve(root, relativePath);
        writeFileSync(absolutePath, mutate(readFileSync(sourcePath, "utf8")));
        desired.workers[role].config = relativePath;
        const desiredPath = desiredFixturePath(name);
        writeFileSync(resolve(root, desiredPath), JSON.stringify(desired));

        const result = spawnSync("bun", ["run", "scripts/compile-dark-plan.ts", "--desired-state", desiredPath], {
          cwd: root,
          encoding: "utf8",
        });

        expect(result.status, name).not.toBe(0);
        expect(result.stdout, name).toBe("");
        expect(result.stderr, name).toContain(expected);
        rmSync(absolutePath);
        rmSync(resolve(root, desiredPath), { force: true });
      }

      const desired = structuredClone(original);
      desired.workers.relay_router.config = "config/desired-state.example.json";
      const desiredPath = desiredFixturePath("arbitrary-path");
      writeFileSync(resolve(root, desiredPath), JSON.stringify(desired));
      const result = spawnSync("bun", ["run", "scripts/compile-dark-plan.ts", "--desired-state", desiredPath], {
        cwd: root,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("repository-relative canonical wrangler.mail-router*.toml path");
    } finally {
      rmSync(directory, { recursive: true, force: true });
      cleanupDesiredFixtures();
      for (const directoryName of ["mail-router", "mail-outbound", "routing-health"]) {
        const directoryPath = resolve(root);
        for (const name of Array.from(new Bun.Glob(`wrangler.${directoryName}.review-${process.pid}-*.toml`).scanSync(directoryPath))) {
          rmSync(resolve(directoryPath, name), { force: true });
        }
      }
    }
  });

  test("rejects desired resource and Worker names that disagree with exact configs", () => {
    const original = JSON.parse(readFileSync(resolve(root, "config/desired-state.example.json"), "utf8")) as Record<string, any>;
    const cases: Array<[string, (desired: Record<string, any>) => void]> = [
      ["router name", (desired) => (desired.workers.relay_router.script_name = "different-router")],
      ["outbound name", (desired) => (desired.workers.relay_outbound.script_name = "different-outbound")],
      ["health name", (desired) => (desired.workers.routing_health.script_name = "different-health")],
      ["D1", (desired) => (desired.storage.d1_database = "different-db")],
      ["policy R2", (desired) => (desired.storage.r2_policy_bucket = "different-policy")],
      ["spool R2", (desired) => (desired.storage.r2_spool_bucket = "different-spool")],
      ["Queue", (desired) => (desired.storage.queue = "different-queue")],
      ["DLQ", (desired) => (desired.storage.dead_letter_queue = "different-dlq")],
      ["reply domain", (desired) => (desired.operator_delivery.reply_domain = "different.example.com")],
      ["sender mode", (desired) => (desired.sender.mode = "cloudflare_email_service")],
    ];
    try {
      for (const [name, mutate] of cases) {
        const desired = structuredClone(original);
        mutate(desired);
        const path = desiredFixturePath(name);
        writeFileSync(resolve(root, path), JSON.stringify(desired));
        const result = spawnSync("bun", ["run", "scripts/compile-dark-plan.ts", "--desired-state", path], {
          cwd: root,
          encoding: "utf8",
        });
        expect(result.status, name).not.toBe(0);
        expect(result.stdout, name).toBe("");
        expect(result.stderr, name).toContain("desired");
        rmSync(resolve(root, path), { force: true });
      }
    } finally {
      cleanupDesiredFixtures();
    }
  });

  test("rejects policy and spool resources attached to the wrong canonical bindings", () => {
    const original = JSON.parse(readFileSync(resolve(root, "config/desired-state.example.json"), "utf8")) as Record<string, any>;
    const directory = mkdtempSync(join(tmpdir(), "maildesk-dark-binding-pairs-"));
    try {
      for (const role of ["relay_router", "relay_outbound"] as const) {
        const desired = structuredClone(original);
        const sourcePath = resolve(root, desired.workers[role].config);
        const roleDirectory = role === "relay_router" ? "mail-router" : "mail-outbound";
        const relativePath = `wrangler.${roleDirectory}.review-${process.pid}-swapped-bindings.toml`;
        const config = readFileSync(sourcePath, "utf8")
          .replace('binding = "POLICY_STORE"\nbucket_name = "maildesk-cf-policy"', 'binding = "POLICY_STORE"\nbucket_name = "maildesk-cf-relay-spool"')
          .replace('binding = "RELAY_SPOOL"\nbucket_name = "maildesk-cf-relay-spool"', 'binding = "RELAY_SPOOL"\nbucket_name = "maildesk-cf-policy"');
        writeFileSync(resolve(root, relativePath), config);
        desired.workers[role].config = relativePath;
        const desiredPath = desiredFixturePath(`${role}-swapped-bindings`);
        writeFileSync(resolve(root, desiredPath), JSON.stringify(desired));

        const result = spawnSync("bun", ["run", "scripts/compile-dark-plan.ts", "--desired-state", desiredPath], {
          cwd: root,
          encoding: "utf8",
        });
        expect(result.status, role).not.toBe(0);
        expect(result.stdout, role).toBe("");
        expect(result.stderr, role).toContain("must bind POLICY_STORE to desired bucket_name");
        rmSync(resolve(root, relativePath), { force: true });
        rmSync(resolve(root, desiredPath), { force: true });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
      cleanupDesiredFixtures();
      for (const directoryName of ["mail-router", "mail-outbound"]) {
        const directoryPath = resolve(root);
        for (const name of Array.from(new Bun.Glob(`wrangler.${directoryName}.review-${process.pid}-*.toml`).scanSync(directoryPath))) {
          rmSync(resolve(directoryPath, name), { force: true });
        }
      }
    }
  });

  test("rejects additional Worker authority including extra Email bindings", () => {
    const original = JSON.parse(readFileSync(resolve(root, "config/desired-state.example.json"), "utf8")) as Record<string, any>;
    try {
      for (const role of ["relay_router", "relay_outbound"] as const) {
        const desired = structuredClone(original);
        const roleDirectory = role === "relay_router" ? "mail-router" : "mail-outbound";
        const relativePath = `wrangler.${roleDirectory}.review-${process.pid}-extra-email.toml`;
        const config = readFileSync(resolve(root, desired.workers[role].config), "utf8")
          .replace('{ name = "EMAIL" }', '{ name = "EMAIL" },\n  { name = "UNEXPECTED_EMAIL" }');
        writeFileSync(resolve(root, relativePath), config);
        desired.workers[role].config = relativePath;
        const desiredPath = desiredFixturePath(`${role}-extra-email`);
        writeFileSync(resolve(root, desiredPath), JSON.stringify(desired));
        const result = spawnSync("bun", ["run", "scripts/compile-dark-plan.ts", "--desired-state", desiredPath], {
          cwd: root,
          encoding: "utf8",
        });
        expect(result.status, role).not.toBe(0);
        expect(result.stdout, role).toBe("");
        expect(result.stderr, role).toContain("send_email must contain exactly the EMAIL binding");
        rmSync(resolve(root, relativePath), { force: true });
        rmSync(resolve(root, desiredPath), { force: true });
      }
    } finally {
      cleanupDesiredFixtures();
      for (const directoryName of ["mail-router", "mail-outbound"]) {
        const directoryPath = resolve(root);
        for (const name of Array.from(new Bun.Glob(`wrangler.${directoryName}.review-${process.pid}-*.toml`).scanSync(directoryPath))) {
          rmSync(resolve(directoryPath, name), { force: true });
        }
      }
    }
  });

  test("rejects legacy desired activation, extra Worker roles, and desired state outside the checkout", () => {
    const original = JSON.parse(readFileSync(resolve(root, "config/desired-state.example.json"), "utf8")) as Record<string, any>;
    const fixtures: Array<[string, (desired: Record<string, any>) => void, string]> = [
      [
        "legacy activation",
        (desired) => (desired.operator_delivery.processing_mode = "enabled"),
        "must not combine the legacy operator_delivery.processing_mode",
      ],
      [
        "extra worker",
        (desired) => (desired.workers.unexpected_fourth_worker = {
          script_name: "unexpected-worker",
          config: "wrangler.routing-health.toml",
        }),
        "must contain exactly the canonical roles",
      ],
    ];

    try {
      for (const [name, mutate, expected] of fixtures) {
        const desired = structuredClone(original);
        mutate(desired);
        const path = desiredFixturePath(name);
        writeFileSync(resolve(root, path), JSON.stringify(desired));
        const result = spawnSync("bun", ["run", "scripts/compile-dark-plan.ts", "--desired-state", path], {
          cwd: root,
          encoding: "utf8",
        });
        expect(result.status, name).not.toBe(0);
        expect(result.stdout, name).toBe("");
        expect(result.stderr, name).toContain(expected);
        rmSync(resolve(root, path), { force: true });
      }

      const directory = mkdtempSync(join(tmpdir(), "maildesk-external-desired-"));
      const externalPath = join(directory, "desired.json");
      writeFileSync(externalPath, JSON.stringify(original));
      const result = spawnSync("bun", ["run", "scripts/compile-dark-plan.ts", "--desired-state", externalPath], {
        cwd: root,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("repository-relative config/*.json path");
      rmSync(directory, { recursive: true, force: true });
    } finally {
      cleanupDesiredFixtures();
    }
  });
});

function desiredFixturePath(name: string): string {
  return `config/desired-state.review-${process.pid}-${name.toLowerCase().replaceAll(" ", "-")}.local.json`;
}

function cleanupDesiredFixtures(): void {
  const directoryPath = resolve(root, "config");
  for (const name of Array.from(new Bun.Glob(`desired-state.review-${process.pid}-*.local.json`).scanSync(directoryPath))) {
    rmSync(resolve(directoryPath, name), { force: true });
  }
}
