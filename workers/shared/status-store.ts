import { operatorDeliveryConfig, type MaildeskEnv } from "./contracts";
import { loadActivePolicy } from "./policy-store";
import { policyStorageId } from "./policy-inventory";
import { publicIdentityProfileSha256, sha256Hex } from "./inbox-relay";
import { projectRouteStatus, proofMillis } from "./route-status";

interface StatusRow {
  route_id: string; source_generation: number; enabled: number; policy_sha256: string;
  desired_provider: string; inbound_status: string | null; reply_status: string | null;
  last_inbox_verified_at: string | null; last_reply_verified_at: string | null;
  activation_id: string | null; identity_profile_sha256: string | null; operator_set_sha256: string | null;
  runtime_artifacts_sha256: string | null; topology_sha256: string | null;
  activation_expires_at: string | null;
  pending_dispatch: number; pending_queue: number; unknown_provider_attempts: number; quarantined: number;
}

export const ROUTE_STATUS_INPUT_SQL = `SELECT ar.id AS route_id, ar.status_generation AS source_generation,
  ar.enabled, ar.policy_sha256, rh.desired_provider,
  COALESCE((SELECT d.status FROM inbound_deliveries d WHERE d.route_id = ar.id AND d.policy_sha256 = ar.policy_sha256
    AND d.status IN ('provider_accepted','partial_delivery','failed','recovery_required') ORDER BY julianday(d.received_at) DESC LIMIT 1), rh.inbound_status) AS inbound_status,
  COALESCE((SELECT rad.status FROM reply_admissions_all rad WHERE rad.route_id = ar.id AND rad.policy_sha256 = ar.policy_sha256
    AND rad.status IN ('sending','provider_accepted','failed','recovery_required') ORDER BY julianday(rad.admitted_at) DESC LIMIT 1), rh.reply_status) AS reply_status,
  COALESCE((SELECT p.verified_at FROM route_proofs p WHERE p.route_id = ar.id AND p.policy_sha256 = ar.policy_sha256
    AND p.proof_kind = 'inbox_verified' ORDER BY julianday(p.verified_at) DESC LIMIT 1), rh.last_inbox_verified_at) AS last_inbox_verified_at,
  COALESCE((SELECT p.verified_at FROM route_proofs p WHERE p.route_id = ar.id AND p.policy_sha256 = ar.policy_sha256
    AND p.proof_kind = 'reply_verified' ORDER BY julianday(p.verified_at) DESC LIMIT 1), rh.last_reply_verified_at) AS last_reply_verified_at,
  a.id AS activation_id, a.expires_at AS activation_expires_at,
  a.identity_profile_sha256, a.operator_set_sha256, a.runtime_artifacts_sha256, a.topology_sha256,
  EXISTS (SELECT 1 FROM active_route_reply_quarantines q WHERE q.route_id = ar.id) AS quarantined,
  (SELECT count(*) FROM relay_attempts rat JOIN reply_relays rr ON rr.id = rat.relay_id
    JOIN reply_admissions_all rad ON rad.claimed_attempt_id = rat.id
    WHERE rr.route_id = ar.id AND rat.status = 'receiving' AND rad.status = 'claimed') AS pending_dispatch,
  (SELECT count(*) FROM relay_attempts rat JOIN reply_relays rr ON rr.id = rat.relay_id
    JOIN reply_admissions_all rad ON rad.claimed_attempt_id = rat.id
    WHERE rr.route_id = ar.id AND rat.status IN ('queued','authorized') AND rad.status = 'claimed') AS pending_queue,
  (SELECT count(*) FROM relay_attempts rat JOIN reply_relays rr ON rr.id = rat.relay_id
    LEFT JOIN reply_admissions_all rad ON rad.claimed_attempt_id = rat.id
    WHERE rr.route_id = ar.id AND (rad.status = 'sending' OR rat.status = 'recovery_required')) AS unknown_provider_attempts
  FROM alias_routes ar JOIN route_health rh ON rh.route_id = ar.id
  LEFT JOIN current_route_reply_authorizations a ON a.route_id = ar.id
  WHERE ar.policy_sha256 = ?1 ORDER BY ar.id`;

