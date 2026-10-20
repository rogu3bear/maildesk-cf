import { atomicPolicyRouteBindings, atomicPolicyRouteMatchSql } from "./policy-inventory";
import type { RouteDecision } from "./router";
import { relaySpoolKey, type MaildeskEnv as Env } from "./contracts";
import { normalizeMailbox, relayRecordIsActive, sha256Hex } from "./inbox-relay";
import { recordAudit } from "./ingress-audit";

export const ACTIVE_REPLY_ADMISSION_SQL =
  "SELECT ra.id, ra.transaction_sha256, ra.desired_state_sha256, ra.identity_profile_sha256 FROM reply_admissions ra JOIN reply_relays rr ON rr.id = ra.relay_id JOIN inbound_deliveries idl ON idl.id = ra.inbound_delivery_id AND idl.relay_id = rr.id AND idl.thread_id = rr.thread_id AND idl.route_id = rr.route_id AND idl.policy_sha256 = ra.policy_sha256 JOIN alias_routes ar ON ar.id = rr.route_id JOIN runtime_state rs ON rs.singleton = 1 AND rs.active_policy_sha256 = ra.policy_sha256 AND rs.active_policy_sha256 = ar.policy_sha256 JOIN policy_projection_state ps ON ps.key = 'active_desired_state_sha256' AND ps.value = ra.desired_state_sha256 WHERE ra.relay_id = ?1 AND ra.thread_id = rr.thread_id AND ra.route_id = rr.route_id AND ra.admitted_operator_ref = ?2 AND ra.operator_set_sha256 = ?3 AND ra.identity_profile_sha256 = ?4 AND lower(ra.public_identity) = ?5 AND ra.policy_sha256 = ?6 AND ra.status = 'admitted' AND julianday(ra.admitted_at) <= julianday('now') AND julianday(ra.expires_at) > julianday('now') AND rr.revoked_at IS NULL AND rr.superseded_by_relay_id IS NULL AND julianday(rr.expires_at) > julianday('now') AND ar.enabled = 1 AND NOT EXISTS (SELECT 1 FROM active_route_reply_quarantines q WHERE q.route_id = rr.route_id) LIMIT 1";

export const INSERT_ADMITTED_RELAY_ATTEMPT_SQL = `INSERT INTO relay_attempts
  (id, relay_id, operator, operator_message_id, raw_r2_key, raw_sha256, status,
   identity_version, payload_version, admission_kind, admission_id, transaction_sha256, attempt_sha256,
   claimed_payload_sha256, desired_state_sha256, identity_profile_sha256, policy_sha256,
   operator_ref, operator_set_sha256, dispatch_received_at)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'receiving', 2, 2, 'canary', ra.id,
    ra.transaction_sha256, ?9, ?10, ra.desired_state_sha256, ra.identity_profile_sha256,
    ra.policy_sha256, ra.admitted_operator_ref, ra.operator_set_sha256, ?11
  FROM reply_admissions ra JOIN reply_relays rr ON rr.id = ra.relay_id
  JOIN runtime_state rs ON rs.singleton = 1 AND rs.active_policy_sha256 = ra.policy_sha256
  JOIN policy_projection_state ps ON ps.key = 'active_desired_state_sha256' AND ps.value = ra.desired_state_sha256
  WHERE ra.id = ?7 AND ra.transaction_sha256 = ?8 AND ra.relay_id = ?2
    AND ra.status = 'admitted' AND julianday(ra.admitted_at) <= julianday('now')
    AND julianday(ra.expires_at) > julianday('now')
    AND rr.revoked_at IS NULL AND rr.superseded_by_relay_id IS NULL
    AND ${atomicPolicyRouteMatchSql("ra.route_id", 12)}
    AND NOT EXISTS (SELECT 1 FROM active_route_reply_quarantines q WHERE q.route_id = ra.route_id)`;

export const CLAIM_REPLY_ADMISSION_SQL =
  "UPDATE reply_admissions SET status = 'claimed', claimed_attempt_id = ?2, claimed_attempt_sha256 = ?3, claimed_payload_sha256 = ?4, claimed_at = CURRENT_TIMESTAMP WHERE id = ?1 AND transaction_sha256 = ?5 AND policy_sha256 = ?6 AND desired_state_sha256 = ?7 AND status = 'admitted' AND julianday(admitted_at) <= julianday('now') AND julianday(expires_at) > julianday('now') AND EXISTS (SELECT 1 FROM runtime_state rs WHERE rs.singleton = 1 AND rs.active_policy_sha256 = ?6) AND EXISTS (SELECT 1 FROM policy_projection_state ps WHERE ps.key = 'active_desired_state_sha256' AND ps.value = ?7) AND EXISTS (SELECT 1 FROM reply_relays rr WHERE rr.id = reply_admissions.relay_id AND rr.revoked_at IS NULL AND rr.superseded_by_relay_id IS NULL) AND NOT EXISTS (SELECT 1 FROM active_route_reply_quarantines q WHERE q.route_id = reply_admissions.route_id)";

