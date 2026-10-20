import { readRouteStatusProjection, operationalReadinessBlocker, type RouteStatusRead } from "../../shared/route-status-reader";
import { proofMillis, proofFreshness, deliveryOutcome } from "../../shared/route-status";
export { proofMillis } from "../../shared/route-status";
export interface RouteSnapshot {
  route_id: string;
  status_generation?: number;
  operational_status?: unknown;
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

export interface ProbeSelection {
  route_id: string;
  reason: "never_proven" | "oldest_proof";
}

export interface CanaryReport {
  schema_version: 2;
  checked_at: string;
  status: "failed" | "unverified" | "configuration_current" | "receipts_current";
  policy_sha256: string;
  expected_routes: number;
  observed_routes: number;
  excluded_routes: number;
  current_routes: number;
  configuration_routes: number;
  inbox_proofs_fresh: number;
  reply_proofs_fresh: number;
  inbox_proofs_recorded: number;
  reply_proofs_recorded: number;
  probe_due: number;
  issues: Record<string, number>;
  operational_status: Array<RouteStatusRead & { route_id: string }>;
  // Configuration coverage never sends a provider or mailbox probe.
  provider_inventory_checked: false;
  live_probe_sent: false;
}

const FAILURES = new Set(["failed", "partial_delivery", "unknown"]);
const ROUTE_KINDS = new Set(["role_alias", "personal_alias", "catch_all"]);

export function reportRoutes(
  snapshot: CanarySnapshot,
  now: number,
  maxProofAgeMs: number,
  processing: { inbound: string; reply: string },
  probeBatch = 3,
): CanaryReport {
  if (!Number.isFinite(now) || !Number.isFinite(maxProofAgeMs) || maxProofAgeMs <= 0) {
    throw new Error("invalid canary clock or proof age");
  }
  if (!Number.isSafeInteger(probeBatch) || probeBatch < 1 || probeBatch > 8) {
    throw new Error("invalid canary probe batch");
  }
  const issues: Record<string, number> = {};
  const issue = (code: string) => { issues[code] = (issues[code] ?? 0) + 1; };
  const operational: CanaryReport["operational_status"] = [];
  let failed = false;
  let excluded = 0;
  let current = 0;
  let configuration = 0;
  let eligible = 0;
  let inboxFresh = 0;
  let replyFresh = 0;
  let inboxRecorded = 0;
  let replyRecorded = 0;
  if (!/^[a-f0-9]{64}$/.test(snapshot.policy_sha256)) issue("active_policy_missing");
  if (!Number.isSafeInteger(snapshot.expected_routes) || snapshot.expected_routes <= 0 ||
      snapshot.expected_routes !== snapshot.routes.length ||
      new Set(snapshot.routes.map((route) => route.route_id)).size !== snapshot.routes.length) {
    issue("route_inventory_incomplete");
  }
  if (processing.inbound !== "enabled") issue("inbound_processing_disabled");
  if (processing.reply !== "enabled") issue("reply_processing_disabled");
  for (const route of snapshot.routes) {
    const read = readRouteStatusProjection(route.operational_status, {
      policySha256: snapshot.policy_sha256, sourceGeneration: route.status_generation, now,
    });
    operational.push({ route_id: route.route_id, ...read });
    const blocker = operationalReadinessBlocker(read);
    if (blocker) issue(blocker);
    if (route.health_policy_sha256 !== snapshot.policy_sha256) {
      issue("route_health_revision_missing");
      continue;
    }
    if (route.decision_kind === "sink") {
      excluded++;
      if (route.inbound_status !== "intentionally_excluded" || route.reply_status !== "intentionally_excluded") {
        issue("sink_disposition_missing");
        continue;
      }
      configuration++;
      continue;
    }
    if (!ROUTE_KINDS.has(route.decision_kind)) {
      issue("route_kind_invalid");
      continue;
    }
    if (FAILURES.has(deliveryOutcome(route.inbound_status)) || FAILURES.has(deliveryOutcome(route.reply_status))) {
      failed = true;
      issue("route_delivery_failed");
      continue;
    }
    configuration++;
    eligible++;
    const inbox = proofMillis(route.last_inbox_verified_at, now);
    const reply = proofMillis(route.last_reply_verified_at, now);
    if (inbox !== null) inboxRecorded++;
    if (reply !== null) replyRecorded++;
    if (proofFreshness(route.last_inbox_verified_at, now, maxProofAgeMs) === "fresh") inboxFresh++;
    if (proofFreshness(route.last_reply_verified_at, now, maxProofAgeMs) === "fresh") replyFresh++;
    if (proofFreshness(route.last_inbox_verified_at, now, maxProofAgeMs) === "fresh" &&
        proofFreshness(route.last_reply_verified_at, now, maxProofAgeMs) === "fresh") current++;
  }
  const status = failed ? "failed"
    : Object.keys(issues).length ? "unverified"
    : eligible > 0 && current < eligible ? "configuration_current"
    : "receipts_current";
  return {
    schema_version: 2,
    checked_at: new Date(now).toISOString(),
    status,
    policy_sha256: snapshot.policy_sha256,
    expected_routes: snapshot.expected_routes,
    observed_routes: snapshot.routes.length,
    excluded_routes: excluded,
    current_routes: current,
    configuration_routes: configuration,
    inbox_proofs_fresh: inboxFresh,
    reply_proofs_fresh: replyFresh,
    inbox_proofs_recorded: inboxRecorded,
    reply_proofs_recorded: replyRecorded,
    probe_due: selectProbeRotation(snapshot.routes, now, probeBatch).length,
    issues, operational_status: operational,
    provider_inventory_checked: false,
    live_probe_sent: false,
  };
}

/** Oldest independent inbox/reply proofs, missing proofs first. Bounded; does not send them. */
export function selectProbeRotation(routes: RouteSnapshot[], now: number, batch: number): ProbeSelection[] {
  return routes
    .filter((route) => route.decision_kind !== "sink" && ROUTE_KINDS.has(route.decision_kind))
    .map((route) => {
      const inbox = proofMillis(route.last_inbox_verified_at, now);
      const reply = proofMillis(route.last_reply_verified_at, now);
      const complete = inbox !== null && reply !== null;
      return {
        route_id: route.route_id,
        oldest: complete ? Math.min(inbox, reply) : null,
        reason: complete ? "oldest_proof" as const : "never_proven" as const,
      };
    })
    .sort((left, right) => {
      if (left.oldest === null && right.oldest !== null) return -1;
      if (left.oldest !== null && right.oldest === null) return 1;
      if (left.oldest !== null && right.oldest !== null && left.oldest !== right.oldest) return left.oldest - right.oldest;
      return left.route_id < right.route_id ? -1 : left.route_id > right.route_id ? 1 : 0;
    })
    .slice(0, batch)
    .map(({ route_id, reason }) => ({ route_id, reason }));
}
