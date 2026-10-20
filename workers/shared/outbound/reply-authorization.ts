import { atomicPolicyRouteBindings, atomicPolicyRouteMatchSql } from "../policy-inventory";
import type { MaildeskEnv as Env,OutboundReplyRequestedJob } from "../contracts";
import { normalizeMailbox as normalizeRelayMailbox,outboundRelayPayloadSha256 } from "../inbox-relay";
import { admissionTable,replyAuthorizationKind } from "../ordinary-reply";
import { resolveReplyTarget, type RouteDecision } from "../router";
import { configuredOutboundMode } from "./configuration";

export const CLAIMED_REPLY_SPOOL_SQL =
  "SELECT rat.id FROM relay_attempts rat JOIN reply_relays rr ON rr.id = rat.relay_id JOIN reply_admissions_all rad ON rad.claimed_attempt_id = rat.id WHERE rat.id = ?1 AND rat.relay_id = ?2 AND rat.operator = ?3 AND rat.operator_message_id = ?4 AND rat.raw_r2_key = ?5 AND rat.raw_sha256 = ?6 AND rat.status IN ('receiving', 'queued', 'authorized') AND rad.id = ?7 AND rad.transaction_sha256 = ?8 AND rad.claimed_attempt_sha256 = ?9 AND rad.claimed_payload_sha256 = ?10 AND rad.desired_state_sha256 = ?11 AND rad.identity_profile_sha256 = ?12 AND rad.admission_kind = ?13 AND (rad.activation_id IS ?14) AND (rad.status = 'claimed' OR (rad.status = 'sending' AND rad.sender_adapter = 'resend' AND julianday(rad.provider_boundary_at) > julianday('now', '-23 hours'))) AND julianday(rad.admitted_at) <= julianday('now') AND julianday(rad.expires_at) > julianday('now') AND rr.revoked_at IS NULL AND rr.superseded_by_relay_id IS NULL AND NOT EXISTS (SELECT 1 FROM active_route_reply_quarantines q WHERE q.route_id = rr.route_id) LIMIT 1";

export const AUTHORIZED_OUTBOUND_REPLY_SQL =
  "SELECT rat.id FROM relay_attempts rat JOIN reply_relays rr ON rr.id = rat.relay_id JOIN reply_admissions_all rad ON rad.claimed_attempt_id = rat.id JOIN alias_routes ar ON ar.id = rr.route_id JOIN domains d ON d.id = ar.domain_id JOIN runtime_state rs ON rs.singleton = 1 AND rs.active_policy_sha256 = ar.policy_sha256 JOIN policy_projection_state ps ON ps.key = 'active_desired_state_sha256' AND ps.value = rad.desired_state_sha256 JOIN audit_events ae ON ae.dedupe_key = ?9 AND ae.thread_id = rr.thread_id WHERE rat.id = ?1 AND rat.raw_r2_key = ?2 AND lower(rat.operator) = ?3 AND rat.status = 'authorized' AND rr.thread_id = ?4 AND lower(ar.local_part || '@' || d.domain) = ?5 AND lower(rr.external_recipient) = ?6 AND lower(rad.public_identity) = ?7 AND EXISTS (SELECT 1 FROM alias_route_reply_identities binding JOIN operators actor ON actor.id = binding.operator_id JOIN identities public_i ON public_i.id = binding.public_identity_id WHERE binding.route_id = ar.id AND binding.policy_sha256 = ar.policy_sha256 AND actor.email = rat.operator AND public_i.address = rad.public_identity) AND rr.revoked_at IS NULL AND rr.superseded_by_relay_id IS NULL AND julianday(rr.expires_at) > julianday('now') AND ar.enabled = 1 AND ar.policy_sha256 = ?8 AND rs.active_policy_sha256 = ?8 AND json_extract(ae.detail_json, '$.outboundPayloadSha256') = ?10 AND rad.id = ?11 AND rad.transaction_sha256 = ?12 AND rad.claimed_attempt_sha256 = ?13 AND rad.claimed_payload_sha256 = ?14 AND rad.desired_state_sha256 = ?15 AND rad.identity_profile_sha256 = ?16 AND rad.admission_kind = ?17 AND (rad.activation_id IS ?18) AND (rad.status = 'claimed' OR (rad.status = 'sending' AND rad.sender_adapter = 'resend' AND julianday(rad.provider_boundary_at) > julianday('now', '-23 hours'))) AND julianday(rad.admitted_at) <= julianday('now') AND julianday(rad.expires_at) > julianday('now') AND NOT EXISTS (SELECT 1 FROM active_route_reply_quarantines q WHERE q.route_id = rr.route_id) LIMIT 1";

