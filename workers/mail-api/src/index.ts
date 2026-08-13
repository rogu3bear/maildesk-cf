import {
  InboundDeliveryResultJob,
  InboxReplyReceivedJob,
  json,
  MailJob,
  MaildeskEnv,
  methodNotAllowed,
  notFound,
  operatorDeliveryConfig,
  OutboundReplyRequestedJob,
  readiness,
} from "../../shared/contracts";
import {
  assertWithinRelayLimit,
  normalizeMailbox as normalizeRelayMailbox,
  outboundReplyPayload,
  parseRelayEmail,
  relayRecordIsActive,
  sha256Hex,
} from "../../shared/inbox-relay";
import { authorizeReplyWithPolicy, RouterPolicy } from "../../shared/router";
import { loadActivePolicy } from "../../shared/policy-store";

const RESEND_REQUEST_TIMEOUT_MS = 10_000;
// wrangler.toml allows five retries after the initial Queue delivery.
const MAX_OUTBOUND_ATTEMPTS = 6;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "maildesk-cf" });
    }

    if (url.pathname === "/readyz") {
      const report = await readiness(env);
      return json(report, { status: report.ok ? 200 : 503 });
    }

    if (url.pathname === "/api/replies" && request.method !== "POST") {
      return methodNotAllowed();
    }

    if (url.pathname === "/api/replies") {
      if ((env.MAILDESK_REPLY_API_MODE ?? "disabled") !== "token") {
        return notFound();
      }
      return queueReply(request, env);
    }

    return notFound();
  },

  async queue(batch: MessageBatch<MailJob>, env: Env): Promise<void> {
    await processQueueBatch(batch, env);
  },
};

export async function processQueueBatch(batch: MessageBatch<MailJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const disposition = await recordQueueEvent(message.body, env, Math.max(1, message.attempts));
      if (disposition.kind === "retry") {
        message.retry({ delaySeconds: disposition.delaySeconds });
      } else {
        message.ack();
      }
    }
}

async function queueReply(request: Request, env: Env): Promise<Response> {
  if (!isAuthorizedRequest(request, env)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }

  if (!isOutboundReplyRequestedJob(body)) {
    return json({ error: "invalid_reply_request" }, { status: 400 });
  }

  const policy = await loadPolicy(env);
  if (!policy) {
    return json({ error: "policy_unavailable" }, { status: 503 });
  }

  const authorization = authorizeReplyWithPolicy(policy, {
    envelopeTo: body.envelopeTo,
    operator: body.operator,
    requestedIdentity: body.requestedIdentity || body.fromIdentity || undefined,
  });
  if (!authorization.ok) {
    if (authorization.error.kind === "invalid_request" || authorization.error.kind === "adapter_failure") {
      return json({ error: "policy_unavailable" }, { status: 503 });
    }
    return json({ error: "reply_not_authorized", detail: authorization.error.message }, { status: 403 });
  }

  const job: OutboundReplyRequestedJob = {
    ...body,
    fromIdentity: authorization.value.fromIdentity,
    queuedAt: body.queuedAt || new Date().toISOString(),
  };

  await env.MAIL_JOBS.send(job);
  return json({ queued: true, messageId: job.messageId, fromIdentity: job.fromIdentity }, { status: 202 });
}