export const RELAY_CONTAINMENT_BY_TOKEN_SQL =
  "SELECT CASE WHEN rr.revoked_at IS NOT NULL THEN 'relay_revoked' WHEN rr.superseded_by_relay_id IS NOT NULL THEN 'relay_superseded' WHEN EXISTS (SELECT 1 FROM active_route_reply_quarantines q WHERE q.route_id = rr.route_id) THEN 'route_quarantined' ELSE NULL END AS blocker FROM reply_relays rr WHERE rr.token_sha256 = ?1 LIMIT 1";

export const EXACT_DUPLICATE_REPLY_CLAIM_SQL =
  "SELECT rat.status, rat.raw_r2_key, rat.raw_sha256 FROM relay_attempts rat JOIN reply_admissions_all rad ON rad.claimed_attempt_id = rat.id WHERE rat.id = ?1 AND rat.relay_id = ?2 AND lower(rat.operator) = ?3 AND rat.operator_message_id = ?4 AND rat.raw_sha256 = ?5 AND rad.id = ?6 AND rad.transaction_sha256 = ?7 AND rad.claimed_attempt_sha256 = ?8 AND rad.claimed_payload_sha256 = ?9 AND rad.desired_state_sha256 = ?10 AND rad.identity_profile_sha256 = ?11 AND rad.status IN ('claimed', 'sending', 'provider_accepted', 'failed', 'recovery_required') AND julianday(rad.admitted_at) <= julianday('now') LIMIT 1";

export async function loadActiveRelay(tokenHash: string, env: Env): Promise<ReplyRelayRow | null> {
  const relay = await env.DB.prepare(
    "SELECT rr.id, rr.thread_id, rr.route_id, rr.external_recipient, lower(t.external_sender) AS thread_external_sender, rr.reply_identity, rr.original_message_id, rr.references_json, rr.expires_at, rr.revoked_at, lower(ar.local_part || '@' || d.domain) AS route_address FROM reply_relays rr JOIN threads t ON t.id = rr.thread_id AND t.route_id = rr.route_id JOIN alias_routes ar ON ar.id = rr.route_id JOIN domains d ON d.id = ar.domain_id JOIN runtime_state rs ON rs.singleton = 1 AND rs.active_policy_sha256 = ar.policy_sha256 WHERE rr.token_sha256 = ?1 AND rr.revoked_at IS NULL AND rr.superseded_by_relay_id IS NULL AND ar.enabled = 1 AND NOT EXISTS (SELECT 1 FROM active_route_reply_quarantines q WHERE q.route_id = rr.route_id) LIMIT 1",
  )
    .bind(tokenHash)
    .first<ReplyRelayRow>();
  if (!relay || !relayRecordIsActive(relay.expires_at, relay.revoked_at)) return null;
  return relay;
}

export async function loadRelayContainmentBlocker(tokenHash: string, env: Env): Promise<string | null> {
  try {
    const row = await env.DB.prepare(RELAY_CONTAINMENT_BY_TOKEN_SQL)
      .bind(tokenHash)
      .first<{ blocker: string | null }>();
    return row?.blocker ?? null;
  } catch {
    return "containment_state_unavailable";
  }
}

export async function loadActiveReplyAdmission(
  input: {
    relayId: string;
    operatorRef: string;
    operatorSetSha256: string;
    identityProfileSha256: string;
    publicIdentity: string;
    policySha256: string;
  },
  env: Env,
): Promise<ReplyAdmissionRow | null> {
  return env.DB.prepare(ACTIVE_REPLY_ADMISSION_SQL)
    .bind(
      input.relayId,
      input.operatorRef,
      input.operatorSetSha256,
      input.identityProfileSha256,
      normalizeMailbox(input.publicIdentity),
      input.policySha256,
    )
    .first<ReplyAdmissionRow>();
}

export async function claimRelayAttemptAndAdmission(
  input: {
    attemptId: string;
    relay: ReplyRelayRow;
    operator: string;
    operatorMessageId: string;
    rawR2Key: string;
    rawSha256: string;
    claimedPayloadSha256: string;
    attemptSha256: string;
    admission: ReplyAdmissionRow;
    policySha256: string;
    expectedRoute: RouteDecision;
    receivedAt: string;
  },
  env: Env,
): Promise<RelayAttemptRow | null> {
  const result = await env.DB.prepare(INSERT_ADMITTED_RELAY_ATTEMPT_SQL).bind(
    input.attemptId, input.relay.id, input.operator, input.operatorMessageId,
    input.rawR2Key, input.rawSha256, input.admission.id, input.admission.transaction_sha256,
    input.attemptSha256, input.claimedPayloadSha256, input.receivedAt, ...atomicPolicyRouteBindings(input.expectedRoute),
  ).run();
  if (Number(result.meta?.changes ?? 0) === 0) return null;
  return {
    status: "receiving",
    raw_r2_key: input.rawR2Key,
    raw_sha256: input.rawSha256,
  };
}

