import { expect, test } from "bun:test";
import { activateFixture, relayRuntime } from "../helpers/relay-runtime";

test("explicit fixture activation permits ordinary replies without new controller artifacts", async () => {
  const f = await relayRuntime();
  try {
    await activateFixture(f);
    for (const [id, operator] of [["first", "operator@example.com"], ["second", "second@example.com"]]) {
      const raw = await f.signedReply(`<${id}@example.com>`, `${id} authored paragraph.\r\n\r\nA final line.\r\n`, operator);
      expect(await f.ingress(raw, f.relayRecipient, operator)).toBeUndefined();
      const job = f.jobs.at(-1)!;
      expect(job).toMatchObject({ schemaVersion: 2, admissionKind: "ordinary", activationId: "activation:fixture" });
      await f.consume(job);
      await f.consume(job);
      expect(await f.ingress(raw, f.relayRecipient, operator)).toBeUndefined();
    }
    expect(f.sends).toHaveLength(3); // One canary and two independently authored replies.
    expect(f.db.query("SELECT count(*) AS n FROM reply_admissions").get()).toEqual({ n: 1 });
    expect(f.db.query("SELECT count(*) AS n FROM ordinary_reply_admissions WHERE status = 'provider_accepted'").get()).toEqual({ n: 2 });
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(f.spools.size).toBe(0);
  } finally { f.db.close(); }
});

test("enabled switches do not create ordinary authority", async () => {
  const f = await relayRuntime();
  try {
    f.env.MAILDESK_ORDINARY_REPLY_MODE = "enabled";
    expect(await f.ingress(await f.signedReply())).toContain("explicit ordinary route authorization");
    expect(f.sends).toHaveLength(0);
    expect(f.jobs).toHaveLength(0);
    expect(f.db.query("SELECT count(*) AS n FROM ordinary_reply_admissions").get()).toEqual({ n: 0 });
  } finally { f.db.close(); }
});

test("revoked activation, stale bindings and kill switches cannot authorize ordinary mail", async () => {
  const changes: Array<(f: Awaited<ReturnType<typeof relayRuntime>>) => void> = [
    (f) => { f.db.run("UPDATE route_reply_authorizations SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, revocation_receipt_sha256 = ?", ["8".repeat(64)]); },
    (f) => { f.env.MAILDESK_RUNTIME_ARTIFACTS_SHA256 = "9".repeat(64); },
    (f) => { f.db.run("UPDATE policy_projection_state SET value = ? WHERE key = 'active_desired_state_sha256'", ["9".repeat(64)]); },
    (f) => { f.db.run("UPDATE policy_projection_state SET value = ? WHERE key = 'active_topology_sha256'", ["9".repeat(64)]); },
    (f) => { f.env.MAILDESK_ORDINARY_REPLY_MODE = "disabled"; },
    (f) => { f.env.MAILDESK_REPLY_RELAY_MODE = "disabled"; },
  ];
  for (const change of changes) {
    const f = await relayRuntime();
    try {
      await activateFixture(f);
      change(f);
      expect(await f.ingress(await f.signedReply())).toBeDefined();
      expect(f.sends).toHaveLength(1);
      expect(f.jobs).toHaveLength(1);
      expect(f.db.query("SELECT count(*) AS n FROM ordinary_reply_admissions").get()).toEqual({ n: 0 });
    } finally { f.db.close(); }
  }
});

test("stale observations do not silently revoke a current explicit activation", async () => {
  const f = await relayRuntime();
  try {
    await activateFixture(f);
    // Model elapsed observation freshness in fixture evidence, without changing authority.
    f.db.run("UPDATE route_proofs SET verified_at = '2020-01-01T00:00:00Z'");
    expect(await f.ingress(await f.signedReply())).toBeUndefined();
    await f.consume(f.jobs.at(-1));
    expect(f.sends).toHaveLength(2);
    expect(f.db.query("SELECT status FROM route_reply_authorizations").get()).toEqual({ status: "active" });
  } finally { f.db.close(); }
});

