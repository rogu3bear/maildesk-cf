import {
InboxReplyReceivedJob,
MaildeskEnv,
MailJob,
operatorDeliveryConfig,
OutboundReplyRequestedJob
} from "../contracts";
import {
assertWithinRelayLimit,
normalizeMailbox as normalizeRelayMailbox,
outboundReplyPayload,
parseRelayEmail,
publicIdentityProfileSha256,
relayRecordIsActive,
sha256Hex
} from "../inbox-relay";
import { decodeMailJob } from "../job-codec";
import { loadOrdinaryRouteAuthorization,replyAuthorizationKind } from "../ordinary-reply";
import { loadActivePolicy } from "../policy-store";
import { loadStoredReplyClaim } from "../reply-recovery";
import { authorizeReplyWithPolicy,resolveReplyTarget } from "../router";
import { refreshRouteStatuses } from "../status-store";
import { auditOperator,auditOutboundModeForClaim,auditSendResult,recordAuditEvent,recordOutboundDuplicateSuppressed,terminalSendRecordForDedupeKey } from "./audit";
import { configuredOutboundMode } from "./configuration";
import { storedReferences,validMessageId } from "./conversation";
import { projectInboundDeliveryResult } from "./inbound-results";
import { resendRequestBody,sendOutboundReply } from "./provider";
import { CLAIMED_REPLY_SPOOL_SQL,claimReplyFailureBeforeBoundary,outboundPayloadSha256 } from "./reply-authorization";
import { finalizeTerminalSendState,recordTerminalSendEvent,resumeInboxTerminal } from "./terminal";
import { QueueDisposition,ReplyRelayJobRow } from "./types";

// wrangler.toml allows five retries after the initial Queue delivery.
const MAX_OUTBOUND_ATTEMPTS = 6;

export async function processQueueBatch(batch: MessageBatch<MailJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      let disposition: QueueDisposition;
      let job: MailJob | null = null;
      try {
        job = decodeMailJob(message.body);
        if (!job) {
          await recordAuditEvent(env, "system", "queue_contract_rejected", { reason: "unsupported_or_malformed_job" });
          disposition = ACK;
        } else disposition = await recordQueueEvent(job, env, Math.max(1, message.attempts));
      }
      finally {
        // Read-only status work cannot change dispatch, acknowledgment or replay policy.
        if (job) await refreshJobRouteStatus(job, env)
          .catch(() => console.error(JSON.stringify({ event: "status_projection_unavailable" })));
      }
      if (disposition.kind === "retry") {
        message.retry({ delaySeconds: disposition.delaySeconds });
      } else {
        message.ack();
      }
    }
}

async function refreshJobRouteStatus(job: MailJob, env: Env): Promise<void> {
  if (operatorDeliveryConfig(env).mode !== "inbox_relay") return;
  let statement: D1PreparedStatement;
  if (job.kind === "inbox_reply_received") {
    statement = env.DB.prepare("SELECT route_id FROM reply_relays WHERE id = ?1 LIMIT 1").bind(job.relayId);
  } else if ("threadId" in job) {
    statement = env.DB.prepare("SELECT route_id FROM threads WHERE id = ?1 LIMIT 1").bind(job.threadId);
  } else {
    statement = env.DB.prepare("SELECT route_id FROM inbound_deliveries WHERE id = ?1 LIMIT 1").bind(job.deliveryId);
  }
  const row = await statement.first<{ route_id: string }>();
  if (row) await refreshRouteStatuses(env, Date.now(), { routeIds: [row.route_id] });
}

