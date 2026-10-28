import { loadActivePolicy, type ActivePolicy } from "../../shared/policy-store";
import { policyStorageId } from "../../shared/policy-inventory";
import { operationalReadinessBlocker, readRouteStatusProjection } from "../../shared/route-status-reader";
import type { MaildeskEnv } from "../../shared/contracts";
import type { RouteDecision } from "../../shared/router";
import type { McpPrincipal } from "./auth";

export type McpDataEnv = Pick<MaildeskEnv, "DB" | "POLICY_STORE" | "MAILDESK_OPERATOR_DELIVERY_MODE">;
export const MCP_ROUTE_PAGE_SIZE = 32;
export class McpReadError extends Error {}
const routeId = (route: RouteDecision) => policyStorageId("route", route.domain, route.localPart);
const descriptor = (route: RouteDecision) => ({ route_id: routeId(route), address: `${route.localPart}@${route.domain}`, kind: route.routeKind });
const allowed = (active: ActivePolicy, principal: McpPrincipal) => active.projection.routes.filter(route => route.operators.includes(principal.operator));

async function policy(env: McpDataEnv, signal?: AbortSignal): Promise<ActivePolicy> {
  signal?.throwIfAborted();
  if (env.MAILDESK_OPERATOR_DELIVERY_MODE !== "inbox_relay") throw new McpReadError("policy_unavailable");
  try {
    const active = await loadActivePolicy(env);
    signal?.throwIfAborted();
    if (!active) throw new Error();
    return active;
  } catch { throw new McpReadError("policy_unavailable"); }
}

function cursorAfter(value: string | undefined, active: ActivePolicy, principal: McpPrincipal, now: number): string {
  if (!value) return "";
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const raw: unknown = JSON.parse(atob(value.replace(/-/g, "+").replace(/_/g, "/")));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "after,expires_at,policy,principal" || row.policy !== active.sha256 || row.principal !== principal.binding ||
        typeof row.after !== "string" || !allowed(active, principal).some(route => routeId(route) === row.after) ||
        typeof row.expires_at !== "number" || !Number.isSafeInteger(row.expires_at) || row.expires_at <= now || row.expires_at > now + 600_000) throw new Error();
    return row.after;
  } catch { throw new McpReadError("cursor_invalid_or_stale"); }
}

export async function listAuthorizedRoutes(env: McpDataEnv, principal: McpPrincipal, cursor: string | undefined, clock: () => number, signal?: AbortSignal) {
  const active = await policy(env, signal), now = clock(), after = cursorAfter(cursor, active, principal, now);
  const routes = allowed(active, principal).sort((a, b) => routeId(a) < routeId(b) ? -1 : routeId(a) > routeId(b) ? 1 : 0).filter(route => routeId(route) > after);
  const page = routes.slice(0, MCP_ROUTE_PAGE_SIZE);
  const next = routes.length > page.length ? btoa(JSON.stringify({ policy: active.sha256, principal: principal.binding,
    after: routeId(page.at(-1)!), expires_at: now + 600_000 })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : null;
  return { schema_version: 1 as const, read_at: new Date(now).toISOString(), policy_sha256: active.sha256, routes: page.map(descriptor), next_cursor: next };
}

interface StoredStatus {
  source_generation: number;
  projection_json: string | null;
  stored_generation: number | null;
  stored_policy: string | null;
  schema_version: number | null;
  projection_revision: string | null;
  observed_at: string | null;
  valid_until: string | null;
}
export const MCP_STATUS_SQL = `SELECT ar.status_generation AS source_generation, sp.projection_json,
  sp.source_generation AS stored_generation, sp.policy_sha256 AS stored_policy,
  sp.schema_version, sp.projection_revision, sp.observed_at, sp.valid_until
  FROM alias_routes ar JOIN runtime_state rs ON rs.singleton = 1
  LEFT JOIN route_status_projection sp ON sp.route_id = ar.id
  WHERE ar.id = ?1 AND ar.enabled = 1 AND ar.policy_sha256 = ?2 AND rs.active_policy_sha256 = ?2 LIMIT 1`;
export const MCP_GENERATION_SQL = `SELECT ar.status_generation AS source_generation FROM alias_routes ar
  JOIN runtime_state rs ON rs.singleton = 1 WHERE ar.id = ?1 AND ar.enabled = 1
  AND ar.policy_sha256 = ?2 AND rs.active_policy_sha256 = ?2 LIMIT 1`;

/** Reads the existing generation-fenced projection; never refreshes or repairs it. */
export async function getDeliveryStatus(env: McpDataEnv, principal: McpPrincipal, id: string, clock: () => number, signal?: AbortSignal) {
  const active = await policy(env, signal), route = allowed(active, principal).find(row => routeId(row) === id);
  if (!route) throw new McpReadError("route_not_found_or_not_authorized");
  let row: StoredStatus | null;
  try { row = await env.DB.prepare(MCP_STATUS_SQL).bind(id, active.sha256).first<StoredStatus>(); }
  catch { throw new McpReadError("status_unavailable"); }
  if (!row) throw new McpReadError("policy_changed_or_status_unavailable");
  // A second complete parity check fences policy/recipient changes during the read.
  const current = await policy(env, signal);
  if (current.sha256 !== active.sha256 || !allowed(current, principal).some(candidate => routeId(candidate) === id)) throw new McpReadError("policy_changed");
  let latest: { source_generation: number } | null;
  try { latest = await env.DB.prepare(MCP_GENERATION_SQL).bind(id, active.sha256).first<{ source_generation: number }>(); }
  catch { throw new McpReadError("status_unavailable"); }
  signal?.throwIfAborted();
  if (!latest || latest.source_generation !== row.source_generation) throw new McpReadError("status_changed_during_read");
  const now = clock();
  const read = readRouteStatusProjection(row.projection_json, { policySha256: active.sha256, sourceGeneration: row.source_generation, now });
  if (read.status && (row.schema_version !== 1 || row.projection_revision !== read.status.projection_revision ||
      row.stored_generation !== row.source_generation || row.stored_policy !== active.sha256 ||
      row.observed_at !== read.status.observed_at || row.valid_until !== read.status.valid_until)) {
    read.state = "unknown"; read.status = null; read.reason = "operational_projection_binding_mismatch";
  }
  const status = read.status;
  return { schema_version: 1 as const, read_at: new Date(now).toISOString(), policy_sha256: active.sha256, route: descriptor(route),
    projection_state: read.state, operational_ready: operationalReadinessBlocker(read) === null, reason: read.reason,
    status: status ? { classification: status.classification, observed_at: status.observed_at, valid_until: status.valid_until,
      inbound_outcome: status.inbound_outcome, reply_outcome: status.reply_outcome, inbox_proof: status.inbox_proof, reply_proof: status.reply_proof,
      pending_dispatch: status.pending_dispatch, pending_queue: status.pending_queue, unknown_provider_attempts: status.unknown_provider_attempts,
      reason_codes: status.reason_codes, next_action: status.next_action } : null };
}
