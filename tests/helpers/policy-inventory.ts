import { createHash } from "node:crypto";
import { projectPolicy, type RouterPolicy } from "../../workers/shared/router";
import { policyStorageId, type PolicyInventoryRow } from "../../workers/shared/policy-inventory";

/** Database setup for mocks; corruption tests alter these rows independently. */
export function inventoryFixture(policyJson: string): PolicyInventoryRow[] {
  const projection = projectPolicy(JSON.parse(policyJson) as RouterPolicy);
  if (!projection.ok) return [];
  return projection.value.routes.map((route) => ({
    route_id: policyStorageId("route", route.domain, route.localPart),
    domain_id: policyStorageId("domain", route.domain), domain: route.domain,
    local_part: route.localPart,
    storage_kind: route.routeKind === "personal_alias" ? "personal" : "role",
    decision_kind: route.routeKind,
    reply_identity_id: policyStorageId("identity", route.defaultReplyIdentity),
    reply_identity: route.defaultReplyIdentity,
    operators_json: JSON.stringify(route.operators),
    policy_sha256: createHash("sha256").update(policyJson).digest("hex"),
  }));
}
