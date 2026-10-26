import { operatorDeliveryConfig, type MaildeskEnv } from "./contracts";
import { loadActivePolicy } from "./policy-store";
import { policyStorageId } from "./policy-inventory";
import { publicIdentityProfileSha256, sha256Hex } from "./inbox-relay";
import { projectRouteStatus, proofMillis } from "./route-status";
import type { RouteDecision } from "./router";

export const ROUTE_STATUS_REFRESH_PAGE_SIZE = 32;

export interface RouteStatusRefreshScope {
  routeIds?: readonly string[];
  afterRouteId?: string;
}

interface StatusRow {
  route_id: string; source_generation: number; enabled: number; policy_sha256: string;
  desired_provider: string; inbound_status: string | null; reply_status: string | null;
  last_inbox_verified_at: string | null; last_reply_verified_at: string | null;
  activation_id: string | null; identity_profile_sha256: string | null; operator_set_sha256: string | null;
  runtime_artifacts_sha256: string | null; topology_sha256: string | null;
  activation_expires_at: string | null;
  authorizations_json: string;
  pending_dispatch: number; pending_queue: number; unknown_provider_attempts: number; quarantined: number;
}

export const ROUTE_STATUS_INPUT_SQL = `SELECT ar.id AS route_id, ar.status_generation AS source_generation,
  ar.enabled, ar.policy_sha256, rh.desired_provider,
  COALESCE((SELECT CASE WHEN rd.status = 'pending' THEN 'pending' ELSE 'recovery_required' END
    FROM inbound_recipient_deliveries rd JOIN inbound_deliveries d ON d.id = rd.delivery_id
    WHERE d.route_id = ar.id AND d.policy_sha256 = ar.policy_sha256
      AND rd.status IN ('pending','sending','recovery_required')
    ORDER BY (rd.status != 'pending') DESC, julianday(d.received_at) DESC LIMIT 1),
    (SELECT d.status FROM inbound_deliveries d WHERE d.route_id = ar.id AND d.policy_sha256 = ar.policy_sha256
    ORDER BY julianday(d.received_at) DESC LIMIT 1), rh.inbound_status) AS inbound_status,
  COALESCE((SELECT rad.status FROM reply_admissions_all rad WHERE rad.route_id = ar.id AND rad.policy_sha256 = ar.policy_sha256
    AND rad.status IN ('sending','provider_accepted','failed','recovery_required') ORDER BY julianday(rad.admitted_at) DESC LIMIT 1), rh.reply_status) AS reply_status,
  COALESCE((SELECT p.verified_at FROM route_proofs p WHERE p.route_id = ar.id AND p.policy_sha256 = ar.policy_sha256
    AND p.proof_kind = 'inbox_verified' ORDER BY julianday(p.verified_at) DESC LIMIT 1), rh.last_inbox_verified_at) AS last_inbox_verified_at,
  COALESCE((SELECT p.verified_at FROM route_proofs p WHERE p.route_id = ar.id AND p.policy_sha256 = ar.policy_sha256
    AND p.proof_kind = 'reply_verified' ORDER BY julianday(p.verified_at) DESC LIMIT 1), rh.last_reply_verified_at) AS last_reply_verified_at,
  a.id AS activation_id, a.expires_at AS activation_expires_at,
  a.identity_profile_sha256, a.operator_set_sha256, a.runtime_artifacts_sha256, a.topology_sha256,
  (SELECT json_group_array(json_object('id', ca.id, 'public_identity', ca.public_identity,
    'identity_profile_sha256', ca.identity_profile_sha256, 'operator_set_sha256', ca.operator_set_sha256,
    'runtime_artifacts_sha256', ca.runtime_artifacts_sha256, 'topology_sha256', ca.topology_sha256,
    'sender_adapter', ca.sender_adapter, 'expires_at', ca.expires_at,
    'inbox_at', (SELECT p.verified_at FROM route_proofs p WHERE p.id = ca.inbox_proof_id),
    'reply_at', (SELECT p.verified_at FROM route_proofs p WHERE p.id = ca.reply_proof_id)))
    FROM current_route_reply_authorizations ca WHERE ca.route_id = ar.id) AS authorizations_json,
  EXISTS (SELECT 1 FROM active_route_reply_quarantines q WHERE q.route_id = ar.id) AS quarantined,
  (SELECT count(*) FROM relay_attempts rat JOIN reply_relays rr ON rr.id = rat.relay_id
    JOIN reply_admissions_all rad ON rad.claimed_attempt_id = rat.id
    WHERE rr.route_id = ar.id AND rat.status = 'receiving' AND rad.status = 'claimed') AS pending_dispatch,
  (SELECT count(*) FROM relay_attempts rat JOIN reply_relays rr ON rr.id = rat.relay_id
    JOIN reply_admissions_all rad ON rad.claimed_attempt_id = rat.id
    WHERE rr.route_id = ar.id AND rat.status IN ('queued','authorized') AND rad.status = 'claimed') AS pending_queue,
  ((SELECT count(*) FROM relay_attempts rat JOIN reply_relays rr ON rr.id = rat.relay_id
    LEFT JOIN reply_admissions_all rad ON rad.claimed_attempt_id = rat.id
    WHERE rr.route_id = ar.id AND (rad.status = 'sending' OR rat.status = 'recovery_required')) +
    (SELECT count(*) FROM inbound_recipient_deliveries rd JOIN inbound_deliveries d ON d.id = rd.delivery_id
    WHERE d.route_id = ar.id AND rd.status IN ('sending','recovery_required'))) AS unknown_provider_attempts
  FROM alias_routes ar JOIN route_health rh ON rh.route_id = ar.id
  LEFT JOIN current_route_reply_authorizations a ON a.id =
    (SELECT min(representative.id) FROM current_route_reply_authorizations representative WHERE representative.route_id = ar.id)
  WHERE ar.policy_sha256 = ?1 AND ar.id > ?2
    AND (?3 IS NULL OR ar.id IN (SELECT value FROM json_each(?3)))
  ORDER BY ar.id LIMIT ${ROUTE_STATUS_REFRESH_PAGE_SIZE + 1}`;

