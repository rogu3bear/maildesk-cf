import type { MaildeskEnv } from "./contracts";
import type { RouterPolicy } from "./router";

interface ActivePolicyRow {
  active_policy_sha256: string;
  active_policy_r2_key: string;
  revision_sha256: string;
  revision_r2_key: string;
  expected_domain_count: number;
  expected_route_count: number;
  projected_route_count: number;
  projected_domain_count: number;
}

export interface ActivePolicy {
  policy: RouterPolicy;
  sha256: string;
  r2ObjectKey: string;
}

/** Loads the D1-selected immutable R2 policy and proves all three digests agree. */
export async function loadActivePolicy(
  env: Pick<MaildeskEnv, "DB" | "POLICY_STORE" | "MAILDESK_POLICY_JSON" | "MAILDESK_OPERATOR_DELIVERY_MODE">,
): Promise<ActivePolicy | null> {
  // Kept only for generic legacy web-desk development. Inbox relay always
  // requires the active D1 pointer and its exact immutable R2 object.
  if (env.MAILDESK_OPERATOR_DELIVERY_MODE === "web_desk" && env.MAILDESK_POLICY_JSON) {
    const policy = parsePolicy(env.MAILDESK_POLICY_JSON);
    return policy
      ? { policy, sha256: await sha256Hex(env.MAILDESK_POLICY_JSON), r2ObjectKey: "inline:development" }
      : null;
  }
  if (!env.POLICY_STORE) return null;

  const row = await env.DB.prepare(
    "SELECT rs.active_policy_sha256, rs.active_policy_r2_key, pr.policy_sha256 AS revision_sha256, pr.r2_object_key AS revision_r2_key, pr.expected_domain_count, pr.expected_route_count, (SELECT COUNT(*) FROM alias_routes ar WHERE ar.enabled = 1 AND ar.policy_sha256 = rs.active_policy_sha256) AS projected_route_count, (SELECT COUNT(DISTINCT ar.domain_id) FROM alias_routes ar WHERE ar.enabled = 1 AND ar.policy_sha256 = rs.active_policy_sha256) AS projected_domain_count FROM runtime_state rs JOIN policy_revisions pr ON pr.policy_sha256 = rs.active_policy_sha256 WHERE rs.singleton = 1 LIMIT 1",
  ).first<ActivePolicyRow>();
  if (!row || !/^[a-f0-9]{64}$/.test(row.active_policy_sha256)) return null;
  const expectedKey = `config/policy/${row.active_policy_sha256}.json`;
  if (
    row.active_policy_sha256 !== row.revision_sha256 ||
    row.active_policy_r2_key !== row.revision_r2_key ||
    row.active_policy_r2_key !== expectedKey ||
    Number(row.projected_route_count) !== Number(row.expected_route_count) ||
    Number(row.projected_domain_count) !== Number(row.expected_domain_count)
  ) {
    return null;
  }

  const object = await env.POLICY_STORE.get(expectedKey);
  if (!object) return null;
  const bytes = await object.arrayBuffer();
  if ((await sha256Hex(bytes)) !== row.active_policy_sha256) return null;
  const policy = parsePolicy(new TextDecoder().decode(bytes));
  if (
    !policy ||
    Object.keys(policy.domains).length !== Number(row.expected_domain_count) ||
    policyRouteCount(policy) !== Number(row.expected_route_count)
  ) return null;
  return { policy, sha256: row.active_policy_sha256, r2ObjectKey: expectedKey };
}

function policyRouteCount(policy: RouterPolicy): number {
  return Object.values(policy.domains).reduce(
    (count, domain) =>
      count + Object.keys(domain.role_aliases).length + Object.keys(domain.personal_aliases).length + Number(Boolean(domain.catch_all)),
    0,
  );
}

function parsePolicy(value: string): RouterPolicy | null {
  try {
    const parsed = JSON.parse(value) as RouterPolicy;
    return parsed && typeof parsed === "object" && parsed.domains && typeof parsed.domains === "object"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function sha256Hex(value: string | ArrayBuffer): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