export function relayConversationHeaders(relay: ReplyRelayRow): Record<string, string> {
  const references = storedRelayReferences(relay.references_json);
  if (relay.original_message_id && isValidRelayMessageId(relay.original_message_id)) {
    references.push(relay.original_message_id);
  }
  const headers: Record<string, string> = {};
  if (relay.original_message_id && isValidRelayMessageId(relay.original_message_id)) {
    headers["In-Reply-To"] = relay.original_message_id;
  }
  if (references.length > 0) headers.References = [...new Set(references)].join(" ");
  return headers;
}

function storedRelayReferences(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && isValidRelayMessageId(entry))
      : [];
  } catch {
    return [];
  }
}

function isValidRelayMessageId(value: string): boolean {
  return value.length <= 998 && /^<[^<>\s]+>$/.test(value);
}

export async function loadRelayAttempt(attemptId: string, env: Env): Promise<RelayAttemptRow | null> {
  return env.DB.prepare(
    "SELECT status, raw_r2_key, raw_sha256 FROM relay_attempts WHERE id = ?1 LIMIT 1",
  )
    .bind(attemptId)
    .first<RelayAttemptRow>();
}

export function replyAttemptStagingKey(attemptId: string, receivedAt: string, nonce = crypto.randomUUID()): string {
  return relaySpoolKey(`${attemptId}.${nonce}`, receivedAt);
}

export async function loadExactDuplicateReplyClaim(
  input: {
    attemptId: string;
    relay: ReplyRelayRow;
    operator: string;
    operatorMessageId: string;
    rawSha256: string;
    claimedPayloadSha256: string;
    attemptSha256: string;
    admission: ReplyAdmissionRow;
  },
  env: Env,
): Promise<RelayAttemptRow | null> {
  return env.DB.prepare(EXACT_DUPLICATE_REPLY_CLAIM_SQL)
    .bind(
      input.attemptId, input.relay.id, normalizeMailbox(input.operator), input.operatorMessageId,
      input.rawSha256, input.admission.id, input.admission.transaction_sha256,
      input.attemptSha256, input.claimedPayloadSha256, input.admission.desired_state_sha256,
      input.admission.identity_profile_sha256,
    )
    .first<RelayAttemptRow>();
}

export async function recordReplyDuplicateSuppressed(
  attemptId: string,
  relay: ReplyRelayRow,
  admission: ReplyAdmissionRow,
  attemptSha256: string,
  operator: string,
  env: Env,
): Promise<void> {
  await recordAudit(
    env,
    `${attemptId}:inbox_reply_duplicate_suppressed`,
    relay.thread_id,
    `operator:${await sha256Hex(normalizeMailbox(operator))}`,
    "inbox_reply_duplicate_suppressed",
    {
      attemptId,
      relayId: relay.id,
      transactionSha256: admission.transaction_sha256,
      attemptSha256,
      outcome: "duplicate_suppressed",
      providerReplay: false,
    },
  );
}

export interface ReplyRelayRow {
  id: string;
  thread_id: string;
  route_id: string;
  route_address: string;
  external_recipient: string;
  thread_external_sender: string;
  reply_identity: string;
  original_message_id: string | null;
  references_json: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface RelayAttemptRow {
  status: "receiving" | "queued" | "authorized" | "provider_accepted" | "failed" | "recovery_required";
  raw_r2_key: string | null;
  raw_sha256: string | null;
}

export interface ReplyAdmissionRow {
  id: string;
  transaction_sha256: string;
  desired_state_sha256: string;
  identity_profile_sha256: string;
}

/** Reading a historical relay establishes identity for reconciliation only. */
export async function loadRelayForReconciliation(tokenHash: string, env: Env): Promise<ReplyRelayRow | null> {
  return env.DB.prepare(`SELECT rr.id, rr.thread_id, rr.route_id, rr.external_recipient,
    lower(t.external_sender) AS thread_external_sender, rr.reply_identity, rr.original_message_id,
    rr.references_json, rr.expires_at, rr.revoked_at, ar.local_part || '@' || d.domain AS route_address
    FROM reply_relays rr JOIN threads t ON t.id = rr.thread_id AND t.route_id = rr.route_id
    JOIN alias_routes ar ON ar.id = rr.route_id JOIN domains d ON d.id = ar.domain_id
    WHERE rr.token_sha256 = ?1 LIMIT 1`).bind(tokenHash).first<ReplyRelayRow>();
}
