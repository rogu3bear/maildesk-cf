import { loadActivePolicy } from "../../shared/policy-store";
import { reportRoutes, type CanaryReport, type RouteSnapshot } from "./report";

export interface CanaryEnv {
  DB: D1Database;
  POLICY_STORE: R2Bucket;
  EMAIL: SendEmail;
  MAILDESK_CANARY_MODE?: string;
  MAILDESK_CANARY_FROM?: string;
  MAILDESK_CANARY_TO?: string;
  MAILDESK_CANARY_MAX_PROOF_AGE_HOURS?: string;
  MAILDESK_CANARY_INBOUND_MODE?: string;
  MAILDESK_CANARY_REPLY_MODE?: string;
}

const HOUR = 3_600_000;
export const ROUTES_SQL = `SELECT ar.id AS route_id, ar.decision_kind,
  rh.policy_sha256 AS health_policy_sha256, rh.inbound_status, rh.reply_status,
  rh.last_inbox_verified_at, rh.last_reply_verified_at,
  (SELECT MAX(rp.verified_at) FROM route_proofs rp
   WHERE rp.route_id = ar.id AND rp.policy_sha256 = ar.policy_sha256
     AND rp.proof_kind = 'edge_verified') AS edge_verified_at
  FROM alias_routes ar
  JOIN runtime_state rs ON rs.singleton = 1 AND rs.active_policy_sha256 = ar.policy_sha256
  LEFT JOIN route_health rh ON rh.route_id = ar.id AND rh.policy_sha256 = ar.policy_sha256
  WHERE ar.enabled = 1 AND ar.policy_sha256 = ?1 ORDER BY ar.id LIMIT 10001`;

export async function runCanary(env: CanaryEnv, now = Date.now()): Promise<CanaryReport | null> {
  if (env.MAILDESK_CANARY_MODE === "disabled") return null;
  if (env.MAILDESK_CANARY_MODE !== "enabled") throw new Error("canary mode must be explicit");
  const from = mailbox(env.MAILDESK_CANARY_FROM);
  const to = mailbox(env.MAILDESK_CANARY_TO);
  const hours = Number(env.MAILDESK_CANARY_MAX_PROOF_AGE_HOURS ?? "24");
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 720) throw new Error("invalid canary proof age");
  if (!env.EMAIL) throw new Error("canary notification binding missing");
  const sender = await env.DB.prepare(
    "SELECT i.address FROM identities i JOIN alias_routes ar ON ar.default_reply_identity_id = i.id JOIN runtime_state rs ON rs.singleton = 1 AND rs.active_policy_sha256 = ar.policy_sha256 WHERE ar.enabled = 1 AND ar.decision_kind <> 'sink' AND i.kind = 'role' AND i.address = ?1 LIMIT 1",
  ).bind(from).first<{ address: string }>();
  if (sender?.address !== from) throw new Error("canary sender must be an active public role identity");
  let report: CanaryReport;
  try {
    const active = await loadActivePolicy({ ...env, MAILDESK_OPERATOR_DELIVERY_MODE: "inbox_relay" });
    if (!active) throw new Error("active policy unavailable");
    const revision = await env.DB.prepare(
      "SELECT pr.expected_route_count FROM runtime_state rs JOIN policy_revisions pr ON pr.policy_sha256 = rs.active_policy_sha256 WHERE rs.singleton = 1 AND rs.active_policy_sha256 = ?1",
    ).bind(active.sha256).first<{ expected_route_count: number }>();
    if (!revision) throw new Error("policy changed during canary");
    const routes = await env.DB.prepare(ROUTES_SQL).bind(active.sha256).all<RouteSnapshot>();
    if (!routes.success || !routes.results || routes.results.length > 10000) throw new Error("route inventory unavailable");
    report = reportRoutes({
      policy_sha256: active.sha256,
      expected_routes: revision.expected_route_count,
      routes: routes.results,
    }, now, hours * HOUR, {
      inbound: env.MAILDESK_CANARY_INBOUND_MODE ?? "disabled",
      reply: env.MAILDESK_CANARY_REPLY_MODE ?? "disabled",
    });
  } catch {
    // Do not leak policy, addresses, provider payloads or exception text.
    report = {
      schema_version: 1, checked_at: new Date(now).toISOString(), status: "unverified",
      policy_sha256: "", expected_routes: 0, observed_routes: 0, excluded_routes: 0,
      current_routes: 0, issues: { policy_or_route_inventory_unavailable: 1 },
      provider_inventory_checked: false, live_probe_sent: false,
    };
  }
  await notify(env, from, to, report, now);
  return report;
}

