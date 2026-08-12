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
  MAILDESK_OPERATOR_DELIVERY_MODE?: "web_desk" | "inbox_relay";
  MAILDESK_REPLY_DOMAIN?: string;
  MAILDESK_REPLY_TOKEN_TTL_DAYS?: string;
  MAILDESK_SPOOL_RETENTION_DAYS?: string;
  MAILDESK_MAX_ENCODED_MESSAGE_BYTES?: string;
}

export type MailJob =
  | InboundEmailReceivedJob
  | InboundEmailPersistedJob
  | InboxReplyReceivedJob
  | OutboundReplyRequestedJob;

export type OperatorDeliveryMode = "web_desk" | "inbox_relay" | "invalid";

export interface OperatorDeliveryConfig {
  mode: OperatorDeliveryMode;
  replyDomain: string | null;
  replyTokenTtlDays: number;
  spoolRetentionDays: number;
  maxEncodedMessageBytes: number;
  bannerMode: "inline";
}

export type RouteProofStatus =
  | "declared"
  | "local_policy_valid"
  | "edge_verified"
  | "provider_accepted"
  | "inbox_verified"
  | "reply_verified"
  | "partial_delivery"
  | "recovery_required"
  | "failed"
  | "intentionally_excluded";

export interface RouteHealthSummary {
  routeId: string;
  routeAddress: string;
  routeKind: "role_alias" | "personal_alias" | "catch_all" | "sink";
  desiredProvider: "cloudflare_email_routing" | "google_workspace" | "external";
  observedProvider?: string;
  operatorCount: number;
  replyIdentity: string;
  inboundStatus: RouteProofStatus;
  replyStatus: RouteProofStatus;
  lastInboundAt?: string;
  lastReplyAt?: string;
  lastInboundProviderAcceptedAt?: string;
  lastInboxVerifiedAt?: string;
  lastReplyProviderAcceptedAt?: string;
  lastReplyVerifiedAt?: string;
  lastErrorCode?: string;
}

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

export interface InboxReplyReceivedJob {
  kind: "inbox_reply_received";
  attemptId: string;
  relayId: string;
  operator: string;
  operatorMessageId: string;
  rawR2Key: string;
  receivedAt: string;
}

export type MailAttachmentPayload =
  | {
      disposition: "inline";
      contentId: string;
      filename: string;
      type: string;
      content: ArrayBuffer;
    }
  | {
      disposition: "attachment";
      contentId?: undefined;
      filename: string;
      type: string;
      content: ArrayBuffer;
    };

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
  attachments?: MailAttachmentPayload[];
  requestedIdentity?: string;
  relayAttemptId?: string;
  relaySpoolKey?: string;
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

export function relaySpoolKey(attemptId: string, receivedAt: string): string {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(receivedAt)?.[0] ?? "undated";
  const safeId = attemptId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `relay-spool/${day}/${safeId}.eml`;
}

export function operatorDeliveryConfig(env: MaildeskEnv): OperatorDeliveryConfig {
  const configuredMode = env.MAILDESK_OPERATOR_DELIVERY_MODE as string | undefined;
  const mode: OperatorDeliveryMode = configuredMode === undefined || configuredMode === "web_desk"
    ? "web_desk"
    : configuredMode === "inbox_relay"
      ? "inbox_relay"
      : "invalid";
  const replyDomain = normalizeDomain(env.MAILDESK_REPLY_DOMAIN);
  const replyTokenTtlDays = boundedPositiveInteger(env.MAILDESK_REPLY_TOKEN_TTL_DAYS, 90, 1, 365);
  const spoolRetentionDays = boundedPositiveInteger(env.MAILDESK_SPOOL_RETENTION_DAYS, 7, 1, 30);
  const maxEncodedMessageBytes = boundedPositiveInteger(
    env.MAILDESK_MAX_ENCODED_MESSAGE_BYTES,
    5 * 1024 * 1024,
    64 * 1024,
    5 * 1024 * 1024,
  );

  return {
    mode,
    replyDomain,
    replyTokenTtlDays,
    spoolRetentionDays,
    maxEncodedMessageBytes,
    bannerMode: "inline",
  };
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

  const delivery = operatorDeliveryConfig(env);
  checks.push({
    name: "operator_delivery_mode",
    ok: delivery.mode !== "invalid",
    detail: delivery.mode,
  });
  if (delivery.mode === "inbox_relay") {
    checks.push({
      name: "reply_domain",
      ok: Boolean(delivery.replyDomain),
      detail: delivery.replyDomain ?? "missing",
    });
    checks.push({
      name: "operator_delivery_sender",
      ok: Boolean(env.EMAIL),
      detail: "cloudflare_email_service",
    });
  }

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

function normalizeDomain(value: string | undefined): string | null {
  const domain = value?.trim().toLowerCase();
  if (!domain || domain.length > 253 || !/^[a-z0-9.-]+$/.test(domain)) return null;
  return domain;
}

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
