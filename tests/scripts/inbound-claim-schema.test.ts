import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DISCARD_SUPERSEDED_UNSENT_RELAY_SQL } from "../../workers/mail-router/src/index";

const root = resolve(import.meta.dir, "../..");
const OLD_POLICY = "a".repeat(64);
const ACTIVE_POLICY = "b".repeat(64);

function migratedDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
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
  return database;
}

function seedSupersededClaim(database: Database): void {
  database.exec(`
    INSERT INTO policy_revisions (policy_sha256, r2_object_key, expected_domain_count, expected_route_count)
    VALUES
      ('${OLD_POLICY}', 'config/policy/${OLD_POLICY}.json', 1, 1),
      ('${ACTIVE_POLICY}', 'config/policy/${ACTIVE_POLICY}.json', 1, 1);
    INSERT INTO runtime_state (singleton, active_policy_sha256, active_policy_r2_key)
    VALUES (1, '${ACTIVE_POLICY}', 'config/policy/${ACTIVE_POLICY}.json');
    INSERT INTO domains (id, domain) VALUES ('domain:tenant', 'tenant.example.com');
    INSERT INTO identities (id, domain_id, address, kind)
    VALUES ('identity:security', 'domain:tenant', 'security@tenant.example.com', 'role');
    INSERT INTO alias_routes (
      id, domain_id, local_part, kind, default_reply_identity_id, decision_kind, enabled, policy_sha256
    ) VALUES (
      'route:security', 'domain:tenant', 'security', 'role', 'identity:security', 'role_alias', 1, '${OLD_POLICY}'
    );
    INSERT INTO threads (id, domain_id, route_id, external_sender, subject)
    VALUES ('thread:message', 'domain:tenant', 'route:security', 'sender@example.net', NULL);
    INSERT INTO reply_relays (
      id, token_sha256, thread_id, route_id, external_recipient, reply_identity, expires_at
    ) VALUES (
      'relay:message', '${"c".repeat(64)}', 'thread:message', 'route:security',
      'sender@example.net', 'security@tenant.example.com', '2099-01-01T00:00:00.000Z'
    );
    INSERT INTO inbound_deliveries (
      id, fingerprint_sha256, relay_id, thread_id, route_id, policy_sha256, raw_r2_key, received_at, status
    ) VALUES (
      'inbound:message', '${"d".repeat(64)}', 'relay:message', 'thread:message',
      'route:security', '${OLD_POLICY}', 'relay-spool/message.eml', '2026-08-13T00:00:00.000Z', 'pending'
    );
    INSERT INTO inbound_recipient_deliveries (
      delivery_id, operator_ref, delivery_message_id, status
    ) VALUES
      ('inbound:message', '${"e".repeat(64)}', '<operator-a@example.com>', 'pending'),
      ('inbound:message', '${"f".repeat(64)}', '<operator-b@example.com>', 'pending');
  `);
}

test("stale all-pending relay retirement compiles against the exact migrated schema", () => {
  const database = migratedDatabase();
  try {
    expect(() => database.query(DISCARD_SUPERSEDED_UNSENT_RELAY_SQL).run(
      "relay:missing",
      OLD_POLICY,
      "inbound:missing",
    )).not.toThrow();
  } finally {
    database.close();
  }
});

test("stale all-pending relay retirement cascades the complete durable claim", () => {
  const database = migratedDatabase();
  try {
    seedSupersededClaim(database);
    const result = database.query(DISCARD_SUPERSEDED_UNSENT_RELAY_SQL).run(
      "relay:message",
      OLD_POLICY,
      "inbound:message",
    );

    // Bun's SQLite reports the root deletion plus three FK cascades. Runtime
    // success must therefore use a positive-count predicate, not equality 1.
    expect(result.changes).toBe(4);
    expect(database.query("SELECT count(*) AS count FROM reply_relays").get()).toEqual({ count: 0 });
    expect(database.query("SELECT count(*) AS count FROM inbound_deliveries").get()).toEqual({ count: 0 });
    expect(database.query("SELECT count(*) AS count FROM inbound_recipient_deliveries").get()).toEqual({ count: 0 });
  } finally {
    database.close();
  }
});

test("stale relay retirement refuses any claim that crossed the provider boundary", () => {
  const database = migratedDatabase();
  try {
    seedSupersededClaim(database);
    database.query(
      "UPDATE inbound_recipient_deliveries SET status = 'sending' WHERE delivery_id = ?1 AND operator_ref = ?2",
    ).run("inbound:message", "e".repeat(64));

    const result = database.query(DISCARD_SUPERSEDED_UNSENT_RELAY_SQL).run(
      "relay:message",
      OLD_POLICY,
      "inbound:message",
    );

    expect(result.changes).toBe(0);
    expect(database.query("SELECT count(*) AS count FROM reply_relays").get()).toEqual({ count: 1 });
    expect(database.query("SELECT count(*) AS count FROM inbound_deliveries").get()).toEqual({ count: 1 });
    expect(database.query("SELECT count(*) AS count FROM inbound_recipient_deliveries").get()).toEqual({ count: 2 });
  } finally {
    database.close();
  }
});