function isOutboundReplyRequestedJob(value: unknown): value is OutboundReplyRequestedJob {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Record<keyof OutboundReplyRequestedJob, unknown>>;

  return (
    candidate.kind === "outbound_reply_requested" &&
    typeof candidate.messageId === "string" &&
    typeof candidate.threadId === "string" &&
    typeof candidate.operator === "string" &&
    typeof candidate.envelopeTo === "string" &&
    typeof candidate.fromIdentity === "string" &&
    Array.isArray(candidate.to) &&
    candidate.to.every((value) => typeof value === "string") &&
    (candidate.cc === undefined ||
      (Array.isArray(candidate.cc) && candidate.cc.every((value) => typeof value === "string"))) &&
    (candidate.bcc === undefined ||
      (Array.isArray(candidate.bcc) && candidate.bcc.every((value) => typeof value === "string"))) &&
    (candidate.replyTo === undefined || typeof candidate.replyTo === "string") &&
    typeof candidate.subject === "string" &&
    (candidate.text === undefined || typeof candidate.text === "string") &&
    (candidate.html === undefined || typeof candidate.html === "string") &&
    (typeof candidate.text === "string" || typeof candidate.html === "string") &&
    (candidate.headers === undefined || isStringRecord(candidate.headers)) &&
    (candidate.attachments === undefined || isAttachmentArray(candidate.attachments)) &&
    (candidate.relayAttemptId === undefined || typeof candidate.relayAttemptId === "string") &&
    (candidate.relaySpoolKey === undefined || typeof candidate.relaySpoolKey === "string") &&
    typeof candidate.queuedAt === "string" &&
    (candidate.requestedIdentity === undefined || typeof candidate.requestedIdentity === "string")
  );
}

