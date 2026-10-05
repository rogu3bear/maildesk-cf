import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { runCanary, type CanaryEnv } from "../../workers/mail-canary/src/index";
import { reportRoutes, type CanarySnapshot } from "../../workers/mail-canary/src/report";

const now = Date.parse("2026-10-05T12:00:00Z");
const recent = "2026-10-05 11:30:00";
const policyJson = JSON.stringify({ domains: { "example.com": {
  role_aliases: { postmaster: { operators: ["operator@example.com"], reply_identity: "postmaster@example.com" } },
  personal_aliases: {},
} } });

test("full route coverage requires independent fresh edge, inbox and reply receipts", () => {
  const snapshot = goodSnapshot();
  expect(reportRoutes(snapshot, now, 3_600_000, { inbound: "enabled", reply: "enabled" }).status).toBe("receipts_current");
  snapshot.routes[0]!.last_reply_verified_at = null;
  expect(reportRoutes(snapshot, now, 3_600_000, { inbound: "enabled", reply: "enabled" }).issues)
    .toEqual({ reply_receipt_missing_or_stale: 1 });
});

test("missing coverage, stale/future receipts, disabled replies and policy drift cannot pass", () => {
  for (const timestamp of ["2026-10-01T12:00:00Z", "2026-10-06T12:00:00Z", "bad-date"]) {
    const snapshot = goodSnapshot();
    snapshot.routes[0]!.last_inbox_verified_at = timestamp;
    expect(reportRoutes(snapshot, now, 3_600_000, { inbound: "enabled", reply: "enabled" }).status).toBe("unverified");
  }
  const snapshot = goodSnapshot();
  snapshot.expected_routes = 2;
  snapshot.routes[0]!.health_policy_sha256 = "b".repeat(64);
  expect(reportRoutes(snapshot, now, 3_600_000, { inbound: "enabled", reply: "disabled" }).issues)
    .toEqual({ route_inventory_incomplete: 1, reply_processing_disabled: 1, route_health_revision_missing: 1 });
  expect(reportRoutes({ ...snapshot, expected_routes: 0, routes: [] }, now, 3_600_000, { inbound: "enabled", reply: "enabled" }).status).toBe("unverified");
});

test("intentional sinks are excluded; partial delivery is a failure", () => {
  const snapshot = goodSnapshot();
  snapshot.routes[0]!.decision_kind = "sink";
  snapshot.routes[0]!.inbound_status = "intentionally_excluded";
  snapshot.routes[0]!.reply_status = "intentionally_excluded";
  expect(reportRoutes(snapshot, now, 3_600_000, { inbound: "enabled", reply: "enabled" }).excluded_routes).toBe(1);
  snapshot.routes[0]!.decision_kind = "role_alias";
  snapshot.routes[0]!.inbound_status = "partial_delivery";
  expect(reportRoutes(snapshot, now, 3_600_000, { inbound: "enabled", reply: "enabled" }).status).toBe("failed");
});

test("scheduled notification uses real schema, deduplicates, reminds daily and records acceptance", async () => {
  const f = await fixture();
  try {
    expect((await runCanary(f.env, now))?.status).toBe("receipts_current");
    await runCanary(f.env, now + 60_000);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.to).toEqual(["operator@example.com"]);
    expect(f.sent[0]!.text).toContain("did not check live provider inventory");
    expect(JSON.stringify(f.sent)).not.toContain("private-message-body");
    await runCanary(f.env, now + 24 * 3_600_000);
    expect(f.sent).toHaveLength(2);
    expect(f.db.query("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'canary_notification_provider_accepted'").get()).toEqual({ n: 2 });
  } finally { f.db.close(); }
});

test("changes and recovery notify immediately; concurrent runs claim once", async () => {
  const f = await fixture();
  try {
    await Promise.all([runCanary(f.env, now), runCanary(f.env, now)]);
    expect(f.sent).toHaveLength(1);
    f.db.run("UPDATE route_health SET inbound_status = 'failed'");
    await runCanary(f.env, now + 60_000);
    expect(f.sent[1]!.subject).toContain("failed");
    f.db.run("UPDATE route_health SET inbound_status = 'inbox_verified'");
    await runCanary(f.env, now + 120_000);
    expect(f.sent[2]!.subject).toContain("receipts_current");
  } finally { f.db.close(); }
});

test("an ambiguous provider send is retained and never automatically replayed", async () => {
  const f = await fixture();
  let calls = 0;
  f.env.EMAIL = { send: async () => { calls++; throw new Error("private-provider-payload"); } } as unknown as SendEmail;
  try {
    await expect(runCanary(f.env, now)).rejects.toThrow("outcome uncertain");
    await expect(runCanary(f.env, now + 3_600_000)).rejects.toThrow("reconciliation");
    expect(calls).toBe(1);
    expect(f.db.query("SELECT attempt_state FROM mail_canary_state").get()).toEqual({ attempt_state: "uncertain" });
  } finally { f.db.close(); }
});

