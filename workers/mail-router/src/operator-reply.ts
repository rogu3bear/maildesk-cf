import { operatorDeliveryConfig,type MaildeskEnv as Env } from "../../shared/contracts";
import { verifyOperatorDkim } from "../../shared/dkim";
import {
assertWithinRelayLimit,normalizeMailbox,
outboundRelayPayloadSha256,
outboundReplyPayload,
parseRelayEmail,publicIdentityProfileSha256,sha256Hex
} from "../../shared/inbox-relay";
import { recordAudit } from "../../shared/ingress-audit";
import { replyAttemptIdentities } from "../../shared/message-identity";
import { claimOrdinaryReply,loadOrdinaryRouteAuthorization } from "../../shared/ordinary-reply";
import { loadActivePolicy } from "../../shared/policy-store";
import { isExactReplyRedelivery,loadStoredReplyClaim,recoverKnownUnsentDispatch } from "../../shared/reply-recovery";
import {
claimRelayAttemptAndAdmission,
loadActiveRelay,loadActiveReplyAdmission,
loadRelayAttempt,
loadRelayContainmentBlocker,
loadRelayForReconciliation,
relayConversationHeaders,
replyAttemptStagingKey
} from "../../shared/reply-repository";
import { authorizeReplyWithPolicy,resolveReplyTarget,routeInbound } from "../../shared/router";
const MIME_CONTENT_TYPE = "message/rfc822";

