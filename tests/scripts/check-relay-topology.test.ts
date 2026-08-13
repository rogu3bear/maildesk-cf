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
});