async function processInboxReply(
  job: InboxReplyReceivedJob,
  env: Env,
  attempt: number,
): Promise<QueueDisposition> {
  if (!env.RELAY_SPOOL || !env.POLICY_STORE) {
    await recoverRelayAttempt(job, env, "relay_storage_unavailable");
    return ACK;
  }
  const relay = await env.DB.prepare(
    "SELECT rr.id, rr.thread_id, rr.external_recipient, rr.reply_identity, rr.original_message_id, rr.references_json, rr.expires_at, rr.revoked_at, lower(ar.local_part || '@' || d.domain) AS route_address FROM reply_relays rr JOIN alias_routes ar ON ar.id = rr.route_id JOIN domains d ON d.id = ar.domain_id JOIN runtime_state rs ON rs.singleton = 1 AND rs.active_policy_sha256 = ar.policy_sha256 WHERE rr.id = ?1 AND ar.enabled = 1 LIMIT 1",
  )
    .bind(job.relayId)
    .first<ReplyRelayJobRow>();
  if (!relay || !relayRecordIsActive(relay.expires_at, relay.revoked_at)) {
    await failRelayAttempt(job, env, "relay_inactive");
    return ACK;
  }
  if (!normalizeRelayMailbox(relay.external_recipient) || !normalizeRelayMailbox(relay.reply_identity)) {
    await failRelayAttempt(job, env, "relay_address_invalid");
    return ACK;
  }

  const policy = await loadPolicy(env);
  if (!policy) {
    await recoverRelayAttempt(job, env, "policy_unavailable");
    return ACK;
  }
  const authorization = authorizeReplyWithPolicy(policy, {
    envelopeTo: relay.route_address,
    operator: job.operator,
    requestedIdentity: relay.reply_identity,
  });
  if (!authorization.ok || authorization.value.fromIdentity !== relay.reply_identity) {
    await failRelayAttempt(job, env, "operator_no_longer_authorized");
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

  let parsed: Awaited<ReturnType<typeof parseRelayEmail>>;
  try {
    parsed = await parseRelayEmail(await object.arrayBuffer());
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
    payload = outboundReplyPayload(parsed);
  } catch {
    await failRelayAttempt(job, env, "reply_plaintext_required");
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
    { attemptId: job.attemptId, relayId: job.relayId, fromIdentity: relay.reply_identity },
    `${job.attemptId}:inbox_reply_authorized`,
    relay.thread_id,
  );

  const outbound: OutboundReplyRequestedJob = {
    kind: "outbound_reply_requested",
    messageId: job.attemptId.replace(/^relay-attempt:/, ""),
    threadId: relay.thread_id,
    operator: job.operator,
    envelopeTo: relay.route_address,
    fromIdentity: relay.reply_identity,
    to: [relay.external_recipient],
    replyTo: relay.reply_identity,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
    headers,
    attachments: payload.attachments,
    requestedIdentity: relay.reply_identity,
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
    "UPDATE relay_attempts SET status = 'failed', error_code = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
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
    "UPDATE relay_attempts SET status = 'recovery_required', error_code = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
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

  // The first audit insert is the durable side-effect claim. Completed
  // transitions always have a terminal result event. A claimed transition
  // without a result is safe to resume only for Resend, whose request carries
  // the stable messageId idempotency key. Cloudflare Email Service does not
  // expose an equivalent key, so an interrupted transition is surfaced for
  // deliberate recovery instead of risking a duplicate send.
  if (!claimed) {
    const terminal = await terminalSendRecordForDedupeKey(
      env,
      `${job.messageId}:outbound_reply_result`,
    );
    if (terminal) {
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
    if (claimedMode !== "resend" || currentMode !== claimedMode) {
      await recordTerminalSendEvent(job, env, "outbound_reply_recovery_required", {
        ok: false,
        provider: claimedMode ?? "unknown",
        ambiguous: true,
        error:
          claimedMode && claimedMode !== currentMode
            ? `outbound provider mode changed before recovery: ${claimedMode} -> ${currentMode}`
            : "outbound transition was claimed without a resumable provider result",
      });
      return ACK;
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
      provider: configuredOutboundMode(env),
      attempt,
    },
    `${job.messageId}:outbound_reply_send_attempted:${attempt}`,
    job.threadId,
  );

  const sendResult = await sendOutboundReply(job, env);
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

async function projectInboundDeliveryResult(
  job: InboundDeliveryResultJob,
  env: Env,
): Promise<void> {
  const acceptedCount = job.results.filter((result) => result.ok).length;
  const providerMessageIds = job.results.flatMap((result) =>
    result.providerMessageId ? [result.providerMessageId] : []
  );
  const projected = await env.DB.prepare(
    "UPDATE route_health SET inbound_status = CASE WHEN ?1 = 'provider_accepted' AND inbound_status = 'inbox_verified' THEN inbound_status ELSE ?1 END, last_inbound_provider_accepted_at = CASE WHEN ?2 > 0 THEN CURRENT_TIMESTAMP ELSE last_inbound_provider_accepted_at END, last_inbound_provider_message_ids_json = CASE WHEN ?2 > 0 THEN ?3 ELSE last_inbound_provider_message_ids_json END, last_error_code = ?4, updated_at = CURRENT_TIMESTAMP WHERE route_id = ?5 AND policy_sha256 = ?6 AND EXISTS (SELECT 1 FROM runtime_state rs WHERE rs.singleton = 1 AND rs.active_policy_sha256 = ?6)",
  )
    .bind(
      job.status,
      acceptedCount,
      JSON.stringify(providerMessageIds),
      job.status === "provider_accepted" ? null : job.status,
      job.routeId,
      job.policySha256,
    )
    .run();
  if (Number(projected.meta?.changes ?? 0) === 0) {
    const runtime = await env.DB.prepare(
      "SELECT active_policy_sha256 FROM runtime_state WHERE singleton = 1",
    ).first<{ active_policy_sha256: string }>();
    if (!runtime?.active_policy_sha256 || runtime.active_policy_sha256 === job.policySha256) {
      throw new Error("active route health revision is unavailable for inbound result projection");
    }
    await recordAuditEvent(
      env,
      "system",
      "operator_delivery_result_superseded",
      {
        deliveryId: job.deliveryId,
        relayId: job.relayId,
        routeId: job.routeId,
        policySha256: job.policySha256,
        acceptedCount,
        failedCount: job.results.length - acceptedCount,
        providerMessageIds,
      },
      `${job.deliveryId}:operator_delivery_result_superseded`,
      job.threadId,
    );
    if (!env.RELAY_SPOOL) throw new Error("relay spool binding unavailable");
    await env.RELAY_SPOOL.delete(job.relaySpoolKey);
    return;
  }
  for (const [index, result] of job.results.entries()) {
    await recordAuditEvent(
      env,
      "system",
      result.ok ? "operator_delivery_recipient_provider_accepted" : "operator_delivery_recipient_recovery_required",
      {
        deliveryId: job.deliveryId,
        relayId: job.relayId,
        operatorRef: result.operatorRef,
        providerMessageId: result.providerMessageId,
        errorCode: result.errorCode,
      },
      `${job.deliveryId}:operator_delivery:${index}`,
      job.threadId,
    );
  }
  await recordAuditEvent(
    env,
    "system",
    job.status === "provider_accepted" ? "operator_delivery_provider_accepted" : job.status,
    {
      deliveryId: job.deliveryId,
      relayId: job.relayId,
      acceptedCount,
      failedCount: job.results.length - acceptedCount,
      providerMessageIds,
      recoverySpool: true,
    },
    `${job.deliveryId}:operator_delivery_result`,
    job.threadId,
  );
  if (job.status === "provider_accepted") {
    if (!env.RELAY_SPOOL) throw new Error("relay spool binding unavailable");
    await env.RELAY_SPOOL.delete(job.relaySpoolKey);
  }
}

async function recordTerminalSendEvent(
  job: OutboundReplyRequestedJob,
  env: Env,
  action: "outbound_reply_delivered" | "outbound_reply_failed" | "outbound_reply_recovery_required",
  result: OutboundSendResult,
): Promise<void> {
  await recordAuditEvent(
    env,
    await auditOperator(env, job.operator),
    action,
    {
      messageId: job.messageId,
      threadId: job.threadId,
      fromIdentity: job.fromIdentity,
      to: job.to,
      result: auditSendResult(result),
    },
    `${job.messageId}:outbound_reply_result`,
    job.threadId,
  );
  await finalizeTerminalSendState(job, env, action, result);
}

async function finalizeTerminalSendState(
  job: OutboundReplyRequestedJob,
  env: Env,
  action: TerminalSendAction,
  result: OutboundSendResult,
): Promise<void> {
  if (job.relayAttemptId) {
    const status = action === "outbound_reply_delivered"
      ? "provider_accepted"
      : action === "outbound_reply_recovery_required"
        ? "recovery_required"
        : "failed";
    await env.DB.prepare(
      "UPDATE relay_attempts SET status = ?1, provider_message_id = ?2, error_code = ?3, updated_at = CURRENT_TIMESTAMP WHERE id = ?4",
    )
      .bind(status, result.providerMessageId ?? null, result.error ? status : null, job.relayAttemptId)
      .run();
    await env.DB.prepare(
    "UPDATE route_health SET reply_status = CASE WHEN ?1 = 'provider_accepted' AND reply_status = 'reply_verified' THEN reply_status ELSE ?1 END, last_reply_at = CASE WHEN ?1 = 'provider_accepted' THEN CURRENT_TIMESTAMP ELSE last_reply_at END, last_reply_provider_accepted_at = CASE WHEN ?1 = 'provider_accepted' THEN CURRENT_TIMESTAMP ELSE last_reply_provider_accepted_at END, last_reply_provider_message_id = CASE WHEN ?1 = 'provider_accepted' THEN ?2 ELSE last_reply_provider_message_id END, last_error_code = ?3, updated_at = CURRENT_TIMESTAMP WHERE route_id = (SELECT rr.route_id FROM relay_attempts ra JOIN reply_relays rr ON rr.id = ra.relay_id WHERE ra.id = ?4)",
  )
      .bind(
        status,
        result.providerMessageId ?? null,
        result.error ? status : null,
        job.relayAttemptId,
      )
      .run();
    if (action === "outbound_reply_delivered" && job.relaySpoolKey) {
      if (!env.RELAY_SPOOL) throw new Error("relay spool binding unavailable");
      await env.RELAY_SPOOL.delete(job.relaySpoolKey);
      await env.DB.prepare(
        "UPDATE relay_attempts SET raw_r2_key = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
      )
        .bind(job.relayAttemptId)
        .run();
    }
  }
}

async function terminalSendRecordForDedupeKey(
  env: Env,
  dedupeKey: string,
): Promise<{ action: TerminalSendAction; result: OutboundSendResult } | null> {
  const row = await env.DB.prepare(
    "SELECT action, detail_json FROM audit_events WHERE dedupe_key = ?1 LIMIT 1",
  )
    .bind(dedupeKey)
    .first<{ action: string; detail_json: string }>();
  if (!row) return null;
  if (!isTerminalSendAction(row.action)) {
    throw new Error("outbound terminal audit action is invalid");
  }
  let detail: unknown;
  try {
    detail = JSON.parse(row.detail_json);
  } catch {
    throw new Error("outbound terminal audit detail is invalid");
  }
  if (!detail || typeof detail !== "object" || !("result" in detail)) {
    throw new Error("outbound terminal audit result is missing");
  }
  const result = (detail as { result: unknown }).result;
  if (!isStoredOutboundSendResult(result)) {
    throw new Error("outbound terminal audit result is invalid");
  }
  return { action: row.action, result };
}

function isTerminalSendAction(value: string): value is TerminalSendAction {
  return value === "outbound_reply_delivered" ||
    value === "outbound_reply_failed" ||
    value === "outbound_reply_recovery_required";
}

function isStoredOutboundSendResult(value: unknown): value is OutboundSendResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.ok === "boolean" &&
    typeof result.provider === "string" &&
    (result.providerMessageId === undefined || typeof result.providerMessageId === "string") &&
    (result.error === undefined || typeof result.error === "string") &&
    (result.status === undefined || typeof result.status === "number") &&
    (result.retryable === undefined || typeof result.retryable === "boolean") &&
    (result.ambiguous === undefined || typeof result.ambiguous === "boolean")
  );
}

async function auditOutboundModeForClaim(env: Env, dedupeKey: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT detail_json FROM audit_events WHERE dedupe_key = ?1 LIMIT 1",
  )
    .bind(dedupeKey)
    .first<{ detail_json: string }>();
  if (!row?.detail_json) return null;

  try {
    const detail = JSON.parse(row.detail_json) as { outboundMode?: unknown };
    return typeof detail.outboundMode === "string" ? detail.outboundMode : null;
  } catch {
    return null;
  }
}

function retryDelaySeconds(attempt: number): number {
  return Math.min(300, 5 * 2 ** Math.max(0, attempt - 1));
}

const ACK: QueueDisposition = { kind: "ack" };

// Stable idempotency base for a job: the inbound deliveryId (set by the router)
// or the outbound messageId. Returns undefined for jobs without one (no dedup).
function dedupeBase(job: MailJob): string | undefined {
  if (job.kind === "inbound_email_received") return job.deliveryId;
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
      operatorMessageId: job.operatorMessageId,
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
    to: job.to,
    outboundMode: configuredOutboundMode(env),
    cc: job.cc,
    replyTo: job.replyTo,
    subjectLength: job.subject.length,
    hasText: Boolean(job.text),
    hasHtml: Boolean(job.html),
    attachmentCount: job.attachments?.length ?? 0,
    queuedAt: job.queuedAt,
  };
}

