import {
  errorDetail,
  json,
  MailJob,
  MaildeskEnv,
  methodNotAllowed,
  notFound,
  OutboundReplyRequestedJob,
  readiness,
} from "../../shared/contracts";

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
      return queueReply(request, env);
    }

    return notFound();
  },

  async queue(batch: MessageBatch<MailJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await recordQueueEvent(message.body, env);
      message.ack();
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

  const authorization = authorizeReply(policy, body);
  if (authorization instanceof Error) {
    return json({ error: "reply_not_authorized", detail: authorization.message }, { status: 403 });
  }

  const job: OutboundReplyRequestedJob = {
    ...body,
    fromIdentity: authorization.fromIdentity,
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

async function recordQueueEvent(job: MailJob, env: Env): Promise<void> {
  const base = dedupeBase(job);

  await recordAuditEvent(env, "system", job.kind, job, base ? `${base}:${job.kind}` : undefined);

  if (job.kind !== "outbound_reply_requested") return;

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
      provider: env.MAILDESK_OUTBOUND_MODE ?? "disabled",
    },
    `${job.messageId}:outbound_reply_send_attempted`,
  );

  const sendResult = await sendOutboundReply(job, env);
  await recordAuditEvent(
    env,
    job.operator,
    sendResult.ok ? "outbound_reply_delivered" : "outbound_reply_failed",
    {
      messageId: job.messageId,
      threadId: job.threadId,
      fromIdentity: job.fromIdentity,
      to: job.to,
      result: sendResult,
    },
    `${job.messageId}:outbound_reply_result`,
  );
}

// Stable idempotency base for a job: the inbound deliveryId (set by the router)
// or the outbound messageId. Returns undefined for jobs without one (no dedup).
function dedupeBase(job: MailJob): string | undefined {
  if (job.kind === "inbound_email_received") return job.deliveryId;
  if (job.kind === "outbound_reply_requested") return job.messageId;
  return undefined;
}

async function recordAuditEvent(
  env: Env,
  actor: string,
  action: string,
  detail: unknown,
  dedupeKey?: string,
): Promise<void> {
  // INSERT OR IGNORE against a partial UNIQUE(dedupe_key) makes the at-least-once
  // queue consumer idempotent: a redelivered job re-inserts the same dedupe_key
  // and is silently dropped. Rows with a null dedupe_key are unconstrained by the
  // partial index, so legacy/ad-hoc events still always insert.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO audit_events (id, dedupe_key, actor, action, detail_json) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(crypto.randomUUID(), dedupeKey ?? null, actor, action, JSON.stringify(detail))
    .run();
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

function authorizeReply(policy: RouterPolicy, job: OutboundReplyRequestedJob): ReplyAuthorization | Error {
  const route = routeAddress(policy, job.envelopeTo);
  if (route instanceof Error) return route;

  const operator = normalizeMailbox(job.operator);
  if (!route.operators.includes(operator)) {
    return new Error(`operator is not allowed on route: ${operator}`);
  }

  const requestedIdentity = normalizeMailbox(job.requestedIdentity || job.fromIdentity || route.defaultReplyIdentity);
  if (!route.allowedReplyIdentities.includes(requestedIdentity)) {
    return new Error(`reply identity is not allowed for this route: ${requestedIdentity}`);
  }

  return { fromIdentity: requestedIdentity };
}

function routeAddress(policy: RouterPolicy, address: string): RouteDecision | Error {
  const parsed = parseMailbox(address);
  if (!parsed) return new Error(`invalid route recipient: ${address}`);

  const domainPolicy = policy.domains[parsed.domain];
  if (!domainPolicy) return new Error(`domain is not configured: ${parsed.domain}`);

  const roleAlias = domainPolicy.role_aliases[parsed.localPart];
  if (roleAlias) {
    if (roleAlias.sink) {
      return new Error(`alias is a store-only sink, not a reply route: ${address}`);
    }
    return {
      operators: unique(roleAlias.operators),
      defaultReplyIdentity: normalizeMailbox(roleAlias.reply_identity),
      allowedReplyIdentities: unique([
        roleAlias.reply_identity,
        ...roleAlias.allowed_reply_identities,
      ]),
    };
  }

  const personalAlias = domainPolicy.personal_aliases[parsed.localPart];
  if (personalAlias) {
    return {
      operators: [normalizeMailbox(personalAlias.operator)],
      defaultReplyIdentity: normalizeMailbox(personalAlias.reply_identity),
      allowedReplyIdentities: [normalizeMailbox(personalAlias.reply_identity)],
    };
  }

  const catchAll = domainPolicy.catch_all;
  if (catchAll) {
    if (catchAll.sink) {
      return new Error(`alias is a store-only sink, not a reply route: ${address}`);
    }
    return {
      operators: unique(catchAll.operators),
      defaultReplyIdentity: normalizeMailbox(catchAll.reply_identity),
      allowedReplyIdentities: unique([
        catchAll.reply_identity,
        ...catchAll.allowed_reply_identities,
      ]),
    };
  }

  return new Error(`alias is not configured: ${address}`);
}

async function sendOutboundReply(
  job: OutboundReplyRequestedJob,
  env: Env,
): Promise<OutboundSendResult> {
  const mode = env.MAILDESK_OUTBOUND_MODE ?? "disabled";
  const verifiedDomain = senderDomain(job.fromIdentity);

  if (!isVerifiedSenderDomain(verifiedDomain, env)) {
    return { ok: false, provider: mode, error: `sender domain is not verified: ${verifiedDomain}` };
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
    } catch (error) {
      return { ok: false, provider: mode, error: errorDetail(error) };
    }
  }

  if (mode === "resend") {
    if (!env.RESEND_API_KEY) {
      return { ok: false, provider: mode, error: "RESEND_API_KEY is not configured" };
    }

    return sendWithResend(job, env.RESEND_API_KEY);
  }

  return { ok: false, provider: mode, error: "outbound sending is disabled" };
}

async function sendWithResend(
  job: OutboundReplyRequestedJob,
  apiKey: string,
): Promise<OutboundSendResult> {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
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
        response: data,
      };
    }

    return {
      ok: true,
      provider: "resend",
      providerMessageId: responseId(data),
      response: data,
    };
  } catch (error) {
    return { ok: false, provider: "resend", error: errorDetail(error) };
  }
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

function unique(values: string[]): string[] {
  return [...new Set(values.map(normalizeMailbox).filter(Boolean))];
}

function responseId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("id" in value)) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

interface RouterPolicy {
  domains: Record<string, DomainPolicy>;
}

interface DomainPolicy {
  role_aliases: Record<string, RoleAliasPolicy>;
  personal_aliases: Record<string, PersonalAliasPolicy>;
  catch_all?: CatchAllPolicy;
}

interface RoleAliasPolicy {
  operators: string[];
  reply_identity: string;
  allowed_reply_identities: string[];
  sink?: boolean;
}

interface PersonalAliasPolicy {
  operator: string;
  reply_identity: string;
}

interface CatchAllPolicy {
  operators: string[];
  reply_identity: string;
  allowed_reply_identities: string[];
  sink?: boolean;
}

interface RouteDecision {
  operators: string[];
  defaultReplyIdentity: string;
  allowedReplyIdentities: string[];
}

interface ReplyAuthorization {
  fromIdentity: string;
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
  response?: unknown;
}
