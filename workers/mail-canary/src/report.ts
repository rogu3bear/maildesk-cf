export interface RouteSnapshot {
  route_id: string;
  decision_kind: string;
  health_policy_sha256: string | null;
  inbound_status: string | null;
  reply_status: string | null;
  last_inbox_verified_at: string | null;
  last_reply_verified_at: string | null;
  edge_verified_at: string | null;
}

export interface CanarySnapshot {
  policy_sha256: string;
  expected_routes: number;
  routes: RouteSnapshot[];
}

export interface CanaryReport {
  schema_version: 1;
  checked_at: string;
  status: "failed" | "unverified" | "receipts_current";
  policy_sha256: string;
  expected_routes: number;
  observed_routes: number;
  excluded_routes: number;
  current_routes: number;
  issues: Record<string, number>;
  // D1 receipt freshness never establishes a new provider or mailbox probe.
  provider_inventory_checked: false;
  live_probe_sent: false;
}

const FAILURES = new Set(["failed", "partial_delivery", "recovery_required"]);

export function reportRoutes(
  snapshot: CanarySnapshot,
  now: number,
  maxProofAgeMs: number,
  processing: { inbound: string; reply: string },
): CanaryReport {
  if (!Number.isFinite(now) || !Number.isFinite(maxProofAgeMs) || maxProofAgeMs <= 0) {
    throw new Error("invalid canary clock or proof age");
  }
  const issues: Record<string, number> = {};
  const issue = (code: string) => { issues[code] = (issues[code] ?? 0) + 1; };
  let failed = false;
  let excluded = 0;
  let current = 0;
  if (!/^[a-f0-9]{64}$/.test(snapshot.policy_sha256)) issue("active_policy_missing");
  if (!Number.isSafeInteger(snapshot.expected_routes) || snapshot.expected_routes <= 0 ||
      snapshot.expected_routes !== snapshot.routes.length ||
      new Set(snapshot.routes.map((route) => route.route_id)).size !== snapshot.routes.length) {
    issue("route_inventory_incomplete");
  }
  if (processing.inbound !== "enabled") issue("inbound_processing_disabled");
  if (processing.reply !== "enabled") issue("reply_processing_disabled");
  for (const route of snapshot.routes) {
    if (route.health_policy_sha256 !== snapshot.policy_sha256) {
      issue("route_health_revision_missing");
      continue;
    }
    if (route.decision_kind === "sink") {
      excluded++;
      if (route.inbound_status !== "intentionally_excluded" || route.reply_status !== "intentionally_excluded") {
        issue("sink_disposition_missing");
      }
      continue;
    }
    if (!["role_alias", "personal_alias", "catch_all"].includes(route.decision_kind)) {
      issue("route_kind_invalid");
      continue;
    }
    if (FAILURES.has(route.inbound_status ?? "") || FAILURES.has(route.reply_status ?? "")) {
      failed = true;
      issue("route_delivery_failed");
      continue;
    }
    let fresh = true;
    for (const [code, timestamp] of [
      ["edge_proof_missing_or_stale", route.edge_verified_at],
      ["inbox_receipt_missing_or_stale", route.last_inbox_verified_at],
      ["reply_receipt_missing_or_stale", route.last_reply_verified_at],
    ] as const) {
      if (!freshTimestamp(timestamp, now, maxProofAgeMs)) { issue(code); fresh = false; }
    }
    if (route.inbound_status !== "inbox_verified" && route.inbound_status !== "reply_verified") {
      issue("inbox_receipt_unverified"); fresh = false;
    }
    if (route.reply_status !== "reply_verified") { issue("reply_receipt_unverified"); fresh = false; }
    if (fresh) current++;
  }
  return {
    schema_version: 1,
    checked_at: new Date(now).toISOString(),
    status: failed ? "failed" : Object.keys(issues).length ? "unverified" : "receipts_current",
    policy_sha256: snapshot.policy_sha256,
    expected_routes: snapshot.expected_routes,
    observed_routes: snapshot.routes.length,
    excluded_routes: excluded,
    current_routes: current,
    issues,
    provider_inventory_checked: false,
    live_probe_sent: false,
  };
}

function freshTimestamp(value: string | null, now: number, maxAgeMs: number): boolean {
  if (!value) return false;
  // SQLite CURRENT_TIMESTAMP is UTC without a suffix. Reject ambiguous formats.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(" ", "T") + "Z" : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) return false;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= maxAgeMs;
}
