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
  const response = await fetchImpl(url, { method: "POST", redirect: "error" });
  if (!response.ok) throw new Error("heartbeat endpoint rejected the ping");
  return "sent";
}

async function configurationReady(env: HeartbeatEnv, now: number, maxAgeMs: number): Promise<boolean> {
  // The canary stamps last_coverage_at_ms in the same transaction as its whole ledger.
  const state = await env.DB.prepare(
    "SELECT attempt_state, last_notified_at_ms, last_coverage_at_ms FROM mail_canary_state WHERE singleton = 1",
  ).first<{ attempt_state: string; last_notified_at_ms: number; last_coverage_at_ms: number }>();
  return !!state && state.attempt_state === "idle" && state.last_notified_at_ms > 0 &&
    state.last_coverage_at_ms > 0 && state.last_coverage_at_ms <= now && now - state.last_coverage_at_ms <= maxAgeMs;
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
