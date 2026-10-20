import { expect, test } from "bun:test";
import { activateFixture, relayRuntime } from "../helpers/relay-runtime";

type Fixture = Awaited<ReturnType<typeof relayRuntime>>;
const changes: Record<string, (f: Fixture) => void> = {
  operator_set: (f) => { f.db.run("UPDATE operators SET email='replacement@example.net' WHERE email='second@example.com'"); },
  identity_profile: (f) => { f.db.run("UPDATE identities SET address='replacement@example.com'"); },
  route_address: (f) => { f.db.run("UPDATE alias_routes SET local_part='replacement'"); },
  route_kind: (f) => { f.db.run("UPDATE alias_routes SET decision_kind='sink'"); },
  desired_policy: (f) => { f.db.run("UPDATE policy_projection_state SET value=? WHERE key='active_desired_state_sha256'", ["e".repeat(64)]); },
  active_policy: (f) => {
    f.db.run("INSERT INTO policy_revisions (policy_sha256,r2_object_key,expected_domain_count,expected_route_count) VALUES (?, ?, 1, 1)", ["e".repeat(64),`config/policy/${"e".repeat(64)}.json`]);
    f.db.run("UPDATE runtime_state SET active_policy_sha256=?,active_policy_r2_key=?", ["e".repeat(64),`config/policy/${"e".repeat(64)}.json`]);
  },
  quarantine: (f) => { f.db.run(`INSERT INTO route_reply_containment_events
    (id,schema_version,route_id,action,reason,receipt_sha256,owner_authorization_sha256,recorded_at,cannot_unsend)
    VALUES ('q:atomic',1,'route:example.com:support','quarantine','controller_recovery',?,?,CURRENT_TIMESTAMP,1)`, ["a".repeat(64),"b".repeat(64)]); },
};
for (const kind of ["canary", "ordinary"] as const) {
  for (const [name, change] of Object.entries(changes)) {
    test(`${kind} ingress claim is atomic against ${name} replacement`, async () => {
      const f = await relayRuntime();
      try {
        if (kind === "ordinary") await activateFixture(f); else await f.admitCanary();
        const prior = kind === "ordinary" ? 1 : 0;
        f.d1.before = (sql) => {
          if (!sql.startsWith(kind === "ordinary" ? "INSERT INTO ordinary_reply_admissions" : "INSERT INTO relay_attempts")) return;
          f.d1.before = undefined; change(f);
        };
        expect(await f.ingress(await f.signedReply())).toBeDefined();
        expect(f.db.query("SELECT count(*) AS n FROM relay_attempts").get()).toEqual({n:prior});
        if (kind === "ordinary") expect(f.db.query("SELECT count(*) AS n FROM ordinary_reply_admissions").get()).toEqual({n:0});
        else expect(f.db.query("SELECT status,claimed_attempt_id FROM reply_admissions").get()).toEqual({status:"admitted",claimed_attempt_id:null});
        expect(f.jobs).toHaveLength(prior); expect(f.sends).toHaveLength(prior);
        expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {f.db.close();}
    });
    test(`${kind} provider claim has no provider call after a zero-row ${name} guard`, async () => {
      const f = await relayRuntime();
      try {
        if (kind === "ordinary") await activateFixture(f); else await f.admitCanary();
        const prior = kind === "ordinary" ? 1 : 0;
        expect(await f.ingress(await f.signedReply())).toBeUndefined();
        let reached = false;
        f.d1.before = (sql) => {
          if (!sql.startsWith(`UPDATE ${kind === "ordinary" ? "ordinary_reply_admissions" : "reply_admissions"} SET status = 'sending'`)) return;
          f.d1.before = undefined; reached = true; change(f);
        };
        await f.consume(f.jobs.at(-1));
        expect(reached).toBe(true); expect(f.sends).toHaveLength(prior);
        expect(f.db.query(`SELECT provider_boundary_at FROM ${kind === "ordinary" ? "ordinary_reply_admissions" : "reply_admissions"}`).get()).toEqual({provider_boundary_at:null});
        expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {f.db.close();}
    });
  }
}
