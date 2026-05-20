export interface MaildeskEnv {
  DB: D1Database;
  RAW_MAIL: R2Bucket;
  MAIL_JOBS: Queue<MailJob>;
  MAILDESK_POLICY_JSON?: string;
  MAILDESK_POLICY_R2_KEY?: string;
}

export type MailJob = InboundEmailReceivedJob | InboundEmailPersistedJob | OutboundReplyRequestedJob;

export interface InboundEmailReceivedJob {
  kind: "inbound_email_received";
  messageId: string;
  envelopeTo: string;
  envelopeFrom: string;
  routeKind?: "role_alias" | "personal_alias";
  forwardedTo?: string[];
  defaultReplyIdentity?: string;
  rawR2Key: string;
  rawSize: number;
  storageError?: string;
  receivedAt: string;
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

export function rawMailKey(messageId: string): string {
  const safeId = messageId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `raw/${new Date().toISOString().slice(0, 10)}/${safeId}.eml`;
}

export async function readiness(env: MaildeskEnv): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [
    { name: "db_binding", ok: Boolean(env.DB) },
    { name: "raw_mail_binding", ok: Boolean(env.RAW_MAIL) },
    { name: "mail_jobs_binding", ok: Boolean(env.MAIL_JOBS) },
    {
      name: "policy_config",
      ok: Boolean(env.MAILDESK_POLICY_JSON || env.MAILDESK_POLICY_R2_KEY),
      detail: "optional in template",
    },
  ];

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
