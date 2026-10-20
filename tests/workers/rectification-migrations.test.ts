import { expect, test } from "bun:test";
import { activateFixture, migrate, relayRuntime, testPolicy } from "../helpers/relay-runtime";
import { authorizeReplyWithPolicy } from "../../workers/shared/router";
import { outboundRelayPayloadSha256, outboundReplyPayload, parseRelayEmail, sha256Hex } from "../../workers/shared/inbox-relay";
import { replyAttemptIdentities } from "../../workers/shared/message-identity";
import { recoverKnownUnsentDispatch } from "../../workers/shared/reply-recovery";
import type { InboxReplyReceivedJob } from "../../workers/shared/contracts";

async function baselineClaim(f: Awaited<ReturnType<typeof relayRuntime>>, terminal = false): Promise<InboxReplyReceivedJob> {
  await f.admitCanary();
  const messageId = "<Legacy-ID@example.com>";
  const raw = await f.signedReply(messageId, "Legacy authored reply.\r\n\r\n-- \r\nPrivate signature\r\n");
  const attemptId = (await replyAttemptIdentities("relay:one", messageId)).legacy;
  const authorization = authorizeReplyWithPolicy(testPolicy, { envelopeTo: "support@example.com", operator: "operator@example.com" });
  if (!authorization.ok || !authorization.value.identityProfile) throw new Error("profile missing");
  const payload = outboundReplyPayload(await parseRelayEmail(raw), authorization.value.identityProfile, 1);
  const payloadSha = await outboundRelayPayloadSha256({ ...payload, headers: { "In-Reply-To": "<original@example.net>", References: "<original@example.net>" } });
  const key = "relay-spool/legacy.eml";
  f.spools.set(key, raw);
  const rawSha = await sha256Hex(raw);
  f.db.run("INSERT INTO relay_attempts (id,relay_id,operator,operator_message_id,raw_r2_key,raw_sha256,status) VALUES (?, 'relay:one', 'operator@example.com', ?, ?, ?, ?)",
    [attemptId, messageId, key, rawSha, terminal ? "provider_accepted" : "queued"]);
  f.db.run("UPDATE reply_admissions SET status = ?, claimed_attempt_id = ?, claimed_attempt_sha256 = ?, claimed_payload_sha256 = ?, claimed_at = CURRENT_TIMESTAMP, provider_boundary_at = ?, terminal_at = ?",
    [terminal ? "provider_accepted" : "claimed", attemptId, "e".repeat(64), payloadSha, terminal ? new Date().toISOString() : null, terminal ? new Date().toISOString() : null]);
  return { kind: "inbox_reply_received", attemptId, admissionId: "admission:one", transactionSha256: await sha256Hex("admission:one"),
    attemptSha256: "e".repeat(64), claimedPayloadSha256: payloadSha, desiredStateSha256: f.desiredSha,
    identityProfileSha256: f.profileSha, relayId: "relay:one", operator: "operator@example.com",
    operatorMessageId: messageId, rawR2Key: key, rawSha256: rawSha, receivedAt: new Date().toISOString() };
}