async function processInboxReply(
  job: InboxReplyReceivedJob,
  env: Env,
  attempt: number,
): Promise<QueueDisposition> {
  const authorizationKind = replyAuthorizationKind(job);
  if (!authorizationKind) return ACK;
  if (await resumeInboxTerminal(job, env)) return ACK;
  const delivery = operatorDeliveryConfig(env);
  if (delivery.mode !== "inbox_relay") {
    await failRelayAttempt(
      job,
      env,
      delivery.mode === "invalid" ? "operator_delivery_mode_invalid" : "inbox_relay_disabled",
    );
    return ACK;
  }

  if (!env.RELAY_SPOOL || !env.POLICY_STORE) {
    await recoverRelayAttempt(job, env, "relay_storage_unavailable");
    return ACK;
  }
  let relay = await env.DB.prepare(
    "SELECT rr.id, rr.thread_id, rr.route_id, rr.external_recipient, lower(t.external_sender) AS thread_external_sender, rr.reply_identity, rr.original_message_id, rr.references_json, rr.expires_at, rr.revoked_at, lower(ar.local_part || '@' || d.domain) AS route_address FROM reply_relays rr JOIN threads t ON t.id = rr.thread_id AND t.route_id = rr.route_id JOIN alias_routes ar ON ar.id = rr.route_id JOIN domains d ON d.id = ar.domain_id JOIN runtime_state rs ON rs.singleton = 1 AND rs.active_policy_sha256 = ar.policy_sha256 WHERE rr.id = ?1 AND ar.enabled = 1 LIMIT 1",
  )
    .bind(job.relayId)
    .first<ReplyRelayJobRow>();
  if (!relay || !relayRecordIsActive(relay.expires_at, relay.revoked_at)) {
    await failRelayAttempt(job, env, "relay_inactive");
    return ACK;
  }
  const replyTarget = resolveReplyTarget([
    relay.external_recipient,
    relay.thread_external_sender,
  ]);
  if (!replyTarget.ok) {
    await failRelayAttempt(job, env, replyTarget.error.kind);
    return ACK;
  }
  if (!normalizeRelayMailbox(relay.external_recipient) || !normalizeRelayMailbox(relay.reply_identity)) {
    await failRelayAttempt(job, env, "relay_address_invalid");
    return ACK;
  }

  const activePolicy = await loadActivePolicy(env);
  if (!activePolicy) {
    await recoverRelayAttempt(job, env, "policy_unavailable");
    return ACK;
  }
  const authorization = authorizeReplyWithPolicy(activePolicy.policy, {
    envelopeTo: relay.route_address,
    operator: job.operator,
  });
  const currentOperatorIdentity = activePolicy.projection.routes.find((route) =>
    `${route.localPart}@${route.domain}` === relay!.route_address)?.operatorReplyIdentities?.[job.operator]?.publicAddress;
  if (!authorization.ok || (authorization.value.fromIdentity !== relay.reply_identity && authorization.value.fromIdentity !== currentOperatorIdentity)) {
    await failRelayAttempt(job, env, "operator_no_longer_authorized");
    return ACK;
  }
  const identityProfile = authorization.value.identityProfile;
  if (!identityProfile) {
    await failRelayAttempt(job, env, "identity_profile_unavailable");
    return ACK;
  }
  relay = { ...relay, reply_identity: authorization.value.fromIdentity };
  if (await publicIdentityProfileSha256(identityProfile) !== job.identityProfileSha256) {
    await failRelayAttempt(job, env, "identity_profile_binding_changed");
    return ACK;
  }

  if (authorizationKind === "ordinary") {
    const projected = activePolicy.projection.routes.find((route) => `${route.localPart}@${route.domain}` === relay.route_address);
    const active = projected && await loadOrdinaryRouteAuthorization({ routeId: relay.route_id,
      policySha256: activePolicy.sha256, identityProfileSha256: await publicIdentityProfileSha256(identityProfile),
      operatorSetSha256: await sha256Hex(JSON.stringify(projected.operators)) }, env);
    if (!active || active.id !== job.activationId) {
      await failRelayAttempt(job, env, "ordinary_activation_unavailable");
      return ACK;
    }
  }
  const claimedAttempt = await env.DB.prepare(
    CLAIMED_REPLY_SPOOL_SQL,
  )
    .bind(
      job.attemptId,
      job.relayId,
      job.operator,
      job.operatorMessageId,
      job.rawR2Key,
      job.rawSha256,
      job.admissionId,
      job.transactionSha256,
      job.attemptSha256,
      job.claimedPayloadSha256,
      job.desiredStateSha256,
      job.identityProfileSha256,
      authorizationKind, job.activationId ?? null,
    )
    .first<{ id: string }>();
  if (!claimedAttempt) {
    await failRelayAttempt(job, env, "relay_attempt_integrity_mismatch");
    return ACK;
  }

  const object = await env.RELAY_SPOOL.get(job.rawR2Key);
  if (!object) {
    await recoverRelayAttempt(job, env, "relay_spool_missing");
    return ACK;
  }
  const config = operatorDeliveryConfig(env);
  if (object.size > config.maxEncodedMessageBytes) {
    await failRelayAttempt(job, env, "reply_too_large");
    return ACK;
  }

  if (!/^[a-f0-9]{64}$/.test(job.rawSha256)) {
    await failRelayAttempt(job, env, "relay_spool_digest_invalid");
    return ACK;
  }
  const rawBytes = await object.arrayBuffer();
  if ((await sha256Hex(rawBytes)) !== job.rawSha256) {
    await failRelayAttempt(job, env, "relay_spool_digest_mismatch");
    return ACK;
  }

  let parsed: Awaited<ReturnType<typeof parseRelayEmail>>;
  try {
    parsed = await parseRelayEmail(rawBytes);
  } catch {
    await failRelayAttempt(job, env, "reply_mime_invalid");
    return ACK;
  }
  if (normalizeRelayMailbox(parsed.from.address) !== normalizeRelayMailbox(job.operator)) {
    await failRelayAttempt(job, env, "operator_identity_changed");
    return ACK;
  }

  let payload: ReturnType<typeof outboundReplyPayload>;
  try {
    payload = outboundReplyPayload(parsed, identityProfile, job.payloadVersion ?? 1);
  } catch (error) {
    const errorCode = error instanceof Error && error.message.includes("plaintext MIME alternative")
      ? "reply_plaintext_required"
      : "reply_identity_normalization_failed";
    await failRelayAttempt(job, env, errorCode);
    return ACK;
  }
  try {
    assertWithinRelayLimit(payload, config);
  } catch {
    await failRelayAttempt(job, env, "reply_too_large");
    return ACK;
  }
  const references = storedReferences(relay.references_json);
  if (relay.original_message_id && validMessageId(relay.original_message_id)) {
    references.push(relay.original_message_id);
  }
  const headers: Record<string, string> = {};
  if (relay.original_message_id && validMessageId(relay.original_message_id)) {
    headers["In-Reply-To"] = relay.original_message_id;
  }
  if (references.length > 0) headers.References = [...new Set(references)].join(" ");

  await env.DB.prepare(
    "UPDATE relay_attempts SET status = 'authorized', updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
  )
    .bind(job.attemptId)
    .run();
  await recordAuditEvent(
    env,
    await auditOperator(env, job.operator),
    "inbox_reply_authorized",
    {
      attemptId: job.attemptId,
      relayId: job.relayId,
      fromIdentity: relay.reply_identity,
      identityProfileRef: identityProfile.profileRef,
      signatureProfileRef: identityProfile.signatureProfileRef,
      outboundPayloadSha256: await outboundPayloadSha256({ ...payload, headers }),
    },
    `${job.attemptId}:inbox_reply_authorized`,
    relay.thread_id,
  );

  const outbound: OutboundReplyRequestedJob = {
    kind: "outbound_reply_requested", schemaVersion: job.schemaVersion, payloadVersion: job.payloadVersion,
    admissionKind: job.admissionKind, activationId: job.activationId,
    messageId: job.attemptId.replace(/^relay-attempt:/, ""),
    threadId: relay.thread_id,
    operator: job.operator,
    envelopeTo: relay.route_address,
    fromIdentity: relay.reply_identity,
    fromDisplayName: identityProfile.displayName,
    identityProfileRef: identityProfile.profileRef,
    signatureProfileRef: identityProfile.signatureProfileRef,
    senderAdapter: identityProfile.senderAdapter,
    to: [replyTarget.value.recipient],
    replyTo: relay.reply_identity,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
    headers,
    attachments: payload.attachments,
    requestedIdentity: relay.reply_identity,
    policySha256: activePolicy.sha256,
    admissionId: job.admissionId,
    transactionSha256: job.transactionSha256,
    attemptSha256: job.attemptSha256,
    claimedPayloadSha256: job.claimedPayloadSha256,
    desiredStateSha256: job.desiredStateSha256,
    identityProfileSha256: job.identityProfileSha256,
    relayAttemptId: job.attemptId,
    relaySpoolKey: job.rawR2Key,
    queuedAt: job.receivedAt,
  };
  return recordQueueEvent(outbound, env, attempt);
}

