import { expect, test } from "bun:test";
import { relayRuntime } from "../helpers/relay-runtime";
import { processQueueBatch } from "../../workers/shared/outbound/queue";
import type { MailJob, OutboundReplyRequestedJob } from "../../workers/shared/contracts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const webDeskJob: OutboundReplyRequestedJob = {
  kind: "outbound_reply_requested", messageId: "message:duplicate", threadId: "thread:one",
  operator: "operator@example.com", envelopeTo: "support@example.com", fromIdentity: "support@example.com",
  to: ["sender@example.net"], subject: "Subject", text: "Body", queuedAt: "2026-01-01T00:00:00Z",
};

for (const outcome of ["accepted", "ambiguous"] as const) for (const duplicateMode of ["web_desk", "invalid"] as const) {
  test(`a web-desk duplicate leaves the in-flight result to its sender: ${outcome}, ${duplicateMode}`, async () => {
    const f = await relayRuntime();
    const entered = gate(), proceed = gate();
    let winner: ReturnType<typeof f.consume> | undefined;
    try {
      f.env.MAILDESK_OPERATOR_DELIVERY_MODE = "web_desk";
      f.faults.beforeProviderResult = async () => { entered.release(); await proceed.promise; };
      f.faults.providerAfter = outcome === "ambiguous";
      winner = f.consume(webDeskJob);
      await entered.promise;
      let acked = 0, retries = 0;
      await processQueueBatch({ messages: [{ body: webDeskJob, attempts: 1,
        ack() { acked++; }, retry() { retries++; } }] } as unknown as MessageBatch<MailJob>,
        { ...f.env, MAILDESK_OPERATOR_DELIVERY_MODE: duplicateMode });
      expect({ acked, retries }).toEqual({ acked: 1, retries: 0 });
      expect(f.db.query("SELECT action FROM audit_events WHERE dedupe_key=?").get(`${webDeskJob.messageId}:outbound_reply_result`)).toBeNull();
      expect(f.sends).toHaveLength(1);
      proceed.release();
      expect(await winner).toEqual({ acked: 1, retries: 0 });
      await f.consume(webDeskJob);
      expect(f.sends).toHaveLength(1);
      expect(f.db.query("SELECT action FROM audit_events WHERE dedupe_key=?").get(`${webDeskJob.messageId}:outbound_reply_result`))
        .toEqual({ action: outcome === "accepted" ? "outbound_reply_delivered" : "outbound_reply_recovery_required" });
    } finally {
      proceed.release();
      if (winner) await Promise.allSettled([winner]);
      f.db.close();
    }
  });
}

for (const durableTerminal of [false, true]) {
  test(`a legacy unknown remains unchanged without replay: terminal evidence ${durableTerminal}`, async () => {
    const f = await relayRuntime();
    try {
      f.env.MAILDESK_OPERATOR_DELIVERY_MODE = "web_desk";
      const records = [
        { id: "legacy:claim", suffix: "outbound_reply_requested", action: "outbound_reply_requested", detail: { outboundMode: "cloudflare_email_service" } },
        { id: "legacy:attempt", suffix: "outbound_reply_send_attempted:1", action: "outbound_reply_send_attempted", detail: { provider: "cloudflare_email_service", attempt: 1 } },
        ...(durableTerminal ? [{ id: "legacy:unknown", suffix: "outbound_reply_result", action: "outbound_reply_recovery_required",
          detail: { outcome: "recovery_required", result: { ok: false, provider: "cloudflare_email_service", ambiguous: true, error: "legacy_unknown" } } }] : []),
      ];
      for (const row of records) f.db.run("INSERT INTO audit_events(id,dedupe_key,thread_id,actor,action,detail_json) VALUES(?,?,'thread:one','system',?,?)",
        [row.id, `${webDeskJob.messageId}:${row.suffix}`, row.action, JSON.stringify(row.detail)]);
      const original = f.db.query("SELECT * FROM audit_events WHERE id LIKE 'legacy:%' ORDER BY id").all();
      await f.consume(webDeskJob);
      await f.consume(webDeskJob);
      expect(f.sends).toHaveLength(0);
      expect(f.db.query("SELECT * FROM audit_events WHERE id LIKE 'legacy:%' ORDER BY id").all()).toEqual(original);
      expect(f.db.query("SELECT id FROM audit_events WHERE dedupe_key=?").get(`${webDeskJob.messageId}:outbound_reply_result`))
        .toEqual(durableTerminal ? { id: "legacy:unknown" } : null);
      expect(f.db.query("SELECT action FROM audit_events WHERE action='outbound_reply_duplicate_suppressed'").all())
        .toEqual([{ action: "outbound_reply_duplicate_suppressed" }]);
    } finally { f.db.close(); }
  });
}

