import { loadActivePolicy } from "../../shared/policy-store";
import { proofMillis, reportRoutes, selectProbeRotation, type CanaryReport } from "./report";
import { assertPolicyRoutes, type RouteInventoryRow } from "./policy-routes";

export interface CanaryEnv {
  DB: D1Database;
  POLICY_STORE: R2Bucket;
  EMAIL: SendEmail;
  MAILDESK_CANARY_MODE?: string;
  MAILDESK_CANARY_FROM?: string;
  MAILDESK_CANARY_TO?: string;
  MAILDESK_CANARY_MAX_PROOF_AGE_HOURS?: string;
  MAILDESK_CANARY_PROBE_BATCH?: string;
  MAILDESK_CANARY_INBOUND_MODE?: string;
  MAILDESK_CANARY_REPLY_MODE?: string;
}

const HOUR = 3_600_000;
export const ROUTES_SQL = `SELECT ar.id AS route_id, ar.decision_kind,
  ar.domain_id, d.domain, ar.local_part, ar.kind AS storage_kind,
  ar.default_reply_identity_id AS reply_identity_id, i.address AS reply_identity,
  rh.policy_sha256 AS health_policy_sha256, rh.inbound_status, rh.reply_status,
  rh.last_inbox_verified_at, rh.last_reply_verified_at,
  (SELECT MAX(rp.verified_at) FROM route_proofs rp
   WHERE rp.route_id = ar.id AND rp.policy_sha256 = ar.policy_sha256
     AND rp.proof_kind = 'edge_verified') AS edge_verified_at
  FROM alias_routes ar
  JOIN domains d ON d.id = ar.domain_id
  JOIN identities i ON i.id = ar.default_reply_identity_id
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
  const batch = Number(env.MAILDESK_CANARY_PROBE_BATCH ?? "3");
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 8) throw new Error("invalid canary probe batch");
  if (!env.EMAIL) throw new Error("canary notification binding missing");
  const sender = await env.DB.prepare(
    "SELECT i.address FROM identities i JOIN alias_routes ar ON ar.default_reply_identity_id = i.id JOIN runtime_state rs ON rs.singleton = 1 AND rs.active_policy_sha256 = ar.policy_sha256 WHERE ar.enabled = 1 AND ar.decision_kind <> 'sink' AND i.kind = 'role' AND i.address = ?1 LIMIT 1",
  ).bind(from).first<{ address: string }>();
  if (sender?.address !== from) throw new Error("canary sender must be an active public role identity");
  let report: CanaryReport;
  let coverage: { sha256: string; routes: RouteInventoryRow[] } | null = null;
  try {
    const active = await loadActivePolicy({ ...env, MAILDESK_OPERATOR_DELIVERY_MODE: "inbox_relay" });
    if (!active) throw new Error("active policy unavailable");
    const revision = await env.DB.prepare(
      "SELECT pr.expected_route_count FROM runtime_state rs JOIN policy_revisions pr ON pr.policy_sha256 = rs.active_policy_sha256 WHERE rs.singleton = 1 AND rs.active_policy_sha256 = ?1",
    ).bind(active.sha256).first<{ expected_route_count: number }>();
    if (!revision) throw new Error("policy changed during canary");
    const routes = await env.DB.prepare(ROUTES_SQL).bind(active.sha256).all<RouteInventoryRow>();
    if (!routes.success || !routes.results || routes.results.length > 10000) throw new Error("route inventory unavailable");
    assertPolicyRoutes(active.policy, routes.results);
    report = reportRoutes({
      policy_sha256: active.sha256,
      expected_routes: revision.expected_route_count,
      routes: routes.results,
    }, now, hours * HOUR, {
      inbound: env.MAILDESK_CANARY_INBOUND_MODE ?? "disabled",
      reply: env.MAILDESK_CANARY_REPLY_MODE ?? "disabled",
    }, batch);
    coverage = { sha256: active.sha256, routes: routes.results };
  } catch {
    // Do not leak policy, addresses, provider payloads or exception text.
    report = {
      schema_version: 2, checked_at: new Date(now).toISOString(), status: "unverified",
      policy_sha256: "", expected_routes: 0, observed_routes: 0, excluded_routes: 0,
      current_routes: 0, configuration_routes: 0, inbox_proofs_fresh: 0, reply_proofs_fresh: 0,
      inbox_proofs_recorded: 0, reply_proofs_recorded: 0, probe_due: 0,
      issues: { policy_or_route_inventory_unavailable: 1 },
      provider_inventory_checked: false, live_probe_sent: false,
    };
  }
  if (coverage) {
    try {
      await recordCoverage(env, coverage.sha256, coverage.routes, now, batch);
    } catch {
      // The inventory was read; only its ledger was not saved. Keep the counts.
      report = {
        ...report,
        status: report.status === "failed" ? "failed" : "unverified",
        issues: { ...report.issues, proof_ledger_unavailable: 1 },
      };
    }
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

// Ledger rows per JSON parameter. Keeps each bound value well under D1's row size limit.
const LEDGER_CHUNK = 2000;

// Each ledger statement binds one JSON array, so a run issues a handful of D1
// queries regardless of inventory size. Unchanged rows are not rewritten, and a
// configuration row keeps the first time it was read under its policy revision.
const LEDGER_UPSERT = `INSERT INTO route_proof_ledger (route_id, plane, policy_sha256, verified_at_ms, updated_at_ms)
  SELECT value ->> '$[0]', value ->> '$[1]', ?1, value ->> '$[2]', ?2 FROM json_each(?3) WHERE true
  ON CONFLICT(route_id, plane) DO UPDATE SET
    policy_sha256 = excluded.policy_sha256,
    verified_at_ms = excluded.verified_at_ms,
    updated_at_ms = excluded.updated_at_ms
  WHERE route_proof_ledger.policy_sha256 IS NOT excluded.policy_sha256
    OR (route_proof_ledger.plane <> 'configuration' AND route_proof_ledger.verified_at_ms IS NOT excluded.verified_at_ms)`;

export async function recordCoverage(env: CanaryEnv, policySha256: string, routes: RouteInventoryRow[], now: number, batch: number): Promise<void> {
  const rotation = selectProbeRotation(routes, now, batch).map((probe) => [probe.route_id, probe.reason]);
  const rows: Array<[string, string, number | null]> = [];
  for (const route of routes) {
    rows.push(
      [route.route_id, "configuration", now],
      [route.route_id, "inbox", proofMillis(route.last_inbox_verified_at, now)],
      [route.route_id, "reply", proofMillis(route.last_reply_verified_at, now)],
      [route.route_id, "edge", proofMillis(route.edge_verified_at, now)],
    );
  }
  const statements = [
    env.DB.prepare("DELETE FROM mail_canary_probe_rotation"),
    env.DB.prepare(
      "INSERT INTO mail_canary_probe_rotation (route_id, selected_at_ms, reason) SELECT value ->> '$[0]', ?1, value ->> '$[1]' FROM json_each(?2)",
    ).bind(now, JSON.stringify(rotation)),
  ];
  for (let index = 0; index < rows.length; index += LEDGER_CHUNK) {
    statements.push(env.DB.prepare(LEDGER_UPSERT).bind(policySha256, now, JSON.stringify(rows.slice(index, index + LEDGER_CHUNK))));
  }
  statements.push(env.DB.prepare(
    "UPDATE mail_canary_state SET last_coverage_at_ms = ?1 WHERE singleton = 1",
  ).bind(now));
  // One batch is one transaction: the heartbeat stamp moves only with the whole ledger.
  const saved = await env.DB.batch(statements);
  if (saved.some((result) => !result.success) || saved.at(-1)?.meta.changes !== 1) {
    throw new Error("proof ledger persistence failed");
  }
}

export function notificationText(report: CanaryReport): string {
  return [
    `Maildesk route canary at ${report.checked_at}`,
    `Status: ${report.status}`,
    `Active routes: ${report.observed_routes}/${report.expected_routes}`,
    `Configuration reads: ${report.configuration_routes}`,
    `Independent inbox proofs inside the window: ${report.inbox_proofs_fresh}; recorded: ${report.inbox_proofs_recorded}`,
    `Independent reply proofs inside the window: ${report.reply_proofs_fresh}; recorded: ${report.reply_proofs_recorded}`,
    `Independent receipt pairs inside the window: ${report.current_routes}; intentionally excluded: ${report.excluded_routes}`,
    `Probe rotation selected: ${report.probe_due}`,
    ...Object.entries(report.issues).map(([code, count]) => `${code}: ${count}`),
    "This run read every active route's configuration and recorded the last independent proof per path.",
    "It selected the next inbox and reply probe rotation and did not send those probes.",
    "It did not check live provider inventory.",
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