async function failRelayAttempt(
  job: InboxReplyReceivedJob,
  env: Env,
  errorCode: string,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE relay_attempts SET status = 'failed', error_code = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2 AND status IN ('receiving', 'queued', 'authorized') AND EXISTS (SELECT 1 FROM reply_admissions_all rad WHERE rad.claimed_attempt_id = relay_attempts.id AND rad.status = 'claimed')",
  )
    .bind(errorCode, job.attemptId)
    .run();
  await recordAuditEvent(
    env,
    "system",
    "inbox_reply_failed",
    { attemptId: job.attemptId, relayId: job.relayId, errorCode },
    `${job.attemptId}:inbox_reply_result`,
  );
}

async function recoverRelayAttempt(
  job: InboxReplyReceivedJob,
  env: Env,
  errorCode: string,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE relay_attempts SET status = 'recovery_required', error_code = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2 AND status IN ('receiving', 'queued', 'authorized') AND EXISTS (SELECT 1 FROM reply_admissions_all rad WHERE rad.claimed_attempt_id = relay_attempts.id AND rad.status = 'claimed')",
  )
    .bind(errorCode, job.attemptId)
    .run();
  await recordAuditEvent(
    env,
    "system",
    "inbox_reply_recovery_required",
    { attemptId: job.attemptId, relayId: job.relayId, errorCode },
    `${job.attemptId}:inbox_reply_result`,
  );
}

