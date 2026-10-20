import type { RouterPolicy } from "../../shared/router";
import { assertPolicyInventory } from "../../shared/policy-inventory";
import type { RouteSnapshot } from "./report";

export interface RouteInventoryRow extends RouteSnapshot {
  domain_id: string;
  domain: string;
  local_part: string;
  storage_kind: string;
  reply_identity_id: string;
  reply_identity: string;
  operators_json: string;
}

/** Full membership and operator parity are checked against Rust, never counts. */
export function assertPolicyRoutes(policy: RouterPolicy, rows: RouteInventoryRow[]): void {
  assertPolicyInventory(policy, rows);
}
