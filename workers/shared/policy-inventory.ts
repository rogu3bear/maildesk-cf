import { projectPolicy, type PolicyProjection, type RouterPolicy, type RouteDecision } from "./router";

/** Transport/storage IDs retain the original percent-encoded v1 contract. */
export function policyStorageId(prefix: string, ...parts: string[]): string {
  return [prefix, ...parts.map((value) => encodeURIComponent(value.trim().toLowerCase()))].join(":");
}

export interface PolicyInventoryRow {
  route_id: string;
  domain_id: string;
  domain: string;
  local_part: string;
  storage_kind: string;
  decision_kind: string;
  reply_identity_id: string;
  reply_identity: string;
  operators_json: string;
  reply_identity_bindings_json: string;
  policy_sha256?: string;
}

/** Exact sorted Rust-projected operator, public identity and selection mode. */
export function routeReplyIdentityBindings(route: RouteDecision): string[][] {
  if (route.operatorReplyIdentities && JSON.stringify(Object.keys(route.operatorReplyIdentities).sort()) !== JSON.stringify([...route.operators].sort())) {
    throw new Error("operator public identity membership differs from policy");
  }
  return route.operators.map((operator) => [operator,
    route.operatorReplyIdentities?.[operator]?.publicAddress ?? route.defaultReplyIdentity,
    route.operatorReplyIdentities ? "personal_first" : "role_first"]);
}

export function replyIdentityBindingsSql(route: string, policy: string): string {
  return `(SELECT json_group_array(json_array(operator, address, reply_mode)) FROM
    (SELECT o.email AS operator, i.address, binding.reply_mode FROM alias_route_reply_identities binding
      JOIN operators o ON o.id = binding.operator_id JOIN identities i ON i.id = binding.public_identity_id
      WHERE binding.route_id = ${route} AND binding.policy_sha256 = ${policy} ORDER BY o.email))`;
}

export const POLICY_INVENTORY_SQL = `SELECT ar.id AS route_id, ar.domain_id,
  d.domain, ar.local_part, ar.kind AS storage_kind, ar.decision_kind,
  ar.default_reply_identity_id AS reply_identity_id, i.address AS reply_identity,
  ar.policy_sha256,
  (SELECT json_group_array(email) FROM
    (SELECT o.email FROM alias_route_operators aro JOIN operators o ON o.id = aro.operator_id
     WHERE aro.route_id = ar.id ORDER BY o.email)) AS operators_json,
  ${replyIdentityBindingsSql("ar.id", "ar.policy_sha256")} AS reply_identity_bindings_json
  FROM alias_routes ar JOIN domains d ON d.id = ar.domain_id
  JOIN identities i ON i.id = ar.default_reply_identity_id
  WHERE ar.enabled = 1 ORDER BY ar.id LIMIT 10001`;

export function assertPolicyInventory(
  policy: RouterPolicy | PolicyProjection,
  rows: PolicyInventoryRow[],
  policySha256?: string,
): void {
  const projected = "schemaVersion" in policy ? { ok: true as const, value: policy } : projectPolicy(policy);
  if (!projected.ok) throw new Error("policy projection unavailable");
  const expected = new Map(projected.value.routes.map((route) => [
    policyStorageId("route", route.domain, route.localPart), route,
  ]));
  if (rows.length !== expected.size || rows.length > 10000) {
    throw new Error("route projection membership differs from policy");
  }
  for (const row of rows) {
    const route = expected.get(row.route_id);
    if (!route || row.domain_id !== policyStorageId("domain", route.domain) ||
        row.domain !== route.domain || row.local_part !== route.localPart ||
        row.storage_kind !== (route.routeKind === "personal_alias" ? "personal" : "role") ||
        row.decision_kind !== route.routeKind || row.reply_identity !== route.defaultReplyIdentity ||
        row.reply_identity_id !== policyStorageId("identity", route.defaultReplyIdentity) ||
        (policySha256 !== undefined && row.policy_sha256 !== policySha256)) {
      throw new Error("route projection differs from policy");
    }
    const operators: unknown = JSON.parse(row.operators_json);
    if (!Array.isArray(operators) || operators.some((value) => typeof value !== "string") ||
        JSON.stringify([...operators].sort()) !== JSON.stringify(route.operators)) {
      throw new Error("route operator projection differs from policy");
    }
    if (row.reply_identity_bindings_json !== JSON.stringify(routeReplyIdentityBindings(route))) {
      throw new Error("operator public identity projection differs from policy");
    }
    expected.delete(row.route_id);
  }
}

/** Recheck the exact Rust-projected row inside the statement that consumes
 * authority. A prior SELECT cannot protect against changes before that claim.
 */
export function atomicPolicyRouteMatchSql(routeId: "ra.route_id" | "reply_admissions.route_id" | "?6", firstParameter: number): string {
  const p = (offset: number) => `?${firstParameter + offset}`;
  return `EXISTS (SELECT 1 FROM alias_routes guard_ar
    JOIN domains guard_d ON guard_d.id = guard_ar.domain_id
    JOIN identities guard_i ON guard_i.id = guard_ar.default_reply_identity_id
    WHERE guard_ar.id = ${routeId} AND guard_ar.enabled = 1
      AND guard_ar.id = ${p(0)} AND guard_ar.domain_id = ${p(1)}
      AND guard_d.domain = ${p(2)} AND guard_ar.local_part = ${p(3)}
      AND guard_ar.kind = ${p(4)} AND guard_ar.decision_kind = ${p(5)}
      AND guard_ar.default_reply_identity_id = ${p(6)} AND guard_i.address = ${p(7)}
      AND (SELECT json_group_array(email) FROM (SELECT o.email FROM alias_route_operators aro
        JOIN operators o ON o.id = aro.operator_id WHERE aro.route_id = guard_ar.id ORDER BY o.email)) = ${p(8)}
      AND ${replyIdentityBindingsSql("guard_ar.id", "guard_ar.policy_sha256")} = ${p(9)})`;
}

export function atomicPolicyRouteBindings(route: RouteDecision): string[] {
  return [policyStorageId("route", route.domain, route.localPart), policyStorageId("domain", route.domain),
    route.domain, route.localPart, route.routeKind === "personal_alias" ? "personal" : "role", route.routeKind,
    policyStorageId("identity", route.defaultReplyIdentity), route.defaultReplyIdentity, JSON.stringify(route.operators),
    JSON.stringify(routeReplyIdentityBindings(route))];
}
