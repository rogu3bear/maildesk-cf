import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CLAIM_ACTIVE_INBOUND_RECIPIENT_SQL,
  DISCARD_SUPERSEDED_UNSENT_RELAY_SQL,
} from "../../workers/mail-router/src/index";
import {
  CLAIMED_INBOUND_RESULT_SQL,
  CLAIMED_REPLY_SPOOL_SQL,
} from "../../workers/mail-api/src/index";

const root = resolve(import.meta.dir, "../..");
const OLD_POLICY = "a".repeat(64);
const ACTIVE_POLICY = "b".repeat(64);

function migratedDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  for (let version = 1; version <= 8; version += 1) {
    const filename = [
      "0001_maildesk_core.sql",
      "0002_audit_idempotency.sql",
      "0003_outbound_delivery_status.sql",
      "0004_inbox_reply_relay.sql",
      "0005_route_proof_timestamps.sql",
      "0006_active_policy_revision.sql",
      "0007_inbound_delivery_claims.sql",
      "0008_reply_spool_integrity.sql",
    ][version - 1]!;
    database.exec(readFileSync(resolve(root, "migrations", filename), "utf8"));
  }
  return database;
}

test("relay attempts persist the authenticated reply-spool digest", () => {
  const database = migratedDatabase();
  try {
    const columns = database.query("PRAGMA table_info(relay_attempts)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "raw_sha256")).toBe(true);
    seedSupersededClaim(database);
    const digest = "9".repeat(64);
    database.query(
      "INSERT INTO relay_attempts (id, relay_id, operator, operator_message_id, raw_r2_key, raw_sha256, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'receiving')",
    ).run(
      "relay-attempt:integrity",
      "relay:message",
      "operator@example.com",
      "<reply@example.com>",
      "relay-spool/reply.eml",
      digest,
    );
    expect(database.query(
      "SELECT raw_r2_key, raw_sha256 FROM relay_attempts WHERE id = ?1",
    ).get("relay-attempt:integrity")).toEqual({
      raw_r2_key: "relay-spool/reply.eml",
      raw_sha256: digest,
    });
    expect(database.query(CLAIMED_REPLY_SPOOL_SQL).get(
      "relay-attempt:integrity",
      "relay:message",
      "operator@example.com",
      "<reply@example.com>",
      "relay-spool/reply.eml",
      digest,
    )).toEqual({ id: "relay-attempt:integrity" });
    expect(database.query(CLAIMED_REPLY_SPOOL_SQL).get(
      "relay-attempt:integrity",
      "relay:message",
      "operator@example.com",
      "<reply@example.com>",
      "relay-spool/reply.eml",
      "7".repeat(64),
    )).toBeNull();
    expect(() => database.query(
      "INSERT INTO relay_attempts (id, relay_id, operator, operator_message_id, raw_r2_key, raw_sha256, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'receiving')",
    ).run(
      "relay-attempt:invalid-integrity",
      "relay:message",
      "operator@example.com",
      "<invalid@example.com>",
      "relay-spool/invalid.eml",
      "8".repeat(63),
    )).toThrow();
  } finally {
    database.close();
  }
});

test("inbound Queue results must match the complete durable D1 claim", () => {
  const database = migratedDatabase();
  try {
    seedSupersededClaim(database);
    database.exec(`
      UPDATE inbound_recipient_deliveries
      SET status = 'provider_accepted', provider_message_id =
        CASE operator_ref WHEN '${"e".repeat(64)}' THEN 'provider-a' ELSE 'provider-b' END;
    `);
    const results = [
      {
        operatorRef: "e".repeat(64),
        deliveryPayloadR2Key: "relay-spool/message.a.json",
        ok: true,
        providerMessageId: "provider-a",
      },
      {
        operatorRef: "f".repeat(64),
        deliveryPayloadR2Key: "relay-spool/message.b.json",
        ok: true,
        providerMessageId: "provider-b",
      },
    ];
    const query = database.query(CLAIMED_INBOUND_RESULT_SQL);
    const binds = [
      "inbound:message",
      "relay:message",
      "thread:message",
      "route:security",
      OLD_POLICY,
      "relay-spool/message.eml",
    ] as const;
    const receivedAt = "2026-08-13T00:00:00.000Z";
    const matched = query.get(
      ...binds,
      JSON.stringify(results),
      receivedAt,
      "provider_accepted",
    ) as {
      raw_r2_key: string;
      accepted_payload_keys_json: string;
    };
    expect(matched.raw_r2_key).toBe("relay-spool/message.eml");
    expect((JSON.parse(matched.accepted_payload_keys_json) as string[]).sort()).toEqual([
      "relay-spool/message.a.json",
      "relay-spool/message.b.json",
    ]);
    expect(query.get(
      ...binds,
      JSON.stringify(results.slice(0, 1)),
      receivedAt,
      "provider_accepted",
    )).toBeNull();
    expect(query.get(...binds, JSON.stringify([
      ...results.slice(0, 1),
      { ...results[1], deliveryPayloadR2Key: "relay-spool/unrelated.json" },
    ]), receivedAt, "provider_accepted")).toBeNull();
    expect(query.get(
      ...binds.slice(0, 5),
      "relay-spool/unrelated.eml",
      JSON.stringify(results),
      receivedAt,
      "provider_accepted",
    )).toBeNull();
    expect(query.get(...binds, JSON.stringify([
      ...results.slice(0, 1),
      { ...results[1], providerMessageId: "counterfeit-provider" },
    ]), receivedAt, "provider_accepted")).toBeNull();
    expect(query.get(
      ...binds,
      JSON.stringify(results),
      "2026-08-13T00:00:01.000Z",
      "provider_accepted",
    )).toBeNull();
    expect(query.get(
      ...binds,
      JSON.stringify(results),
      receivedAt,
      "recovery_required",
    )).toBeNull();
    expect(query.get(
      "inbound:missing",
      "relay:missing",
      "thread:missing",
      "route:security",
      OLD_POLICY,
      "relay-spool/unrelated.eml",
      JSON.stringify(results),
      receivedAt,
      "provider_accepted",
    )).toBeNull();
  } finally {
    database.close();
  }
});

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
      delivery_id, operator_ref, delivery_message_id, delivery_payload_r2_key, delivery_payload_sha256, status
    ) VALUES
      ('inbound:message', '${"e".repeat(64)}', '<operator-a@example.com>', 'relay-spool/message.a.json', '${"1".repeat(64)}', 'pending'),
      ('inbound:message', '${"f".repeat(64)}', '<operator-b@example.com>', 'relay-spool/message.b.json', '${"2".repeat(64)}', 'pending');
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

