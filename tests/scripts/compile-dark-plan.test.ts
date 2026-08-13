import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
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
    expect(JSON.stringify(plan)).not.toMatch(/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/);
    expect(plan.explicit_exclusions).toContain("live inbound or outbound email probes");
  });
});