export async function acceptOperatorReply(
  message: ForwardableEmailMessage,
  token: string,
  env: Env,
  affectedRoutes?: Set<string>,
): Promise<void> {
  const config = operatorDeliveryConfig(env);
  if (config.mode !== "inbox_relay" || config.replyProcessingMode !== "enabled" || !config.replyDomain) {
    message.setReject("maildesk reply relay is disabled");
    return;
  }
  if (!env.RELAY_SPOOL || !env.POLICY_STORE) {
    message.setReject("maildesk reply relay storage is not configured");
    return;
  }
  if (message.rawSize > config.maxEncodedMessageBytes) {
    message.setReject("maildesk replies may not exceed 5 MiB including attachments");
    return;
  }

  let rawBytes: ArrayBuffer;
  let parsed: Awaited<ReturnType<typeof parseRelayEmail>>;
  try {
    rawBytes = await new Response(message.raw).arrayBuffer();
    parsed = await parseRelayEmail(rawBytes);
  } catch {
    message.setReject("maildesk could not safely parse this reply");
    return;
  }

  const operator = normalizeMailbox(parsed.from.address);
  if (!operator || normalizeMailbox(message.from) !== operator) {
    message.setReject("maildesk reply sender identity does not match the authenticated envelope");
    return;
  }
  if (!parsed.messageId) {
    message.setReject("maildesk replies require a valid Message-ID");
    return;
  }
  const authentication = await verifyOperatorDkim(rawBytes, operator, {
    binding: { recipient: message.to, messageId: parsed.messageId },
  });
  if (authentication.status !== "verified") {
    structuredError("reply_authentication_rejected", {
      status: authentication.status,
      errorCode: authentication.boundedErrorCode ?? "dkim_rejected",
    });
    message.setReject("maildesk reply sender did not pass aligned email authentication");
    return;
  }

  const tokenHash = await sha256Hex(token);
  const historicalRelay = await loadRelayForReconciliation(tokenHash, env);
  const rawSha256 = await sha256Hex(rawBytes);
  if (!historicalRelay) {
    message.setReject("maildesk reply route is unknown");
    return;
  }
  affectedRoutes?.add(historicalRelay.route_id);
  const identities = await replyAttemptIdentities(historicalRelay.id, parsed.messageId);
  // Historical identity lookup precedes current admission, policy and proof freshness.
  // A duplicate never mints authority, even when the old proof or relay expired.
  for (const id of [identities.legacy, identities.current]) {
    if (!await loadRelayAttempt(id, env)) continue;
    const existing = await loadStoredReplyClaim(id, env);
    if (!existing || !isExactReplyRedelivery(existing, {
      relayId: historicalRelay.id, operator, messageId: parsed.messageId, rawSha256,
    })) {
      message.setReject("maildesk reply conflicts with an existing attempt");
      return;
    }
    const dispatch = await recoverKnownUnsentDispatch(id, env);
    await recordAudit(env, `${id}:exact_reply_redelivery:${dispatch.state}`, historicalRelay.thread_id,
      `operator:${await sha256Hex(operator)}`, "exact_reply_redelivery", {
        attemptId: id, dispatchState: dispatch.state, reason: dispatch.reason, providerReplay: false,
      });
    if (dispatch.state === "dispatch_unconfirmed") message.setReject("maildesk reply dispatch remains unconfirmed");
    return;
  }
  const containmentBlocker = await loadRelayContainmentBlocker(tokenHash, env);
  if (containmentBlocker) {
    structuredError("reply_containment_blocked", { errorCode: containmentBlocker });
    message.setReject("maildesk reply route is quarantined or terminal");
    return;
  }
  let relay = await loadActiveRelay(tokenHash, env);
  if (!relay) {
    message.setReject("maildesk reply route is unknown, expired, or revoked");
    return;
  }
  const replyTarget = resolveReplyTarget([
    relay.external_recipient,
    relay.thread_external_sender,
  ]);
  if (!replyTarget.ok) {
    message.setReject(
      replyTarget.error.kind === "recipient_ambiguous"
        ? "maildesk stored thread has multiple external reply targets"
        : "maildesk stored thread has no external reply target",
    );
    return;
  }

  const activePolicy = await loadActivePolicy(env);
  if (!activePolicy) {
    message.setReject("maildesk policy unavailable");
    return;
  }
  const authorization = authorizeReplyWithPolicy(activePolicy.policy, {
    envelopeTo: relay.route_address,
    operator,
  });
  if (!authorization.ok) {
    structuredError("reply_policy_rejected", { errorCode: authorization.error.kind });
    message.setReject(
      authorization.error.kind === "ambiguous_identity_profile"
        ? "maildesk public reply identity profile is ambiguous"
        : "maildesk operator is not authorized for this reply identity",
    );
    return;
  }
  const currentOperatorIdentity = activePolicy.projection.routes.find((route) =>
    `${route.localPart}@${route.domain}` === relay!.route_address)?.operatorReplyIdentities?.[operator]?.publicAddress;
  if (authorization.value.fromIdentity !== relay.reply_identity && authorization.value.fromIdentity !== currentOperatorIdentity) {
    message.setReject("maildesk operator is not authorized for this reply identity");
    return;
  }
  if (!authorization.value.identityProfile) {
    message.setReject("maildesk public reply identity profile is unavailable");
    return;
  }
  // Stored relay history remains unchanged. The current Rust decision selects
  // this authenticated operator's identity for the new immutable claim.
  relay = { ...relay, reply_identity: authorization.value.fromIdentity };
  const routed = routeInbound(activePolicy.policy, {
    envelopeTo: relay.route_address,
    headerFrom: operator,
  });
  if (!routed.ok) {
    message.setReject("maildesk route policy is unavailable for this reply");
    return;
  }
  const operatorRef = await sha256Hex(operator);
  const projected = activePolicy.projection.routes.find((route) =>
    route.domain === routed.value.domain && route.localPart === routed.value.localPart);
  if (!projected) { message.setReject("maildesk route projection is unavailable"); return; }
  const operatorSetSha256 = await sha256Hex(JSON.stringify(projected.operators));
  const identityProfileSha256 = await publicIdentityProfileSha256(
    authorization.value.identityProfile,
  );
  const admission = await loadActiveReplyAdmission({
    relayId: relay.id,
    operatorRef,
    operatorSetSha256,
    identityProfileSha256,
    publicIdentity: relay.reply_identity,
    policySha256: activePolicy.sha256,
  }, env);
  const activation = admission ? null : await loadOrdinaryRouteAuthorization({
    routeId: relay.route_id, policySha256: activePolicy.sha256, identityProfileSha256, operatorSetSha256,
  }, env);
  if (!admission && !activation) {
    message.setReject("maildesk reply requires a current canary admission or explicit ordinary route authorization");
    return;
  }

  if (activation && !authentication.ordinaryBinding) {
    structuredError("ordinary_signing_compatibility_hold", { errorCode: authentication.ordinaryBindingError ?? "message_binding_missing" });
    message.setReject("maildesk ordinary reply requires signed recipient, Message-ID and MIME headers");
    return;
  }
  let payload: ReturnType<typeof outboundReplyPayload>;
  try {
    payload = outboundReplyPayload(parsed, authorization.value.identityProfile);
  } catch {
    message.setReject("maildesk reply content cannot be normalized for public delivery");
    return;
  }
  try {
    assertWithinRelayLimit(payload, config);
  } catch {
    message.setReject("maildesk replies may not exceed 5 MiB including attachments");
    return;
  }
  if (!parsed.messageId) {
    message.setReject("maildesk replies require a valid Message-ID");
    return;
  }

  const attemptId = identities.current;
  const receivedAt = new Date().toISOString();
  const candidateRawR2Key = replyAttemptStagingKey(attemptId, receivedAt);
  const claimedPayloadSha256 = await outboundRelayPayloadSha256({
    ...payload, headers: relayConversationHeaders(relay),
  });
  const attemptSha256 = await sha256Hex(
    `maildesk-reply-attempt-v2\0${admission?.transaction_sha256 ?? "ordinary"}\0${await sha256Hex(parsed.messageId)}\0${rawSha256}\0${claimedPayloadSha256}`,
  );

  try {
    await env.RELAY_SPOOL.put(candidateRawR2Key, rawBytes, {
      httpMetadata: { contentType: MIME_CONTENT_TYPE },
      customMetadata: { retentionClass: "relay-spool", relayId: relay.id },
    });
  } catch {
    message.setReject("maildesk could not durably spool this reply");
    return;
  }

  let claimUncertain = false;
  try {
    if (admission) {
      await claimRelayAttemptAndAdmission({
        attemptId, relay, operator, operatorMessageId: parsed.messageId, rawR2Key: candidateRawR2Key,
        rawSha256, claimedPayloadSha256, attemptSha256, admission, policySha256: activePolicy.sha256,
        expectedRoute: projected, receivedAt,
      }, env);
    } else if (activation) {
      await claimOrdinaryReply({ activation, relay, profile: authorization.value.identityProfile,
        authentication, operator, operatorRef, attemptId, messageId: parsed.messageId,
        rawSha256, rawR2Key: candidateRawR2Key, payloadSha256: claimedPayloadSha256, expectedRoute: projected, receivedAt,
      }, env);
    } else throw new Error("reply authorization variant missing");
  } catch { claimUncertain = true; }
  let durable;
  try { durable = await loadStoredReplyClaim(attemptId, env); }
  catch {
    // An unknown database outcome is not permission to delete the exact spool.
    message.setReject("maildesk reply claim requires reconciliation");
    return;
  }
  if (!durable || !isExactReplyRedelivery(durable, { relayId: relay.id, operator, messageId: parsed.messageId, rawSha256 })) {
    if (!claimUncertain) await env.RELAY_SPOOL.delete(candidateRawR2Key).catch(() => undefined);
    message.setReject("maildesk could not durably claim this reply");
    return;
  }
  if (durable.raw_r2_key !== candidateRawR2Key) {
    await env.RELAY_SPOOL.delete(candidateRawR2Key).catch(() => undefined);
  }
  const dispatch = await recoverKnownUnsentDispatch(attemptId, env);
  if (dispatch.state !== "queued") {
    message.setReject("maildesk reply is retained for dispatch recovery");
    return;
  }
  await recordAudit(env, `${attemptId}:inbox_reply_received`, relay.thread_id,
    `operator:${operatorRef}`, "inbox_reply_received", {
      attemptId, relayId: relay.id, authentication: {
        status: authentication.status, method: authentication.method,
        signingDomain: authentication.signingDomain, selectorHash: authentication.selectorHash,
        alignedOperatorId: authentication.alignedOperatorId, verifiedAt: authentication.verifiedAt,
      },
    });
}

function structuredError(event: string, detail: Record<string, string>): void {
  console.error(JSON.stringify({ event, ...detail }));
}