test("populated baseline upgrades preserve original canary identity, expiry, terminal and containment lineage", async () => {
  const f = await relayRuntime(12);
  try {
    const job = await baselineClaim(f, true);
    f.db.run(`INSERT INTO route_outbound_quarantines (id, route_id, relay_id, reply_admission_id,
      controller_transaction_sha256, action, reason, containment_plan_sha256, quarantined_at)
      VALUES ('q:legacy', 'route:example.com:support','relay:one','admission:one',?,'quarantine','wrong_identity',?,CURRENT_TIMESTAMP)`, ["1".repeat(64), "2".repeat(64)]);
    f.db.run(`INSERT INTO route_outbound_quarantines (id, route_id, relay_id, reply_admission_id,
      controller_transaction_sha256, action, reason, containment_plan_sha256, source_containment_plan_sha256, release_of_quarantine_id, quarantined_at)
      VALUES ('r:legacy', 'route:example.com:support','relay:one','admission:one',?,'release','controller_recovery',?,?,'q:legacy',CURRENT_TIMESTAMP)`, ["3".repeat(64), "4".repeat(64), "2".repeat(64)]);
    const admissionBefore = f.db.query("SELECT * FROM reply_admissions").all();
    const lineageBefore = f.db.query("SELECT * FROM route_outbound_quarantines ORDER BY id").all();
    migrate(f.db, 12);
    expect(f.db.query("SELECT * FROM reply_admissions").all()).toEqual(admissionBefore);
    expect(f.db.query("SELECT * FROM route_outbound_quarantines ORDER BY id").all()).toEqual(lineageBefore);
    expect(f.db.query("SELECT id,identity_version,payload_version,admission_kind,status FROM relay_attempts").get())
      .toEqual({ id: job.attemptId, identity_version: 1, payload_version: 1, admission_kind: "canary", status: "provider_accepted" });
    expect(f.db.query("SELECT count(*) AS n FROM route_reply_authorizations").get()).toEqual({ n: 0 });
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => f.db.run("UPDATE reply_admissions SET status='claimed'")).toThrow("terminal");
    expect(() => f.db.run("UPDATE reply_admissions SET expires_at='2099-01-01'")).toThrow("immutable");
    expect(() => f.db.run("UPDATE relay_attempts SET status='queued'")).toThrow("terminal");
    expect(() => f.db.run("DELETE FROM route_outbound_quarantines")).toThrow("append-only");
    await f.consume(job);
    expect(f.sends).toHaveLength(0);
  } finally { f.db.close(); }
});

test("old immutable canary jobs and new ordinary jobs share the upgraded pipeline without hash reinterpretation", async () => {
  const f = await relayRuntime(12);
  try {
    const job = await baselineClaim(f);
    migrate(f.db, 12);
    await f.consume(job);
    await f.consume(job);
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]?.text).toBe("Legacy authored reply.\n\n-- \nExample Support\nexample.com");
    expect(f.db.query("SELECT payload_version,identity_version FROM relay_attempts").get()).toEqual({ payload_version: 1, identity_version: 1 });
    // A new route activation is explicit. It does not reinterpret the old job.
    await activateFixture(f, true);
    expect(await f.ingress(await f.signedReply("<new-after-upgrade@example.com>"))).toBeUndefined();
    const ordinary = f.jobs.at(-1)!;
    expect(ordinary).toMatchObject({ schemaVersion: 2, admissionKind: "ordinary" });
    await f.consume(ordinary);
    await f.consume(job);
    expect(f.sends).toHaveLength(2);
    expect(f.db.query("SELECT status FROM route_reply_authorizations").get()).toEqual({ status: "active" });
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { f.db.close(); }
});

test("expired legacy duplicates remain reconciliation records without dispatch or new authority", async () => {
  const f = await relayRuntime(12);
  try {
    const job = await baselineClaim(f);
    f.db.run("UPDATE reply_admissions SET admitted_at='2020-01-01T00:00:00Z', expires_at='2020-01-01T00:10:00Z'");
    migrate(f.db, 12);
    const raw = f.spools.get(job.rawR2Key)!;
    expect(await f.ingress(raw)).toBeUndefined();
    expect(f.jobs).toHaveLength(0);
    expect(await recoverKnownUnsentDispatch(job.attemptId, f.env)).toMatchObject({ state: "blocked", reason: "dispatch_safety_changed" });
    expect(f.db.query("SELECT count(*) AS n FROM relay_attempts").get()).toEqual({ n: 1 });
    expect(f.sends).toHaveLength(0);
  } finally { f.db.close(); }
});