export const OUTBOUND_REPLY_TARGET_CANDIDATES_SQL =
  "SELECT rr.external_recipient, lower(t.external_sender) AS thread_external_sender FROM relay_attempts rat JOIN reply_relays rr ON rr.id = rat.relay_id JOIN threads t ON t.id = rr.thread_id AND t.route_id = rr.route_id WHERE rat.id = ?1 AND rr.thread_id = ?2 LIMIT 1";

export const CLAIM_OUTBOUND_PROVIDER_BOUNDARY_SQL =
  "UPDATE reply_admissions SET status = 'sending', provider_boundary_at = COALESCE(provider_boundary_at, CURRENT_TIMESTAMP) WHERE id = ?1 AND transaction_sha256 = ?2 AND claimed_attempt_id = ?3 AND claimed_attempt_sha256 = ?4 AND claimed_payload_sha256 = ?5 AND desired_state_sha256 = ?6 AND identity_profile_sha256 = ?7 AND policy_sha256 = ?8 AND (status = 'claimed' OR (status = 'sending' AND sender_adapter = 'resend' AND ?10 = 'resend' AND julianday(provider_boundary_at) > julianday('now', '-23 hours'))) AND julianday(admitted_at) <= julianday('now') AND julianday(expires_at) > julianday('now') AND EXISTS (SELECT 1 FROM runtime_state rs WHERE rs.singleton = 1 AND rs.active_policy_sha256 = ?8) AND EXISTS (SELECT 1 FROM policy_projection_state ps WHERE ps.key = 'active_desired_state_sha256' AND ps.value = ?6) AND EXISTS (SELECT 1 FROM reply_relays rr WHERE rr.id = reply_admissions.relay_id AND rr.revoked_at IS NULL AND rr.superseded_by_relay_id IS NULL) AND EXISTS (SELECT 1 FROM reply_relays rr JOIN alias_routes ar ON ar.id = rr.route_id JOIN relay_attempts attempt ON attempt.id = reply_admissions.claimed_attempt_id JOIN operators actor ON actor.email = attempt.operator JOIN alias_route_reply_identities binding ON binding.route_id = ar.id AND binding.operator_id = actor.id AND binding.policy_sha256 = ar.policy_sha256 JOIN identities i ON i.id = binding.public_identity_id WHERE rr.id = reply_admissions.relay_id AND ar.enabled = 1 AND ar.policy_sha256 = ?8 AND i.address = reply_admissions.public_identity AND julianday(rr.expires_at) > julianday('now')) AND (SELECT json_group_array(email) FROM (SELECT o.email FROM alias_route_operators aro JOIN operators o ON o.id = aro.operator_id WHERE aro.route_id = reply_admissions.route_id ORDER BY o.email)) = ?9 AND NOT EXISTS (SELECT 1 FROM active_route_reply_quarantines q WHERE q.route_id = reply_admissions.route_id)" + " AND " + atomicPolicyRouteMatchSql("reply_admissions.route_id", 11);

export const CLAIM_ORDINARY_PROVIDER_BOUNDARY_SQL = CLAIM_OUTBOUND_PROVIDER_BOUNDARY_SQL
  .replaceAll("reply_admissions", "ordinary_reply_admissions") +
  " AND EXISTS (SELECT 1 FROM current_route_reply_authorizations a WHERE a.id = ordinary_reply_admissions.activation_id AND a.route_id = ordinary_reply_admissions.route_id AND a.policy_sha256 = ordinary_reply_admissions.policy_sha256 AND a.desired_state_sha256 = ordinary_reply_admissions.desired_state_sha256 AND a.identity_profile_sha256 = ordinary_reply_admissions.identity_profile_sha256 AND a.operator_set_sha256 = ordinary_reply_admissions.operator_set_sha256)";