test("ordinary authority is rechecked at provider claim and cannot be regained through a legacy Queue shape", async () => {
  for (const mutation of ["revoke", "remove_operator", "legacy_payload"] as const) {
    const f = await relayRuntime();
    try {
      await activateFixture(f);
      expect(await f.ingress(await f.signedReply())).toBeUndefined();
      const job = f.jobs.at(-1)!;
      if (mutation === "legacy_payload") {
        if (job.kind !== "inbox_reply_received") throw new Error("invalid fixture job");
        delete job.schemaVersion; delete job.admissionKind; delete job.activationId;
      } else {
        f.d1.before = (sql) => {
          if (!sql.startsWith("UPDATE ordinary_reply_admissions SET status = 'sending'")) return;
          f.d1.before = undefined;
          if (mutation === "revoke") f.db.run("UPDATE route_reply_authorizations SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, revocation_receipt_sha256 = ?", ["8".repeat(64)]);
          else f.db.run("DELETE FROM alias_route_operators WHERE operator_id = 'operator:second%40example.com'");
        };
      }
      await f.consume(job);
      expect(f.sends).toHaveLength(1);
    } finally { f.db.close(); }
  }
});

test("concurrent exact ordinary deliveries share one claim while independent operator messages remain distinct", async () => {
  const f = await relayRuntime();
  try {
    await activateFixture(f);
    const raw = await f.signedReply();
    await Promise.all([f.ingress(raw), f.ingress(raw)]);
    expect(f.db.query("SELECT count(*) AS n FROM ordinary_reply_admissions").get()).toEqual({ n: 1 });
    await Promise.allSettled(f.jobs.slice(1).map((job) => f.consume(job)));
    expect(f.sends).toHaveLength(2);
    const one = await f.signedReply("<operator-one@example.com>");
    const two = await f.signedReply("<operator-two@example.com>", "Second authored reply.\r\n", "second@example.com");
    await Promise.all([f.ingress(one), f.ingress(two, f.relayRecipient, "second@example.com")]);
    for (const job of f.jobs) await f.consume(job);
    expect(f.db.query("SELECT count(*) AS n FROM ordinary_reply_admissions").get()).toEqual({ n: 3 });
    expect(f.sends).toHaveLength(4);
  } finally { f.db.close(); }
});

test("route-wide quarantine or operator-set drift racing ordinary admission rolls back its paired attempt", async () => {
  for (const cause of ["quarantine", "operator"] as const) {
    const f = await relayRuntime();
    try {
      await activateFixture(f);
      f.d1.before = (sql) => {
        if (!sql.startsWith("INSERT INTO ordinary_reply_admissions")) return;
        f.d1.before = undefined;
        if (cause === "operator") f.db.run("DELETE FROM alias_route_operators WHERE operator_id='operator:second%40example.com'");
        else f.db.run(`INSERT INTO route_reply_containment_events (id,schema_version,route_id,action,reason,
          receipt_sha256,owner_authorization_sha256,recorded_at,cannot_unsend)
          VALUES ('q:race',1,'route:example.com:support','quarantine','controller_recovery',?,?,CURRENT_TIMESTAMP,1)`, ["a".repeat(64),"b".repeat(64)]);
      };
      expect(await f.ingress(await f.signedReply())).toBeDefined();
      expect(f.db.query("SELECT count(*) AS n FROM ordinary_reply_admissions").get()).toEqual({ n: 0 });
      expect(f.db.query("SELECT count(*) AS n FROM relay_attempts").get()).toEqual({ n: 1 });
      expect(f.sends).toHaveLength(1);
    } finally { f.db.close(); }
  }
});

test("expired explicit activation blocks new ordinary claims without inventing revocation", async () => {
  const f = await relayRuntime();
  try {
    await activateFixture(f, false, 30);
    await Bun.sleep(60);
    expect(f.db.query("SELECT status FROM route_reply_authorizations").get()).toEqual({ status: "active" });
    expect(f.db.query("SELECT count(*) AS n FROM current_route_reply_authorizations").get()).toEqual({ n: 0 });
    expect(await f.ingress(await f.signedReply())).toContain("explicit ordinary route authorization");
    expect(f.db.query("SELECT count(*) AS n FROM ordinary_reply_admissions").get()).toEqual({ n: 0 });
    expect(f.jobs).toHaveLength(1);
    expect(f.sends).toHaveLength(1);
  } finally { f.db.close(); }
});