for (const outcome of ["accepted", "ambiguous", "lost_terminal_audit"] as const) {
  test(`an in-flight duplicate cannot reserve the winner's terminal result: ${outcome}`, async () => {
    const f = await relayRuntime();
    const firstSpoolReached = gate(), duplicateReady = gate(), duplicateProceed = gate(), providerEntered = gate(), providerProceed = gate();
    const consumers: Array<ReturnType<typeof f.consume>> = [];
    try {
      await f.admitCanary();
      await f.ingress(await f.signedReply());
      let reads = 0;
      let duplicatePreBoundaryState: unknown;
      f.faults.beforeSpoolRead = async () => {
        if (++reads === 1) {
          firstSpoolReached.release();
          await duplicateReady.promise;
        }
        else if (reads === 2) {
          duplicatePreBoundaryState = f.db.query("SELECT status FROM reply_admissions").get();
          duplicateReady.release();
          await duplicateProceed.promise;
        }
      };
      f.faults.beforeProviderResult = async () => {
        providerEntered.release();
        await providerProceed.promise;
      };
      f.faults.providerAfter = outcome === "ambiguous";
      if (outcome === "lost_terminal_audit") f.d1.before = (sql, values) => {
        if (sql.startsWith("INSERT OR IGNORE INTO audit_events") && values[4] === "outbound_reply_delivered") {
          f.d1.before = undefined;
          throw new Error("terminal evidence write lost");
        }
      };
      const winner = f.consume();
      consumers.push(winner);
      await Promise.race([firstSpoolReached.promise, winner.then(() => { throw new Error("first consumer did not reach the spool"); })]);
      const duplicate = f.consume();
      consumers.push(duplicate);
      // Observe rejections immediately, including the intentional lost audit.
      const settled = Promise.allSettled(consumers);
      await Promise.race([providerEntered.promise, winner.then(() => { throw new Error("sender did not reach the provider"); })]);
      expect(duplicatePreBoundaryState).toEqual({ status: "claimed" });
      expect(f.db.query("SELECT status FROM reply_admissions").get()).toEqual({ status: "sending" });
      expect(f.sends).toHaveLength(1);
      duplicateProceed.release();
      expect(await duplicate).toEqual({ acked: 1, retries: 0 });
      expect(f.db.query("SELECT action FROM audit_events WHERE dedupe_key LIKE '%:outbound_reply_result'").all()).toEqual([]);
      expect(f.db.query("SELECT status FROM reply_admissions").get()).toEqual({ status: "sending" });
      providerProceed.release();
      const results = await settled;
      expect(results[0]?.status).toBe(outcome === "lost_terminal_audit" ? "rejected" : "fulfilled");
      expect(results[1]?.status).toBe("fulfilled");
      await f.consume();
      expect(f.sends).toHaveLength(1);
      const status = outcome === "accepted" ? "provider_accepted" : outcome === "ambiguous" ? "recovery_required" : "sending";
      expect(f.db.query("SELECT status FROM reply_admissions").get()).toEqual({ status });
      expect(f.spools.size).toBe(outcome === "accepted" ? 0 : 1);
      const terminal = f.db.query("SELECT action FROM audit_events WHERE dedupe_key LIKE '%:outbound_reply_result'").all();
      expect(terminal).toEqual(outcome === "lost_terminal_audit" ? [] : [{ action: outcome === "accepted" ? "outbound_reply_delivered" : "outbound_reply_recovery_required" }]);
    } finally {
      firstSpoolReached.release(); duplicateReady.release(); duplicateProceed.release(); providerEntered.release(); providerProceed.release();
      await Promise.allSettled(consumers);
      f.db.close();
    }
  });
}
