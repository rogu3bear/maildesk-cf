import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrations = resolve(import.meta.dir, "../../migrations");

test("delivery-only claims preserve attempted outcomes without a reply relay", () => {
  const db = new Database(":memory:", { strict: true });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const files = readdirSync(migrations).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
    for (const name of files.filter((name) => Number(name.slice(0, 4)) < 18)) {
      db.exec(readFileSync(resolve(migrations, name), "utf8"));
    }
    db.exec(`INSERT INTO domains(id,domain) VALUES('d','example.com');
      INSERT INTO identities(id,domain_id,address,kind) VALUES('i','d','reports@example.com','role');
      INSERT INTO alias_routes(id,domain_id,local_part,kind,default_reply_identity_id)
        VALUES('r','d','reports','role','i');`);
    db.exec(readFileSync(resolve(migrations, "0018_delivery_only_claims.sql"), "utf8"));
    db.query("INSERT INTO delivery_only_deliveries(id,fingerprint_sha256,route_id,policy_sha256,received_at,recipient_count) VALUES(?1,?2,?3,?4,?5,1)")
      .run("x", "a".repeat(64), "r", "b".repeat(64), "2026-01-01T00:00:00Z");
    db.query("INSERT INTO delivery_only_recipient_deliveries(delivery_id,recipient_ref,delivery_message_id,delivery_payload_r2_key,delivery_payload_sha256) VALUES(?1,?2,?3,?4,?5)")
      .run("x", "c".repeat(64), "message", "spool", "d".repeat(64));
    expect(db.query("SELECT COUNT(*) AS count FROM reply_relays").get()).toEqual({ count: 0 });
    db.exec(`INSERT INTO threads(id,domain_id,route_id,external_sender) VALUES('t','d','r','sender@example.net');
      INSERT INTO reply_relays(id,token_sha256,thread_id,route_id,external_recipient,reply_identity,expires_at)
      VALUES('relay','${"e".repeat(64)}','t','r','sender@example.net','reports@example.com','2099-01-01');`);
    const ordinary = db.query("INSERT INTO inbound_deliveries(id,fingerprint_sha256,relay_id,thread_id,route_id,policy_sha256,received_at) VALUES('ordinary',?1,'relay','t','r',?2,'now')");
    expect(() => ordinary.run("a".repeat(64), "b".repeat(64))).toThrow();
    ordinary.run("f".repeat(64), "b".repeat(64));
    expect(() => db.query("INSERT INTO delivery_only_deliveries(id,fingerprint_sha256,route_id,policy_sha256,received_at,recipient_count) VALUES('other',?1,'r',?2,'now',1)").run("f".repeat(64), "b".repeat(64))).toThrow();
    expect(() => db.query("UPDATE inbound_deliveries SET fingerprint_sha256=?1 WHERE id='ordinary'").run("a".repeat(64))).toThrow();
    expect(() => db.exec("UPDATE delivery_only_recipient_deliveries SET delivery_payload_r2_key='other' ")).toThrow();
    expect(() => db.exec("UPDATE delivery_only_deliveries SET fingerprint_sha256='other' ")).toThrow();
    db.exec("UPDATE delivery_only_recipient_deliveries SET status='sending'");
    expect(() => db.exec("UPDATE delivery_only_recipient_deliveries SET status='pending'")).toThrow();
    expect(() => db.exec("DELETE FROM delivery_only_deliveries WHERE id='x'")).toThrow();
    db.exec("UPDATE delivery_only_recipient_deliveries SET status='recovery_required'");
    expect(() => db.exec("UPDATE delivery_only_recipient_deliveries SET status='sending'")).toThrow();
    db.exec("UPDATE delivery_only_recipient_deliveries SET status='provider_accepted'");
    expect(() => db.exec("UPDATE delivery_only_recipient_deliveries SET status='recovery_required'")).toThrow();
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("delivery-only recipient claim is single-use and bound to active policy and payload", async () => {
  const { CLAIM_ACTIVE_DELIVERY_ONLY_RECIPIENT_SQL, PROJECT_DELIVERY_ONLY_OUTCOME_SQL } = await import("../../workers/mail-router/src/delivery-only-claims");
  const db = new Database(":memory:", { strict: true });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    for (const name of readdirSync(migrations).filter((name) => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 18).sort()) {
      db.exec(readFileSync(resolve(migrations, name), "utf8"));
    }
    const policy = "a".repeat(64), otherPolicy = "b".repeat(64), ref = "c".repeat(64), payload = "d".repeat(64);
    db.query("INSERT INTO policy_revisions(policy_sha256,r2_object_key,expected_domain_count,expected_route_count) VALUES(?1,?2,1,1)").run(policy,"policy/a");
    db.query("INSERT INTO policy_revisions(policy_sha256,r2_object_key,expected_domain_count,expected_route_count) VALUES(?1,?2,1,1)").run(otherPolicy,"policy/b");
    db.query("INSERT INTO runtime_state(singleton,active_policy_sha256,active_policy_r2_key) VALUES(1,?1,'policy/a')").run(policy);
    db.exec("INSERT INTO domains(id,domain) VALUES('d','example.com'); INSERT INTO identities(id,domain_id,address,kind) VALUES('i','d','reports@example.com','role');");
    db.query("INSERT INTO alias_routes(id,domain_id,local_part,kind,default_reply_identity_id,policy_sha256) VALUES('r','d','reports','role','i',?1)").run(policy);
    db.query("INSERT INTO delivery_only_deliveries(id,fingerprint_sha256,route_id,policy_sha256,raw_r2_key,received_at,recipient_count) VALUES('x',?1,'r',?2,'spool','now',2)").run("e".repeat(64),policy);
    db.query("INSERT INTO delivery_only_recipient_deliveries(delivery_id,recipient_ref,delivery_message_id,delivery_payload_r2_key,delivery_payload_sha256) VALUES('x',?1,'m','payload',?2)").run(ref,payload);
    const claim = db.query(CLAIM_ACTIVE_DELIVERY_ONLY_RECIPIENT_SQL);
    expect(claim.run("x",ref,policy,"spool",payload).changes).toBe(0);
    db.query("INSERT INTO delivery_only_recipient_deliveries(delivery_id,recipient_ref,delivery_message_id,delivery_payload_r2_key,delivery_payload_sha256) VALUES('x',?1,'m2','payload2',?2)").run("9".repeat(64),payload);
    expect(claim.run("x",ref,policy,"spool","f".repeat(64)).changes).toBe(0);
    expect(claim.run("x",ref,policy,"wrong-spool",payload).changes).toBe(0);
    db.query("UPDATE runtime_state SET active_policy_sha256=?1, active_policy_r2_key='policy/b' WHERE singleton=1").run(otherPolicy);
    expect(claim.run("x",ref,policy,"spool",payload).changes).toBe(0);
    db.query("UPDATE runtime_state SET active_policy_sha256=?1, active_policy_r2_key='policy/a' WHERE singleton=1").run(policy);
    expect(claim.run("x",ref,policy,"spool",payload).changes).toBeGreaterThan(0);
    expect(() => db.query("INSERT INTO delivery_only_recipient_deliveries(delivery_id,recipient_ref,delivery_message_id,delivery_payload_r2_key,delivery_payload_sha256) VALUES('x',?1,'m3','payload3',?2)").run("8".repeat(64),payload)).toThrow();
    expect(() => db.query("DELETE FROM delivery_only_recipient_deliveries WHERE delivery_id='x' AND recipient_ref=?1").run("9".repeat(64))).toThrow();
    expect(claim.run("x",ref,policy,"spool",payload).changes).toBe(0);
    const project = db.query(PROJECT_DELIVERY_ONLY_OUTCOME_SQL);
    expect(project.run("provider_accepted", "provider-id", null, "x", ref, "f".repeat(64)).changes).toBe(0);
    expect(project.run("recovery_required", null, "provider_unknown", "x", ref, payload).changes).toBeGreaterThan(0);
    expect(claim.run("x",ref,policy,"spool",payload).changes).toBe(0);
    expect(project.run("provider_accepted", "provider-id", null, "x", ref, payload).changes).toBe(0);
    expect(db.query("SELECT status,provider_message_id,error_code FROM delivery_only_recipient_deliveries WHERE recipient_ref=?1").get(ref)).toEqual({ status: "recovery_required", provider_message_id: null, error_code: "provider_unknown" });
    const { REFRESH_DELIVERY_ONLY_STATUS_SQL } = await import("../../workers/mail-router/src/delivery-only-recovery");
    expect(db.query(REFRESH_DELIVERY_ONLY_STATUS_SQL).run("x").changes).toBeGreaterThan(0);
    expect(db.query("SELECT status FROM delivery_only_deliveries WHERE id='x'").get()).toEqual({ status: "recovery_required" });
    expect(claim.run("x","9".repeat(64),policy,"spool",payload).changes).toBeGreaterThan(0);
    expect(project.run("provider_accepted", "provider-id", null, "x", "9".repeat(64), payload).changes).toBeGreaterThan(0);
    db.query(REFRESH_DELIVERY_ONLY_STATUS_SQL).run("x");
    expect(db.query("SELECT status FROM delivery_only_deliveries WHERE id='x'").get()).toEqual({ status: "partial_delivery" });
  } finally {
    db.close();
  }
});

test("delivery-only persistence requires an enabled route and the active policy", async () => {
  const { INSERT_ACTIVE_DELIVERY_ONLY_SQL, INSERT_DELIVERY_ONLY_RECIPIENT_SQL, readDeliveryOnlyClaim } = await import("../../workers/mail-router/src/delivery-only-claims");
  const db = new Database(":memory:", { strict: true });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    for (const name of readdirSync(migrations).filter((name) => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 18).sort()) {
      db.exec(readFileSync(resolve(migrations, name), "utf8"));
    }
    const policy = "a".repeat(64), other = "b".repeat(64), recipient = "c".repeat(64), digest = "d".repeat(64);
    db.query("INSERT INTO policy_revisions(policy_sha256,r2_object_key,expected_domain_count,expected_route_count) VALUES(?1,'policy/a',1,1)").run(policy);
    db.query("INSERT INTO policy_revisions(policy_sha256,r2_object_key,expected_domain_count,expected_route_count) VALUES(?1,'policy/b',1,1)").run(other);
    db.query("INSERT INTO runtime_state(singleton,active_policy_sha256,active_policy_r2_key) VALUES(1,?1,'policy/a')").run(policy);
    db.exec("INSERT INTO domains(id,domain) VALUES('d','example.com'); INSERT INTO identities(id,domain_id,address,kind) VALUES('i','d','reports@example.com','role');");
    db.query("INSERT INTO alias_routes(id,domain_id,local_part,kind,default_reply_identity_id,policy_sha256) VALUES('r','d','reports','role','i',?1)").run(policy);
    const parent = db.query(INSERT_ACTIVE_DELIVERY_ONLY_SQL), child = db.query(INSERT_DELIVERY_ONLY_RECIPIENT_SQL);
    expect(() => parent.run("x","e".repeat(64),"r",other,"spool","now",1)).toThrow();
    expect(() => child.run("x",recipient,"m","payload",digest,other,"spool")).toThrow();
    const partial = db.transaction(() => {
      parent.run("partial", "f".repeat(64), "r", policy, "spool", "now",1);
      child.run("partial", recipient, "m", "payload", digest, policy, "wrong");
    });
    expect(() => partial()).toThrow();
    expect(db.query("SELECT COUNT(*) AS count FROM delivery_only_deliveries WHERE id='partial'").get()).toEqual({ count: 0 });
    expect(parent.run("x","e".repeat(64),"r",policy,"spool","now",1).changes).toBeGreaterThan(0);
    expect(() => child.run("x",recipient,"m","payload",digest,policy,"wrong")).toThrow();
    expect(child.run("x",recipient,"m","payload",digest,policy,"spool").changes).toBeGreaterThan(0);
    expect(() => parent.run("y","e".repeat(64),"r",policy,"spool","now",1)).toThrow();
    expect(db.query("SELECT COUNT(*) AS count FROM reply_relays").get()).toEqual({ count: 0 });
    const adapter = {
      withSession(constraint: string) {
        expect(constraint).toBe("first-primary");
        return { prepare(sql: string) { return { bind(value: string) { return {
          async all() { return { success: true, results: db.query(sql).all(value) }; },
        }; } }; } };
      },
    } as unknown as D1Database;
    const binding = { deliveryId: "x", fingerprintSha256: "e".repeat(64), routeId: "r", policySha256: policy,
      rawSpoolKey: "spool", receivedAt: "now", recipients: [{ ref: recipient, messageId: "m", payloadKey: "payload", payloadSha256: digest }] };
    expect(await readDeliveryOnlyClaim(adapter, binding)).toEqual({ kind: "matched", deliveryStatus: "pending", recipients: [{ ref: recipient, status: "pending" }] });
    expect(await readDeliveryOnlyClaim(adapter, { ...binding, rawSpoolKey: "different" })).toEqual({ kind: "unresolved" });
    expect(await readDeliveryOnlyClaim(adapter, { ...binding, fingerprintSha256: "0".repeat(64) })).toEqual({ kind: "unresolved" });
    expect(await readDeliveryOnlyClaim(adapter, { ...binding, recipients: [...binding.recipients, binding.recipients[0]!] })).toEqual({ kind: "unresolved" });
  } finally {
    db.close();
  }
});