test("recipient claim atomically rejects a superseded runtime policy", () => {
  const database = migratedDatabase();
  try {
    seedSupersededClaim(database);
    const stale = database.query(CLAIM_ACTIVE_INBOUND_RECIPIENT_SQL).run(
      "inbound:message",
      "e".repeat(64),
      OLD_POLICY,
      "relay-spool/message.eml",
    );
    expect(stale.changes).toBe(0);
    expect(database.query(
      "SELECT status FROM inbound_recipient_deliveries WHERE delivery_id = ?1 AND operator_ref = ?2",
    ).get("inbound:message", "e".repeat(64))).toEqual({ status: "pending" });

    database.query(
      "UPDATE runtime_state SET active_policy_sha256 = ?1, active_policy_r2_key = ?2 WHERE singleton = 1",
    ).run(OLD_POLICY, `config/policy/${OLD_POLICY}.json`);
    const active = database.query(CLAIM_ACTIVE_INBOUND_RECIPIENT_SQL).run(
      "inbound:message",
      "e".repeat(64),
      OLD_POLICY,
      "relay-spool/message.eml",
    );
    expect(active.changes).toBe(1);
    expect(database.query(
      "SELECT status FROM inbound_recipient_deliveries WHERE delivery_id = ?1 AND operator_ref = ?2",
    ).get("inbound:message", "e".repeat(64))).toEqual({ status: "sending" });
  } finally {
    database.close();
  }
});