test("route-wide quarantine needs no admission and release must name exact append-only lineage", async () => {
  const f = await relayRuntime();
  try {
    const insert = (id: string, action: string, release: string | null, receipt = "1".repeat(64)) => f.db.run(`INSERT INTO route_reply_containment_events
      (id,schema_version,route_id,action,reason,receipt_sha256,owner_authorization_sha256,release_of,recorded_at,cannot_unsend)
      VALUES (?,1,'route:example.com:support',?,'controller_recovery',?,?,?,CURRENT_TIMESTAMP,1)`, [id, action, receipt, "2".repeat(64), release]);
    insert("q:new", "quarantine", null);
    expect(f.db.query("SELECT count(*) AS n FROM reply_admissions").get()).toEqual({ n: 0 });
    expect(await f.ingress(await f.signedReply())).toContain("quarantined");
    expect(() => insert("r:wrong", "release", "q:absent", "3".repeat(64))).toThrow("lineage");
    expect(() => insert("r:same", "release", "q:new")).toThrow("lineage");
    insert("r:new", "release", "q:new", "3".repeat(64));
    expect(() => insert("r:twice", "release", "q:new", "4".repeat(64))).toThrow();
    expect(f.db.query("SELECT * FROM active_route_reply_quarantines").all()).toEqual([]);
    await f.admitCanary();
    expect(await f.ingress(await f.signedReply())).toBeUndefined();
    await f.consume();
    expect(f.sends).toHaveLength(1);
    expect(() => f.db.run("DELETE FROM route_reply_containment_events")).toThrow("append-only");
  } finally { f.db.close(); }
});

