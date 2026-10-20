import { operatorDeliveryConfig,type MaildeskEnv as Env,type OutboundReplyRequestedJob } from "../contracts";
import { publicIdentityProfileSha256,sha256Hex } from "../inbox-relay";
import { loadOrdinaryRouteAuthorization,replyAuthorizationKind } from "../ordinary-reply";
import { loadActivePolicy } from "../policy-store";
import { authorizeReplyWithPolicy } from "../router";
import { auditOperator,recordAuditEvent } from "./audit";
import { configuredOutboundMode,isVerifiedSenderDomain,senderDomain } from "./configuration";
import { canonicalConversationHeaders } from "./conversation";
import { outboundOpaqueTokenFailure,outboundPrivacyFailure } from "./privacy";
import { cloudflareEmailServiceFailure } from "./provider-errors";
import { claimOutboundProviderBoundary,hasInboxRelayTransactionBindings,outboundContainmentBlocker,verifyAuthorizedOutboundTransaction } from "./reply-authorization";
import type { OutboundSendResult } from "./types";

export const RESEND_REQUEST_TIMEOUT_MS = 10_000;

export async function sendOutboundReply(
  job: OutboundReplyRequestedJob,
  env: Env,
  attempt: number,
): Promise<OutboundSendResult> {
  const mode = configuredOutboundMode(env);
  const delivery = operatorDeliveryConfig(env);
  let publicDisplayName = job.fromDisplayName;

  if (delivery.mode === "invalid") {
    return { ok: false, provider: mode, error: "operator delivery mode is invalid" };
  }

  if (mode === "disabled") {
    return { ok: false, provider: mode, error: "outbound sending is disabled" };
  }

  if (mode === "invalid") {
    return { ok: false, provider: mode, error: "outbound mode is invalid" };
  }

  const verifiedDomain = senderDomain(job.fromIdentity);
  if (!isVerifiedSenderDomain(verifiedDomain, env)) {
    return { ok: false, provider: mode, error: "sender domain is not verified" };
  }

  if (delivery.mode === "inbox_relay") {
    if (delivery.replyProcessingMode !== "enabled") return { ok: false, provider: mode, error: "reply processing is disabled" };
    if (!hasInboxRelayTransactionBindings(job)) {
      return {
        ok: false,
        provider: mode,
        error: "inbox relay job is missing public identity transaction bindings",
      };
    }
    const activePolicy = await loadActivePolicy(env);
    if (!activePolicy) {
      return { ok: false, provider: mode, error: "active policy is unavailable" };
    }
    if (activePolicy.sha256 !== job.policySha256) {
      return { ok: false, provider: mode, error: "relay policy revision is no longer active" };
    }
    const authorization = authorizeReplyWithPolicy(activePolicy.policy, {
      envelopeTo: job.envelopeTo,
      operator: job.operator,
      requestedIdentity: job.fromIdentity,
    });
    if (!authorization.ok) {
      return {
        ok: false,
        provider: mode,
        error: authorization.error.kind === "ambiguous_identity_profile"
          ? authorization.error.kind
          : "public identity profile is unavailable",
      };
    }
    const identityProfile = authorization.value.identityProfile;
    if (authorization.value.fromIdentity !== job.fromIdentity || !identityProfile) {
      return { ok: false, provider: mode, error: "public identity profile is unavailable" };
    }
    if (
      job.identityProfileRef !== identityProfile.profileRef ||
      job.signatureProfileRef !== identityProfile.signatureProfileRef ||
      job.fromDisplayName !== identityProfile.displayName ||
      job.senderAdapter !== identityProfile.senderAdapter ||
      job.requestedIdentity !== identityProfile.publicAddress
    ) {
      return { ok: false, provider: mode, error: "public identity profile does not match active policy" };
    }
    if (identityProfile.senderAdapter !== mode) {
      return { ok: false, provider: mode, error: "public identity sender adapter does not match runtime mode" };
    }
    const containmentBlocker = await outboundContainmentBlocker(job, env);
    if (containmentBlocker) {
      return { ok: false, provider: mode, error: `reply_containment_${containmentBlocker}` };
    }
    const transactionBinding = await verifyAuthorizedOutboundTransaction(job, env);
    if (transactionBinding !== null) {
      return { ok: false, provider: mode, error: transactionBinding };
    }
    publicDisplayName = identityProfile.displayName;
    const privacyFailure = outboundPrivacyFailure(job, activePolicy.policy) ?? await outboundOpaqueTokenFailure(job, env);
    if (privacyFailure) {
      return { ok: false, provider: mode, error: privacyFailure };
    }
    const projected = activePolicy.projection.routes.find((route) => `${route.localPart}@${route.domain}` === job.envelopeTo);
    if (!projected) return { ok: false, provider: mode, error: "route projection unavailable" };
    if (replyAuthorizationKind(job) === "ordinary") {
      const current = await loadOrdinaryRouteAuthorization({
        routeId: `route:${encodeURIComponent(projected.domain)}:${encodeURIComponent(projected.localPart)}`,
        policySha256: activePolicy.sha256, identityProfileSha256: await publicIdentityProfileSha256(identityProfile),
        operatorSetSha256: await sha256Hex(JSON.stringify(projected.operators)),
      }, env);
      if (!current || current.id !== job.activationId) return { ok: false, provider: mode, error: "ordinary_activation_unavailable" };
    }
    const boundary = await claimOutboundProviderBoundary(job, env, projected);
    if (!boundary) {
      const owner = await env.DB.prepare("SELECT status FROM reply_admissions_all WHERE id = ?1 AND transaction_sha256 = ?2")
        .bind(job.admissionId, job.transactionSha256).first<{ status: string }>();
      if (owner && ["sending", "provider_accepted", "recovery_required"].includes(owner.status)) {
        return { ok: false, provider: mode, notClaimed: true, error: "provider attempt belongs to an existing claim" };
      }
      const boundaryContainmentBlocker = await outboundContainmentBlocker(job, env);
      return {
        ok: false,
        provider: mode,
        error: boundaryContainmentBlocker
          ? `reply_containment_${boundaryContainmentBlocker}`
          : "controller admission is stale, consumed, or no longer authoritative",
      };
    }
  }

  await recordAuditEvent(
    env,
    await auditOperator(env, job.operator),
    "outbound_reply_authorized",
    {
      messageId: job.messageId,
      threadId: job.threadId,
      fromIdentity: job.fromIdentity,
      fromDisplayName: publicDisplayName,
      identityProfileRef: job.identityProfileRef,
      signatureProfileRef: job.signatureProfileRef,
      to: job.to,
    },
    `${job.messageId}:outbound_reply_authorized`,
    job.threadId,
  );
  await recordAuditEvent(
    env,
    await auditOperator(env, job.operator),
    "outbound_reply_send_attempted",
    {
      messageId: job.messageId,
      threadId: job.threadId,
      fromIdentity: job.fromIdentity,
      to: job.to,
      provider: mode,
      attempt,
    },
    `${job.messageId}:outbound_reply_send_attempted:${attempt}`,
    job.threadId,
  );

  if (mode === "cloudflare_email_service") {
    if (!env.EMAIL) {
      return { ok: false, provider: mode, providerBoundaryClaimed: true, error: "Cloudflare Email Service binding is not configured" };
    }

    try {
      const message = {
        to: job.to,
        cc: job.cc,
        bcc: job.bcc,
        replyTo: job.fromIdentity,
        subject: job.subject,
        text: job.text,
        html: job.html,
        headers: canonicalConversationHeaders(job),
        attachments: job.attachments,
      };
      const result = publicDisplayName
        ? await env.EMAIL.send({
          ...message,
          from: { email: job.fromIdentity, name: publicDisplayName },
        })
        : await env.EMAIL.send({ ...message, from: job.fromIdentity });
      return { ok: true, provider: mode, providerBoundaryClaimed: true, providerMessageId: result.messageId };
    } catch (error) {
      return { ...cloudflareEmailServiceFailure(error), providerBoundaryClaimed: true };
    }
  }

  if (mode === "resend") {
    if (!env.RESEND_API_KEY) {
      return { ok: false, provider: mode, providerBoundaryClaimed: true, error: "RESEND_API_KEY is not configured" };
    }
    if (job.attachments && job.attachments.length > 0) {
      return { ok: false, provider: mode, providerBoundaryClaimed: true, error: "Resend relay attachments are not configured" };
    }

    return { ...await sendWithResend(job, env.RESEND_API_KEY, publicDisplayName), providerBoundaryClaimed: true };
  }

  return { ok: false, provider: "invalid", error: "outbound mode is invalid" };
}

export async function sendWithResend(
  job: OutboundReplyRequestedJob,
  apiKey: string,
  publicDisplayName?: string,
): Promise<OutboundSendResult> {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(RESEND_REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": job.messageId,
      },
      body: resendRequestBody(job, publicDisplayName),
    });

    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ok: false,
        provider: "resend",
        error: `Resend send failed with ${response.status}`,
        status: response.status,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        response: data,
      };
    }

    return {
      ok: true,
      provider: "resend",
      providerMessageId: responseId(data),
      response: data,
    };
  } catch {
    return {
      ok: false,
      provider: "resend",
      retryable: true,
      error: "Resend request failed before a confirmed result",
    };
  }
}

/** One frozen field order binds the exact Resend request across retries. */
export function resendRequestBody(job: OutboundReplyRequestedJob, publicDisplayName = job.fromDisplayName): string {
  return JSON.stringify({
    from: publicDisplayName ? `${publicDisplayName} <${job.fromIdentity}>` : job.fromIdentity,
    to: job.to, cc: job.cc, bcc: job.bcc, reply_to: [job.fromIdentity],
    subject: job.subject, text: job.text, html: job.html, headers: canonicalConversationHeaders(job),
  });
}

export function responseId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("id" in value)) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}
