import type { MaildeskEnv, OperatorAuthenticationResult } from "./contracts";
import { sha256Hex } from "./inbox-relay";
import { policyStorageId, atomicPolicyRouteBindings, atomicPolicyRouteMatchSql } from "./policy-inventory";
import type { ReplyRelayRow } from "./reply-repository";
import type { ResolvedIdentityProfile, RouteDecision } from "./router";

export interface RouteReplyAuthorization {
  id: string;
  route_id: string;
  policy_sha256: string;
  desired_state_sha256: string;
  public_identity: string;
  identity_profile_ref: string;
  identity_profile_sha256: string;
  operator_set_sha256: string;
  sender_adapter: "cloudflare_email_service" | "resend";
  sender_domain: string;
  runtime_artifacts_sha256: string;
  topology_sha256: string;
  activated_at: string;
  expires_at: string | null;
}

export async function loadOrdinaryRouteAuthorization(input: {
  routeId: string; policySha256: string; identityProfileSha256: string; operatorSetSha256: string;
}, env: MaildeskEnv): Promise<RouteReplyAuthorization | null> {
  if (env.MAILDESK_ORDINARY_REPLY_MODE !== "enabled" ||
      !/^[a-f0-9]{64}$/.test(env.MAILDESK_RUNTIME_ARTIFACTS_SHA256 ?? "") ||
      !/^[a-f0-9]{64}$/.test(env.MAILDESK_TOPOLOGY_SHA256 ?? "")) return null;
  return env.DB.prepare(`SELECT * FROM current_route_reply_authorizations
    WHERE route_id = ?1 AND policy_sha256 = ?2 AND identity_profile_sha256 = ?3
      AND operator_set_sha256 = ?4 AND sender_adapter = ?5
      AND runtime_artifacts_sha256 = ?6 AND topology_sha256 = ?7 LIMIT 1`)
    .bind(input.routeId, input.policySha256, input.identityProfileSha256, input.operatorSetSha256,
      env.MAILDESK_OUTBOUND_MODE, env.MAILDESK_RUNTIME_ARTIFACTS_SHA256, env.MAILDESK_TOPOLOGY_SHA256)
    .first<RouteReplyAuthorization>();
}

export async function claimOrdinaryReply(input: {
  activation: RouteReplyAuthorization; relay: ReplyRelayRow; profile: ResolvedIdentityProfile;
  authentication: OperatorAuthenticationResult; operator: string; operatorRef: string;
  attemptId: string; messageId: string; rawSha256: string; rawR2Key: string;
  payloadSha256: string; receivedAt: string; expectedRoute: RouteDecision;
}, env: MaildeskEnv): Promise<void> {
  const { activation, relay, profile, authentication } = input;
  if (authentication.status !== "verified" || !authentication.ordinaryBinding ||
      authentication.ordinaryBinding.messageIdSha256 !== await sha256Hex(input.messageId)) {
    throw new Error("ordinary message signing shape is unsupported");
  }
  const expiresAt = new Date(Math.min(Date.parse(relay.expires_at),
    activation.expires_at ? Date.parse(activation.expires_at) : Number.POSITIVE_INFINITY)).toISOString();
  const transactionSha256 = await sha256Hex(JSON.stringify({
    schema_version: 2, admission_kind: "ordinary", activation_id: activation.id,
    relay_id: relay.id, thread_id: relay.thread_id, route_id: relay.route_id,
    operator_ref: input.operatorRef, raw_sha256: input.rawSha256,
    message_id_sha256: authentication.ordinaryBinding.messageIdSha256,
    signed_recipient_sha256: authentication.ordinaryBinding.recipientSha256,
    claimed_payload_sha256: input.payloadSha256, external_recipient: relay.external_recipient,
    identity_profile_sha256: activation.identity_profile_sha256,
    policy_sha256: activation.policy_sha256, desired_state_sha256: activation.desired_state_sha256,
    sender_adapter: activation.sender_adapter, admitted_at: input.receivedAt, expires_at: expiresAt,
  }));
  const attemptSha256 = await sha256Hex(`maildesk-reply-attempt-v2\0${transactionSha256}\0${authentication.ordinaryBinding.messageIdSha256}\0${input.rawSha256}\0${input.payloadSha256}`);
  // This single statement's AFTER INSERT trigger also creates the dispatch row.
  await env.DB.prepare(`INSERT INTO ordinary_reply_admissions (
    id, schema_version, admission_kind, activation_id, transaction_sha256,
    relay_id, thread_id, route_id, policy_sha256, desired_state_sha256,
    operator_set_sha256, admitted_operator_ref, operator_id, public_identity, sender_domain,
    identity_profile_ref, identity_profile_sha256, display_name, signature_profile_ref,
    signature_sha256, sender_adapter, authenticated_raw_sha256, authenticated_message_id_sha256,
    signed_recipient_sha256, operator_message_id, raw_r2_key, external_recipient,
    admitted_at, expires_at, status, claimed_attempt_id, claimed_attempt_sha256, claimed_payload_sha256, claimed_at
  ) SELECT ?1, 2, 'ordinary', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
    ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, 'claimed', ?28, ?29, ?30, ?26
    WHERE EXISTS (SELECT 1 FROM current_route_reply_authorizations WHERE id = ?2)
      AND ${atomicPolicyRouteMatchSql("?6", 31)}`)
    .bind(`ordinary-admission:${transactionSha256}`, activation.id, transactionSha256,
      relay.id, relay.thread_id, relay.route_id, activation.policy_sha256, activation.desired_state_sha256,
      activation.operator_set_sha256, input.operatorRef, policyStorageId("operator", input.operator),
      relay.reply_identity, activation.sender_domain, profile.profileRef, activation.identity_profile_sha256,
      profile.displayName, profile.signatureProfileRef, await sha256Hex(profile.signatureText),
      profile.senderAdapter, input.rawSha256, authentication.ordinaryBinding.messageIdSha256,
      authentication.ordinaryBinding.recipientSha256, input.messageId, input.rawR2Key, relay.external_recipient,
      input.receivedAt, expiresAt, input.attemptId, attemptSha256, input.payloadSha256,
      ...atomicPolicyRouteBindings(input.expectedRoute)).run();
}

export type ReplyAuthorizationKind = "canary" | "ordinary";

/** Missing version retains the old canary-only contract. Unknown never upgrades. */
export function replyAuthorizationKind(value: {
  schemaVersion?: unknown; admissionKind?: unknown; activationId?: unknown;
}): ReplyAuthorizationKind | null {
  if (value.schemaVersion === undefined && value.admissionKind === undefined && value.activationId === undefined) return "canary";
  if (value.schemaVersion !== 2) return null;
  if (value.admissionKind === "canary" && value.activationId === undefined) return "canary";
  return value.admissionKind === "ordinary" && typeof value.activationId === "string" && value.activationId.length > 0
    ? "ordinary" : null;
}

export function admissionTable(kind: ReplyAuthorizationKind): "reply_admissions" | "ordinary_reply_admissions" {
  return kind === "canary" ? "reply_admissions" : "ordinary_reply_admissions";
}
