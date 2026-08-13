import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { requireCanonicalDesiredTopology } from "../../scripts/desired-topology";

const root = resolve(import.meta.dir, "../..");

test("the tracked desired state uses the one canonical Worker and storage topology", () => {
  const desired: unknown = JSON.parse(
    readFileSync(resolve(root, "config/desired-state.example.json"), "utf8"),
  );
  expect(() => requireCanonicalDesiredTopology(desired)).not.toThrow();
});

test("legacy or additional topology authorities fail closed", () => {
  expect(() => requireCanonicalDesiredTopology({
    workers: {
      mail_router: { script_name: "legacy-router", config: "wrangler.toml" },
      relay_router: { script_name: "router", config: "router.toml" },
      relay_outbound: { script_name: "outbound", config: "outbound.toml" },
      routing_health: { script_name: "health", config: "health.toml" },
    },
    storage: {
      d1_database: "db",
      r2_policy_bucket: "policy",
      r2_spool_bucket: "spool",
      r2_raw_mail_bucket: "legacy-raw",
      queue: "queue",
      dead_letter_queue: "dlq",
    },
  })).toThrow("canonical topology keys");
});
