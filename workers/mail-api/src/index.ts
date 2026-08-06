import {
  json,
  MailJob,
  MaildeskEnv,
  methodNotAllowed,
  notFound,
  OutboundReplyRequestedJob,
  readiness,
} from "../../shared/contracts";
import { authorizeReplyWithPolicy, RouterPolicy } from "../../shared/router";

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
    for (const message of batch.messages) {
      const disposition = await recordQueueEvent(message.body, env, Math.max(1, message.attempts));
      if (disposition.kind === "retry") {
        message.retry({ delaySeconds: disposition.delaySeconds });
      } else {
        message.ack();
      }
    }
  },
};

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
    typeof candidate.queuedAt === "string" &&
    (candidate.requestedIdentity === undefined || typeof candidate.requestedIdentity === "string")
  );
}

async function recordQueueEvent(
  job: MailJob,
  env: Env,
  attempt: number,
): Promise<QueueDisposition> {
  const base = dedupeBase(job);

  const claimed = await recordAuditEvent(
    env,
    "system",
    job.kind,
    auditDetailForJob(job, env),
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
    const terminalAction = await auditActionForDedupeKey(
      env,
      `${job.messageId}:outbound_reply_result`,
    );
    if (terminalAction) return ACK;

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
    job.operator,
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
    job.operator,
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
      job.operator,
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
  return ACK;
}

async function recordTerminalSendEvent(
  job: OutboundReplyRequestedJob,
  env: Env,
  action: "outbound_reply_delivered" | "outbound_reply_failed" | "outbound_reply_recovery_required",
  result: OutboundSendResult,
): Promise<void> {
  await recordAuditEvent(
    env,
    job.operator,
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
}

async function auditActionForDedupeKey(env: Env, dedupeKey: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT action FROM audit_events WHERE dedupe_key = ?1 LIMIT 1",
  )
    .bind(dedupeKey)
    .first<{ action: string }>();
  return row?.action ?? null;
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
  return undefined;
}

function jobThreadId(job: MailJob): string | undefined {
  if (job.kind === "inbound_email_persisted" || job.kind === "outbound_reply_requested") {
    return job.threadId;
  }
  return undefined;
}

function auditDetailForJob(job: MailJob, env: Env): unknown {
  if (job.kind !== "outbound_reply_requested") return job;

  return {
    kind: job.kind,
    messageId: job.messageId,
    threadId: job.threadId,
    operator: job.operator,
    envelopeTo: job.envelopeTo,
    fromIdentity: job.fromIdentity,
    to: job.to,
    outboundMode: configuredOutboundMode(env),
    cc: job.cc,
    replyTo: job.replyTo,
    subjectLength: job.subject.length,
    hasText: Boolean(job.text),
    hasHtml: Boolean(job.html),
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

async function loadPolicy(env: Env): Promise<RouterPolicy | null> {
  const policyJson = env.MAILDESK_POLICY_JSON ?? (await loadPolicyFromR2(env));
  if (!policyJson) return null;
  // Malformed policy JSON must not 500; return null so callers emit a clean
  // 503 policy_unavailable (mirrors the router's fail-closed handling).
  try {
    return JSON.parse(policyJson) as RouterPolicy;
  } catch {
    return null;
  }
}

async function loadPolicyFromR2(env: Env): Promise<string | null> {
  if (!env.MAILDESK_POLICY_R2_KEY) return null;
  const policyObject = await env.RAW_MAIL.get(env.MAILDESK_POLICY_R2_KEY);
  return policyObject?.text() ?? null;
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
        replyTo: job.replyTo,
        subject: job.subject,
        text: job.text,
        html: job.html,
        headers: job.headers,
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
        reply_to: job.replyTo ? [job.replyTo] : undefined,
        subject: job.subject,
        text: job.text,
        html: job.html,
        headers: job.headers,
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
  if (configured === "*") return true;
  return configured
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(domain);
}

function senderDomain(address: string): string {
  const parsed = parseMailbox(address);
  return parsed?.domain ?? "";
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

function responseId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("id" in value)) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

interface ParsedMailbox {
  localPart: string;
  domain: string;
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

type QueueDisposition = { kind: "ack" } | { kind: "retry"; delaySeconds: number };
type OutboundMode = "disabled" | "cloudflare_email_service" | "resend" | "invalid";
