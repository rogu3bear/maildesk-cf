import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relayRuntime, testPolicy } from "../helpers/relay-runtime";
import { claimWebDeskProvider } from "../../workers/shared/outbound/webdesk-claim";
import { routeInbound } from "../../workers/shared/router";
import type { OutboundReplyRequestedJob } from "../../workers/shared/contracts";

const job: OutboundReplyRequestedJob = { kind: "outbound_reply_requested", messageId: "message:1", threadId: "thread:one",
  operator: "operator@example.com", envelopeTo: "support@example.com", fromIdentity: "support@example.com",
  to: ["sender@example.net"], subject: "Subject", text: "Body", queuedAt: "2026-01-01T00:00:00Z" };

test("web-desk send claim is policy-bound, target-bound and single-use for Cloudflare", async () => {
  const f = await relayRuntime();
  try {
    const routed = routeInbound(testPolicy, { envelopeTo: job.envelopeTo, headerFrom: "sender@example.net" });
    if (!routed.ok) throw new Error("route missing");
    const claim = (j = job, route = routed.value, sha = f.policySha) => claimWebDeskProvider(f.env, j, route, sha, "cloudflare_email_service");
    expect(await claim({ ...job, to: ["other@example.net"] })).toBe(false);
    expect(await claim(job, { ...routed.value, deliveryOnly: true })).toBe(false);
    expect(await claim(job, routed.value, "0".repeat(64))).toBe(false);
    expect(await claim()).toBe(true);
    expect(await claim()).toBe(false);
    expect(() => f.db.run("DELETE FROM webdesk_provider_claims")).toThrow();
    expect(() => f.db.run("UPDATE webdesk_provider_claims SET request_sha256=?", ["0".repeat(64)])).toThrow();
  } finally { f.db.close(); }
});

test("Resend may resume only the same request while the same route remains active", async () => {
  const f = await relayRuntime();
  try {
    const routed = routeInbound(testPolicy, { envelopeTo: job.envelopeTo, headerFrom: "sender@example.net" });
    if (!routed.ok) throw new Error("route missing");
    const claim = (j = job) => claimWebDeskProvider(f.env, j, routed.value, f.policySha, "resend");
    expect(await claim()).toBe(true);
    expect(await claim({ ...job, text: "changed" })).toBe(false);
    expect(await claim()).toBe(true);
    f.db.run("UPDATE alias_routes SET enabled=0 WHERE id='route:example.com:support'");
    expect(await claim()).toBe(false);
  } finally { f.db.close(); }
});

test("web-desk provider sends only after a live policy and atomic claim", async () => {
  const { sendOutboundReply } = await import("../../workers/shared/outbound/provider");
  const f = await relayRuntime();
  try {
    f.env.MAILDESK_OPERATOR_DELIVERY_MODE = "web_desk";
    const first = await sendOutboundReply(job, f.env, 1);
    expect(first.ok).toBe(true); expect(f.sends).toHaveLength(1);
    const duplicate = await sendOutboundReply(job, f.env, 1);
    expect(duplicate.notClaimed).toBe(true); expect(f.sends).toHaveLength(1);
  } finally { f.db.close(); }
});

test("lost claim acknowledgement never sends or silently becomes a fresh claim", async () => {
  const { sendOutboundReply } = await import("../../workers/shared/outbound/provider");
  const f = await relayRuntime();
  try {
    f.env.MAILDESK_OPERATOR_DELIVERY_MODE = "web_desk";
    let lost = false;
    f.d1.after = (sql) => { if (!lost && sql.startsWith("INSERT INTO webdesk_provider_claims")) { lost = true; throw new Error("claim acknowledgement lost"); } };
    await expect(sendOutboundReply(job, f.env, 1)).rejects.toThrow();
    expect(f.sends).toHaveLength(0);
    expect(f.db.query("SELECT count(*) AS n FROM webdesk_provider_claims").get()).toEqual({ n: 1 });
    f.d1.after = undefined;
    expect((await sendOutboundReply(job, f.env, 2)).notClaimed).toBe(true);
    expect(f.sends).toHaveLength(0);
  } finally { f.db.close(); }
});

test("a route change between policy read and provider claim prevents the send", async () => {
  const { sendOutboundReply } = await import("../../workers/shared/outbound/provider");
  const f = await relayRuntime();
  try {
    f.env.MAILDESK_OPERATOR_DELIVERY_MODE = "web_desk";
    f.d1.before = (sql) => { if (sql.startsWith("INSERT INTO webdesk_provider_claims")) f.db.run("UPDATE alias_routes SET enabled=0 WHERE id='route:example.com:support'"); };
    const result = await sendOutboundReply(job, f.env, 1);
    expect(result.ok).toBe(false); expect(result.error).toContain("binding changed");
    expect(f.sends).toHaveLength(0);
    expect(f.db.query("SELECT count(*) AS n FROM webdesk_provider_claims").get()).toEqual({ n: 0 });
  } finally { f.db.close(); }
});

