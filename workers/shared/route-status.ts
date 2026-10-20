/** Canonical body-free operational classification. Evidence planes remain separate. */
export const ROUTE_STATUS_REVISION = "route-operational-v1";
export type ProofFreshness = "fresh" | "stale" | "missing" | "invalid" | "not_applicable";
export type DeliveryOutcome = "provider_accepted" | "partial_delivery" | "failed" | "unknown" | "unobserved" | "not_applicable";
export interface RouteStatusInput {
  policySha256: string;
  sourceGeneration?: number;
  bindingCurrent: boolean;
  enabled: boolean;
  routeKind: string;
  enrollment: "required" | "excluded" | "pending" | "scheduled";
  inboundProcessing: "enabled" | "disabled" | "unknown";
  replyProcessing: "enabled" | "disabled" | "unknown";
  ordinaryProcessing: "enabled" | "disabled" | "unknown";
  activationId: string | null;
  quarantined: boolean;
  inboundStatus: string | null;
  replyStatus: string | null;
  inboxObservedAt: string | null;
  replyObservedAt: string | null;
  pendingDispatch: number;
  pendingQueue: number;
  unknownProviderAttempts: number;
}

export interface RouteOperationalStatus {
  schema_version: 1;
  projection_revision: typeof ROUTE_STATUS_REVISION;
  source_generation: number;
  policy_sha256: string;
  observed_at: string;
  valid_until: string;
  classification: "current" | "needs_attention" | "unverified" | "stale" | "intentionally_excluded" | "disabled" | "pending" | "scheduled";
  inbound_processing: RouteStatusInput["inboundProcessing"];
  ordinary_authority_active: boolean;
  ordinary_reply_enabled: boolean;
  activation_id: string | null;
  inbound_outcome: DeliveryOutcome;
  reply_outcome: DeliveryOutcome;
  inbox_proof: ProofFreshness;
  reply_proof: ProofFreshness;
  pending_dispatch: number;
  pending_queue: number;
  unknown_provider_attempts: number;
  reason_codes: string[];
  next_action: "none" | "refresh_projection" | "review_enrollment" | "review_processing_modes" |
    "reconcile_provider_outcome" | "recover_dispatch_by_claim_id" | "observe_queue" |
    "review_quarantine" | "review_route_activation" | "record_inbox_receipt" | "record_reply_receipt";
}

export function proofMillis(value: string | null, now: number): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(" ", "T") + "Z" : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) return null;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) && timestamp <= now ? timestamp : null;
}

export function proofFreshness(value: string | null, now: number, maxAgeMs: number): ProofFreshness {
  if (!value) return "missing";
  const instant = proofMillis(value, now);
  return instant === null ? "invalid" : now - instant >= maxAgeMs ? "stale" : "fresh";
}

export function deliveryOutcome(value: string | null): DeliveryOutcome {
  if (value === "provider_accepted" || value === "partial_delivery" || value === "failed") return value;
  if (value === "unknown" || value === "recovery_required" || value === "sending") return "unknown";
  // Historical "delivered" meant provider acceptance. This explicit mapping
  // does not change old events or make them recipient-observation evidence.
  if (value === "delivered") return "provider_accepted";
  return value === null || ["declared", "local_policy_valid", "edge_verified", "inbox_verified", "reply_verified", "receiving", "queued", "authorized"].includes(value)
    ? "unobserved" : "unknown";
}

export function projectRouteStatus(input: RouteStatusInput, now = Date.now(), maxProofAgeMs = 86_400_000): RouteOperationalStatus {
  if (!Number.isFinite(now) || !Number.isFinite(maxProofAgeMs) || maxProofAgeMs <= 0 ||
      [input.pendingDispatch, input.pendingQueue, input.unknownProviderAttempts].some((n) => !Number.isSafeInteger(n) || n < 0)) {
    throw new Error("invalid route status input");
  }
  const sink = input.routeKind === "sink";
  const projection: RouteOperationalStatus = {
    schema_version: 1, projection_revision: ROUTE_STATUS_REVISION, policy_sha256: input.policySha256,
    source_generation: input.sourceGeneration ?? 0,
    observed_at: new Date(now).toISOString(), valid_until: new Date(now + 7_200_000).toISOString(),
    classification: "unverified", inbound_processing: input.inboundProcessing,
    ordinary_authority_active: !sink && input.activationId !== null && !input.quarantined,
    ordinary_reply_enabled: !sink && input.activationId !== null && !input.quarantined && input.replyProcessing === "enabled" && input.ordinaryProcessing === "enabled",
    activation_id: sink ? null : input.activationId,
    inbound_outcome: sink ? "not_applicable" : deliveryOutcome(input.inboundStatus),
    reply_outcome: sink ? "not_applicable" : deliveryOutcome(input.replyStatus),
    inbox_proof: sink ? "not_applicable" : proofFreshness(input.inboxObservedAt, now, maxProofAgeMs),
    reply_proof: sink ? "not_applicable" : proofFreshness(input.replyObservedAt, now, maxProofAgeMs),
    pending_dispatch: input.pendingDispatch, pending_queue: input.pendingQueue,
    unknown_provider_attempts: input.unknownProviderAttempts, reason_codes: [], next_action: "none",
  };
  const choose = (classification: RouteOperationalStatus["classification"], reason: string, action: RouteOperationalStatus["next_action"]) => {
    projection.classification = classification; projection.reason_codes.push(reason); projection.next_action = action;
  };
  if (!input.bindingCurrent) {
    projection.ordinary_authority_active = false; projection.ordinary_reply_enabled = false;
    choose("unverified", "projection_binding_missing", "refresh_projection");
  } else if (sink || input.enrollment === "excluded") {
    projection.ordinary_authority_active = false; projection.ordinary_reply_enabled = false;
    choose("intentionally_excluded", sink ? "sink_no_delivery_reply_not_applicable" : "enrollment_excluded", "none");
  } else if (input.enrollment === "pending" || input.enrollment === "scheduled") {
    choose(input.enrollment, `enrollment_${input.enrollment}`, "review_enrollment");
  } else if (!input.enabled) {
    projection.ordinary_reply_enabled = false;
    choose("disabled", "route_disabled", "review_processing_modes");
  } else if (input.quarantined) choose("needs_attention", "route_quarantined", "review_quarantine");
  else if (input.unknownProviderAttempts || [projection.inbound_outcome, projection.reply_outcome].some((v) => ["unknown", "failed", "partial_delivery"].includes(v))) {
    choose("needs_attention", "provider_outcome_requires_reconciliation", "reconcile_provider_outcome");
  } else if (input.pendingDispatch) choose("needs_attention", "dispatch_unconfirmed", "recover_dispatch_by_claim_id");
  else if (input.pendingQueue) choose("unverified", "queue_processing_pending", "observe_queue");
  else if (input.inboundProcessing !== "enabled") choose("unverified", "inbound_processing_unconfirmed", "review_processing_modes");
  else if (projection.inbox_proof !== "fresh") choose(projection.inbox_proof === "stale" ? "stale" : "unverified", `inbox_proof_${projection.inbox_proof}`, "record_inbox_receipt");
  else if (projection.reply_proof !== "fresh") choose(projection.reply_proof === "stale" ? "stale" : "unverified", `reply_proof_${projection.reply_proof}`, "record_reply_receipt");
  else if (!projection.ordinary_authority_active) choose("unverified", "ordinary_route_not_activated", "review_route_activation");
  else if (!projection.ordinary_reply_enabled) choose("unverified", "reply_processing_disabled", "review_processing_modes");
  else choose("current", "current_independent_observations", "none");
  return projection;
}