function auditSendResult(result: OutboundSendResult): Omit<OutboundSendResult, "response"> {
  return {
    ok: result.ok,
    provider: result.provider,
    providerMessageId: result.providerMessageId,
    error: result.error,
    status: result.status,
    retryable: result.retryable,
    ambiguous: result.ambiguous,
  };
}

async function recordAuditEvent(
  env: Env,
  actor: string,
  action: string,
  detail: unknown,
  dedupeKey?: string,
  threadId?: string,
): Promise<boolean> {
  // INSERT OR IGNORE against a partial UNIQUE(dedupe_key) makes the at-least-once
  // queue consumer idempotent: a redelivered job re-inserts the same dedupe_key
  // and is silently dropped. Rows with a null dedupe_key are unconstrained by the
  // partial index, so legacy/ad-hoc events still always insert.
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO audit_events (id, dedupe_key, thread_id, actor, action, detail_json) VALUES (?1, ?2, (SELECT id FROM threads WHERE id = ?3), ?4, ?5, ?6)",
  )
    .bind(crypto.randomUUID(), dedupeKey ?? null, threadId ?? null, actor, action, JSON.stringify(detail))
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

type Env = MaildeskEnv;

function isAuthorizedRequest(request: Request, env: Env): boolean {
  const tokens = [env.MAILDESK_API_TOKEN, env.MAILDESK_PROOF_API_TOKEN].filter(Boolean);
  if (tokens.length === 0) return false;

  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const headerToken = request.headers.get("x-maildesk-token");
  return Boolean((bearer && tokens.includes(bearer)) || (headerToken && tokens.includes(headerToken)));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function isAttachmentArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const attachment = entry as Record<string, unknown>;
    return (
      (attachment.disposition === "inline" || attachment.disposition === "attachment") &&
      typeof attachment.filename === "string" &&
      typeof attachment.type === "string" &&
      attachment.content instanceof ArrayBuffer &&
      (attachment.contentId === undefined || typeof attachment.contentId === "string")
    );
  });
}

