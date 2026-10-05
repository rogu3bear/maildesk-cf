export interface HeartbeatEnv {
  DB: D1Database;
  MAILDESK_HEARTBEAT_MODE?: string;
  MAILDESK_HEARTBEAT_URL?: string;
  MAILDESK_HEARTBEAT_MAX_AGE_HOURS?: string;
}

const HOUR = 3_600_000;

export async function runHeartbeat(
  env: HeartbeatEnv,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<"sent" | null> {
  if (env.MAILDESK_HEARTBEAT_MODE === "disabled") return null;
  if (env.MAILDESK_HEARTBEAT_MODE !== "enabled") throw new Error("heartbeat mode must be explicit");
  const url = heartbeatUrl(env.MAILDESK_HEARTBEAT_URL);
  const hours = Number(env.MAILDESK_HEARTBEAT_MAX_AGE_HOURS ?? "2");
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 24) throw new Error("invalid heartbeat age");
  const ready = await configurationReady(env, now, hours * HOUR);
  if (!ready) throw new Error("heartbeat withheld; configuration ledger is stale or notification attempt is incomplete");
  const response = await fetchImpl(url, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "maildesk-heartbeat", status: "ready" }),
  });
  if (!response.ok) throw new Error("heartbeat endpoint rejected the ping");
  return "sent";
}

async function configurationReady(env: HeartbeatEnv, now: number, maxAgeMs: number): Promise<boolean> {
  const attempt = await env.DB.prepare(
    "SELECT attempt_state, last_notified_at_ms FROM mail_canary_state WHERE singleton = 1",
  ).first<{ attempt_state: string; last_notified_at_ms: number }>();
  if (!attempt || attempt.attempt_state !== "idle" || !(attempt.last_notified_at_ms > 0)) return false;
  const ledger = await env.DB.prepare(
    "SELECT COUNT(*) AS n, MAX(updated_at_ms) AS updated_at_ms FROM route_proof_ledger WHERE plane = 'configuration'",
  ).first<{ n: number; updated_at_ms: number | null }>();
  return !!ledger && ledger.n > 0 && ledger.updated_at_ms !== null &&
    ledger.updated_at_ms <= now && now - ledger.updated_at_ms <= maxAgeMs;
}

function heartbeatUrl(value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error("heartbeat URL must be explicit https");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("heartbeat URL must be explicit https");
  }
  return url.toString();
}

export default {
  async scheduled(_event: ScheduledController, env: HeartbeatEnv): Promise<void> {
    await runHeartbeat(env);
  },
} satisfies ExportedHandler<HeartbeatEnv>;
