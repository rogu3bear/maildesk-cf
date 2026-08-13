import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DISCARD_SUPERSEDED_UNSENT_RELAY_SQL } from "../../workers/mail-router/src/index";

const root = resolve(import.meta.dir, "../..");

test("stale all-pending relay retirement compiles against the exact migrated schema", () => {
  const database = new Database(":memory:", { strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (let version = 1; version <= 7; version += 1) {
      const filename = [
        "0001_maildesk_core.sql",
        "0002_audit_idempotency.sql",
        "0003_outbound_delivery_status.sql",
        "0004_inbox_reply_relay.sql",
        "0005_route_proof_timestamps.sql",
        "0006_active_policy_revision.sql",
        "0007_inbound_delivery_claims.sql",
      ][version - 1]!;
      database.exec(readFileSync(resolve(root, "migrations", filename), "utf8"));
    }

    expect(() => database.query(DISCARD_SUPERSEDED_UNSENT_RELAY_SQL).run(
      "relay:missing",
      "a".repeat(64),
      "inbound:missing",
    )).not.toThrow();
  } finally {
    database.close();
  }
});
