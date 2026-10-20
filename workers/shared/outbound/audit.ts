import { operatorDeliveryConfig,type MaildeskEnv as Env,type OutboundReplyRequestedJob } from "../contracts";
import { normalizeMailbox as normalizeRelayMailbox,sha256Hex } from "../inbox-relay";
import type { OutboundSendResult,TerminalSendAction } from "./types";

export async function terminalSendRecordForDedupeKey(
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

export function isTerminalSendAction(value: string): value is TerminalSendAction {
  return value === "outbound_reply_delivered" ||
    value === "outbound_reply_failed" ||
    value === "outbound_reply_recovery_required";
}

export function isStoredOutboundSendResult(value: unknown): value is OutboundSendResult {
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

export async function auditOutboundModeForClaim(env: Env, dedupeKey: string): Promise<string | null> {
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

export function auditSendResult(result: OutboundSendResult): Omit<OutboundSendResult, "response"> {
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

export async function recordAuditEvent(
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

export async function recordOutboundDuplicateSuppressed(
  job: OutboundReplyRequestedJob,
  env: Env,
  observedState: "terminal" | "non_resumable_claim",
): Promise<void> {
  await recordAuditEvent(
    env,
    "system",
    "outbound_reply_duplicate_suppressed",
    {
      messageIdSha256: await sha256Hex(job.messageId),
      admissionId: job.admissionId ?? null,
      transactionSha256: job.transactionSha256 ?? null,
      attemptSha256: job.attemptSha256 ?? null,
      outcome: "duplicate_suppressed",
      observedState,
      providerReplay: false,
    },
    `${job.messageId}:outbound_reply_duplicate_suppressed`,
    job.threadId,
  );
}

export async function auditOperator(env: Env, operator: string): Promise<string> {
  const mode = operatorDeliveryConfig(env).mode;
  if (mode === "inbox_relay") return `operator:${await sha256Hex(normalizeRelayMailbox(operator))}`;
  if (mode === "web_desk") return operator;
  return "operator:invalid";
}
