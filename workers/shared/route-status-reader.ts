import { ROUTE_STATUS_REVISION, type RouteOperationalStatus } from "./route-status";

export interface RouteStatusRead {
  state: "current" | "stale" | "unknown";
  status: RouteOperationalStatus | null;
  reason: string | null;
}

const fields = ["schema_version", "projection_revision", "source_generation", "policy_sha256", "observed_at",
  "valid_until", "classification", "inbound_processing", "ordinary_authority_active", "ordinary_reply_enabled",
  "activation_id", "inbound_outcome", "reply_outcome", "inbox_proof", "reply_proof", "pending_dispatch",
  "pending_queue", "unknown_provider_attempts", "reason_codes", "next_action"];
const classes = ["current", "needs_attention", "unverified", "stale", "intentionally_excluded", "disabled", "pending", "scheduled"];
const outcomes = ["provider_accepted", "partial_delivery", "failed", "unknown", "unobserved", "not_applicable"];
const proofs = ["fresh", "stale", "missing", "invalid", "not_applicable"];
const actions = ["none", "refresh_projection", "review_enrollment", "review_processing_modes", "reconcile_provider_outcome",
  "recover_dispatch_by_claim_id", "observe_queue", "review_quarantine", "review_route_activation", "record_inbox_receipt", "record_reply_receipt"];
const member = (value: unknown, values: readonly string[]): value is string => typeof value === "string" && values.includes(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function statusShape(value: unknown): value is RouteOperationalStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== fields.length || Object.keys(row).some((key) => !fields.includes(key))) return false;
  return row.schema_version === 1 && row.projection_revision === ROUTE_STATUS_REVISION &&
    count(row.source_generation) && typeof row.policy_sha256 === "string" && /^[a-f0-9]{64}$/.test(row.policy_sha256) &&
    typeof row.observed_at === "string" && typeof row.valid_until === "string" &&
    member(row.classification, classes) && member(row.inbound_processing, ["enabled", "disabled", "unknown"]) &&
    typeof row.ordinary_authority_active === "boolean" && typeof row.ordinary_reply_enabled === "boolean" &&
    (row.activation_id === null || (typeof row.activation_id === "string" && /^[a-zA-Z0-9:._-]{1,160}$/.test(row.activation_id))) &&
    member(row.inbound_outcome, outcomes) && member(row.reply_outcome, outcomes) &&
    member(row.inbox_proof, proofs) && member(row.reply_proof, proofs) &&
    count(row.pending_dispatch) && count(row.pending_queue) && count(row.unknown_provider_attempts) &&
    Array.isArray(row.reason_codes) && row.reason_codes.length > 0 && row.reason_codes.length <= 32 &&
    row.reason_codes.every((reason) => typeof reason === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(reason)) &&
    member(row.next_action, actions) && (!row.ordinary_reply_enabled || row.ordinary_authority_active) &&
    (!row.ordinary_authority_active || row.activation_id !== null);
}

/** Read an existing projection, never reconstruct authority from receipt strings.
 * A stale projection retains its historical facts but cannot establish readiness.
 * Missing provider fields stay unknown until the governed readback is qualified.
 */
export function readRouteStatusProjection(value: unknown, context: {
  policySha256: string; sourceGeneration: unknown; now?: number;
}): RouteStatusRead {
  const unknown = (reason: string): RouteStatusRead => ({ state: "unknown", status: null, reason });
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return unknown("operational_projection_invalid"); }
  }
  if (!statusShape(value)) return unknown("operational_projection_missing_or_incompatible");
  if (!count(context.sourceGeneration) || value.source_generation !== context.sourceGeneration ||
      value.policy_sha256 !== context.policySha256.replace(/^sha256:/, "")) return unknown("operational_projection_binding_mismatch");
  const now = context.now ?? Date.now(), observed = Date.parse(value.observed_at), until = Date.parse(value.valid_until);
  if (!Number.isFinite(now) || !Number.isFinite(observed) || !Number.isFinite(until) || observed > now || until <= observed) {
    return unknown("operational_projection_time_invalid");
  }
  if (until <= now) return { state: "stale", status: value, reason: "operational_projection_stale" };
  return { state: "current", status: value, reason: null };
}

export function operationalReadinessBlocker(read: RouteStatusRead): string | null {
  if (read.state !== "current" || !read.status) return read.reason ?? "operational_projection_unknown";
  const status = read.status;
  if (status.pending_dispatch) return "dispatch_unconfirmed";
  if (status.unknown_provider_attempts || [status.inbound_outcome, status.reply_outcome].some((outcome) =>
      ["partial_delivery", "failed", "unknown"].includes(outcome))) return "provider_outcome_requires_reconciliation";
  if (status.pending_queue) return "queue_processing_pending";
  return ["current", "intentionally_excluded"].includes(status.classification)
    ? null : status.reason_codes[0] ?? "operational_state_unverified";
}