async function loadPolicy(env: Env): Promise<RouterPolicy | null> {
  return (await loadActivePolicy(env))?.policy ?? null;
}

async function sendOutboundReply(
  job: OutboundReplyRequestedJob,
  env: Env,
): Promise<OutboundSendResult> {
  const mode = configuredOutboundMode(env);

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

  if (operatorDeliveryConfig(env).mode === "inbox_relay") {
    const activePolicy = await loadActivePolicy(env);
    if (!activePolicy) {
      return { ok: false, provider: mode, error: "active policy is unavailable" };
    }
    const privacyFailure = outboundPrivacyFailure(job, activePolicy.policy);
    if (privacyFailure) {
      return { ok: false, provider: mode, error: privacyFailure };
    }
  }

  if (mode === "cloudflare_email_service") {
    if (!env.EMAIL) {
      return { ok: false, provider: mode, error: "Cloudflare Email Service binding is not configured" };
    }

    try {
      const result = await env.EMAIL.send({
        from: job.fromIdentity,
        to: job.to,
        cc: job.cc,
        bcc: job.bcc,
        replyTo: job.fromIdentity,
        subject: job.subject,
        text: job.text,
        html: job.html,
        headers: canonicalConversationHeaders(job),
        attachments: job.attachments,
      });
      return { ok: true, provider: mode, providerMessageId: result.messageId };
    } catch {
      return {
        ok: false,
        provider: mode,
        ambiguous: true,
        error: "Cloudflare Email Service send outcome is unknown",
      };
    }
  }

  if (mode === "resend") {
    if (!env.RESEND_API_KEY) {
      return { ok: false, provider: mode, error: "RESEND_API_KEY is not configured" };
    }
    if (job.attachments && job.attachments.length > 0) {
      return { ok: false, provider: mode, error: "Resend relay attachments are not configured" };
    }

    return sendWithResend(job, env.RESEND_API_KEY);
  }

  return { ok: false, provider: "invalid", error: "outbound mode is invalid" };
}

