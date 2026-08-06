export interface MaildeskEnv {
  DB: D1Database;
  RAW_MAIL: R2Bucket;
  MAIL_JOBS: Queue<MailJob>;
  EMAIL?: SendEmail;
  RESEND_API_KEY?: string;
  MAILDESK_API_TOKEN?: string;
  MAILDESK_PROOF_API_TOKEN?: string;
  MAILDESK_REPLY_API_MODE?: "disabled" | "token";
  MAILDESK_OUTBOUND_MODE?: "disabled" | "cloudflare_email_service" | "resend";
  MAILDESK_POLICY_JSON?: string;
  MAILDESK_POLICY_R2_KEY?: string;
  MAILDESK_VERIFIED_SENDER_DOMAINS?: string;
}

export type MailJob = InboundEmailReceivedJob | InboundEmailPersistedJob | OutboundReplyRequestedJob;

export interface InboundEmailReceivedJob {
  kind: "inbound_email_received";
  messageId: string;
  /** Stable per-acceptance id; the idempotency key for audit + raw-archive. */
  deliveryId: string;
  envelopeTo: string;
  envelopeFrom: string;
  routeKind?: "role_alias" | "personal_alias" | "catch_all" | "sink";
  forwardedTo?: string[];
  forwardErrors?: ForwardError[];
  defaultReplyIdentity?: string;
  rawR2Key: string;
  rawSize: number;
  storageError?: string;
  receivedAt: string;
}

export interface ForwardError {
  recipient: string;
  error: string;
}

export interface InboundEmailPersistedJob {
  kind: "inbound_email_persisted";
  messageId: string;
  threadId: string;
  routeId: string;
  queuedAt: string;
}

export interface OutboundReplyRequestedJob {
  kind: "outbound_reply_requested";
  messageId: string;
  threadId: string;
  operator: string;
  envelopeTo: string;
  fromIdentity: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  requestedIdentity?: string;
  queuedAt: string;
}

export interface ReadinessReport {
  ok: boolean;
  checks: ReadinessCheck[];
}

export interface ReadinessCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function notFound(): Response {
  return json({ error: "not_found" }, { status: 404 });
}

export function methodNotAllowed(): Response {
  return json({ error: "method_not_allowed" }, { status: 405 });
}

export function rawMailKey(messageId: string, deliveryId: string): string {
  const safeId = messageId.replace(/[^a-zA-Z0-9._-]/g, "_");
  // deliveryId disambiguates same-day retries that reuse a Message-ID, so a
  // retried delivery never overwrites the prior raw archive.
  return `raw/${new Date().toISOString().slice(0, 10)}/${safeId}__${deliveryId}.eml`;
}

export async function readiness(env: MaildeskEnv): Promise<ReadinessReport> {
  const replyApiMode = env.MAILDESK_REPLY_API_MODE ?? "disabled";
  const checks: ReadinessCheck[] = [
    { name: "db_binding", ok: Boolean(env.DB) },
    { name: "raw_mail_binding", ok: Boolean(env.RAW_MAIL) },
    { name: "mail_jobs_binding", ok: Boolean(env.MAIL_JOBS) },
    {
      name: "reply_api",
      ok:
        replyApiMode === "disabled" ||
        (replyApiMode === "token" && Boolean(env.MAILDESK_API_TOKEN || env.MAILDESK_PROOF_API_TOKEN)),
      detail: replyApiMode,
    },
    {
      name: "policy_config",
      ok: Boolean(env.MAILDESK_POLICY_JSON || env.MAILDESK_POLICY_R2_KEY),
      detail: "optional in template",
    },
  ];

  const outboundMode = (env.MAILDESK_OUTBOUND_MODE ?? "disabled") as string;
  if (outboundMode === "cloudflare_email_service") {
    checks.push({
      name: "outbound_sender",
      ok: Boolean(env.EMAIL),
      detail: "cloudflare_email_service",
    });
  } else if (outboundMode === "resend") {
    checks.push({
      name: "outbound_sender",
      ok: Boolean(env.RESEND_API_KEY),
      detail: "resend",
    });
  } else if (outboundMode === "disabled") {
    checks.push({
      name: "outbound_sender",
      ok: true,
      detail: "disabled",
    });
  } else {
    checks.push({
      name: "outbound_sender",
      ok: false,
      detail: `invalid outbound mode: ${outboundMode}`,
    });
  }

  if (env.DB) {
    try {
      await env.DB.prepare("SELECT 1").first();
      checks.push({ name: "db_query", ok: true });
    } catch (error) {
      checks.push({ name: "db_query", ok: false, detail: errorDetail(error) });
    }
  }

  return {
    ok: checks.every((check) => check.ok || check.name === "policy_config"),
    checks,
  };
}

export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