test("disabled canary performs no reads or sends; undeclared sender cannot notify", async () => {
  expect(await runCanary({ MAILDESK_CANARY_MODE: "disabled" } as CanaryEnv, now)).toBeNull();
  const f = await fixture();
  try {
    f.env.MAILDESK_CANARY_FROM = "unapproved@example.net";
    await expect(runCanary(f.env, now)).rejects.toThrow("active public role identity");
    expect(f.sent).toHaveLength(0);
  } finally { f.db.close(); }
});

test("missing R2 policy alerts unverified rather than reporting a healthy empty inventory", async () => {
  const f = await fixture();
  f.env.POLICY_STORE = { get: async () => null } as unknown as R2Bucket;
  try {
    expect((await runCanary(f.env, now))?.issues).toEqual({ policy_or_route_inventory_unavailable: 1 });
    expect(f.sent[0]!.subject).toContain("unverified");
  } finally { f.db.close(); }
});

function goodSnapshot(): CanarySnapshot {
  return { policy_sha256: "a".repeat(64), expected_routes: 1, routes: [{
    route_id: "route-example", decision_kind: "role_alias", health_policy_sha256: "a".repeat(64),
    inbound_status: "inbox_verified", reply_status: "reply_verified",
    last_inbox_verified_at: recent, last_reply_verified_at: recent, edge_verified_at: recent,
  }] };
}

async function fixture() {
  const db = new Database(":memory:");
  const root = resolve(import.meta.dir, "../..");
  for (const file of readdirSync(resolve(root, "migrations")).sort()) {
    if (file.endsWith(".sql")) db.exec(readFileSync(resolve(root, "migrations", file), "utf8"));
  }
  const hashBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(policyJson));
  const hash = Array.from(new Uint8Array(hashBytes), (b) => b.toString(16).padStart(2, "0")).join("");
  const key = `config/policy/${hash}.json`;
  db.run("INSERT INTO domains (id, domain) VALUES ('d', 'example.com')");
  db.run("INSERT INTO identities (id, domain_id, address, kind) VALUES ('i', 'd', 'postmaster@example.com', 'role')");
  db.run("INSERT INTO policy_revisions (policy_sha256, r2_object_key, expected_domain_count, expected_route_count) VALUES (?, ?, 1, 1)", [hash, key]);
  db.run("INSERT INTO runtime_state (singleton, active_policy_sha256, active_policy_r2_key) VALUES (1, ?, ?)", [hash, key]);
  db.run("INSERT INTO alias_routes (id, domain_id, local_part, kind, default_reply_identity_id, policy_sha256) VALUES ('r', 'd', 'postmaster', 'role', 'i', ?)", [hash]);
  db.run("INSERT INTO route_health (route_id, route_address, decision_kind, desired_provider, reply_identity, policy_sha256, inbound_status, reply_status, last_inbox_verified_at, last_reply_verified_at) VALUES ('r', 'postmaster@example.com', 'role_alias', 'cloudflare_email_routing', 'postmaster@example.com', ?, 'inbox_verified', 'reply_verified', ?, ?)", [hash, recent, recent]);
  db.run("INSERT INTO route_proofs (id, route_id, policy_sha256, proof_kind, evidence_sha256, verified_at) VALUES ('p', 'r', ?, 'edge_verified', ?, ?)", [hash, "a".repeat(64), recent]);
  const sent: Array<{ to: string[]; subject: string; text: string }> = [];
  const adapter = {
    prepare(sql: string) {
      let values: any[] = [];
      return {
        bind(...next: any[]) { values = next; return this; },
        async first() { return db.query(sql).get(...values); },
        async all() { return { success: true, results: db.query(sql).all(...values) }; },
        async run() { const result = db.query(sql).run(...values); return { success: true, meta: { changes: result.changes } }; },
      };
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      db.exec("BEGIN");
      try { const results = []; for (const s of statements) results.push(await s.run()); db.exec("COMMIT"); return results; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
  const env = {
    DB: adapter, POLICY_STORE: { get: async () => ({ arrayBuffer: async () => new TextEncoder().encode(policyJson).buffer }) },
    EMAIL: { send: async (message: any) => { sent.push(message); return { messageId: `canary-${sent.length}` }; } },
    MAILDESK_CANARY_MODE: "enabled", MAILDESK_CANARY_FROM: "postmaster@example.com",
    MAILDESK_CANARY_TO: "operator@example.com", MAILDESK_CANARY_MAX_PROOF_AGE_HOURS: "720",
    MAILDESK_CANARY_INBOUND_MODE: "enabled", MAILDESK_CANARY_REPLY_MODE: "enabled",
  } as unknown as CanaryEnv;
  return { db, env, sent };
}
