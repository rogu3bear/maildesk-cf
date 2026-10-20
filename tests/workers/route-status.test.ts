import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { projectRouteStatus, proofFreshness, type RouteStatusInput } from "../../workers/shared/route-status";
import { refreshRouteStatuses } from "../../workers/shared/status-store";
import { activateFixture, relayRuntime } from "../helpers/relay-runtime";
import { operationalReadinessBlocker, readRouteStatusProjection } from "../../workers/shared/route-status-reader";
import { CLAIM_ACTIVE_INBOUND_RECIPIENT_SQL } from "../../workers/mail-router/src/inbound-repository";

const now = Date.parse("2026-10-15T12:00:00Z");
const input = (): RouteStatusInput => ({ policySha256: "a".repeat(64), bindingCurrent: true, enabled: true, routeKind: "role_alias", enrollment: "required",
  inboundProcessing: "enabled", replyProcessing: "enabled", ordinaryProcessing: "enabled", activationId: "activation:fixture", quarantined: false,
  inboundStatus: "provider_accepted", replyStatus: "provider_accepted", inboxObservedAt: "2026-10-15T11:00:00Z", replyObservedAt: "2026-10-15T11:00:00Z",
  pendingDispatch: 0, pendingQueue: 0, unknownProviderAttempts: 0 });

const inbound = (id: string) => new TextEncoder().encode(`From: sender@example.net\r\nTo: support@example.com\r\nMessage-ID: <${id}@example.net>\r\nContent-Type: text/plain\r\n\r\nHello\r\n`).buffer;

async function operationalStatus(f: Awaited<ReturnType<typeof relayRuntime>>) {
  await refreshRouteStatuses(f.env);
  const row = f.db.query("SELECT projection_json, source_generation FROM route_status_projection WHERE route_id='route:example.com:support'").get() as { projection_json: string; source_generation: number };
  return readRouteStatusProjection(row.projection_json, { policySha256: f.policySha, sourceGeneration: row.source_generation });
}

test("a claimed inbound provider call blocks readiness even before the delivery rollup updates", async () => {
  const f = await relayRuntime();
  let release = () => {};
  let delivery: Promise<string | undefined> | undefined;
  try {
    await activateFixture(f);
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });
    f.env.EMAIL = { async send() { entered(); await gate; return { messageId: "provider:inbound" }; } } as SendEmail;
    delivery = f.ingress(inbound("in-flight"), "support@example.com", "sender@example.net");
    await Promise.race([started, delivery.then(() => { throw new Error("inbound returned before the provider boundary"); })]);
    const read = await operationalStatus(f);
    expect(read.status).toMatchObject({ classification: "needs_attention", inbound_outcome: "unknown", unknown_provider_attempts: 1, next_action: "reconcile_provider_outcome" });
    expect(operationalReadinessBlocker(read)).toBe("provider_outcome_requires_reconciliation");
  } finally { release(); await delivery; f.db.close(); }
});

test("a later accepted inbound delivery cannot hide unresolved provider attempts", async () => {
  const f = await relayRuntime();
  try {
    await activateFixture(f);
    f.faults.providerAfter = true;
    await f.ingress(inbound("uncertain"), "support@example.com", "sender@example.net");
    f.faults.providerAfter = false;
    await f.ingress(inbound("accepted"), "support@example.com", "sender@example.net");
    const read = await operationalStatus(f);
    expect(read.status).toMatchObject({ classification: "needs_attention", unknown_provider_attempts: 2, next_action: "reconcile_provider_outcome" });
    expect(operationalReadinessBlocker(read)).toBe("provider_outcome_requires_reconciliation");
  } finally { f.db.close(); }
});

test("a later accepted inbound delivery cannot hide recipients still awaiting a send claim", async () => {
  const f = await relayRuntime();
  try {
    await activateFixture(f);
    f.d1.before = (sql) => { if (sql === CLAIM_ACTIVE_INBOUND_RECIPIENT_SQL) throw new Error("claim unavailable before send"); };
    await f.ingress(inbound("pending"), "support@example.com", "sender@example.net");
    f.d1.before = undefined;
    // Model interruption after the durable pending rows, before rollup projection.
    f.db.run("UPDATE inbound_deliveries SET status='pending' WHERE id != 'inbound:one'");
    await f.ingress(inbound("accepted-after-pending"), "support@example.com", "sender@example.net");
    const read = await operationalStatus(f);
    expect(read.status).toMatchObject({ classification: "needs_attention", inbound_outcome: "unknown", unknown_provider_attempts: 0, next_action: "reconcile_provider_outcome" });
    expect(operationalReadinessBlocker(read)).toBe("provider_outcome_requires_reconciliation");
  } finally { f.db.close(); }
});

