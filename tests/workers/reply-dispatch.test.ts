import { expect, test } from "bun:test";
import { relayRuntime } from "../helpers/relay-runtime";
import { recoverKnownUnsentDispatch } from "../../workers/shared/reply-recovery";

test("failed Queue submission resumes the original immutable canary claim on exact redelivery", async () => {
  const f = await relayRuntime();
  try {
    await f.admitCanary();
    const raw = await f.signedReply();
    f.faults.queueBefore = true;
    expect(await f.ingress(raw)).toContain("dispatch recovery");
    expect(f.jobs).toHaveLength(0);
    expect(f.spools.size).toBe(1);
    expect(f.db.query("SELECT status FROM reply_admissions").get()).toEqual({ status: "claimed" });
    f.faults.queueBefore = false;
    expect(await f.ingress(raw)).toBeUndefined();
    expect(f.jobs).toHaveLength(1);
    expect(f.db.query("SELECT count(*) AS n FROM relay_attempts").get()).toEqual({ n: 1 });
    expect(await f.consume()).toEqual({ acked: 1, retries: 0 });
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]?.text).toBe("A plain reply.\n\n-- \nExample Support\nexample.com");
    expect(f.spools.size).toBe(0);
  } finally { f.db.close(); }
});

test("policy or operator changes at the atomic claim leave neither a partial claim nor an attempt", async () => {
  for (const change of [
    (f: Awaited<ReturnType<typeof relayRuntime>>) => f.db.run("DELETE FROM alias_route_operators"),
    (f: Awaited<ReturnType<typeof relayRuntime>>) => f.db.run("UPDATE policy_projection_state SET value = ? WHERE key = 'active_desired_state_sha256'", ["e".repeat(64)]),
  ]) {
    const f = await relayRuntime();
    try {
      await f.admitCanary();
      f.d1.before = (sql) => { if (sql.startsWith("INSERT INTO relay_attempts")) { f.d1.before = undefined; change(f); } };
      expect(await f.ingress(await f.signedReply())).toBeDefined();
      expect(f.db.query("SELECT count(*) AS n FROM relay_attempts").get()).toEqual({ n: 0 });
      expect(f.db.query("SELECT status, claimed_attempt_id FROM reply_admissions").get()).toEqual({ status: "admitted", claimed_attempt_id: null });
      expect(f.jobs).toHaveLength(0);
      expect(f.sends).toHaveLength(0);
      expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { f.db.close(); }
  }
});

test("removing another operator at the canary claim does not consume authority or leave a dispatch", async () => {
  const f = await relayRuntime();
  try {
    await f.admitCanary();
    f.d1.before = (sql) => {
      if (!sql.startsWith("INSERT INTO relay_attempts")) return;
      f.d1.before = undefined;
      f.db.run("DELETE FROM alias_route_operators WHERE operator_id = 'operator:second%40example.com'");
    };
    expect(await f.ingress(await f.signedReply())).toBeDefined();
    expect(f.db.query("SELECT count(*) AS n FROM relay_attempts").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT status, claimed_attempt_id FROM reply_admissions").get())
      .toEqual({ status: "admitted", claimed_attempt_id: null });
    expect(f.jobs).toHaveLength(0);
    expect(f.sends).toHaveLength(0);
    expect(f.spools.size).toBe(0);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { f.db.close(); }
});

test("recovery accepts a durable claim ID only and never a caller payload or spool path", async () => {
  const f = await relayRuntime();
  try {
    expect(await recoverKnownUnsentDispatch("relay-spool/attacker.eml", f.env)).toMatchObject({ state: "blocked", reason: "invalid_claim_id" });
    expect(f.jobs).toHaveLength(0);
  } finally { f.db.close(); }
});

test("Queue acceptance with lost acknowledgement may enqueue twice but never sends twice", async () => {
  const f = await relayRuntime();
  try {
    await f.admitCanary();
    const raw = await f.signedReply();
    f.faults.queueAfter = true;
    expect(await f.ingress(raw)).toBeDefined();
    f.faults.queueAfter = false;
    expect(await f.ingress(raw)).toBeUndefined();
    expect(f.jobs).toHaveLength(2);
    expect(f.jobs[0]).toEqual(f.jobs[1]);
    await f.consume(f.jobs[0]);
    await f.consume(f.jobs[1]);
    expect(f.sends).toHaveLength(1);
    expect(f.db.query("SELECT status FROM relay_attempts").get()).toEqual({ status: "provider_accepted" });
  } finally { f.db.close(); }
});

test("crashes after spool and after atomic claim preserve exact recovery state", async () => {
  for (const stage of ["spool", "claim"] as const) {
    const f = await relayRuntime();
    try {
      await f.admitCanary();
      const raw = await f.signedReply();
      if (stage === "spool") f.d1.before = (sql) => {
        if (sql.startsWith("INSERT INTO relay_attempts")) { f.d1.before = undefined; throw new Error("before claim"); }
      };
      else f.d1.after = (sql) => {
        if (sql.startsWith("INSERT INTO relay_attempts")) { f.d1.after = undefined; throw new Error("claim acknowledgement lost"); }
      };
      await f.ingress(raw);
      expect(f.spools.size).toBe(1);
      expect(f.db.query("SELECT count(*) AS n FROM relay_attempts").get()).toEqual({ n: stage === "claim" ? 1 : 0 });
      await f.ingress(raw);
      for (const job of f.jobs) await f.consume(job);
      expect(f.sends).toHaveLength(1);
      expect(f.db.query("SELECT count(*) AS n FROM relay_attempts").get()).toEqual({ n: 1 });
    } finally { f.db.close(); }
  }
});

test("after the provider boundary an unknown Cloudflare outcome never automatically replays", async () => {
  for (const stage of ["boundary", "acceptance"] as const) {
    const f = await relayRuntime();
    try {
      await f.admitCanary();
      await f.ingress(await f.signedReply());
      if (stage === "boundary") f.d1.after = (sql) => {
        if (sql.startsWith("UPDATE reply_admissions SET status = 'sending'")) { f.d1.after = undefined; throw new Error("boundary acknowledgement lost"); }
      };
      else f.faults.providerAfter = true;
      try { await f.consume(); } catch { /* Queue retains the unacknowledged delivery. */ }
      await f.consume();
      expect(f.sends).toHaveLength(stage === "boundary" ? 0 : 1);
      expect(f.db.query("SELECT status FROM reply_admissions").get()).toEqual({ status: stage === "boundary" ? "sending" : "recovery_required" });
      expect(f.spools.size).toBe(1);
    } finally { f.db.close(); }
  }
});

test("terminal projection and spool cleanup resume from accepted evidence without a provider call", async () => {
  for (const stage of ["terminal", "cleanup"] as const) {
    const f = await relayRuntime();
    try {
      await f.admitCanary();
      await f.ingress(await f.signedReply());
      if (stage === "terminal") f.d1.before = (sql) => {
        if (sql.startsWith("UPDATE relay_attempts SET status = ?1")) { f.d1.before = undefined; throw new Error("terminal projection unavailable"); }
      };
      else f.faults.cleanup = true;
      await expect(f.consume()).rejects.toThrow();
      expect(f.sends).toHaveLength(1);
      expect(f.spools.size).toBe(1);
      f.faults.cleanup = false;
      await f.consume();
      expect(f.sends).toHaveLength(1);
      expect(f.spools.size).toBe(0);
      expect(f.db.query("SELECT status, raw_r2_key FROM relay_attempts").get()).toEqual({ status: "provider_accepted", raw_r2_key: null });
    } finally { f.db.close(); }
  }
});

test("a spool write failure creates neither authorization claim nor dispatch", async () => {
  const f = await relayRuntime();
  try {
    await f.admitCanary(); f.faults.spoolWrite = true;
    expect(await f.ingress(await f.signedReply())).toBeDefined();
    expect(f.spools.size).toBe(0); expect(f.jobs).toHaveLength(0); expect(f.sends).toHaveLength(0);
    expect(f.db.query("SELECT status FROM reply_admissions").get()).toEqual({ status: "admitted" });
    expect(f.db.query("SELECT count(*) AS n FROM relay_attempts").get()).toEqual({ n: 0 });
  } finally { f.db.close(); }
});

test("accepted provider call with lost terminal audit stays unknown and never automatically sends again", async () => {
  const f = await relayRuntime();
  try {
    await f.admitCanary(); await f.ingress(await f.signedReply());
    f.d1.before = (sql, values) => {
      if (sql.startsWith("INSERT OR IGNORE INTO audit_events") && values[4] === "outbound_reply_delivered") {
        f.d1.before = undefined; throw new Error("terminal evidence write lost");
      }
    };
    await expect(f.consume()).rejects.toThrow("terminal evidence");
    await f.consume();
    expect(f.sends).toHaveLength(1); expect(f.spools.size).toBe(1);
    expect(f.db.query("SELECT status FROM reply_admissions").get()).toEqual({ status: "sending" });
    expect(f.db.query("SELECT json_extract(projection_json,'$.unknown_provider_attempts') AS n FROM route_status_projection").get()).toEqual({ n: 1 });
  } finally { f.db.close(); }
});

test("competing Queue consumers can claim only one non-idempotent provider boundary", async () => {
  const f = await relayRuntime();
  try {
    await f.admitCanary(); await f.ingress(await f.signedReply());
    await Promise.allSettled([f.consume(), f.consume()]);
    await f.consume();
    expect(f.sends).toHaveLength(1);
    expect(f.db.query("SELECT status FROM reply_admissions").get()).toEqual({ status: "provider_accepted" });
    expect(f.db.query("SELECT status FROM relay_attempts").get()).toEqual({ status: "provider_accepted" });
  } finally { f.db.close(); }
});