/** Best-effort derived-state materialization. Losing a generation race leaves
 * the projection absent/unknown; it never overwrites newer evidence.
 */
export async function refreshRouteStatuses(env: MaildeskEnv, now = Date.now()): Promise<void> {
  const config = operatorDeliveryConfig(env);
  if (config.mode !== "inbox_relay") return;
  const active = await loadActivePolicy(env);
  if (!active) return;
  const data = await env.DB.prepare(ROUTE_STATUS_INPUT_SQL).bind(active.sha256).all<StatusRow>();
  if (!data.success || !data.results) throw new Error("status input unavailable");
  for (const row of data.results) {
    const route = active.projection.routes.find((entry) => policyStorageId("route", entry.domain, entry.localPart) === row.route_id);
    if (!route) continue;
    const activationMatches = route.identityProfile && row.activation_id &&
      row.identity_profile_sha256 === await publicIdentityProfileSha256(route.identityProfile) &&
      row.operator_set_sha256 === await sha256Hex(JSON.stringify(route.operators)) &&
      row.runtime_artifacts_sha256 === env.MAILDESK_RUNTIME_ARTIFACTS_SHA256 &&
      row.topology_sha256 === env.MAILDESK_TOPOLOGY_SHA256;
    const projection = projectRouteStatus({
      policySha256: active.sha256, sourceGeneration: row.source_generation,
      bindingCurrent: row.policy_sha256 === active.sha256, enabled: row.enabled === 1,
      routeKind: route.routeKind, enrollment: row.desired_provider === "excluded" ? "excluded" : "required",
      inboundProcessing: config.inboundProcessingMode === "invalid" ? "unknown" : config.inboundProcessingMode,
      replyProcessing: config.replyProcessingMode === "invalid" ? "unknown" : config.replyProcessingMode,
      ordinaryProcessing: env.MAILDESK_ORDINARY_REPLY_MODE === "enabled" ? "enabled" : "disabled",
      activationId: activationMatches ? row.activation_id : null, quarantined: row.quarantined === 1,
      inboundStatus: row.inbound_status, replyStatus: row.reply_status,
      inboxObservedAt: row.last_inbox_verified_at, replyObservedAt: row.last_reply_verified_at,
      pendingDispatch: row.pending_dispatch, pendingQueue: row.pending_queue,
      unknownProviderAttempts: row.unknown_provider_attempts,
    }, now);
    const expirations = [Date.parse(projection.valid_until),
      row.activation_expires_at ? Date.parse(row.activation_expires_at) : NaN,
      ...[row.last_inbox_verified_at, row.last_reply_verified_at].map((value) => {
        const time = proofMillis(value, now);
        return time === null ? NaN : time + 86_400_000;
      }),
    ].filter((time) => Number.isFinite(time) && time > now);
    projection.valid_until = new Date(Math.min(...expirations)).toISOString();
    await env.DB.prepare(`INSERT INTO route_status_projection
      (route_id, schema_version, projection_revision, source_generation, policy_sha256, observed_at, valid_until, projection_json)
      SELECT ?1, 1, ?2, ?3, ?4, ?5, ?6, ?7 FROM alias_routes ar JOIN runtime_state rs ON rs.singleton = 1
      WHERE ar.id = ?1 AND ar.status_generation = ?3 AND ar.policy_sha256 = ?4 AND rs.active_policy_sha256 = ?4
      ON CONFLICT(route_id) DO UPDATE SET schema_version = excluded.schema_version,
        projection_revision = excluded.projection_revision, source_generation = excluded.source_generation,
        policy_sha256 = excluded.policy_sha256, observed_at = excluded.observed_at,
        valid_until = excluded.valid_until, projection_json = excluded.projection_json`)
      .bind(row.route_id, projection.projection_revision, row.source_generation, active.sha256,
        projection.observed_at, projection.valid_until, JSON.stringify(projection)).run();
  }
}