test("inbound recipient changes invalidate cached status and fence a concurrent refresh", async () => {
  const f = await relayRuntime();
  try {
    await activateFixture(f);
    expect((await operationalStatus(f)).status?.classification).toBe("current");
    const cached = () => f.db.query("SELECT count(*) AS n FROM route_status_projection").get();
    f.db.run(`INSERT INTO inbound_recipient_deliveries
      (delivery_id,operator_ref,delivery_message_id,delivery_payload_r2_key,delivery_payload_sha256,status)
      VALUES ('inbound:one',?,'<pending@example.net>','spool:pending',?,'pending')`, ["a".repeat(64), "b".repeat(64)]);
    expect(cached()).toEqual({ n: 0 });
    expect((await operationalStatus(f)).status?.classification).toBe("needs_attention");
    f.d1.before = (sql) => {
      if (!sql.startsWith("INSERT INTO route_status_projection")) return;
      f.d1.before = undefined;
      f.db.run("UPDATE inbound_recipient_deliveries SET status='sending'");
    };
    await refreshRouteStatuses(f.env);
    expect(cached()).toEqual({ n: 0 });
    expect((await operationalStatus(f)).status).toMatchObject({ classification: "needs_attention", unknown_provider_attempts: 1 });
    f.db.run("DELETE FROM inbound_recipient_deliveries");
    expect(cached()).toEqual({ n: 0 });
    expect((await operationalStatus(f)).status?.classification).toBe("current");
    f.db.run("UPDATE inbound_deliveries SET status='sending'");
    expect(cached()).toEqual({ n: 0 });
    expect((await operationalStatus(f)).status?.classification).toBe("needs_attention");
  } finally { f.db.close(); }
});

test("operational projection keeps authority, outcomes, freshness, sink and enrollment separate", () => {
  expect(projectRouteStatus(input(), now)).toMatchObject({ classification: "current", ordinary_authority_active: true, inbox_proof: "fresh", reply_outcome: "provider_accepted" });
  const stale = projectRouteStatus({ ...input(), inboxObservedAt: "2020-01-01T00:00:00Z" }, now);
  expect(stale).toMatchObject({ classification: "stale", ordinary_authority_active: true, ordinary_reply_enabled: true, inbound_outcome: "provider_accepted", reply_proof: "fresh" });
  expect(projectRouteStatus({ ...input(), replyObservedAt: null }, now)).toMatchObject({ classification: "unverified", inbox_proof: "fresh", reply_proof: "missing" });
  expect(projectRouteStatus({ ...input(), routeKind: "sink" }, now)).toMatchObject({ classification: "intentionally_excluded", inbound_outcome: "not_applicable", reply_proof: "not_applicable", ordinary_reply_enabled: false });
  for (const enrollment of ["excluded", "pending", "scheduled"] as const) {
    expect(projectRouteStatus({ ...input(), enrollment }, now).classification).toBe(enrollment === "excluded" ? "intentionally_excluded" : enrollment);
  }
  expect(projectRouteStatus({ ...input(), activationId: null }, now)).toMatchObject({ classification: "unverified", next_action: "review_route_activation" });
  expect(projectRouteStatus({ ...input(), unknownProviderAttempts: 1 }, now)).toMatchObject({ classification: "needs_attention", next_action: "reconcile_provider_outcome" });
  expect(projectRouteStatus({ ...input(), pendingDispatch: 1 }, now)).toMatchObject({ next_action: "recover_dispatch_by_claim_id" });
  expect(projectRouteStatus({ ...input(), bindingCurrent: false }, now)).toMatchObject({ classification: "unverified", ordinary_authority_active: false });
  expect(proofFreshness("2026-10-16T00:00:00Z", now, 86_400_000)).toBe("invalid");
  expect(proofFreshness("2026-10-15 11:00:00", now, 86_400_000)).toBe("fresh");
});

test("real D1 status projection invalidates on proof, operator, containment and runtime changes", async () => {
  const f = await relayRuntime();
  try {
    await activateFixture(f);
    await refreshRouteStatuses(f.env);
    const get = () => f.db.query("SELECT projection_json FROM route_status_projection").get() as { projection_json: string } | null;
    expect(JSON.parse(get()!.projection_json)).toMatchObject({ classification: "current", ordinary_authority_active: true });
    f.db.run("UPDATE route_proofs SET verified_at='2020-01-01T00:00:00Z'");
    expect(get()).toBeNull();
    await refreshRouteStatuses(f.env);
    expect(JSON.parse(get()!.projection_json)).toMatchObject({ classification: "stale", ordinary_authority_active: true, reply_outcome: "provider_accepted" });
    f.db.run("DELETE FROM alias_route_operators WHERE operator_id='operator:second%40example.com'");
    expect(get()).toBeNull();
    // Full inventory drift also blocks publication of a new misleading cache.
    await refreshRouteStatuses(f.env);
    expect(get()).toBeNull();
  } finally { f.db.close(); }
});

