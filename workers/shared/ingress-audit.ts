import type { MaildeskEnv as Env } from "./contracts";

export async function recordAudit(
  env: Env,
  dedupeKey: string,
  threadId: string | null,
  actor: string,
  action: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_events (id, dedupe_key, thread_id, actor, action, detail_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING",
  ).bind(crypto.randomUUID(), dedupeKey, threadId, actor, action, JSON.stringify(detail)).run();
}
