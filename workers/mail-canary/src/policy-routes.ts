import { routeInbound, type RouterPolicy } from "../../shared/router";
import type { RouteSnapshot } from "./report";

export interface RouteInventoryRow extends RouteSnapshot {
  domain_id: string;
  domain: string;
  local_part: string;
  storage_kind: string;
  reply_identity_id: string;
  reply_identity: string;
}

/** Match projection membership and routing fields to decisions from Rust policy. */
export function assertPolicyRoutes(policy: RouterPolicy, rows: RouteInventoryRow[]): void {
  const expected = new Map<string, Omit<RouteInventoryRow, keyof RouteSnapshot> & { decision_kind: string }>();
  for (const [domain, config] of Object.entries(policy.domains)) {
    const aliases = [...Object.keys(config.role_aliases), ...Object.keys(config.personal_aliases)];
    if (config.catch_all) {
      let probe = "maildesk-canary";
      while (aliases.includes(probe)) probe += "-catch-all";
      aliases.push(probe);
    }
    for (const alias of aliases) {
      // This is a pure router call, not a provider or mailbox probe.
      const result = routeInbound(policy, { envelopeTo: `${alias}@${domain}`, headerFrom: "operator@example.com" });
      if (!result.ok) throw new Error("active policy cannot enumerate routes");
      const route = result.value;
      const id = stableId("route", route.domain, route.localPart);
      if (expected.has(id)) throw new Error("active policy has duplicate route identities");
      expected.set(id, {
        domain_id: stableId("domain", route.domain), domain: route.domain, local_part: route.localPart,
        storage_kind: route.routeKind === "personal_alias" ? "personal" : "role",
        reply_identity_id: stableId("identity", route.defaultReplyIdentity),
        reply_identity: route.defaultReplyIdentity.trim().toLowerCase(), decision_kind: route.routeKind,
      });
    }
  }
  if (rows.length !== expected.size) throw new Error("route projection membership differs from policy");
  for (const row of rows) {
    const route = expected.get(row.route_id);
    if (!route || Object.entries(route).some(([field, value]) => row[field as keyof RouteInventoryRow] !== value)) {
      throw new Error("route projection differs from policy");
    }
    expected.delete(row.route_id);
  }
}

function stableId(prefix: string, ...parts: string[]): string {
  return [prefix, ...parts.map((value) => encodeURIComponent(value.trim().toLowerCase()))].join(":");
}