async function notify(env: CanaryEnv, from: string, to: string, report: CanaryReport, now: number): Promise<void> {
  const { checked_at: _checkedAt, ...stableReport } = report;
  const hash = await digest(JSON.stringify(stableReport));
  const previous = await env.DB.prepare(
    "SELECT attempt_state FROM mail_canary_state WHERE singleton = 1",
  ).first<{ attempt_state: string }>();
  if (!previous || previous.attempt_state !== "idle") {
    throw new Error("canary notification requires reconciliation of an incomplete attempt");
  }
  const attempt = crypto.randomUUID();
  // Claim before the external send. Competing cron invocations cannot send twice.
  const claimed = await env.DB.prepare(
    "UPDATE mail_canary_state SET attempt_id = ?1, attempt_state = 'sending' WHERE singleton = 1 AND attempt_state = 'idle' AND (last_report_sha256 IS NULL OR last_report_sha256 <> ?2 OR last_notified_at_ms <= ?3) RETURNING singleton",
  ).bind(attempt, hash, now - 24 * HOUR).first<{ singleton: number }>();
  if (!claimed) return;
  try {
    const sent = await env.EMAIL.send({
      from, to: [to], subject: `Maildesk canary: ${report.status}`,
      text: notificationText(report),
    });
    if (!sent.messageId) throw new Error("notification acceptance missing");
    const saved = await env.DB.batch([
      env.DB.prepare("UPDATE mail_canary_state SET attempt_state = 'idle', last_report_sha256 = ?1, last_notified_at_ms = ?2 WHERE singleton = 1 AND attempt_id = ?3 AND attempt_state = 'sending'").bind(hash, now, attempt),
      env.DB.prepare("INSERT INTO audit_events (id, actor, action, detail_json) VALUES (?1, 'mail_canary', 'canary_notification_provider_accepted', ?2)").bind(attempt, JSON.stringify({ report, provider_message_id: sent.messageId })),
    ]);
    if (saved.some((result) => !result.success) || saved[0]?.meta.changes !== 1) {
      throw new Error("notification receipt persistence failed");
    }
  } catch {
    // A timeout or failed persistence may follow acceptance. Never replay it.
    await env.DB.prepare("UPDATE mail_canary_state SET attempt_state = 'uncertain' WHERE singleton = 1 AND attempt_id = ?1 AND attempt_state = 'sending'").bind(attempt).run();
    throw new Error("canary notification outcome uncertain; inspect provider evidence before recovery");
  }
}

export function notificationText(report: CanaryReport): string {
  return [
    `Maildesk route canary at ${report.checked_at}`,
    `Status: ${report.status}`,
    `Active routes: ${report.observed_routes}/${report.expected_routes}`,
    `Current receipt sets: ${report.current_routes}; intentionally excluded: ${report.excluded_routes}`,
    ...Object.entries(report.issues).map(([code, count]) => `${code}: ${count}`),
    "This run checked D1 route receipts and the active R2 policy. It did not check live provider inventory or send mailbox probes.",
    "Provider acceptance of this notification is separate from receipt in your inbox.",
  ].join("\n");
}

function mailbox(value: string | undefined): string {
  if (!value || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value) || /[\r\n]/.test(value)) {
    throw new Error("canary requires explicit notification addresses");
  }
  return value.toLowerCase();
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default {
  async scheduled(_event: ScheduledController, env: CanaryEnv): Promise<void> {
    await runCanary(env);
  },
} satisfies ExportedHandler<CanaryEnv>;