export const OUTBOUND_CONTAINMENT_STATE_SQL =
  "SELECT CASE WHEN rr.revoked_at IS NOT NULL THEN 'relay_revoked' WHEN rr.superseded_by_relay_id IS NOT NULL THEN 'relay_superseded' WHEN EXISTS (SELECT 1 FROM active_route_reply_quarantines q WHERE q.route_id = rr.route_id) THEN 'route_quarantined' ELSE NULL END AS blocker FROM relay_attempts rat JOIN reply_relays rr ON rr.id = rat.relay_id JOIN reply_admissions_all rad ON rad.claimed_attempt_id = rat.id WHERE rat.id = ?1 AND rad.id = ?2 AND rad.transaction_sha256 = ?3 LIMIT 1";

export async function outboundContainmentBlocker(
  job: OutboundReplyRequestedJob,
  env: Env,
): Promise<string | null> {
  if (!job.relayAttemptId || !job.admissionId || !job.transactionSha256) {
    return "state_unavailable";
  }
  try {
    const row = await env.DB.prepare(OUTBOUND_CONTAINMENT_STATE_SQL)
      .bind(job.relayAttemptId, job.admissionId, job.transactionSha256)
      .first<{ blocker: string | null }>();
    return row?.blocker ?? null;
  } catch {
    return "state_unavailable";
  }
}

export function hasInboxRelayTransactionBindings(job: OutboundReplyRequestedJob): boolean {
  return Boolean(
    replyAuthorizationKind(job) &&
    job.admissionId?.trim() &&
    job.transactionSha256 && /^[a-f0-9]{64}$/.test(job.transactionSha256) &&
    job.attemptSha256 && /^[a-f0-9]{64}$/.test(job.attemptSha256) &&
    job.claimedPayloadSha256 && /^[a-f0-9]{64}$/.test(job.claimedPayloadSha256) &&
    job.desiredStateSha256 && /^[a-f0-9]{64}$/.test(job.desiredStateSha256) &&
    job.identityProfileSha256 && /^[a-f0-9]{64}$/.test(job.identityProfileSha256) &&
    job.relayAttemptId?.trim() &&
    job.relaySpoolKey?.trim() &&
    job.policySha256 && /^[a-f0-9]{64}$/.test(job.policySha256) &&
    job.identityProfileRef?.trim() &&
    job.signatureProfileRef?.trim() &&
    job.fromDisplayName?.trim() &&
    job.senderAdapter &&
    job.requestedIdentity?.trim(),
  );
}

