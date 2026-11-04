import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../helpers/relay-runtime";
import { projectionSql, type ProjectedRoute } from "../../scripts/sync-route-policy";
import { assertPolicyInventory, POLICY_INVENTORY_SQL, routeReplyIdentityBindings } from "../../workers/shared/policy-inventory";
import type { RouteDecision } from "../../workers/shared/router";

test("delivery-only policy projects recipients but no reply identity bindings", () => {
  const db = new Database(":memory:", { strict: true });
  try {
    db.exec("PRAGMA foreign_keys=ON"); migrate(db);
    const policySha = "a".repeat(64), desired = "b".repeat(64);
    const route: ProjectedRoute = { domain: "example.com", localPart: "reports", decisionKind: "role_alias", storageKind: "role",
      desiredProvider: "cloudflare_email_routing", operators: ["recipient@example.net"], replyIdentity: "reports@example.com", deliveryOnly: true, initialStatus: "local_policy_valid" };
    db.exec(projectionSql([route], policySha, "policy/key", desired).sql);
    const decision: RouteDecision = { domain: route.domain, localPart: route.localPart, routeKind: "role_alias", operators: route.operators,
      deliveryOnly: true, defaultReplyIdentity: route.replyIdentity, allowedReplyIdentities: [] };
    expect(routeReplyIdentityBindings(decision)).toEqual([]);
    expect(db.query("SELECT count(*) AS n FROM alias_route_operators").get()).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) AS n FROM alias_route_reply_identities").get()).toEqual({ n: 0 });
    expect(() => assertPolicyInventory({ schemaVersion: 1, protectedOperators: [], routes: [{ ...decision, routeRef: "route:example.com:reports" }] }, db.query(POLICY_INVENTORY_SQL).all() as never, policySha)).not.toThrow();
  } finally { db.close(); }
});

test("rebuilt Rust WASM projects a delivery-only route without reply authorization", async () => {
  const { projectRoutes } = await import("../../scripts/sync-route-policy");
  const { authorizeReplyWithPolicy, projectPolicy } = await import("../../workers/shared/router");
  const policy = { policy_version: 3 as const, default_reply_mode: "personal_first" as const,
    domains: { "example.com": { role_aliases: { reports: { operators: ["reports@example.net"], reply_identity: "reports@example.com", delivery_only: true } }, personal_aliases: {} } } };
  const projection = projectPolicy(policy);
  expect(projection.ok).toBe(true);
  expect(authorizeReplyWithPolicy(policy, { envelopeTo: "reports@example.com", operator: "reports@example.net" }).ok).toBe(false);
  const routes = projectRoutes(policy, { storage: { d1_database: "local" }, domains: [{ name: "example.com", inbound_mx_provider: "cloudflare_email_routing", role_aliases: ["reports"], personal_aliases: [] }] });
  expect(routes[0]?.deliveryOnly).toBe(true);
  const db = new Database(":memory:", { strict: true });
  try {
    db.exec("PRAGMA foreign_keys=ON"); migrate(db);
    const sha = "a".repeat(64);
    db.exec(projectionSql(routes, sha, "policy/key", "b".repeat(64)).sql);
    expect(db.query("SELECT count(*) AS n FROM alias_route_reply_identities").get()).toEqual({ n: 0 });
    if (!projection.ok) throw new Error("projection rejected");
    expect(() => assertPolicyInventory(projection.value, db.query(POLICY_INVENTORY_SQL).all() as never, sha)).not.toThrow();
  } finally { db.close(); }
});