async function sendWithResend(
  job: OutboundReplyRequestedJob,
  apiKey: string,
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
      body: JSON.stringify({
        from: job.fromIdentity,
        to: job.to,
        cc: job.cc,
        bcc: job.bcc,
        reply_to: [job.fromIdentity],
        subject: job.subject,
        text: job.text,
        html: job.html,
        headers: canonicalConversationHeaders(job),
      }),
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

function configuredOutboundMode(env: Env): OutboundMode {
  const mode = env.MAILDESK_OUTBOUND_MODE ?? "disabled";
  if (mode === "disabled" || mode === "cloudflare_email_service" || mode === "resend") {
    return mode;
  }
  return "invalid";
}

function isVerifiedSenderDomain(domain: string, env: Env): boolean {
  const configured = env.MAILDESK_VERIFIED_SENDER_DOMAINS?.trim();
  if (!configured) return false;
  const domains = configured
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (domains.some((value) => value.includes("*"))) return false;
  return domains.includes(domain);
}

function senderDomain(address: string): string {
  const parsed = parseMailbox(address);
  return parsed?.domain ?? "";
}

function outboundPrivacyFailure(job: OutboundReplyRequestedJob, policy: RouterPolicy): string | null {
  // Opaque outbound attachments cannot be proven free of operator identities:
  // an address may be compressed, embedded in document structure, image metadata,
  // or encoded in a format that a byte/text scan cannot interpret. Fail closed
  // until a format-aware attachment policy exists.
  if ((job.attachments?.length ?? 0) > 0) {
    return "outbound attachments are disabled until format-aware privacy inspection is configured";
  }
  const operators = new Set<string>();
  for (const domain of Object.values(policy.domains)) {
    for (const route of Object.values(domain.role_aliases)) {
      for (const operator of route.operators) operators.add(normalizeMailbox(operator));
    }
    for (const route of Object.values(domain.personal_aliases)) operators.add(normalizeMailbox(route.operator));
    for (const operator of domain.catch_all?.operators ?? []) operators.add(normalizeMailbox(operator));
  }
  const outwardHeaders = canonicalConversationHeaders(job);
  const visible = [
    job.fromIdentity,
    job.replyTo ?? job.fromIdentity,
    ...job.to,
    ...(job.cc ?? []),
    ...(job.bcc ?? []),
    job.subject,
    job.text ?? "",
    job.html ?? "",
    htmlVisibleText(job.html ?? ""),
    ...Object.entries(outwardHeaders).flat(),
  ].map(normalizedVisibleValue);
  return [...operators].some((operator) => {
    const protectedIdentity = normalizedVisibleValue(operator);
    return protectedIdentity && visible.some((value) => value.includes(protectedIdentity));
  })
    ? "outbound content contains a private operator identity"
    : null;
}

function htmlVisibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<[^>]*>/g, "");
}