test("a legacy thread cannot send after its route becomes delivery-only", async () => {
  const { sendOutboundReply } = await import("../../workers/shared/outbound/provider");
  const { projectRoutes, projectionSql } = await import("../../scripts/sync-route-policy");
  const { sha256Hex } = await import("../../workers/shared/inbox-relay");
  const f = await relayRuntime();
  try {
    const rustSource = readFileSync(new URL("../../src/server/desk.rs", import.meta.url), "utf8");
    const sql = rustSource.match(/const WEBDESK_REPLY_BINDING_SQL: &str = "([^"]+)";/)?.[1];
    if (!sql) throw new Error("web-desk binding SQL not found");
    const earlyCheck = f.db.query(sql);
    expect(earlyCheck.get(job.threadId, job.operator, job.fromIdentity)).toEqual({ allowed: 1 });
    const policy = { policy_version: 3 as const, default_reply_mode: "personal_first" as const, domains: { "example.com": {
      role_aliases: { support: { operators: ["operator@example.com", "second@example.com"], reply_identity: "support@example.com", delivery_only: true } }, personal_aliases: {},
    } } };
    const json = JSON.stringify(policy), bytes = new TextEncoder().encode(json), sha = await sha256Hex(bytes);
    const desired = { storage: { d1_database: "fixture" }, domains: [{ name: "example.com", inbound_mx_provider: "cloudflare_email_routing" as const, role_aliases: ["support"], personal_aliases: [] }] };
    f.db.exec(projectionSql(projectRoutes(policy, desired), sha, `config/policy/${sha}.json`, "b".repeat(64)).sql);
    f.env.POLICY_STORE = { get: async () => ({ arrayBuffer: async () => bytes.buffer }) } as unknown as R2Bucket;
    f.env.MAILDESK_OPERATOR_DELIVERY_MODE = "web_desk";
    expect(f.db.query("SELECT count(*) AS n FROM alias_route_reply_identities WHERE route_id='route:example.com:support'").get()).toEqual({ n: 0 });
    expect(earlyCheck.get(job.threadId, job.operator, job.fromIdentity)).toBeNull();
    const result = await sendOutboundReply(job, f.env, 1);
    expect(result.ok).toBe(false); expect(result.error).toContain("not authorized");
    expect(f.sends).toHaveLength(0);
    expect(f.db.query("SELECT count(*) AS n FROM webdesk_provider_claims").get()).toEqual({ n: 0 });
  } finally { f.db.close(); }
});

test("queue redelivery retains an uncertain web-desk claim without sending or inventing a result", async () => {
  const { processQueueBatch } = await import("../../workers/shared/outbound/queue");
  const f = await relayRuntime();
  try {
    f.env.MAILDESK_OPERATOR_DELIVERY_MODE = "web_desk";
    let lost = false, acknowledgements = 0, retries = 0;
    f.d1.after = (sql) => { if (!lost && sql.startsWith("INSERT INTO webdesk_provider_claims")) { lost = true; throw new Error("claim acknowledgement lost"); } };
    const batch = (attempts: number) => ({ messages: [{ body: job, attempts, ack() { acknowledgements++; }, retry() { retries++; } }] }) as unknown as MessageBatch<import("../../workers/shared/contracts").MailJob>;
    await expect(processQueueBatch(batch(1), f.env)).rejects.toThrow();
    expect(acknowledgements).toBe(0); expect(f.sends).toHaveLength(0);
    const originalClaim = f.db.query("SELECT * FROM webdesk_provider_claims").get();
    f.d1.after = undefined;
    await processQueueBatch(batch(2), f.env);
    expect(acknowledgements).toBe(1); expect(retries).toBe(0); expect(f.sends).toHaveLength(0);
    expect(f.db.query("SELECT count(*) AS n FROM webdesk_provider_claims").get()).toEqual({ n: 1 });
    expect(f.db.query("SELECT * FROM webdesk_provider_claims").get()).toEqual(originalClaim);
    expect(f.db.query("SELECT action FROM audit_events WHERE dedupe_key=?").get(`${job.messageId}:outbound_reply_result`)).toBeNull();
    expect(f.db.query("SELECT action FROM audit_events WHERE action='outbound_reply_duplicate_suppressed'").get()).toEqual({ action: "outbound_reply_duplicate_suppressed" });
  } finally { f.db.close(); }
});
