import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

describe("relay deployment topology", () => {
  test("keeps router, outbound, and routing-health bindings least privileged", () => {
    const result = spawnSync(
      "bun",
      ["run", "scripts/check-relay-topology.ts", "config/desired-state.example.json"],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("relay topology ok");
  });

  test("rejects role-swapped Worker entrypoints", () => {
    const original = JSON.parse(readFileSync(resolve(root, "config/desired-state.example.json"), "utf8")) as Record<string, any>;
    const cases: Array<[
      "relay_router" | "relay_outbound" | "routing_health",
      string,
      string,
      string,
    ]> = [
      ["relay_router", "mail-router", "../../workers/mail-outbound/src/index.ts", "main = ../../workers/mail-router/src/index.ts"],
      ["relay_outbound", "mail-outbound", "../../workers/mail-router/src/index.ts", "main = ../../workers/mail-outbound/src/index.ts"],
      ["routing_health", "routing-health", "../../workers/mail-api/src/index.ts", "main = ../../build/_worker.js"],
    ];

    for (const [role, directory, swappedMain, expected] of cases) {
      const desired = structuredClone(original);
      const configPath = `deploy/${directory}/wrangler.review-${process.pid}-${role}-entrypoint.toml`;
      const desiredPath = `config/desired-state.review-${process.pid}-${role}-entrypoint.local.json`;
      const config = readFileSync(resolve(root, desired.workers[role].config), "utf8")
        .replace(/^main\s*=\s*"[^"]+"$/m, `main = "${swappedMain}"`);
      try {
        writeFileSync(resolve(root, configPath), config);
        desired.workers[role].config = configPath;
        writeFileSync(resolve(root, desiredPath), JSON.stringify(desired));
        const result = spawnSync("bun", ["run", "scripts/check-relay-topology.ts", desiredPath], {
          cwd: root,
          encoding: "utf8",
        });
        expect(result.status, role).not.toBe(0);
        expect(result.stdout, role).toBe("");
        expect(result.stderr, role).toContain(expected);
      } finally {
        rmSync(resolve(root, configPath), { force: true });
        rmSync(resolve(root, desiredPath), { force: true });
      }
    }
  });

  test("rejects policy and spool bucket targets swapped across canonical bindings", () => {
    const desired = JSON.parse(readFileSync(resolve(root, "config/desired-state.example.json"), "utf8")) as Record<string, any>;
    const configPath = `deploy/mail-router/wrangler.review-${process.pid}-topology-swap.toml`;
    const desiredPath = `config/desired-state.review-${process.pid}-topology-swap.local.json`;
    const swapped = readFileSync(resolve(root, desired.workers.relay_router.config), "utf8")
      .replace('binding = "POLICY_STORE"\nbucket_name = "maildesk-cf-policy"', 'binding = "POLICY_STORE"\nbucket_name = "maildesk-cf-relay-spool"')
      .replace('binding = "RELAY_SPOOL"\nbucket_name = "maildesk-cf-relay-spool"', 'binding = "RELAY_SPOOL"\nbucket_name = "maildesk-cf-policy"');
    try {
      writeFileSync(resolve(root, configPath), swapped);
      desired.workers.relay_router.config = configPath;
      writeFileSync(resolve(root, desiredPath), JSON.stringify(desired));
      const result = spawnSync("bun", ["run", "scripts/check-relay-topology.ts", desiredPath], {
        cwd: root,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("must bind POLICY_STORE to bucket_name = maildesk-cf-policy");
    } finally {
      rmSync(resolve(root, configPath), { force: true });
      rmSync(resolve(root, desiredPath), { force: true });
    }
  });

  test("rejects an additional Email binding", () => {
    const desired = JSON.parse(readFileSync(resolve(root, "config/desired-state.example.json"), "utf8")) as Record<string, any>;
    const configPath = `deploy/mail-router/wrangler.review-${process.pid}-extra-email.toml`;
    const desiredPath = `config/desired-state.review-${process.pid}-extra-email.local.json`;
    const config = readFileSync(resolve(root, desired.workers.relay_router.config), "utf8")
      .replace('{ name = "EMAIL" }', '{ name = "EMAIL" },\n  { name = "UNEXPECTED_EMAIL" }');
    try {
      writeFileSync(resolve(root, configPath), config);
      desired.workers.relay_router.config = configPath;
      writeFileSync(resolve(root, desiredPath), JSON.stringify(desired));
      const result = spawnSync("bun", ["run", "scripts/check-relay-topology.ts", desiredPath], {
        cwd: root,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("send_email must contain exactly the EMAIL binding");
    } finally {
      rmSync(resolve(root, configPath), { force: true });
      rmSync(resolve(root, desiredPath), { force: true });
    }
  });

  test("rejects static assets that can bypass the Access-verifying Worker", () => {
    const original = JSON.parse(readFileSync(resolve(root, "config/desired-state.example.json"), "utf8")) as Record<string, any>;
    for (const [name, mutate] of [
      ["missing", (config: string) => config.replace(/^run_worker_first\s*=\s*true\s*$/m, "")],
      ["false", (config: string) => config.replace(/^run_worker_first\s*=\s*true\s*$/m, "run_worker_first = false")],
    ] as const) {
      const desired = structuredClone(original);
      const configPath = `deploy/routing-health/wrangler.review-${process.pid}-assets-${name}.toml`;
      const desiredPath = `config/desired-state.review-${process.pid}-assets-${name}.local.json`;
      try {
        writeFileSync(resolve(root, configPath), mutate(readFileSync(resolve(root, desired.workers.routing_health.config), "utf8")));
        desired.workers.routing_health.config = configPath;
        writeFileSync(resolve(root, desiredPath), JSON.stringify(desired));
        const result = spawnSync("bun", ["run", "scripts/check-relay-topology.ts", desiredPath], {
          cwd: root,
          encoding: "utf8",
        });
        expect(result.status, name).not.toBe(0);
        expect(result.stdout, name).toBe("");
        expect(result.stderr, name).toContain("[assets] must set run_worker_first = true");
      } finally {
        rmSync(resolve(root, configPath), { force: true });
        rmSync(resolve(root, desiredPath), { force: true });
      }
    }
  });
});