async function recordQueueEvent(
  job: MailJob,
  env: Env,
  attempt: number,
): Promise<QueueDisposition> {
  if (job.kind === "inbox_reply_received") {
    return processInboxReply(job, env, attempt);
  }
  if (job.kind === "inbound_delivery_result") {
    await projectInboundDeliveryResult(job, env);
    return ACK;
  }
  if (job.kind === "outbound_reply_requested" && operatorDeliveryConfig(env).mode === "invalid") {
    await recordTerminalSendEvent(job, env, "outbound_reply_failed", {
      ok: false,
      provider: configuredOutboundMode(env),
      error: "operator delivery mode is invalid",
    });
    return ACK;
  }
  const base = dedupeBase(job);

  const claimed = await recordAuditEvent(
    env,
    "system",
    job.kind,
    await auditDetailForJob(job, env),
    base ? `${base}:${job.kind}` : undefined,
    jobThreadId(job),
  );

  if (job.kind !== "outbound_reply_requested") return ACK;

  // In inbox relay the audit records dispatch intent. The admission's atomic
  // claimed -> sending transition owns the provider boundary. A known-unsent
  // journal may resume; an uncertain non-idempotent provider call may not.
  if (!claimed) {
    const terminal = await terminalSendRecordForDedupeKey(
      env,
      `${job.messageId}:outbound_reply_result`,
    );
    if (terminal) {
      await recordOutboundDuplicateSuppressed(job, env, "terminal");
      // The provider transition is already terminal. Resume only the
      // idempotent D1 projections and spool cleanup that may have been
      // interrupted after the terminal audit was committed.
      await finalizeTerminalSendState(job, env, terminal.action, terminal.result);
      return ACK;
    }

    const currentMode = configuredOutboundMode(env);
    const claimedMode = await auditOutboundModeForClaim(
      env,
      `${job.messageId}:outbound_reply_requested`,
    );
    const journal = job.relayAttemptId ? await loadStoredReplyClaim(job.relayAttemptId, env) : null;
    const knownUnsent = journal?.admission_status === "claimed" && journal.status === "authorized";
    if (!knownUnsent && (claimedMode !== "resend" || currentMode !== claimedMode || !await resendClaimCanResume(job, env))) {
      await recordOutboundDuplicateSuppressed(job, env, "non_resumable_claim");
      await recordTerminalSendEvent(job, env, "outbound_reply_recovery_required", {
        ok: false,
        provider: claimedMode ?? "unknown",
        ambiguous: true,
        error:
          claimedMode && claimedMode !== currentMode
            ? `outbound provider mode changed before recovery: ${claimedMode} -> ${currentMode}`
            : "outbound transition lacks a matching request within the provider idempotency window",
      });
      return ACK;
    }
  }

  const sendResult = await sendOutboundReply(job, env, attempt);
  if (sendResult.notClaimed) return ACK;
  if (!sendResult.ok && job.relayAttemptId && !sendResult.providerBoundaryClaimed &&
      !await claimReplyFailureBeforeBoundary(job, env)) return ACK;
  if (sendResult.ok) {
    await recordTerminalSendEvent(job, env, "outbound_reply_delivered", sendResult);
    return ACK;
  }

  if (sendResult.ambiguous) {
    await recordTerminalSendEvent(job, env, "outbound_reply_recovery_required", sendResult);
    return ACK;
  }

  if (sendResult.retryable && attempt < MAX_OUTBOUND_ATTEMPTS) {
    const delaySeconds = retryDelaySeconds(attempt);
    await recordAuditEvent(
      env,
      await auditOperator(env, job.operator),
      "outbound_reply_retry_scheduled",
      {
        messageId: job.messageId,
        threadId: job.threadId,
        fromIdentity: job.fromIdentity,
        to: job.to,
        attempt,
        nextAttempt: attempt + 1,
        delaySeconds,
        result: auditSendResult(sendResult),
      },
      `${job.messageId}:outbound_reply_retry_scheduled:${attempt}`,
      job.threadId,
    );
    return { kind: "retry", delaySeconds };
  }

  await recordTerminalSendEvent(job, env, "outbound_reply_failed", sendResult);
  // With the production consumer's max_retries = 5, requesting retry on the
  // sixth total attempt transfers this already-recorded terminal failure to
  // the configured DLQ. Definitive non-retryable failures are complete and can
  // be acknowledged without entering recovery triage.
  return sendResult.retryable ? { kind: "retry", delaySeconds: 0 } : ACK;
}

