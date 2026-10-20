import { loadOrdinaryRouteAuthorization } from "./ordinary-reply";
import { operatorDeliveryConfig, type InboxReplyReceivedJob, type MaildeskEnv } from "./contracts";
import { loadActivePolicy } from "./policy-store";
import { authorizeReplyWithPolicy } from "./router";
import { normalizeMailbox, publicIdentityProfileSha256, sha256Hex } from "./inbox-relay";

export interface StoredReplyClaim {
  id: string;
  relay_id: string;
  thread_id: string;
  route_id: string;
  route_address: string;
  operator: string;
  operator_message_id: string;
  raw_r2_key: string | null;
  raw_sha256: string;
  status: string;
  admission_kind: "canary" | "ordinary";
  admission_id: string;
  activation_id: string | null;
  transaction_sha256: string;
  attempt_sha256: string;
  claimed_payload_sha256: string;
  desired_state_sha256: string;
  identity_profile_sha256: string;
  policy_sha256: string;
  operator_set_sha256: string;
  dispatch_received_at: string;
  public_identity: string;
  admission_status: string;
  expires_at: string;
  admitted_at: string;
  identity_version: 1 | 2;
  payload_version: 1 | 2;
}

export const STORED_REPLY_CLAIM_SQL = `SELECT rat.*, rad.thread_id, rad.route_id, rad.activation_id,
  ar.local_part || '@' || d.domain AS route_address, rad.public_identity,
  rad.status AS admission_status, rad.admitted_at, rad.expires_at
  FROM relay_attempts rat JOIN reply_admissions_all rad ON rad.claimed_attempt_id = rat.id
    AND rad.id = rat.admission_id AND rad.admission_kind = rat.admission_kind
    AND rad.transaction_sha256 = rat.transaction_sha256
    AND rad.claimed_attempt_sha256 = rat.attempt_sha256
    AND rad.claimed_payload_sha256 = rat.claimed_payload_sha256
  JOIN alias_routes ar ON ar.id = rad.route_id JOIN domains d ON d.id = ar.domain_id
  WHERE rat.id = ?1 LIMIT 1`;

export async function loadStoredReplyClaim(attemptId: string, env: Pick<MaildeskEnv, "DB">): Promise<StoredReplyClaim | null> {
  return env.DB.prepare(STORED_REPLY_CLAIM_SQL).bind(attemptId).first<StoredReplyClaim>();
}

export function isExactReplyRedelivery(
  claim: StoredReplyClaim, input: { relayId: string; operator: string; messageId: string; rawSha256: string },
): boolean {
  return claim.relay_id === input.relayId && normalizeMailbox(claim.operator) === input.operator &&
    claim.operator_message_id === input.messageId && claim.raw_sha256 === input.rawSha256;
}

export const PENDING_REPLY_DISPATCH_SQL = `SELECT rat.id FROM relay_attempts rat
  JOIN reply_admissions_all rad ON rad.claimed_attempt_id = rat.id AND rad.id = rat.admission_id
  JOIN reply_relays rr ON rr.id = rat.relay_id
  JOIN alias_routes ar ON ar.id = rr.route_id
  JOIN runtime_state rs ON rs.singleton = 1 AND rs.active_policy_sha256 = rad.policy_sha256
  JOIN policy_projection_state ps ON ps.key = 'active_desired_state_sha256' AND ps.value = rad.desired_state_sha256
  WHERE rat.id = ?1 AND rat.status IN ('receiving', 'queued', 'authorized') AND rad.status = 'claimed'
    AND rat.raw_r2_key IS NOT NULL AND rat.policy_sha256 = rad.policy_sha256
    AND rad.admission_kind = rat.admission_kind AND rat.transaction_sha256 = rad.transaction_sha256
    AND rat.attempt_sha256 = rad.claimed_attempt_sha256 AND rat.claimed_payload_sha256 = rad.claimed_payload_sha256
    AND julianday(rad.admitted_at) <= julianday('now') AND julianday(rad.expires_at) > julianday('now')
    AND rr.revoked_at IS NULL AND rr.superseded_by_relay_id IS NULL AND julianday(rr.expires_at) > julianday('now')
    AND ar.enabled = 1 AND ar.policy_sha256 = rad.policy_sha256
    AND NOT EXISTS (SELECT 1 FROM active_route_reply_quarantines q WHERE q.route_id = rr.route_id)`;

export type DispatchRecoveryResult = {
  state: "queued" | "dispatch_unconfirmed" | "reconciliation_required" | "blocked";
  reason: string;
  providerCallPerformed: false;
};

