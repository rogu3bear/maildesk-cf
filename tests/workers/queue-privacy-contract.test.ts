import { expect, test } from "bun:test";
import { relayRuntime, testPolicy } from "../helpers/relay-runtime";
import { outboundOpaqueTokenFailure, outboundPrivacyFailure } from "../../workers/shared/outbound/privacy";
import { decodeMailJob } from "../../workers/shared/job-codec";
import { processQueueBatch } from "../../workers/shared/outbound/queue";
import { resendRequestBody } from "../../workers/shared/outbound/provider";
import { sha256Hex } from "../../workers/shared/inbox-relay";
import type { MailJob, OutboundReplyRequestedJob } from "../../workers/shared/contracts";

const job = (): OutboundReplyRequestedJob => ({ kind: "outbound_reply_requested", messageId: "fixture-resend-id", threadId: "thread:one", operator: "operator@example.com",
  envelopeTo: "support@example.com", fromIdentity: "support@example.com", to: ["sender@example.net"], subject: "Reply", text: "Authored text", queuedAt: new Date().toISOString() });

test("closed job variants never infer ordinary authority or persist unknown fields", async () => {
  const f = await relayRuntime();
  try {
    await f.admitCanary(); await f.ingress(await f.signedReply());
    const original = f.jobs[0]!;
    expect(decodeMailJob(original)).not.toBeNull();
    for (const changes of [{ schemaVersion: 3 }, { admissionKind: "future" }, { admissionKind: "ordinary" },
      { payloadVersion: 3 }, { rawSha256: "invalid" }, { secret_body: "private payload" }]) {
      expect(decodeMailJob({ ...original, ...changes })).toBeNull();
    }
    expect(decodeMailJob({ kind: "unrecognized", text: "private" })).toBeNull();
    expect(decodeMailJob(job())).not.toBeNull();
  } finally { f.db.close(); }
});

test("privacy protects canonical unused operators, encoded tokens and outward metadata without banning unrelated hashes", async () => {
  const f = await relayRuntime();
  try {
    const input = job();
    for (const text of [f.relayRecipient, `https://example.net/?relay=${"a".repeat(62)}`, `https://example.net/?relay=${"%61".repeat(62)}`]) {
      const outward = { ...input, text };
      expect(outboundPrivacyFailure(outward, testPolicy) ?? await outboundOpaqueTokenFailure(outward, f.env)).not.toBeNull();
    }
    expect(await outboundOpaqueTokenFailure({ ...input, subject: "a".repeat(62) }, f.env)).not.toBeNull();
    expect(await outboundOpaqueTokenFailure({ ...input, headers: { "In-Reply-To": `<${"a".repeat(62)}@example.net>` } }, f.env)).not.toBeNull();
    expect(await outboundOpaqueTokenFailure({ ...input, text: `Public digest ${"f".repeat(64)}` }, f.env)).toBeNull();
    const policy = structuredClone(testPolicy);
    policy.policy_version = 2; policy.accountables = { "team:unused": { kind: "team" } };
    policy.destinations = { "mailbox:unused": { accountable_ref: "team:unused", target: { kind: "mailbox", recipients: ["hidden@example.org"] } } };
    expect(outboundPrivacyFailure({ ...input, text: "hidden&#64;example.org" }, policy)).toContain("private operator");
  } finally { f.db.close(); }
});

test("real pipeline refuses opaque-token leakage before any provider call", async () => {
  const f = await relayRuntime();
  try {
    await f.admitCanary();
    await f.ingress(await f.signedReply(undefined, `Please see https://example.net/?token=${"a".repeat(62)}\r\n`));
    await f.consume();
    expect(f.sends).toHaveLength(0);
    expect(f.db.query("SELECT status FROM reply_admissions").get()).toEqual({ status: "failed" });
    expect(JSON.stringify(f.db.query("SELECT detail_json FROM audit_events").all())).not.toContain("a".repeat(62));
  } finally { f.db.close(); }
});

test("Resend recovery requires the original provider, request digest and unexpired bounded idempotency window", async () => {
  for (const scenario of ["matching", "expired", "missing_time", "changed_payload", "changed_provider"] as const) {
    const f = await relayRuntime(); const prior = globalThis.fetch; let calls = 0;
    try {
      const original = job();
      const detail = { outboundMode: scenario === "changed_provider" ? "cloudflare_email_service" : "resend",
        claimObservedAt: scenario === "missing_time" ? undefined : new Date(Date.now() - (scenario === "expired" ? 24 * 3_600_000 : 1000)).toISOString(),
        resendRequestSha256: await sha256Hex(resendRequestBody(original)) };
      f.db.run("INSERT INTO audit_events(id,dedupe_key,thread_id,actor,action,detail_json) VALUES ('seed',?,'thread:one','system','outbound_reply_requested',?)", [`${original.messageId}:outbound_reply_requested`,JSON.stringify(detail)]);
      f.env.MAILDESK_OPERATOR_DELIVERY_MODE = "web_desk"; f.env.MAILDESK_OUTBOUND_MODE = "resend"; f.env.RESEND_API_KEY = "offline-fixture";
      globalThis.fetch = async (_url, init) => { calls++; expect(new Headers(init?.headers).get("idempotency-key")).toBe(original.messageId); return Response.json({ id: "fixture-accepted" }); };
      if (scenario === "changed_payload") original.text = "Changed payload";
      await processQueueBatch({ messages: [{ body: original, attempts: 2, ack() {}, retry() {} }] } as unknown as MessageBatch<MailJob>, f.env);
      expect(calls).toBe(scenario === "matching" ? 1 : 0);
      const event = f.db.query("SELECT action FROM audit_events WHERE dedupe_key=?").get(`${original.messageId}:outbound_reply_result`) as { action: string };
      expect(event.action).toBe(scenario === "matching" ? "outbound_reply_delivered" : "outbound_reply_recovery_required");
    } finally { globalThis.fetch = prior; f.db.close(); }
  }
});
