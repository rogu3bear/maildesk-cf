import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { runCanary, type CanaryEnv } from "../../workers/mail-canary/src/index";
import { reportRoutes, selectProbeRotation, type CanarySnapshot } from "../../workers/mail-canary/src/report";
import { assertPolicyRoutes, type RouteInventoryRow } from "../../workers/mail-canary/src/policy-routes";
import type { RouterPolicy } from "../../workers/shared/router";

const now = Date.parse("2026-10-05T12:00:00Z");
const recent = "2026-10-05 11:30:00";
const policyJson = JSON.stringify({ default_reply_mode: "role_first", domains: { "example.com": {
  role_aliases: { postmaster: { operators: ["operator@example.com"], reply_identity: "postmaster@example.com" } },
  personal_aliases: {},
} } });

test("configuration coverage stays current when an independent reply proof is missing", () => {
  const snapshot = goodSnapshot();
  expect(reportRoutes(snapshot, now, 3_600_000, { inbound: "enabled", reply: "enabled" }).status).toBe("receipts_current");
  snapshot.routes[0]!.last_reply_verified_at = null;
  const report = reportRoutes(snapshot, now, 3_600_000, { inbound: "enabled", reply: "enabled" });
  expect(report.status).toBe("configuration_current");
  expect(report.configuration_routes).toBe(1);
  expect(report.reply_proofs_recorded).toBe(0);
  expect(report.inbox_proofs_fresh).toBe(1);
  expect(report.live_probe_sent).toBe(false);
  expect(report.issues).toEqual({});
});