test("a concurrent source change prevents publication of an obsolete status generation", async () => {
  const f = await relayRuntime();
  try {
    await activateFixture(f);
    f.d1.before = (sql) => {
      if (!sql.startsWith("INSERT INTO route_status_projection")) return;
      f.d1.before = undefined;
      f.db.run("UPDATE route_reply_authorizations SET status='revoked',revoked_at=CURRENT_TIMESTAMP,revocation_receipt_sha256=?", ["f".repeat(64)]);
    };
    await refreshRouteStatuses(f.env);
    expect(f.db.query("SELECT count(*) AS n FROM route_status_projection").get()).toEqual({ n: 0 });
    await refreshRouteStatuses(f.env);
    const row = f.db.query("SELECT projection_json FROM route_status_projection").get() as { projection_json: string };
    expect(JSON.parse(row.projection_json)).toMatchObject({ ordinary_authority_active: false, next_action: "review_route_activation" });
    expect(() => f.db.run("UPDATE route_status_projection SET projection_json='{}'")).toThrow("CHECK");
  } finally { f.db.close(); }
});


test("Rust health query refuses a missing runtime pointer even if an old cache survives", async () => {
  const f = await relayRuntime();
  try {
    await activateFixture(f); await refreshRouteStatuses(f.env);
    const source = readFileSync(resolve(import.meta.dir, "../../src/server/desk.rs"), "utf8");
    const sql = /"(SELECT rh\.route_address[^"]+)"/.exec(source)?.[1];
    if (!sql) throw new Error("Rust health query missing");
    const state = () => (f.db.query(sql).get() as { projection_state: string }).projection_state;
    expect(state()).toBe("current");
    // Exercise the consumer guard independently of the invalidation trigger.
    f.db.exec("DROP TRIGGER route_status_runtime_deleted");
    f.db.exec("DELETE FROM runtime_state");
    expect(f.db.query("SELECT count(*) AS n FROM route_status_projection").get()).toEqual({ n: 1 });
    expect(state()).toBe("unknown");
  } finally { f.db.close(); }
});


test("canary preserves receipt counts while exposing a stranded ordinary dispatch", async () => {
  const { reportRoutes } = await import("../../workers/mail-canary/src/report");
  const { ROUTES_SQL } = await import("../../workers/mail-canary/src/index");
  const f = await relayRuntime();
  try {
    await activateFixture(f);
    f.db.run("UPDATE route_health SET inbound_status='inbox_verified',reply_status='reply_verified',last_inbox_verified_at=CURRENT_TIMESTAMP,last_reply_verified_at=CURRENT_TIMESTAMP");
    f.faults.queueBefore = true;
    await f.ingress(await f.signedReply());
    await refreshRouteStatuses(f.env);
    const rows = f.db.query(ROUTES_SQL).all(f.policySha) as import("../../workers/mail-canary/src/report").RouteSnapshot[];
    const report = reportRoutes({policy_sha256:f.policySha,expected_routes:1,routes:rows}, Date.now(),86_400_000,{inbound:"enabled",reply:"enabled"});
    expect(report.status).toBe("unverified");
    expect(report.current_routes).toBe(1);
    expect(report.issues.dispatch_unconfirmed).toBe(1);
    expect(report.operational_status[0]?.state).toBe("current");
    expect(report.operational_status[0]?.status).toMatchObject({pending_dispatch:1,next_action:"recover_dispatch_by_claim_id"});
  } finally {f.db.close();}
});

test("unknown outcomes never turn current and the proof expiry instant is stale", () => {
  for (const value of ["unknown", "unrecognized_result"]) {
    expect(projectRouteStatus({ ...input(), inboundStatus: value }, now))
      .toMatchObject({ classification: "needs_attention", inbound_outcome: "unknown" });
  }
  const expired = projectRouteStatus({ ...input(), inboxObservedAt: "2026-10-14T12:00:00Z" }, now);
  expect(expired).toMatchObject({ classification: "stale", inbox_proof: "stale", ordinary_authority_active: true });
  expect(proofFreshness("2026-10-14T12:00:00Z", now, 86_400_000)).toBe("stale");
});

test("route and identity substitutions invalidate the canonical operational cache", async () => {
  const mutations = [
    "UPDATE alias_routes SET local_part='substituted'",
    "UPDATE alias_routes SET kind='personal'",
    "UPDATE domains SET domain='substituted.example.com'",
    "UPDATE identities SET address='substituted@example.com'",
    "INSERT INTO operators (id,email) VALUES ('operator:outsider','outsider@example.com'); UPDATE alias_route_operators SET operator_id='operator:outsider' WHERE operator_id='operator:second%40example.com'",
  ];
  for (const sql of mutations) {
    const f = await relayRuntime();
    try {
      await activateFixture(f); await refreshRouteStatuses(f.env);
      expect(f.db.query("SELECT count(*) AS n FROM route_status_projection").get()).toEqual({n:1});
      try {
        f.db.transaction(() => {
          for (const statement of sql.split(";").filter((value) => value.trim())) f.db.exec(statement);
        })();
      } catch (error) {
        expect(String(error)).toContain("FOREIGN KEY constraint failed");
        expect(f.db.query("SELECT count(*) AS n FROM route_status_projection").get()).toEqual({n:1});
        continue;
      }
      expect(f.db.query("SELECT count(*) AS n FROM route_status_projection").get()).toEqual({n:0});
      await refreshRouteStatuses(f.env);
      expect(f.db.query("SELECT count(*) AS n FROM route_status_projection").get()).toEqual({n:0});
    } finally {f.db.close();}
  }
});