/** Best-effort derived-state materialization. Losing a generation race leaves
 * the projection absent/unknown; it never overwrites newer evidence.
 */
export async function refreshRouteStatuses(
  env: MaildeskEnv,
  now = Date.now(),
  scope: RouteStatusRefreshScope = {},
): Promise<{ refreshed: number; nextCursor: string | null }> {
  const empty = { refreshed: 0, nextCursor: null };
  const routeIds = scope.routeIds === undefined ? null : [...new Set(scope.routeIds)];
  if (routeIds && (routeIds.length > ROUTE_STATUS_REFRESH_PAGE_SIZE ||
      routeIds.some((id) => typeof id !== "string" || !id.startsWith("route:") || id.length > 1024))) {
    throw new Error("status refresh route scope is invalid");
  }
  if (routeIds?.length === 0) return empty;
  const config = operatorDeliveryConfig(env);
  if (config.mode !== "inbox_relay") return empty;
  // Full policy validation/parity remains mandatory even for a single route.
  const active = await loadActivePolicy(env);
  if (!active) return empty;
  const data = await env.DB.prepare(ROUTE_STATUS_INPUT_SQL)
    .bind(active.sha256, scope.afterRouteId ?? "", routeIds === null ? null : JSON.stringify(routeIds)).all<StatusRow>();
  if (!data.success || !data.results) throw new Error("status input unavailable");
  const routes = new Map(active.projection.routes.map((route) => [policyStorageId("route", route.domain, route.localPart), route]));
  const page = data.results.slice(0, ROUTE_STATUS_REFRESH_PAGE_SIZE);
  let refreshed = 0;
  for (const row of page) {
    const route = routes.get(row.route_id);
    if (!route) continue;
    const coverage = await completeActivationCoverage(route, row.authorizations_json, env, now);
    const inboxAt = route.operatorReplyIdentities ? coverage?.inboxAt ?? null : row.last_inbox_verified_at;
    const replyAt = route.operatorReplyIdentities ? coverage?.replyAt ?? null : row.last_reply_verified_at;
    const projection = projectRouteStatus({
      policySha256: active.sha256, sourceGeneration: row.source_generation,
      bindingCurrent: row.policy_sha256 === active.sha256, enabled: row.enabled === 1,
      routeKind: route.routeKind, enrollment: row.desired_provider === "excluded" ? "excluded" : "required",
      inboundProcessing: config.inboundProcessingMode === "invalid" ? "unknown" : config.inboundProcessingMode,
      replyProcessing: config.replyProcessingMode === "invalid" ? "unknown" : config.replyProcessingMode,
      ordinaryProcessing: env.MAILDESK_ORDINARY_REPLY_MODE === "enabled" ? "enabled" : "disabled",
      activationId: coverage?.representativeId ?? null, quarantined: row.quarantined === 1,
      inboundStatus: row.inbound_status, replyStatus: row.reply_status,
      inboxObservedAt: inboxAt, replyObservedAt: replyAt,
      pendingDispatch: row.pending_dispatch, pendingQueue: row.pending_queue,
      unknownProviderAttempts: row.unknown_provider_attempts,
    }, now);
    const expirations = [Date.parse(projection.valid_until),
      coverage?.expiresAt ?? NaN,
      ...[inboxAt, replyAt].map((value) => {
        const time = proofMillis(value, now);
        return time === null ? NaN : time + 86_400_000;
      }),
    ].filter((time) => Number.isFinite(time) && time > now);
    projection.valid_until = new Date(Math.min(...expirations)).toISOString();
    const saved = await env.DB.prepare(`INSERT INTO route_status_projection
      (route_id, schema_version, projection_revision, source_generation, policy_sha256, observed_at, valid_until, projection_json)
      SELECT ?1, 1, ?2, ?3, ?4, ?5, ?6, ?7 FROM alias_routes ar JOIN runtime_state rs ON rs.singleton = 1
      WHERE ar.id = ?1 AND ar.status_generation = ?3 AND ar.policy_sha256 = ?4 AND rs.active_policy_sha256 = ?4
      ON CONFLICT(route_id) DO UPDATE SET schema_version = excluded.schema_version,
        projection_revision = excluded.projection_revision, source_generation = excluded.source_generation,
        policy_sha256 = excluded.policy_sha256, observed_at = excluded.observed_at,
        valid_until = excluded.valid_until, projection_json = excluded.projection_json`)
      .bind(row.route_id, projection.projection_revision, row.source_generation, active.sha256,
        projection.observed_at, projection.valid_until, JSON.stringify(projection)).run();
    if (!saved.success) throw new Error("status projection persistence unavailable");
    if (Number(saved.meta?.changes ?? 0) > 0) refreshed++;
  }
  return { refreshed, nextCursor: data.results.length > ROUTE_STATUS_REFRESH_PAGE_SIZE ? page.at(-1)!.route_id : null };
}