function normalizedVisibleValue(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&commat;/gi, "@")
    .replace(/&period;/gi, ".")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "");
}

async function auditOperator(env: Env, operator: string): Promise<string> {
  return operatorDeliveryConfig(env).mode === "inbox_relay"
    ? `operator:${await sha256Hex(normalizeRelayMailbox(operator))}`
    : operator;
}

function parseMailbox(address: string): ParsedMailbox | null {
  const normalized = normalizeMailbox(address);
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === normalized.length - 1) return null;

  return {
    localPart: normalized.slice(0, atIndex),
    domain: normalized.slice(atIndex + 1),
  };
}

function normalizeMailbox(address: string): string {
  return address.trim().toLowerCase();
}

function canonicalConversationHeaders(job: OutboundReplyRequestedJob): Record<string, string> {
  const headers: Record<string, string> = {
    "Message-ID": outboundMessageId(job),
  };
  const inReplyTo = messageHeader(job.headers, "in-reply-to");
  if (validMessageId(inReplyTo)) headers["In-Reply-To"] = inReplyTo;

  const references = validMessageIdList(messageHeader(job.headers, "references"));
  if (references.length > 0) headers.References = references.join(" ");
  return headers;
}

function outboundMessageId(job: OutboundReplyRequestedJob): string {
  const domain = senderDomain(job.fromIdentity) || "maildesk.invalid";
  const local = job.messageId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || crypto.randomUUID();
  return `<${local}@${domain}>`;
}

function messageHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1];
}

function validMessageId(value: string | null | undefined): value is string {
  return Boolean(value && value.length <= 998 && /^<[^<>\s]+>$/.test(value));
}

function validMessageIdList(value: string | null | undefined): string[] {
  if (!value || value.length > 8_000) return [];
  return [...new Set(value.match(/<[^<>\s]+>/g) ?? [])].slice(-50);
}

function storedReferences(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((entry): entry is string => typeof entry === "string" && validMessageId(entry)))].slice(-50);
  } catch {
    return [];
  }
}

function responseId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("id" in value)) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

interface ParsedMailbox {
  localPart: string;
  domain: string;
}

interface ReplyRelayJobRow {
  id: string;
  thread_id: string;
  external_recipient: string;
  reply_identity: string;
  original_message_id: string | null;
  references_json: string;
  expires_at: string;
  revoked_at: string | null;
  route_address: string;
}

interface OutboundSendResult {
  ok: boolean;
  provider: string;
  providerMessageId?: string;
  error?: string;
  status?: number;
  retryable?: boolean;
  ambiguous?: boolean;
  response?: unknown;
}

type TerminalSendAction =
  | "outbound_reply_delivered"
  | "outbound_reply_failed"
  | "outbound_reply_recovery_required";

type QueueDisposition = { kind: "ack" } | { kind: "retry"; delaySeconds: number };
type OutboundMode = "disabled" | "cloudflare_email_service" | "resend" | "invalid";
