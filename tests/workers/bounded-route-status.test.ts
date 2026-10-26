import { expect, test } from "bun:test";
import { refreshRouteStatuses, ROUTE_STATUS_INPUT_SQL, ROUTE_STATUS_REFRESH_PAGE_SIZE } from "../../workers/shared/status-store";
import { activateFixture, relayRuntime, testPolicy } from "../helpers/relay-runtime";

function manyRoutes() {
  const policy = structuredClone(testPolicy);
  const roles = policy.domains["example.com"]!.role_aliases;
  for (let index = 0; index < ROUTE_STATUS_REFRESH_PAGE_SIZE * 2; index++) {
    roles[`role${String(index).padStart(3, "0")}`] = structuredClone(roles.support!);
  }
  return policy;
}

test("full reconciliation advances through bounded pages without omitting routes", async () => {
  const f = await relayRuntime(99, manyRoutes());
  try {
    let nextCursor: string | null = null;
    const seen = new Set<string>();
    const counts: number[] = [];
    do {
      const page = await refreshRouteStatuses(f.env, Date.now(), { afterRouteId: nextCursor ?? undefined });
      counts.push(page.refreshed);
      expect(page.refreshed).toBeLessThanOrEqual(ROUTE_STATUS_REFRESH_PAGE_SIZE);
      nextCursor = page.nextCursor;
      if (nextCursor) { expect(seen.has(nextCursor)).toBe(false); seen.add(nextCursor); }
    } while (nextCursor);
    expect(counts).toEqual([32, 32, 1]);
    expect(f.db.query("SELECT count(*) AS n FROM route_status_projection").get()).toEqual({ n: 65 });
  } finally { f.db.close(); }
});

test("explicit scope touches only the selected route and an empty scope does no work", async () => {
  const f = await relayRuntime(99, manyRoutes());
  try {
    const queries: string[] = [];
    f.d1.before = (sql) => { queries.push(sql); };
    expect(await refreshRouteStatuses(f.env, Date.now(), { routeIds: [] })).toEqual({ refreshed: 0, nextCursor: null });
    expect(queries).toEqual([]);
    const page = await refreshRouteStatuses(f.env, Date.now(), { routeIds: ["route:example.com:support"] });
    expect(page).toEqual({ refreshed: 1, nextCursor: null });
    expect(queries.filter((sql) => sql === ROUTE_STATUS_INPUT_SQL)).toHaveLength(1);
    expect(f.db.query("SELECT route_id FROM route_status_projection").all()).toEqual([{ route_id: "route:example.com:support" }]);
    await expect(refreshRouteStatuses(f.env, Date.now(), { routeIds: Array.from({ length: 33 }, (_, i) => `route:example.com:${i}`) }))
      .rejects.toThrow("scope is invalid");
  } finally { f.db.close(); }
});

test("a bounded refresh keeps generation fencing and whole-policy parity", async () => {
  const f = await relayRuntime();
  const scope = { routeIds: ["route:example.com:support"] };
  try {
    await activateFixture(f);
    f.d1.before = (sql) => {
      if (!sql.startsWith("INSERT INTO route_status_projection")) return;
      f.d1.before = undefined;
      f.db.run("UPDATE route_reply_authorizations SET status='revoked',revoked_at=CURRENT_TIMESTAMP,revocation_receipt_sha256=?", ["f".repeat(64)]);
    };
    expect((await refreshRouteStatuses(f.env, Date.now(), scope)).refreshed).toBe(0);
    expect(f.db.query("SELECT count(*) AS n FROM route_status_projection").get()).toEqual({ n: 0 });
    expect((await refreshRouteStatuses(f.env, Date.now(), scope)).refreshed).toBe(1);
    f.db.run("UPDATE alias_routes SET local_part='substituted' WHERE id='route:example.com:support'");
    expect((await refreshRouteStatuses(f.env, Date.now(), scope)).refreshed).toBe(0);
  } finally { f.db.close(); }
});

test("ingress and queue work refresh only their durable affected route", async () => {
  const f = await relayRuntime(99, manyRoutes());
  try {
    await f.admitCanary();
    expect(await f.ingress(await f.signedReply())).toBeUndefined();
    expect(f.db.query("SELECT route_id FROM route_status_projection").all()).toEqual([{ route_id: "route:example.com:support" }]);
    f.db.run("DELETE FROM route_status_projection");
    await f.consume();
    expect(f.db.query("SELECT route_id FROM route_status_projection").all()).toEqual([{ route_id: "route:example.com:support" }]);
    expect(f.sends).toHaveLength(1);
    const read = f.db.query("SELECT projection_json FROM route_status_projection").get() as { projection_json: string };
    expect(JSON.parse(read.projection_json).reply_outcome).toBe("provider_accepted");
  } finally { f.db.close(); }
});

test("status refresh failure cannot replay an unknown send or change Queue acknowledgment", async () => {
  const f = await relayRuntime();
  try {
    await f.admitCanary();
    await f.ingress(await f.signedReply());
    f.faults.providerAfter = true;
    f.d1.before = (sql) => { if (sql === ROUTE_STATUS_INPUT_SQL) throw new Error("status read unavailable"); };
    expect(await f.consume()).toEqual({ acked: 1, retries: 0 });
    expect(await f.consume()).toEqual({ acked: 1, retries: 0 });
    expect(f.sends).toHaveLength(1);
    expect(f.db.query("SELECT status FROM relay_attempts").get()).toEqual({ status: "recovery_required" });
  } finally { f.db.close(); }
});