export async function verifyAuthorizedOutboundTransaction(
  job: OutboundReplyRequestedJob,
  env: Env,
): Promise<string | null> {
  const expectedMessageId = job.relayAttemptId?.startsWith("relay-attempt:")
    ? job.relayAttemptId.slice("relay-attempt:".length)
    : null;
  if (
    job.to.length !== 1 ||
    (job.cc?.length ?? 0) !== 0 ||
    (job.bcc?.length ?? 0) !== 0 ||
    !expectedMessageId ||
    job.messageId !== expectedMessageId
  ) {
    return "inbox relay job does not match its durable transaction";
  }
  if (await outboundPayloadSha256(job) !== job.claimedPayloadSha256) {
    return "inbox relay payload does not match its controller admission claim";
  }
  const recipient = normalizeRelayMailbox(job.to[0]!);
  const operator = normalizeRelayMailbox(job.operator);
  const route = normalizeRelayMailbox(job.envelopeTo);
  const identity = normalizeRelayMailbox(job.fromIdentity);
  if (!recipient || !operator || !route || !identity) {
    return "inbox relay job does not match its durable transaction";
  }
  let targetRow: { external_recipient: string; thread_external_sender: string } | null;
  try {
    targetRow = await env.DB.prepare(OUTBOUND_REPLY_TARGET_CANDIDATES_SQL)
      .bind(job.relayAttemptId, job.threadId)
      .first<{ external_recipient: string; thread_external_sender: string }>();
  } catch {
    return "reply_target_unavailable";
  }
  const durableTarget = resolveReplyTarget(targetRow
    ? [targetRow.external_recipient, targetRow.thread_external_sender]
    : []);
  if (!durableTarget.ok) return durableTarget.error.kind;
  if (durableTarget.value.recipient !== recipient) return "reply_target_mismatch";
  let row: { id: string } | null;
  try {
    row = await env.DB.prepare(AUTHORIZED_OUTBOUND_REPLY_SQL)
      .bind(
        job.relayAttemptId,
        job.relaySpoolKey,
        operator,
        job.threadId,
        route,
        recipient,
        identity,
        job.policySha256,
        `${job.relayAttemptId}:inbox_reply_authorized`,
        await outboundPayloadSha256(job),
        job.admissionId,
        job.transactionSha256,
        job.attemptSha256,
        job.claimedPayloadSha256,
        job.desiredStateSha256,
        job.identityProfileSha256,
        replyAuthorizationKind(job), job.activationId ?? null,
      )
      .first<{ id: string }>();
  } catch {
    return "inbox relay durable transaction read is unavailable";
  }
  return row?.id === job.relayAttemptId
    ? null
    : "inbox relay job does not match its durable transaction";
}

export async function claimOutboundProviderBoundary(
  job: OutboundReplyRequestedJob,
  env: Env,
  expectedRoute: RouteDecision,
): Promise<boolean> {
  if (!hasInboxRelayTransactionBindings(job) || !job.policySha256) return false;
  const kind = replyAuthorizationKind(job);
  if (!kind) return false;
  const result = await env.DB.prepare(kind === "ordinary" ? CLAIM_ORDINARY_PROVIDER_BOUNDARY_SQL : CLAIM_OUTBOUND_PROVIDER_BOUNDARY_SQL)
      .bind(
        job.admissionId,
        job.transactionSha256,
        job.relayAttemptId,
        job.attemptSha256,
        job.claimedPayloadSha256,
        job.desiredStateSha256,
        job.identityProfileSha256,
        job.policySha256,
        JSON.stringify(expectedRoute.operators), configuredOutboundMode(env), ...atomicPolicyRouteBindings(expectedRoute),
      )
      .run();
  return Number(result.meta?.changes ?? 0) > 0;
}

export async function outboundPayloadSha256(
  payload: Pick<
    OutboundReplyRequestedJob,
    "subject" | "text" | "html" | "headers" | "attachments"
  >,
): Promise<string> {
  return outboundRelayPayloadSha256(payload);
}

/** A pre-boundary rejection may close only the still-unsent claim. A losing
 * consumer cannot replace the winning sender's pending or accepted outcome.
 */
export async function claimReplyFailureBeforeBoundary(job: OutboundReplyRequestedJob, env: Env): Promise<boolean> {
  const kind = replyAuthorizationKind(job);
  if (!kind || !job.admissionId || !job.relayAttemptId) return false;
  const result = await env.DB.prepare(`UPDATE ${admissionTable(kind)} SET status = 'failed',
    terminal_at = COALESCE(terminal_at, CURRENT_TIMESTAMP), error_code = 'pre_boundary_rejected'
    WHERE id = ?1 AND transaction_sha256 = ?2 AND claimed_attempt_id = ?3
      AND claimed_attempt_sha256 = ?4 AND claimed_payload_sha256 = ?5 AND status = 'claimed'`)
    .bind(job.admissionId, job.transactionSha256, job.relayAttemptId, job.attemptSha256, job.claimedPayloadSha256).run();
  // The PK predicate bounds this to one claim. D1 counts trigger side effects.
  return Number(result.meta?.changes ?? 0) > 0;
}
