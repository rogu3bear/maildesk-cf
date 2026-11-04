import type { MaildeskEnv, OutboundReplyRequestedJob } from "../contracts";
import { normalizeMailbox, outboundRelayPayloadSha256, sha256Hex } from "../inbox-relay";
import { atomicPolicyRouteBindings, atomicPolicyRouteMatchSql, policyStorageId } from "../policy-inventory";
import type { RouteDecision } from "../router";

/** The insert and any idempotent Resend retry recheck the active route atomically. */
export const CLAIM_WEBDESK_PROVIDER_SQL = `INSERT INTO webdesk_provider_claims
  (message_id, request_sha256, policy_sha256, provider, thread_id, route_id)
  SELECT ?1, ?2, ?3, ?4, t.id, ar.id FROM threads t
  JOIN alias_routes ar ON ar.id = t.route_id
  JOIN runtime_state rs ON rs.singleton = 1 AND rs.active_policy_sha256 = ar.policy_sha256
  JOIN alias_route_operators aro ON aro.route_id = ar.id
  JOIN operators o ON o.id = aro.operator_id
  JOIN alias_route_reply_identities binding ON binding.route_id = ar.id AND binding.operator_id = o.id AND binding.policy_sha256 = ar.policy_sha256
  JOIN identities i ON i.id = binding.public_identity_id
  WHERE t.id = ?5 AND ar.id = ?6 AND ar.enabled = 1 AND ar.policy_sha256 = ?3
    AND lower(o.email) = ?7 AND lower(i.address) = ?8 AND lower(t.external_sender) = ?9
    AND ${atomicPolicyRouteMatchSql("?6", 10)}
  ON CONFLICT(message_id) DO UPDATE SET last_claimed_at = CURRENT_TIMESTAMP
  WHERE webdesk_provider_claims.provider = 'resend' AND excluded.provider = 'resend'
    AND webdesk_provider_claims.request_sha256 = excluded.request_sha256
    AND webdesk_provider_claims.policy_sha256 = excluded.policy_sha256
    AND webdesk_provider_claims.thread_id = excluded.thread_id AND webdesk_provider_claims.route_id = excluded.route_id
    AND julianday(webdesk_provider_claims.claimed_at) > julianday('now', '-23 hours')`;

export async function claimWebDeskProvider(
  env: MaildeskEnv, job: OutboundReplyRequestedJob, route: RouteDecision, policySha256: string,
  provider: "cloudflare_email_service" | "resend",
): Promise<boolean> {
  const operator = normalizeMailbox(job.operator), identity = normalizeMailbox(job.fromIdentity);
  const recipient = job.to.length === 1 ? normalizeMailbox(job.to[0]!) : "";
  if (!operator || !identity || !recipient || route.deliveryOnly ||
      normalizeMailbox(job.envelopeTo) !== `${route.localPart}@${route.domain}`) return false;
  const payloadSha256 = await outboundRelayPayloadSha256(job);
  const requestSha256 = await sha256Hex(JSON.stringify({ provider, messageId: job.messageId, threadId: job.threadId,
    operator: job.operator, route: job.envelopeTo, identity: job.fromIdentity, recipients: job.to,
    cc: job.cc ?? null, bcc: job.bcc ?? null, payloadSha256, displayName: job.fromDisplayName ?? null }));
  const routeId = policyStorageId("route", route.domain, route.localPart);
  const result = await env.DB.prepare(CLAIM_WEBDESK_PROVIDER_SQL).bind(job.messageId, requestSha256, policySha256,
    provider, job.threadId, routeId, operator, identity, recipient, ...atomicPolicyRouteBindings(route)).run();
  return result.success && Number(result.meta?.changes ?? 0) > 0;
}