function retryDelaySeconds(attempt: number): number {
  return Math.min(300, 5 * 2 ** Math.max(0, attempt - 1));
}

const ACK: QueueDisposition = { kind: "ack" };

// Stable idempotency base for a job: the inbound deliveryId (set by the router)
// or the outbound messageId. Returns undefined for jobs without one (no dedup).
function dedupeBase(job: MailJob): string | undefined {
  if (job.kind === "inbound_email_received" || job.kind === "inbound_work_item_received") {
    return job.deliveryId;
  }
  if (job.kind === "outbound_reply_requested") return job.messageId;
  if (job.kind === "inbox_reply_received") return job.attemptId;
  return undefined;
}

function jobThreadId(job: MailJob): string | undefined {
  if (job.kind === "inbound_email_persisted" || job.kind === "outbound_reply_requested") {
    return job.threadId;
  }
  return undefined;
}

async function auditDetailForJob(job: MailJob, env: Env): Promise<unknown> {
  const operator = "operator" in job
    ? await auditOperator(env, job.operator)
    : undefined;
  if (job.kind === "inbox_reply_received") {
    return {
      kind: job.kind,
      attemptId: job.attemptId,
      relayId: job.relayId,
      operator,
      operatorMessageIdSha256: await sha256Hex(job.operatorMessageId),
      receivedAt: job.receivedAt,
    };
  }
  if (job.kind === "inbound_work_item_received") {
    return {
      kind: job.kind,
      outcome: "reconciliation_required",
      reason: "legacy_internal_queue_event_is_not_work_destination_delivery",
      messageId: job.messageId,
      deliveryId: job.deliveryId,
      queueRef: job.queueRef,
      routeRef: job.routeRef,
      destinationRef: job.destinationRef,
      accountableRef: job.accountableRef,
      rawR2Key: job.rawR2Key,
      receivedAt: job.receivedAt,
    };
  }
  if (job.kind !== "outbound_reply_requested") return job;

  return {
    kind: job.kind,
    messageId: job.messageId,
    threadId: job.threadId,
    operator,
    envelopeTo: job.envelopeTo,
    fromIdentity: job.fromIdentity,
    fromDisplayName: job.fromDisplayName,
    identityProfileRef: job.identityProfileRef,
    signatureProfileRef: job.signatureProfileRef,
    to: job.to,
    outboundMode: configuredOutboundMode(env),
    claimObservedAt: new Date().toISOString(),
    resendRequestSha256: configuredOutboundMode(env) === "resend" ? await sha256Hex(resendRequestBody(job)) : undefined,
    cc: job.cc,
    replyTo: job.replyTo,
    subjectLength: job.subject.length,
    hasText: Boolean(job.text),
    hasHtml: Boolean(job.html),
    attachmentCount: job.attachments?.length ?? 0,
    queuedAt: job.queuedAt,
  };
}

async function resendClaimCanResume(job: OutboundReplyRequestedJob, env: Env): Promise<boolean> {
  if (job.messageId.length < 1 || job.messageId.length > 256) return false;
  const row = await env.DB.prepare("SELECT detail_json FROM audit_events WHERE dedupe_key = ?1 LIMIT 1")
    .bind(`${job.messageId}:outbound_reply_requested`).first<{ detail_json: string }>();
  try {
    const detail: unknown = JSON.parse(row?.detail_json ?? "null");
    if (!detail || typeof detail !== "object" || !("claimObservedAt" in detail) || !("resendRequestSha256" in detail)) return false;
    const time = typeof detail.claimObservedAt === "string" ? Date.parse(detail.claimObservedAt) : NaN;
    const age = Date.now() - time;
    return Number.isFinite(age) && age >= 0 && age < 23 * 3_600_000 &&
      detail.resendRequestSha256 === await sha256Hex(resendRequestBody(job));
  } catch { return false; }
}

type Env = MaildeskEnv;
