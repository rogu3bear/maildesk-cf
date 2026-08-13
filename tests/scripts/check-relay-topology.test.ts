import { describe, expect, test } from "bun:test";
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
});