/** A representative ID is exposed only when every distinct Rust-selected
 * public profile has a matching current activation. One operator is not a group.
 */
export async function completeActivationCoverage(route: RouteDecision, raw: string, env: MaildeskEnv, now: number) {
  const profiles = route.operatorReplyIdentities
    ? Object.values(route.operatorReplyIdentities).map((binding) => binding.identityProfile)
    : [route.identityProfile];
  if (!profiles.length || profiles.some((profile) => !profile)) return null;
  const expected = new Map(profiles.map((profile) => [profile!.publicAddress, profile!]));
  let rows: Array<Record<string, unknown>>;
  try { rows = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(rows) || rows.length !== expected.size) return null;
  const operatorSha = await sha256Hex(JSON.stringify(route.operators));
  const ids: string[] = [], expirations: number[] = [], inboxes: Array<number | null> = [], replies: Array<number | null> = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Object.keys(row).sort().join(",") !==
        "expires_at,id,identity_profile_sha256,inbox_at,operator_set_sha256,public_identity,reply_at,runtime_artifacts_sha256,sender_adapter,topology_sha256") return null;
    const profile = expected.get(String(row.public_identity));
    if (!profile || typeof row.id !== "string" || !/^[a-zA-Z0-9:._-]{1,160}$/.test(row.id) ||
        row.identity_profile_sha256 !== await publicIdentityProfileSha256(profile) || row.operator_set_sha256 !== operatorSha ||
        row.runtime_artifacts_sha256 !== env.MAILDESK_RUNTIME_ARTIFACTS_SHA256 || row.topology_sha256 !== env.MAILDESK_TOPOLOGY_SHA256 ||
        row.sender_adapter !== profile.senderAdapter || row.sender_adapter !== env.MAILDESK_OUTBOUND_MODE) return null;
    if (row.expires_at !== null) {
      if (typeof row.expires_at !== "string" || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= now) return null;
      expirations.push(Date.parse(row.expires_at));
    }
    ids.push(row.id); expected.delete(profile.publicAddress);
    inboxes.push(typeof row.inbox_at === "string" ? proofMillis(row.inbox_at, now) : null);
    replies.push(typeof row.reply_at === "string" ? proofMillis(row.reply_at, now) : null);
  }
  const oldest = (times: Array<number | null>) => times.some((time) => time === null) ? null : new Date(Math.min(...times as number[])).toISOString();
  return { representativeId: ids.sort()[0]!, expiresAt: expirations.length ? Math.min(...expirations) : null,
    inboxAt: oldest(inboxes), replyAt: oldest(replies) };
}