test("stale independent proofs stay recorded while configuration and policy failures do not pass", () => {
  for (const timestamp of ["2026-10-01T12:00:00Z", "2026-10-06T12:00:00Z", "bad-date"]) {
    const snapshot = goodSnapshot();
    snapshot.routes[0]!.last_inbox_verified_at = timestamp;
    const report = reportRoutes(snapshot, now, 3_600_000, { inbound: "enabled", reply: "enabled" });
    expect(report.status).toBe("configuration_current");
    expect(report.inbox_proofs_fresh).toBe(0);
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
    expect(f.sent[0]!.text).toContain("Independent inbox proofs inside the window: 1");
    expect(f.sent[0]!.text).toContain("did not check live provider inventory");
    expect(f.sent[0]!.text).toContain("did not send those probes");
    expect(f.db.query("SELECT plane, verified_at_ms IS NOT NULL AS known FROM route_proof_ledger ORDER BY plane").all())
      .toEqual([
        { plane: "configuration", known: 1 },
        { plane: "edge", known: 1 },
        { plane: "inbox", known: 1 },
        { plane: "reply", known: 1 },
      ]);
    expect(f.db.query("SELECT reason FROM mail_canary_probe_rotation").all()).toEqual([{ reason: "oldest_proof" }]);
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

test("equal-count projection substitutions and changed routing fields cannot report current receipts", async () => {
  for (const change of [
    "UPDATE alias_routes SET id = 'route:example.com:other'; UPDATE route_health SET route_id = 'route:example.com:other'; UPDATE route_proofs SET route_id = 'route:example.com:other'",
    "UPDATE alias_routes SET local_part = 'other'",
    "UPDATE alias_routes SET decision_kind = 'personal_alias'",
    "UPDATE alias_routes SET kind = 'personal'",
    "UPDATE domains SET domain = 'example.net'",
  ]) {
    const f = await fixture();
    try {
      f.db.exec(change);
      expect((await runCanary(f.env, now))?.issues).toEqual({ policy_or_route_inventory_unavailable: 1 });
      expect(f.sent[0]!.subject).toContain("unverified");
    } finally { f.db.close(); }
  }
});

test("probe rotation keeps a few oldest paths and skips sinks", () => {
  const older = "2026-10-05T08:00:00Z";
  const newer = "2026-10-05T11:00:00Z";
  const routes = [
    { ...goodSnapshot().routes[0]!, route_id: "route:example.com:newer", last_inbox_verified_at: newer, last_reply_verified_at: newer },
    { ...goodSnapshot().routes[0]!, route_id: "route:example.com:missing", last_inbox_verified_at: null, last_reply_verified_at: newer },
    { ...goodSnapshot().routes[0]!, route_id: "route:example.com:older", last_inbox_verified_at: older, last_reply_verified_at: newer },
    { ...goodSnapshot().routes[0]!, route_id: "route:example.com:sink", decision_kind: "sink" },
  ];
  expect(selectProbeRotation(routes, now, 2).map((probe) => probe.route_id)).toEqual([
    "route:example.com:missing",
    "route:example.com:older",
  ]);
});

test("Rust-derived inventory preserves personal, sink and catch-all decisions", () => {
  const policy = JSON.parse(policyJson) as RouterPolicy;
  const domain = policy.domains["example.com"]!;
  domain.role_aliases["maildesk-canary"] = { operators: [], reply_identity: "discard@example.com", sink: true };
  domain.personal_aliases["person"] = { operator: "operator@example.com", reply_identity: "person@example.com" };
  domain.catch_all = { operators: ["operator@example.com"], reply_identity: "postmaster@example.com" };
  const row = (alias: string, kind: string, identity: string, storage = "role"): RouteInventoryRow => ({
    ...goodSnapshot().routes[0]!, route_id: `route:example.com:${encodeURIComponent(alias)}`,
    domain_id: "domain:example.com", domain: "example.com", local_part: alias, decision_kind: kind,
    storage_kind: storage, reply_identity_id: `identity:${encodeURIComponent(identity)}`, reply_identity: identity,
  });
  const rows = [row("postmaster", "role_alias", "postmaster@example.com"),
    row("maildesk-canary", "sink", "discard@example.com"),
    row("person", "personal_alias", "person@example.com", "personal"),
    row("*", "catch_all", "postmaster@example.com")];
  expect(() => assertPolicyRoutes(policy, rows)).not.toThrow();
  domain.role_aliases["postmaster"]!.reply_identity = "POSTMASTER@EXAMPLE.COM";
  expect(() => assertPolicyRoutes(policy, rows)).not.toThrow();
  rows[0]!.decision_kind = "sink";
  expect(() => assertPolicyRoutes(policy, rows)).toThrow("differs from policy");
  rows[0]!.decision_kind = "role_alias";
  rows[2]!.reply_identity = "postmaster@example.com";
  expect(() => assertPolicyRoutes(policy, rows)).toThrow("differs from policy");
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
  db.run("INSERT INTO domains (id, domain) VALUES ('domain:example.com', 'example.com')");
  db.run("INSERT INTO identities (id, domain_id, address, kind) VALUES ('identity:postmaster%40example.com', 'domain:example.com', 'postmaster@example.com', 'role')");
  db.run("INSERT INTO policy_revisions (policy_sha256, r2_object_key, expected_domain_count, expected_route_count) VALUES (?, ?, 1, 1)", [hash, key]);
  db.run("INSERT INTO runtime_state (singleton, active_policy_sha256, active_policy_r2_key) VALUES (1, ?, ?)", [hash, key]);
  db.run("INSERT INTO alias_routes (id, domain_id, local_part, kind, default_reply_identity_id, policy_sha256) VALUES ('route:example.com:postmaster', 'domain:example.com', 'postmaster', 'role', 'identity:postmaster%40example.com', ?)", [hash]);
  db.run("INSERT INTO route_health (route_id, route_address, decision_kind, desired_provider, reply_identity, policy_sha256, inbound_status, reply_status, last_inbox_verified_at, last_reply_verified_at) VALUES ('route:example.com:postmaster', 'postmaster@example.com', 'role_alias', 'cloudflare_email_routing', 'postmaster@example.com', ?, 'inbox_verified', 'reply_verified', ?, ?)", [hash, recent, recent]);
  db.run("INSERT INTO route_proofs (id, route_id, policy_sha256, proof_kind, evidence_sha256, verified_at) VALUES ('p', 'route:example.com:postmaster', ?, 'edge_verified', ?, ?)", [hash, "a".repeat(64), recent]);
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
