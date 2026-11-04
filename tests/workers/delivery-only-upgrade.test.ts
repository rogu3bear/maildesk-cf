import { expect, test } from "bun:test";
import { migrate, relayRuntime } from "../helpers/relay-runtime";

test("migration 0018 preserves existing inbound and relay evidence and rejects cross-mode duplicates", async () => {
  const f = await relayRuntime(17);
  try {
    const tables = ["inbound_deliveries", "reply_relays", "threads", "audit_events", "runtime_state", "route_health"];
    const snapshot = () => tables.map((table) => ({ table, rows: f.db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() }));
    const before = snapshot();
    migrate(f.db, 17, 18);
    expect(snapshot()).toEqual(before);
    expect(f.db.query("SELECT singleton,after_fingerprint FROM delivery_only_recovery_cursor").all()).toEqual([{ singleton: 1, after_fingerprint: "" }]);
    expect(() => f.db.run("INSERT INTO delivery_only_recovery_cursor(singleton) VALUES (2)")).toThrow();
    expect(() => f.db.query("INSERT INTO delivery_only_deliveries(id,fingerprint_sha256,route_id,policy_sha256,received_at,recipient_count) VALUES('other',?1,'route:example.com:support',?2,'now',1)")
      .run("c".repeat(64), f.policySha)).toThrow();
    expect(f.db.query("SELECT status FROM inbound_deliveries WHERE id='inbound:one'").get()).toEqual({ status: "provider_accepted" });
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { f.db.close(); }
});

test("migration 0018 preserves accepted and uncertain recipient attempts", async () => {
  const f = await relayRuntime(17);
  try {
    f.db.run("UPDATE inbound_deliveries SET status='partial_delivery', raw_r2_key='relay-spool/legacy.eml' WHERE id='inbound:one'");
    const insert = f.db.query("INSERT INTO inbound_recipient_deliveries(delivery_id,operator_ref,delivery_message_id,delivery_payload_r2_key,delivery_payload_sha256,status,provider_message_id,error_code) VALUES('inbound:one',?1,?2,?3,?4,?5,?6,?7)");
    insert.run("a".repeat(64), "accepted-id", "accepted-payload", "b".repeat(64), "provider_accepted", "provider:accepted", null);
    insert.run("c".repeat(64), "unknown-id", "unknown-payload", "d".repeat(64), "sending", null, "unknown");
    const before = f.db.query("SELECT * FROM inbound_recipient_deliveries ORDER BY operator_ref").all();
    const parentBefore = f.db.query("SELECT * FROM inbound_deliveries WHERE id='inbound:one'").get();
    migrate(f.db, 17, 18);
    expect(f.db.query("SELECT * FROM inbound_recipient_deliveries ORDER BY operator_ref").all()).toEqual(before);
    expect(f.db.query("SELECT * FROM inbound_deliveries WHERE id='inbound:one'").get()).toEqual(parentBefore);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { f.db.close(); }
});