/** Only a durable claim ID is accepted. Queue payload and storage keys are rebuilt
 * from immutable rows. This is an app-side operation, not a remote redrive client.
 */
export async function recoverKnownUnsentDispatch(attemptId: string, env: MaildeskEnv): Promise<DispatchRecoveryResult> {
  const result = (state: DispatchRecoveryResult["state"], reason: string): DispatchRecoveryResult =>
    ({ state, reason, providerCallPerformed: false });
  if (!/^relay-attempt:[a-f0-9]{64}$/.test(attemptId)) return result("blocked", "invalid_claim_id");
  if (operatorDeliveryConfig(env).mode !== "inbox_relay" ||
      operatorDeliveryConfig(env).replyProcessingMode !== "enabled") return result("blocked", "reply_processing_disabled");
  const claim = await loadStoredReplyClaim(attemptId, env);
  if (!claim) return result("blocked", "immutable_claim_missing");
  if (!["receiving", "queued", "authorized"].includes(claim.status) || claim.admission_status !== "claimed") {
    return result("reconciliation_required", "claim_already_crossed_or_terminal");
  }
  const active = await loadActivePolicy(env);
  if (!active || active.sha256 !== claim.policy_sha256) return result("blocked", "policy_binding_changed");
  const authorized = authorizeReplyWithPolicy(active.policy, {
    envelopeTo: claim.route_address, operator: claim.operator, requestedIdentity: claim.public_identity,
  });
  const route = active.projection.routes.find((row) => `${row.localPart}@${row.domain}` === claim.route_address);
  if (!authorized.ok || !authorized.value.identityProfile || !route ||
      await publicIdentityProfileSha256(authorized.value.identityProfile) !== claim.identity_profile_sha256 ||
      await sha256Hex(JSON.stringify(route.operators)) !== claim.operator_set_sha256 ||
      authorized.value.identityProfile.senderAdapter !== env.MAILDESK_OUTBOUND_MODE) {
    return result("blocked", "current_authorization_mismatch");
  }
  if (claim.admission_kind === "ordinary") {
    const activation = await loadOrdinaryRouteAuthorization({ routeId: claim.route_id,
      policySha256: claim.policy_sha256, identityProfileSha256: claim.identity_profile_sha256,
      operatorSetSha256: claim.operator_set_sha256 }, env);
    if (activation?.id !== claim.activation_id) return result("blocked", "ordinary_activation_unavailable");
  }
  if (!claim.raw_r2_key || !env.RELAY_SPOOL || !env.MAIL_JOBS) return result("blocked", "dispatch_storage_unavailable");
  const object = await env.RELAY_SPOOL.get(claim.raw_r2_key);
  if (!object || object.size > operatorDeliveryConfig(env).maxEncodedMessageBytes ||
      await sha256Hex(await object.arrayBuffer()) !== claim.raw_sha256) return result("blocked", "dispatch_spool_unavailable");
  const pending = await env.DB.prepare(PENDING_REPLY_DISPATCH_SQL).bind(attemptId).first<{ id: string }>();
  if (!pending) return result("blocked", "dispatch_safety_changed");
  const job: InboxReplyReceivedJob = {
    kind: "inbox_reply_received", schemaVersion: 2, payloadVersion: claim.payload_version, admissionKind: claim.admission_kind,
    ...(claim.admission_kind === "ordinary" && claim.activation_id ? { activationId: claim.activation_id } : {}),
    attemptId: claim.id,
    admissionId: claim.admission_id, transactionSha256: claim.transaction_sha256,
    attemptSha256: claim.attempt_sha256, claimedPayloadSha256: claim.claimed_payload_sha256,
    desiredStateSha256: claim.desired_state_sha256, identityProfileSha256: claim.identity_profile_sha256,
    relayId: claim.relay_id, operator: claim.operator, operatorMessageId: claim.operator_message_id,
    rawR2Key: claim.raw_r2_key, rawSha256: claim.raw_sha256, receivedAt: claim.dispatch_received_at,
  };
  try { await env.MAIL_JOBS.send(job); }
  catch { return result("dispatch_unconfirmed", "queue_acceptance_unknown"); }
  try {
    await env.DB.prepare("UPDATE relay_attempts SET status = 'queued', updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND status = 'receiving'")
      .bind(claim.id).run();
  } catch { return result("dispatch_unconfirmed", "queue_accepted_journal_pending"); }
  return result("queued", "durable_dispatch_submitted");
}