test("ordinary foreign keys, digest/shape constraints, immutable claims and revocation are enforced by SQLite", async () => {
  const f = await relayRuntime();
  try {
    await activateFixture(f);
    await f.ingress(await f.signedReply());
    expect(() => f.db.run("UPDATE ordinary_reply_admissions SET claimed_attempt_sha256=?", ["f".repeat(64)])).toThrow("immutable");
    expect(() => f.db.run("UPDATE ordinary_reply_admissions SET status='sending'")).toThrow("CHECK");
    expect(() => f.db.run("UPDATE route_reply_authorizations SET status='revoked',revoked_at=CURRENT_TIMESTAMP,revocation_receipt_sha256=?", ["z".repeat(64)])).toThrow("CHECK");
    f.db.run("UPDATE route_reply_authorizations SET status='revoked',revoked_at=CURRENT_TIMESTAMP,revocation_receipt_sha256=?", ["f".repeat(64)]);
    expect(() => f.db.run("UPDATE route_reply_authorizations SET status='active',revoked_at=NULL,revocation_receipt_sha256=NULL")).toThrow("terminal");
    await f.consume(f.jobs.at(-1));
    expect(f.sends).toHaveLength(1);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { f.db.close(); }
});

for (const state of ["admitted", "claimed", "sending", "provider_accepted", "failed", "expired", "superseded", "revoked", "quarantined", "recovery_required"] as const) {
  test(`populated 0012 ${state} records retain identity and safe Queue meaning after upgrade`, async () => {
    const f = await relayRuntime(12);
    try {
      let job: InboxReplyReceivedJob | undefined;
      if (state === "admitted") await f.admitCanary();
      else {
        job = await baselineClaim(f, state === "provider_accepted");
        if (state === "sending") f.db.run("UPDATE reply_admissions SET status='sending',provider_boundary_at=CURRENT_TIMESTAMP");
        if (["failed", "recovery_required"].includes(state)) {
          f.db.run("UPDATE reply_admissions SET status=?,terminal_at=CURRENT_TIMESTAMP", [state]);
          f.db.run("UPDATE relay_attempts SET status=?", [state]);
        }
        if (state === "expired") f.db.run("UPDATE reply_admissions SET status='expired',admitted_at='2020-01-01T00:00:00Z',expires_at='2020-01-01T00:10:00Z'");
        if (state === "superseded" || state === "revoked") {
          f.db.run("UPDATE reply_admissions SET status=?,revoked_at=CURRENT_TIMESTAMP", [state]);
          f.db.run("UPDATE reply_relays SET revoked_at=CURRENT_TIMESTAMP,revocation_reason='controller_recovery'");
        }
        if (state === "quarantined") f.db.run(`INSERT INTO route_outbound_quarantines
          (id,route_id,relay_id,reply_admission_id,controller_transaction_sha256,action,reason,containment_plan_sha256,quarantined_at)
          VALUES ('q:upgrade','route:example.com:support','relay:one','admission:one',?,'quarantine','controller_recovery',?,CURRENT_TIMESTAMP)`, ["1".repeat(64),"2".repeat(64)]);
      }
      const admissionBefore = f.db.query("SELECT * FROM reply_admissions").all();
      const relayBefore = f.db.query("SELECT * FROM reply_relays").all();
      const containmentBefore = f.db.query("SELECT * FROM route_outbound_quarantines").all();
      const attemptColumns = (f.db.query("PRAGMA table_info(relay_attempts)").all() as Array<{name:string}>).map((row) => row.name).join(",");
      const attemptsBefore = f.db.query(`SELECT ${attemptColumns} FROM relay_attempts`).all();
      const evidenceDir = process.env.MAILDESK_TEST_EVIDENCE_DIR;
      if (evidenceDir) await Bun.write(`${evidenceDir}/upgrade-${state}-before.sqlite`, f.db.serialize());
      migrate(f.db,12);
      expect(f.db.query("SELECT * FROM reply_admissions").all()).toEqual(admissionBefore);
      expect(f.db.query("SELECT * FROM reply_relays").all()).toEqual(relayBefore);
      expect(f.db.query("SELECT * FROM route_outbound_quarantines").all()).toEqual(containmentBefore);
      expect(f.db.query(`SELECT ${attemptColumns} FROM relay_attempts`).all()).toEqual(attemptsBefore);
      expect(f.db.query("SELECT count(*) AS n FROM route_reply_authorizations").get()).toEqual({n:0});
      expect(f.db.query("SELECT count(*) AS n FROM ordinary_reply_admissions").get()).toEqual({n:0});
      expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      if (job) { await f.consume(job); await f.consume(job); }
      else { expect(await f.ingress(await f.signedReply())).toBeUndefined(); await f.consume(); }
      expect(f.sends).toHaveLength(state === "admitted" || state === "claimed" ? 1 : 0);
      if (state === "sending") expect(f.db.query("SELECT status FROM reply_admissions").get()).toEqual({status:"sending"});
      if (state === "provider_accepted") expect(f.db.query("SELECT status FROM relay_attempts").get()).toEqual({status:"provider_accepted"});
      if (state === "admitted" || state === "claimed") expect(f.spools.size).toBe(0);
      expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      if (evidenceDir) await Bun.write(`${evidenceDir}/upgrade-${state}-after.sqlite`, f.db.serialize());
    } finally {f.db.close();}
  });
}

test("the supported rollback posture holds both old and ordinary queued work without erasing history", async () => {
  const f = await relayRuntime(12);
  try {
    const oldJob = await baselineClaim(f);
    migrate(f.db,12);
    f.env.MAILDESK_REPLY_RELAY_MODE = "disabled";
    await f.consume(oldJob);
    expect(f.sends).toHaveLength(0);
    expect(f.db.query("SELECT count(*) AS n FROM reply_admissions").get()).toEqual({n:1});
    expect(f.db.query("SELECT count(*) AS n FROM relay_attempts").get()).toEqual({n:1});
  } finally {f.db.close();}
  const f2 = await relayRuntime();
  try {
    await activateFixture(f2); await f2.ingress(await f2.signedReply());
    f2.env.MAILDESK_ORDINARY_REPLY_MODE = "disabled";
    f2.env.MAILDESK_REPLY_RELAY_MODE = "disabled";
    await f2.consume(f2.jobs.at(-1));
    expect(f2.sends).toHaveLength(1);
    expect(f2.db.query("SELECT count(*) AS n FROM ordinary_reply_admissions").get()).toEqual({n:1});
    expect(f2.db.query("SELECT status FROM reply_admissions").get()).toEqual({status:"provider_accepted"});
    expect(f2.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {f2.db.close();}
});
