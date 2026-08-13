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
  });

  test("binds every D1 migration to cfctl's prefixed content digest", () => {
    const pack = readFileSync(resolve(root, ".cfctl/operations/d1-migrations.toml"), "utf8");
    const migrations = [...pack.matchAll(/path = "([^"]+)"\nsha256 = "([^"]+)"/g)];
    expect(migrations).toHaveLength(6);
    for (const [, path, declared] of migrations) {
      const observed = `sha256:${createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex")}`;
      expect(declared).toBe(observed);
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
    const directory = mkdtempSync(join(tmpdir(), "maildesk-dark-plan-"));

    try {
      for (const [name, mutate] of fixtures) {
        const desired = structuredClone(original);
        mutate(desired);
        const path = join(directory, `${name.replaceAll(" ", "-")}.json`);
        writeFileSync(path, JSON.stringify(desired));

        const result = spawnSync("bun", ["run", "scripts/compile-dark-plan.ts", "--desired-state", path], {
          cwd: root,
          encoding: "utf8",
        });

        expect(result.status, name).not.toBe(0);
        expect(result.stdout, name).toBe("");
        expect(result.stderr, name).toContain("both equal disabled");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects desired-state drift from router activation and UI Access config", () => {
    const original = JSON.parse(readFileSync(resolve(root, "config/desired-state.example.json"), "utf8")) as Record<string, any>;
    const cases: Array<[string, "relay_router" | "routing_health", (config: string) => string, string]> = [
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
    ];
    const directory = mkdtempSync(join(tmpdir(), "maildesk-dark-config-"));

    try {
      for (const [name, role, mutate, expected] of cases) {
        const desired = structuredClone(original);
        const sourcePath = resolve(root, desired.workers[role].config);
        const roleDirectory = role === "relay_router" ? "mail-router" : "routing-health";
        const relativePath = `deploy/${roleDirectory}/wrangler.review-${process.pid}-${name.toLowerCase().replaceAll(" ", "-")}.toml`;
        const absolutePath = resolve(root, relativePath);
        writeFileSync(absolutePath, mutate(readFileSync(sourcePath, "utf8")));
        desired.workers[role].config = relativePath;
        const desiredPath = join(directory, `${name.replaceAll(" ", "-")}.json`);
        writeFileSync(desiredPath, JSON.stringify(desired));

        const result = spawnSync("bun", ["run", "scripts/compile-dark-plan.ts", "--desired-state", desiredPath], {
          cwd: root,
          encoding: "utf8",
        });

        expect(result.status, name).not.toBe(0);
        expect(result.stdout, name).toBe("");
        expect(result.stderr, name).toContain(expected);
        rmSync(absolutePath);
      }

      const desired = structuredClone(original);
      desired.workers.relay_router.config = "config/desired-state.example.json";
      const desiredPath = join(directory, "arbitrary-path.json");
      writeFileSync(desiredPath, JSON.stringify(desired));
      const result = spawnSync("bun", ["run", "scripts/compile-dark-plan.ts", "--desired-state", desiredPath], {
        cwd: root,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("repository-relative canonical deploy/mail-router/wrangler*.toml path");
    } finally {
      rmSync(directory, { recursive: true, force: true });
      for (const directoryName of ["mail-router", "routing-health"]) {
        const directoryPath = resolve(root, "deploy", directoryName);
        for (const name of Array.from(new Bun.Glob(`wrangler.review-${process.pid}-*.toml`).scanSync(directoryPath))) {
          rmSync(resolve(directoryPath, name), { force: true });
        }
      }
    }
  });
});
