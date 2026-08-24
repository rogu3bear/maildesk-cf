import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const FLEET_READINESS_PLANES = [
  "configured",
  "cloudflare_active",
  "inbound_provider_accepted",
  "inbox_received",
  "reply_authorized",
  "outbound_provider_accepted",
  "recipient_delivered",
  "privacy_proven",
] as const;

export const FLEET_EVIDENCE_MAX_AGE_SECONDS = 15 * 60;

type Plane = typeof FLEET_READINESS_PLANES[number];
type PlaneState = "proven" | "failed" | "missing" | "stale" | "binding_mismatch" | "not_applicable";
type EnrollmentDecision =
  | "enrolled"
  | "scheduled_for_migration"
  | "intentionally_excluded"
  | "pending_owner_decision";
type RouteKind = "role_alias" | "personal_alias" | "catch_all" | "sink";
type DeliveryContract = "bidirectional_reply" | "inbound_only_v1";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CODE = /^[a-z][a-z0-9_]{0,127}$/;
const GOLDEN_THREAD_PLANES = new Set<Plane>([
  "inbound_provider_accepted",
  "inbox_received",
  "reply_authorized",
  "outbound_provider_accepted",
  "recipient_delivered",
  "privacy_proven",
]);
const SINK_NOT_APPLICABLE_PLANES = new Set<Plane>([
  "reply_authorized",
  "outbound_provider_accepted",
  "recipient_delivered",
  "privacy_proven",
]);
const KILL_BLOCKER_CODES = new Set(["private_identity_exposed", "wrong_public_identity"]);
const SOURCE_BY_PLANE = {
  configured: "policy_projection",
  cloudflare_active: "cloudflare_control_plane",
  inbound_provider_accepted: "d1_inbound_audit",
  inbox_received: "apple_mail_inbox_receipt",
  reply_authorized: "d1_reply_authorization",
  outbound_provider_accepted: "outbound_provider_receipt",
  recipient_delivered: "external_recipient_receipt",
  privacy_proven: "privacy_non_exposure_receipt",
} as const satisfies Record<Plane, string>;

interface Binding {
  transaction_sha256: string;
  checkout_sha256: string;
  tree_sha256: string;
  policy_sha256: string;
  desired_state_sha256: string;
  enrollment_sha256: string;
  route_inventory_sha256: string;
}

interface EnrollmentDomain {
  domain_sha256: string;
  decision: EnrollmentDecision;
  registrar_custody: "cloudflare" | "external" | "unknown";
  desired_inbound_provider: string | null;
  active_policy: boolean;
  configured: boolean;
  reason_code: string | null;
  blocker_code: string | null;
  decision_owner_ref_sha256: string | null;
  first_blocker: { plane: "enrollment"; code: string } | null;
}

interface EnrollmentReport {
  enrollment_sha256: string;
  inventory_complete: boolean;
  inventory_blocker_code: string | null;
  domains: EnrollmentDomain[];
}

interface GraduationContract {
  schema_version: 1;
  route_sha256: string;
  contract_sha256: string;
  reason_code: string;
  owner_ref_sha256: string;
  expires_at: string;
}

interface RouteDefinition {
  route_sha256: string;
  domain_sha256: string;
  route_kind: RouteKind;
  delivery_contract: DeliveryContract;
  graduation_contract?: GraduationContract;
}

interface ObservedReceipt {
  state: "proven" | "failed";
  source: string;
  observed_at: string;
  evidence_sha256: string;
  route_sha256: string;
  domain_sha256: string;
  golden_thread_sha256?: string;
  binding: Binding;
  blocker_code?: string;
}

interface NotApplicableReceipt {
  state: "not_applicable";
  source: "graduation_contract";
  evidence_sha256: string;
  graduation_contract_sha256: string;
  route_sha256: string;
  domain_sha256: string;
  golden_thread_sha256: string;
}

type PlaneReceipt = ObservedReceipt | NotApplicableReceipt;

interface RouteEvidence {
  schema_version: 1;
  route_sha256: string;
  domain_sha256: string;
  golden_thread_sha256: string;
  planes: Partial<Record<Plane, PlaneReceipt>>;
}

interface ValidatedInput {
  binding: Binding;
  enrollment: EnrollmentReport;
  route_inventory: {
    coverage_mode: "full_policy" | "canary";
    declared_route_count: number;
    route_set_sha256: string;
    binding: Binding;
    policy_projection_receipt: {
      configured_route_count: number;
      route_set_sha256: string;
      evidence_sha256: string;
      binding: Binding;
    };
    routes: RouteDefinition[];
  };
  route_evidence: RouteEvidence[];
}

export interface FleetReadinessReport {
  schema_version: 1;
  kind: "maildesk_fleet_readiness_report";
  performed: false;
  body_free: true;
  evaluated_at: string;
  max_evidence_age_seconds: number;
  binding: Binding;
  coverage: {
    mode: "full_policy" | "canary";
    inventory_complete: boolean;
    route_set_attested: boolean;
    policy_projection_attested: boolean;
    all_enrolled_routes_present: boolean;
    transaction_coherent: boolean;
    all_required_planes_proven_and_fresh: boolean;
    full_coverage_proven: boolean;
  };
  counts: {
    configured: number;
    cloudflare_active: number;
    inbox_received: number;
    reply_proven: number;
    failed_or_stale: number;
    known_domains: number;
    enrolled_domains: number;
    scheduled_domains: number;
    pending_domains: number;
    excluded_domains: number;
    declared_routes: number;
    required_routes: number;
    ready_routes: number;
    blocked_routes: number;
    killed_routes: number;
  };
  domains: Array<{
    domain_sha256: string;
    decision: EnrollmentDecision;
    status: "required" | "scheduled" | "pending" | "excluded";
    reason_code: string | null;
    required_route_count: number;
    first_blocker: { plane: "enrollment" | "configured"; code: string } | null;
  }>;
  routes: Array<{
    route_sha256: string;
    domain_sha256: string;
    route_kind: RouteKind;
    delivery_contract: DeliveryContract;
    status: "ready" | "blocked" | "killed";
    planes: Record<Plane, {
      state: PlaneState;
      source: string | null;
      observed_at: string | null;
      evidence_sha256: string | null;
      fresh: boolean | null;
      blocker_code: string | null;
    }>;
    first_blocker: { plane: Plane; code: string } | null;
  }>;
  first_blocker:
    | { plane: "enrollment" | "configured"; code: string; domain_sha256?: string }
    | { route_sha256: string; plane: Plane; code: string }
    | null;
}

export function computeRouteSetSha256(routeDefinitions: unknown[]): string {
  if (!Array.isArray(routeDefinitions)) throw new Error("route definitions must be an array");
  const sorted = routeDefinitions.map((value, index) => {
    const route = record(value, `route definitions[${index}]`);
    requireDigest(route.route_sha256, `route definitions[${index}].route_sha256`);
    return route;
  }).sort((left, right) => (left.route_sha256 as string).localeCompare(right.route_sha256 as string));
  return sha256(canonicalJson(sorted));
}

export function computeGraduationContractSha256(value: unknown): string {
  const contract = record(value, "graduation contract digest input");
  exactKeys(contract, ["schema_version", "route_sha256", "reason_code", "owner_ref_sha256", "expires_at"], "graduation contract digest input");
  if (contract.schema_version !== 1) throw new Error("graduation contract schema_version must be 1");
  requireDigest(contract.route_sha256, "graduation contract route_sha256");
  requireCode(contract.reason_code, "graduation contract reason_code");
  requireDigest(contract.owner_ref_sha256, "graduation contract owner_ref_sha256");
  parseTimestamp(contract.expires_at, "graduation contract expires_at");
  return sha256(canonicalJson(contract));
}

export function computePolicyProjectionReceiptSha256(value: unknown): string {
  const projection = record(value, "policy projection receipt digest input");
  const keys = [
    "schema_version",
    "kind",
    "performed",
    "body_free",
    "transaction_sha256",
    "checkout_sha256",
    "tree_sha256",
    "policy_sha256",
    "desired_state_sha256",
    "enrollment_sha256",
    "configured_route_count",
    "route_set_sha256",
  ];
  exactKeys(projection, keys, "policy projection receipt digest input");
  if (projection.schema_version !== 1 ||
      projection.kind !== "maildesk_policy_projection_inventory_receipt" ||
      projection.performed !== false || projection.body_free !== true) {
    throw new Error("policy projection receipt digest identity is invalid");
  }
  for (const key of [
    "transaction_sha256", "checkout_sha256", "tree_sha256", "policy_sha256",
    "desired_state_sha256", "enrollment_sha256", "route_set_sha256",
  ]) requireDigest(projection[key], `policy projection digest ${key}`);
  if (!Number.isInteger(projection.configured_route_count) || (projection.configured_route_count as number) < 1) {
    throw new Error("policy projection digest configured_route_count must be a positive integer");
  }
  return sha256(canonicalJson(projection));
}

export function compileFleetReadiness(
  value: unknown,
  expectedPolicyProjectionSha256: string,
  trustedNowForTests?: Date,
): FleetReadinessReport {
  requireDigest(expectedPolicyProjectionSha256, "expected policy projection digest");
  const trustedNow = trustedNowForTests ?? new Date();
  if (!(trustedNow instanceof Date) || !Number.isFinite(trustedNow.getTime())) {
    throw new Error("trusted evaluation clock must be a valid Date");
  }
  const evaluatedAt = trustedNow.toISOString();
  const evaluatedAtMs = trustedNow.getTime();
  const input = validateInput(value);
  const evidenceByRoute = new Map(input.route_evidence.map((entry) => [entry.route_sha256, entry]));
  const enrollmentByDomain = new Map(input.enrollment.domains.map((domain) => [domain.domain_sha256, domain]));
  const inventoryBindingCoherent = bindingsEqual(input.route_inventory.binding, input.binding);
  const enrollmentBindingCoherent = input.enrollment.enrollment_sha256 === input.binding.enrollment_sha256;
  const computedRouteSetSha256 = computeRouteSetSha256(input.route_inventory.routes);
  const policyProjection = input.route_inventory.policy_projection_receipt;
  const canonicalRouteSetAttested =
    computedRouteSetSha256 === input.route_inventory.route_set_sha256 &&
    computedRouteSetSha256 === input.binding.route_inventory_sha256 &&
    policyProjection.configured_route_count === input.route_inventory.routes.length &&
    policyProjection.configured_route_count === input.route_inventory.declared_route_count &&
    policyProjection.route_set_sha256 === computedRouteSetSha256 &&
    bindingsEqual(policyProjection.binding, input.binding);
  const computedPolicyProjectionSha256 = computePolicyProjectionReceiptSha256({
    schema_version: 1,
    kind: "maildesk_policy_projection_inventory_receipt",
    performed: false,
    body_free: true,
    transaction_sha256: policyProjection.binding.transaction_sha256,
    checkout_sha256: policyProjection.binding.checkout_sha256,
    tree_sha256: policyProjection.binding.tree_sha256,
    policy_sha256: policyProjection.binding.policy_sha256,
    desired_state_sha256: policyProjection.binding.desired_state_sha256,
    enrollment_sha256: policyProjection.binding.enrollment_sha256,
    configured_route_count: policyProjection.configured_route_count,
    route_set_sha256: policyProjection.route_set_sha256,
  });
  const policyProjectionReceiptDigestCoherent =
    policyProjection.evidence_sha256 === computedPolicyProjectionSha256;
  const policyProjectionExpectedDigestMatched =
    computedPolicyProjectionSha256 === expectedPolicyProjectionSha256;
  const policyProjectionAttested =
    policyProjectionReceiptDigestCoherent && policyProjectionExpectedDigestMatched;
  const routeSetAttested = canonicalRouteSetAttested && policyProjectionAttested;

  let receiptsCoherent = true;
  const routes = input.route_inventory.routes
    .filter((route) => enrollmentByDomain.get(route.domain_sha256)?.decision === "enrolled")
    .map((route) => {
      const evidence = evidenceByRoute.get(route.route_sha256);
      const contractFresh = route.graduation_contract === undefined ||
        parseTimestamp(route.graduation_contract.expires_at, "graduation contract expires_at") > evaluatedAtMs;
      const contractDigestCoherent = route.graduation_contract === undefined ||
        route.graduation_contract.route_sha256 === route.route_sha256 &&
        route.graduation_contract.contract_sha256 === computeGraduationContractSha256({
          schema_version: route.graduation_contract.schema_version,
          route_sha256: route.graduation_contract.route_sha256,
          reason_code: route.graduation_contract.reason_code,
          owner_ref_sha256: route.graduation_contract.owner_ref_sha256,
          expires_at: route.graduation_contract.expires_at,
        });
      const planes = Object.fromEntries(FLEET_READINESS_PLANES.map((plane) => {
        const receipt = evidence?.planes[plane];
        const compiled = compilePlane(
          input,
          route,
          evidence,
          plane,
          receipt,
          evaluatedAtMs,
          contractFresh,
          contractDigestCoherent,
          evidence === undefined,
        );
        if (compiled.state === "binding_mismatch") receiptsCoherent = false;
        return [plane, compiled];
      })) as FleetReadinessReport["routes"][number]["planes"];
      const identityKill = Object.values(planes).some((plane) =>
        plane.state === "failed" && plane.blocker_code !== null && KILL_BLOCKER_CODES.has(plane.blocker_code)
      );
      if (applyGoldenThreadChronology(planes, evidence)) receiptsCoherent = false;
      const firstBlocker = firstRouteBlocker(planes);
      const killed = identityKill;
      return {
        route_sha256: route.route_sha256,
        domain_sha256: route.domain_sha256,
        route_kind: route.route_kind,
        delivery_contract: route.delivery_contract,
        status: killed ? "killed" as const : firstBlocker === null ? "ready" as const : "blocked" as const,
        planes,
        first_blocker: firstBlocker,
      };
    })
    .sort((left, right) => left.route_sha256.localeCompare(right.route_sha256));

  const routeCounts = new Map<string, number>();
  for (const route of input.route_inventory.routes) {
    if (enrollmentByDomain.get(route.domain_sha256)?.decision === "enrolled") {
      routeCounts.set(route.domain_sha256, (routeCounts.get(route.domain_sha256) ?? 0) + 1);
    }
  }
  const domains = input.enrollment.domains
    .map((domain) => {
      const requiredRouteCount = routeCounts.get(domain.domain_sha256) ?? 0;
      const status = domain.decision === "enrolled" ? "required"
        : domain.decision === "scheduled_for_migration" ? "scheduled"
        : domain.decision === "pending_owner_decision" ? "pending" : "excluded";
      const firstBlocker = domain.decision === "enrolled" && requiredRouteCount === 0
        ? { plane: "configured" as const, code: "enrolled_domain_has_no_routes" }
        : domain.first_blocker;
      return {
        domain_sha256: domain.domain_sha256,
        decision: domain.decision,
        status,
        reason_code: domain.reason_code,
        required_route_count: requiredRouteCount,
        first_blocker: firstBlocker,
      };
    })
    .sort((left, right) => left.domain_sha256.localeCompare(right.domain_sha256));

  const allEnrolledDomainsHaveRoutes = domains
    .filter((domain) => domain.decision === "enrolled")
    .every((domain) => domain.required_route_count > 0);
  const allEvidenceRowsPresent = routes.every((route) => evidenceByRoute.has(route.route_sha256));
  const allEnrolledRoutesPresent = allEnrolledDomainsHaveRoutes && allEvidenceRowsPresent;
  const transactionCoherent = inventoryBindingCoherent && enrollmentBindingCoherent && routeSetAttested && receiptsCoherent;
  const allRequiredPlanesProvenAndFresh = routes.length > 0 &&
    routes.every((route) => route.status === "ready");
  const hasUnresolvedEnrollment = input.enrollment.domains.some((domain) =>
    domain.decision === "scheduled_for_migration" || domain.decision === "pending_owner_decision"
  );
  const fullCoverageProven =
    input.route_inventory.coverage_mode === "full_policy" &&
    input.enrollment.inventory_complete &&
    !hasUnresolvedEnrollment &&
    routeSetAttested &&
    allEnrolledRoutesPresent &&
    transactionCoherent &&
    allRequiredPlanesProvenAndFresh;

  const enrollmentBlocker = firstEnrollmentBlocker(input, domains, enrollmentBindingCoherent);
  const configuredBlocker = enrollmentBlocker === null
    ? firstConfiguredFleetBlocker(
      input,
      domains,
      inventoryBindingCoherent,
      canonicalRouteSetAttested,
      policyProjectionReceiptDigestCoherent,
      policyProjectionExpectedDigestMatched,
    )
    : null;
  const routeBlocker = enrollmentBlocker === null && configuredBlocker === null
    ? firstFleetRouteBlocker(routes)
    : null;

  return {
    schema_version: 1,
    kind: "maildesk_fleet_readiness_report",
    performed: false,
    body_free: true,
    evaluated_at: evaluatedAt,
    max_evidence_age_seconds: FLEET_EVIDENCE_MAX_AGE_SECONDS,
    binding: input.binding,
    coverage: {
      mode: input.route_inventory.coverage_mode,
      inventory_complete: input.enrollment.inventory_complete,
      route_set_attested: routeSetAttested,
      policy_projection_attested: policyProjectionAttested,
      all_enrolled_routes_present: allEnrolledRoutesPresent,
      transaction_coherent: transactionCoherent,
      all_required_planes_proven_and_fresh: allRequiredPlanesProvenAndFresh,
      full_coverage_proven: fullCoverageProven,
    },
    counts: {
      configured: routes.filter((route) => route.planes.configured.state === "proven").length,
      cloudflare_active: routes.filter((route) => route.planes.cloudflare_active.state === "proven").length,
      inbox_received: routes.filter((route) => route.planes.inbox_received.state === "proven").length,
      reply_proven: routes.filter((route) => route.delivery_contract === "bidirectional_reply" && [
        route.planes.reply_authorized,
        route.planes.outbound_provider_accepted,
        route.planes.recipient_delivered,
        route.planes.privacy_proven,
      ].every((plane) => plane.state === "proven")).length,
      failed_or_stale: routes.filter((route) => Object.values(route.planes).some((plane) =>
        plane.state === "failed" || plane.state === "stale" || plane.state === "binding_mismatch"
      )).length,
      known_domains: domains.length,
      enrolled_domains: domains.filter((domain) => domain.decision === "enrolled").length,
      scheduled_domains: domains.filter((domain) => domain.decision === "scheduled_for_migration").length,
      pending_domains: domains.filter((domain) => domain.decision === "pending_owner_decision").length,
      excluded_domains: domains.filter((domain) => domain.decision === "intentionally_excluded").length,
      declared_routes: input.route_inventory.declared_route_count,
      required_routes: routes.length,
      ready_routes: routes.filter((route) => route.status === "ready").length,
      blocked_routes: routes.filter((route) => route.status === "blocked").length,
      killed_routes: routes.filter((route) => route.status === "killed").length,
    },
    domains,
    routes,
    first_blocker: enrollmentBlocker ?? configuredBlocker ?? routeBlocker,
  };
}

function compilePlane(
  input: ValidatedInput,
  route: RouteDefinition,
  routeEvidence: RouteEvidence | undefined,
  plane: Plane,
  receipt: PlaneReceipt | undefined,
  evaluatedAtMs: number,
  contractFresh: boolean,
  contractDigestCoherent: boolean,
  entireRouteMissing: boolean,
): FleetReadinessReport["routes"][number]["planes"][Plane] {
  if (receipt === undefined) {
    return {
      state: "missing",
      source: null,
      observed_at: null,
      evidence_sha256: null,
      fresh: null,
      blocker_code: entireRouteMissing && plane === "configured" ? "route_evidence_missing" : "evidence_missing",
    };
  }
  if (receipt.route_sha256 !== route.route_sha256 || receipt.domain_sha256 !== route.domain_sha256) {
    return {
      state: "binding_mismatch",
      source: receipt.source,
      observed_at: receipt.state === "not_applicable" ? null : receipt.observed_at,
      evidence_sha256: receipt.evidence_sha256,
      fresh: false,
      blocker_code: "receipt_route_binding_mismatch",
    };
  }
  if (GOLDEN_THREAD_PLANES.has(plane) &&
      (routeEvidence === undefined || receipt.golden_thread_sha256 !== routeEvidence.golden_thread_sha256)) {
    return {
      state: "binding_mismatch",
      source: receipt.source,
      observed_at: receipt.state === "not_applicable" ? null : receipt.observed_at,
      evidence_sha256: receipt.evidence_sha256,
      fresh: false,
      blocker_code: "golden_thread_binding_mismatch",
    };
  }
  if (receipt.state === "not_applicable") {
    if (!contractDigestCoherent) {
      return {
        state: "binding_mismatch",
        source: receipt.source,
        observed_at: null,
        evidence_sha256: receipt.evidence_sha256,
        fresh: false,
        blocker_code: "graduation_contract_digest_mismatch",
      };
    }
    const matchesContract = route.route_kind === "sink" &&
      route.delivery_contract === "inbound_only_v1" &&
      SINK_NOT_APPLICABLE_PLANES.has(plane) &&
      route.graduation_contract !== undefined &&
      receipt.graduation_contract_sha256 === route.graduation_contract.contract_sha256 &&
      receipt.evidence_sha256 === route.graduation_contract.contract_sha256;
    if (!matchesContract) {
      return {
        state: "binding_mismatch",
        source: receipt.source,
        observed_at: null,
        evidence_sha256: receipt.evidence_sha256,
        fresh: false,
        blocker_code: "graduation_contract_mismatch",
      };
    }
    if (!contractFresh) {
      return {
        state: "stale",
        source: receipt.source,
        observed_at: null,
        evidence_sha256: receipt.evidence_sha256,
        fresh: false,
        blocker_code: "graduation_contract_expired",
      };
    }
    return {
      state: "not_applicable",
      source: receipt.source,
      observed_at: null,
      evidence_sha256: receipt.evidence_sha256,
      fresh: true,
      blocker_code: null,
    };
  }
  const source = SOURCE_BY_PLANE[plane];
  if (!bindingsEqual(receipt.binding, input.binding)) {
    return {
      state: "binding_mismatch",
      source,
      observed_at: receipt.observed_at,
      evidence_sha256: receipt.evidence_sha256,
      fresh: false,
      blocker_code: "receipt_binding_mismatch",
    };
  }
  const observedAtMs = parseTimestamp(receipt.observed_at, `${plane} observed_at`);
  const ageMs = evaluatedAtMs - observedAtMs;
  if (receipt.state === "failed") {
    return {
      state: "failed",
      source,
      observed_at: receipt.observed_at,
      evidence_sha256: receipt.evidence_sha256,
      fresh: ageMs >= 0 && ageMs <= FLEET_EVIDENCE_MAX_AGE_SECONDS * 1000,
      blocker_code: receipt.blocker_code!,
    };
  }
  if (ageMs < 0) {
    return {
      state: "failed",
      source,
      observed_at: receipt.observed_at,
      evidence_sha256: receipt.evidence_sha256,
      fresh: false,
      blocker_code: "evidence_timestamp_in_future",
    };
  }
  if (ageMs > FLEET_EVIDENCE_MAX_AGE_SECONDS * 1000) {
    return {
      state: "stale",
      source,
      observed_at: receipt.observed_at,
      evidence_sha256: receipt.evidence_sha256,
      fresh: false,
      blocker_code: "evidence_stale",
    };
  }
  return {
    state: "proven",
    source,
    observed_at: receipt.observed_at,
    evidence_sha256: receipt.evidence_sha256,
    fresh: true,
    blocker_code: null,
  };
}

function applyGoldenThreadChronology(
  planes: FleetReadinessReport["routes"][number]["planes"],
  evidence: RouteEvidence | undefined,
): boolean {
  if (!evidence) return false;
  let latestObservedAt = Number.NEGATIVE_INFINITY;
  let mismatch = false;
  for (const plane of FLEET_READINESS_PLANES) {
    if (!GOLDEN_THREAD_PLANES.has(plane)) continue;
    const receipt = evidence.planes[plane];
    if (!receipt || receipt.state === "not_applicable") continue;
    const observedAt = parseTimestamp(receipt.observed_at, `${plane} observed_at`);
    if (observedAt < latestObservedAt) {
      const compiled = planes[plane];
      compiled.state = "binding_mismatch";
      compiled.fresh = false;
      compiled.blocker_code = "golden_thread_chronology_mismatch";
      mismatch = true;
    } else {
      latestObservedAt = observedAt;
    }
  }
  return mismatch;
}

function firstRouteBlocker(
  planes: FleetReadinessReport["routes"][number]["planes"],
): { plane: Plane; code: string } | null {
  for (const plane of FLEET_READINESS_PLANES) {
    const evidence = planes[plane];
    if (evidence.state !== "proven" && evidence.state !== "not_applicable") {
      return { plane, code: evidence.blocker_code! };
    }
  }
  return null;
}

function firstEnrollmentBlocker(
  input: ValidatedInput,
  domains: FleetReadinessReport["domains"],
  enrollmentBindingCoherent: boolean,
): FleetReadinessReport["first_blocker"] {
  if (!enrollmentBindingCoherent) return { plane: "enrollment", code: "enrollment_binding_mismatch" };
  if (!input.enrollment.inventory_complete) {
    return { plane: "enrollment", code: input.enrollment.inventory_blocker_code! };
  }
  const unresolved = domains.find((domain) =>
    domain.decision === "scheduled_for_migration" || domain.decision === "pending_owner_decision"
  );
  if (unresolved) {
    return {
      plane: "enrollment",
      code: unresolved.first_blocker?.code ?? "enrollment_decision_unresolved",
      domain_sha256: unresolved.domain_sha256,
    };
  }
  return null;
}

function firstConfiguredFleetBlocker(
  input: ValidatedInput,
  domains: FleetReadinessReport["domains"],
  inventoryBindingCoherent: boolean,
  canonicalRouteSetAttested: boolean,
  policyProjectionReceiptDigestCoherent: boolean,
  policyProjectionExpectedDigestMatched: boolean,
): FleetReadinessReport["first_blocker"] {
  if (input.route_inventory.coverage_mode === "canary") {
    return { plane: "configured", code: "canary_scope_cannot_authorize_fleet" };
  }
  if (!canonicalRouteSetAttested) return { plane: "configured", code: "route_set_digest_mismatch" };
  if (!policyProjectionReceiptDigestCoherent) {
    return { plane: "configured", code: "policy_projection_receipt_digest_mismatch" };
  }
  if (!policyProjectionExpectedDigestMatched) {
    return { plane: "configured", code: "policy_projection_expected_digest_mismatch" };
  }
  if (!inventoryBindingCoherent) return { plane: "configured", code: "route_inventory_binding_mismatch" };
  const routeMissing = domains.find((domain) => domain.first_blocker?.plane === "configured");
  return routeMissing ? {
    plane: "configured",
    code: routeMissing.first_blocker!.code,
    domain_sha256: routeMissing.domain_sha256,
  } : null;
}

function firstFleetRouteBlocker(
  routes: FleetReadinessReport["routes"],
): FleetReadinessReport["first_blocker"] {
  const candidates = routes.flatMap((route) => route.first_blocker ? [{
    route_sha256: route.route_sha256,
    plane: route.first_blocker.plane,
    code: route.first_blocker.code,
  }] : []);
  candidates.sort((left, right) => {
    const planeOrder = FLEET_READINESS_PLANES.indexOf(left.plane) - FLEET_READINESS_PLANES.indexOf(right.plane);
    return planeOrder !== 0 ? planeOrder : left.route_sha256.localeCompare(right.route_sha256);
  });
  return candidates[0] ?? null;
}

function validateInput(value: unknown): ValidatedInput {
  const root = record(value, "fleet readiness input");
  exactKeys(root, [
    "schema_version",
    "binding",
    "enrollment",
    "route_inventory",
    "route_evidence",
  ], "fleet readiness input");
  if (root.schema_version !== 1) throw new Error("fleet readiness input schema_version must be 1");
  const binding = validateBinding(root.binding, "binding");
  const enrollment = validateEnrollment(root.enrollment);
  const routeInventory = validateRouteInventory(root.route_inventory);
  const enrollmentByDomain = new Map(enrollment.domains.map((domain) => [domain.domain_sha256, domain]));
  for (const route of routeInventory.routes) {
    const domain = enrollmentByDomain.get(route.domain_sha256);
    if (!domain) throw new Error("route inventory names a domain outside the enrollment report");
    if (domain.decision !== "enrolled") {
      throw new Error("route inventory may contain routes only for enrolled domains");
    }
  }
  const routeEvidence = validateRouteEvidence(root.route_evidence, routeInventory.routes);
  return {
    binding,
    enrollment,
    route_inventory: routeInventory,
    route_evidence: routeEvidence,
  };
}

function validateBinding(value: unknown, label: string): Binding {
  const binding = record(value, label);
  const keys = [
    "transaction_sha256",
    "checkout_sha256",
    "tree_sha256",
    "policy_sha256",
    "desired_state_sha256",
    "enrollment_sha256",
    "route_inventory_sha256",
  ] as const;
  exactKeys(binding, [...keys], label);
  for (const key of keys) requireDigest(binding[key], `${label}.${key}`);
  return binding as unknown as Binding;
}

function validateEnrollment(value: unknown): EnrollmentReport {
  const report = record(value, "enrollment report");
  exactKeys(report, ["schema_version", "kind", "performed", "body_free", "enrollment_sha256", "status", "counts", "domains"], "enrollment report");
  if (report.schema_version !== 1 || report.kind !== "maildesk_domain_enrollment_report" ||
      report.performed !== false || report.body_free !== true) {
    throw new Error("enrollment report identity is invalid");
  }
  requireDigest(report.enrollment_sha256, "enrollment report enrollment_sha256");
  const status = record(report.status, "enrollment report status");
  exactKeys(status, [
    "ledger_valid",
    "associated_domain_inventory_complete",
    "all_active_domains_classified",
    "full_routing_coverage_claim_allowed",
    "inventory_blocker_code",
  ], "enrollment report status");
  if (status.ledger_valid !== true || status.all_active_domains_classified !== true ||
      status.full_routing_coverage_claim_allowed !== false ||
      typeof status.associated_domain_inventory_complete !== "boolean") {
    throw new Error("enrollment report status is invalid");
  }
  if (status.associated_domain_inventory_complete === false) requireCode(status.inventory_blocker_code, "inventory blocker");
  else if (status.inventory_blocker_code !== null) throw new Error("complete enrollment inventory cannot have a blocker");
  const counts = record(report.counts, "enrollment report counts");
  exactKeys(counts, [
    "total_known_domains", "enrolled_domains", "scheduled_domains", "excluded_domains", "pending_domains",
    "active_policy_domains", "desired_state_domains",
  ], "enrollment report counts");
  for (const [key, count] of Object.entries(counts)) {
    if (!Number.isInteger(count) || (count as number) < 0) throw new Error(`enrollment report ${key} must be a nonnegative integer`);
  }
  if (!Array.isArray(report.domains) || report.domains.length === 0) throw new Error("enrollment report domains must be nonempty");
  const domains = report.domains.map((domain, index) => validateEnrollmentDomain(domain, index));
  ensureUnique(domains.map((domain) => domain.domain_sha256), "enrollment report contains a duplicate domain digest");
  const decisionCount = (decision: EnrollmentDecision) => domains.filter((domain) => domain.decision === decision).length;
  if (counts.total_known_domains !== domains.length ||
      counts.enrolled_domains !== decisionCount("enrolled") ||
      counts.scheduled_domains !== decisionCount("scheduled_for_migration") ||
      counts.excluded_domains !== decisionCount("intentionally_excluded") ||
      counts.pending_domains !== decisionCount("pending_owner_decision")) {
    throw new Error("enrollment report counts disagree with domain decisions");
  }
  return {
    enrollment_sha256: report.enrollment_sha256 as string,
    inventory_complete: status.associated_domain_inventory_complete as boolean,
    inventory_blocker_code: status.inventory_blocker_code as string | null,
    domains,
  };
}

function validateEnrollmentDomain(value: unknown, index: number): EnrollmentDomain {
  const domain = record(value, `enrollment domains[${index}]`);
  exactKeys(domain, [
    "domain_sha256", "decision", "registrar_custody", "desired_inbound_provider", "active_policy", "configured",
    "reason_code", "blocker_code", "decision_owner_ref_sha256", "first_blocker",
  ], `enrollment domains[${index}]`);
  requireDigest(domain.domain_sha256, `enrollment domains[${index}].domain_sha256`);
  const decisions: EnrollmentDecision[] = ["enrolled", "scheduled_for_migration", "intentionally_excluded", "pending_owner_decision"];
  if (!decisions.includes(domain.decision as EnrollmentDecision)) throw new Error(`enrollment domains[${index}].decision is invalid`);
  if (!["cloudflare", "external", "unknown"].includes(domain.registrar_custody as string)) {
    throw new Error(`enrollment domains[${index}].registrar_custody is invalid`);
  }
  if (domain.desired_inbound_provider !== null && typeof domain.desired_inbound_provider !== "string") {
    throw new Error(`enrollment domains[${index}].desired_inbound_provider is invalid`);
  }
  if (typeof domain.active_policy !== "boolean" || typeof domain.configured !== "boolean") {
    throw new Error(`enrollment domains[${index}] activity flags are invalid`);
  }
  for (const key of ["reason_code", "blocker_code"] as const) {
    if (domain[key] !== null) requireCode(domain[key], `enrollment domains[${index}].${key}`);
  }
  if (domain.decision_owner_ref_sha256 !== null) requireDigest(domain.decision_owner_ref_sha256, `enrollment domains[${index}].decision_owner_ref_sha256`);
  let firstBlocker: EnrollmentDomain["first_blocker"] = null;
  if (domain.first_blocker !== null) {
    const blocker = record(domain.first_blocker, `enrollment domains[${index}].first_blocker`);
    exactKeys(blocker, ["plane", "code"], `enrollment domains[${index}].first_blocker`);
    if (blocker.plane !== "enrollment") throw new Error("enrollment first blocker plane is invalid");
    requireCode(blocker.code, "enrollment first blocker code");
    firstBlocker = { plane: "enrollment", code: blocker.code as string };
  }
  const decision = domain.decision as EnrollmentDecision;
  const reasonCode = domain.reason_code as string | null;
  const blockerCode = domain.blocker_code as string | null;
  const ownerRef = domain.decision_owner_ref_sha256 as string | null;
  const activePolicy = domain.active_policy as boolean;
  const configured = domain.configured as boolean;
  const desiredProvider = domain.desired_inbound_provider as string | null;
  if (decision === "enrolled" && (!activePolicy || !configured || desiredProvider !== "cloudflare_email_routing" || reasonCode !== null || blockerCode !== null || ownerRef !== null || firstBlocker !== null)) {
    throw new Error(`enrollment domains[${index}] enrolled domain invariants are invalid`);
  }
  if (decision === "scheduled_for_migration" && (!activePolicy || !configured || desiredProvider === null || blockerCode === null || reasonCode !== null || ownerRef !== null || firstBlocker?.code !== blockerCode)) {
    throw new Error(`enrollment domains[${index}] scheduled domain invariants are invalid`);
  }
  if (decision === "intentionally_excluded" && (activePolicy || configured || reasonCode === null || blockerCode !== null || ownerRef !== null || firstBlocker !== null)) {
    throw new Error(`enrollment domains[${index}] excluded domain invariants are invalid`);
  }
  if (decision === "pending_owner_decision" && (activePolicy || configured || reasonCode !== null || blockerCode !== null || ownerRef === null || firstBlocker?.code !== "owner_decision_pending")) {
    throw new Error(`enrollment domains[${index}] pending domain invariants are invalid`);
  }
  return {
    domain_sha256: domain.domain_sha256 as string,
    decision,
    registrar_custody: domain.registrar_custody as EnrollmentDomain["registrar_custody"],
    desired_inbound_provider: desiredProvider,
    active_policy: activePolicy,
    configured,
    reason_code: reasonCode,
    blocker_code: blockerCode,
    decision_owner_ref_sha256: ownerRef,
    first_blocker: firstBlocker,
  };
}

function validateRouteInventory(value: unknown): ValidatedInput["route_inventory"] {
  const inventory = record(value, "route inventory");
  exactKeys(inventory, ["schema_version", "coverage_mode", "declared_route_count", "route_set_sha256", "binding", "policy_projection_receipt", "routes"], "route inventory");
  if (inventory.schema_version !== 1) throw new Error("route inventory schema_version must be 1");
  if (inventory.coverage_mode !== "full_policy" && inventory.coverage_mode !== "canary") throw new Error("route inventory coverage_mode is invalid");
  if (!Array.isArray(inventory.routes) || inventory.routes.length === 0) throw new Error("route inventory routes must be nonempty");
  if (!Number.isInteger(inventory.declared_route_count) || inventory.declared_route_count !== inventory.routes.length) {
    throw new Error("route inventory declared_route_count disagrees with routes");
  }
  const routes = inventory.routes.map((route, index) => validateRoute(route, index));
  ensureUnique(routes.map((route) => route.route_sha256), "route inventory contains a duplicate route digest");
  requireDigest(inventory.route_set_sha256, "route inventory route_set_sha256");
  return {
    coverage_mode: inventory.coverage_mode,
    declared_route_count: inventory.declared_route_count as number,
    route_set_sha256: inventory.route_set_sha256 as string,
    binding: validateBinding(inventory.binding, "route inventory binding"),
    policy_projection_receipt: validatePolicyProjectionReceipt(inventory.policy_projection_receipt),
    routes,
  };
}

function validatePolicyProjectionReceipt(
  value: unknown,
): ValidatedInput["route_inventory"]["policy_projection_receipt"] {
  const receipt = record(value, "policy projection inventory receipt");
  exactKeys(receipt, [
    "schema_version",
    "kind",
    "performed",
    "body_free",
    "configured_route_count",
    "route_set_sha256",
    "evidence_sha256",
    "binding",
  ], "policy projection inventory receipt");
  if (receipt.schema_version !== 1 ||
      receipt.kind !== "maildesk_policy_projection_inventory_receipt" ||
      receipt.performed !== false || receipt.body_free !== true) {
    throw new Error("policy projection inventory receipt identity is invalid");
  }
  if (!Number.isInteger(receipt.configured_route_count) || (receipt.configured_route_count as number) < 1) {
    throw new Error("policy projection configured_route_count must be a positive integer");
  }
  requireDigest(receipt.route_set_sha256, "policy projection route_set_sha256");
  requireDigest(receipt.evidence_sha256, "policy projection evidence_sha256");
  return {
    configured_route_count: receipt.configured_route_count as number,
    route_set_sha256: receipt.route_set_sha256 as string,
    evidence_sha256: receipt.evidence_sha256 as string,
    binding: validateBinding(receipt.binding, "policy projection binding"),
  };
}

function validateRoute(value: unknown, index: number): RouteDefinition {
  const route = record(value, `routes[${index}]`);
  const delivery = route.delivery_contract;
  const keys = ["route_sha256", "domain_sha256", "route_kind", "delivery_contract"];
  if (delivery === "inbound_only_v1") keys.push("graduation_contract");
  exactKeys(route, keys, `routes[${index}]`);
  requireDigest(route.route_sha256, `routes[${index}].route_sha256`);
  requireDigest(route.domain_sha256, `routes[${index}].domain_sha256`);
  if (!["role_alias", "personal_alias", "catch_all", "sink"].includes(route.route_kind as string)) throw new Error(`routes[${index}].route_kind is invalid`);
  if (delivery !== "bidirectional_reply" && delivery !== "inbound_only_v1") throw new Error(`routes[${index}].delivery_contract is invalid`);
  if (route.route_kind === "sink" && delivery !== "inbound_only_v1") throw new Error("sink routes require inbound_only_v1");
  if (delivery === "inbound_only_v1" && route.route_kind !== "sink") {
    throw new Error("inbound_only_v1 is restricted to sink routes");
  }
  const graduation = delivery === "inbound_only_v1" ? validateGraduation(route.graduation_contract, index) : undefined;
  return {
    route_sha256: route.route_sha256 as string,
    domain_sha256: route.domain_sha256 as string,
    route_kind: route.route_kind as RouteKind,
    delivery_contract: delivery,
    ...(graduation ? { graduation_contract: graduation } : {}),
  };
}

function validateGraduation(value: unknown, routeIndex: number): GraduationContract {
  const contract = record(value, `routes[${routeIndex}].graduation_contract`);
  exactKeys(contract, ["schema_version", "route_sha256", "contract_sha256", "reason_code", "owner_ref_sha256", "expires_at"], `routes[${routeIndex}].graduation_contract`);
  if (contract.schema_version !== 1) throw new Error("graduation contract schema_version must be 1");
  requireDigest(contract.contract_sha256, "graduation contract contract_sha256");
  requireDigest(contract.route_sha256, "graduation contract route_sha256");
  requireDigest(contract.owner_ref_sha256, "graduation contract owner_ref_sha256");
  requireCode(contract.reason_code, "graduation contract reason_code");
  parseTimestamp(contract.expires_at, "graduation contract expires_at");
  return contract as unknown as GraduationContract;
}

function validateRouteEvidence(value: unknown, routes: RouteDefinition[]): RouteEvidence[] {
  if (!Array.isArray(value)) throw new Error("route_evidence must be an array");
  const routeByDigest = new Map(routes.map((route) => [route.route_sha256, route]));
  const entries = value.map((entryValue, index) => {
    const entry = record(entryValue, `route_evidence[${index}]`);
    exactKeys(entry, ["schema_version", "route_sha256", "domain_sha256", "golden_thread_sha256", "planes"], `route_evidence[${index}]`);
    if (entry.schema_version !== 1) throw new Error(`route_evidence[${index}] schema_version must be 1`);
    requireDigest(entry.route_sha256, `route_evidence[${index}].route_sha256`);
    requireDigest(entry.domain_sha256, `route_evidence[${index}].domain_sha256`);
    requireDigest(entry.golden_thread_sha256, `route_evidence[${index}].golden_thread_sha256`);
    const route = routeByDigest.get(entry.route_sha256 as string);
    if (!route) throw new Error("route evidence names an undeclared route digest");
    if (route.domain_sha256 !== entry.domain_sha256) throw new Error("route evidence domain binding mismatch");
    const planesValue = record(entry.planes, `route_evidence[${index}].planes`);
    exactKeys(planesValue, [...FLEET_READINESS_PLANES], `route_evidence[${index}].planes`);
    const planes: Partial<Record<Plane, PlaneReceipt>> = {};
    for (const plane of FLEET_READINESS_PLANES) {
      if (planesValue[plane] === undefined) continue;
      planes[plane] = validatePlaneReceipt(planesValue[plane], plane, route);
    }
    return {
      schema_version: 1 as const,
      route_sha256: entry.route_sha256 as string,
      domain_sha256: entry.domain_sha256 as string,
      golden_thread_sha256: entry.golden_thread_sha256 as string,
      planes,
    };
  });
  ensureUnique(entries.map((entry) => entry.route_sha256), "route evidence contains a duplicate route digest");
  ensureUnique(entries.map((entry) => entry.golden_thread_sha256), "route evidence contains a duplicate golden thread digest");
  return entries;
}

function validatePlaneReceipt(value: unknown, plane: Plane, route: RouteDefinition): PlaneReceipt {
  const receipt = record(value, `${plane} receipt`);
  if (receipt.state === "not_applicable") {
    exactKeys(receipt, [
      "state", "source", "route_sha256", "domain_sha256", "golden_thread_sha256",
      "evidence_sha256", "graduation_contract_sha256",
    ], `${plane} receipt`);
    if (receipt.source !== "graduation_contract" || route.delivery_contract !== "inbound_only_v1" || !SINK_NOT_APPLICABLE_PLANES.has(plane)) {
      throw new Error(`${plane} cannot be not_applicable for this route contract`);
    }
    requireDigest(receipt.route_sha256, `${plane} route_sha256`);
    requireDigest(receipt.domain_sha256, `${plane} domain_sha256`);
    requireDigest(receipt.golden_thread_sha256, `${plane} golden_thread_sha256`);
    requireDigest(receipt.evidence_sha256, `${plane} evidence_sha256`);
    requireDigest(receipt.graduation_contract_sha256, `${plane} graduation_contract_sha256`);
    return receipt as unknown as NotApplicableReceipt;
  }
  const receiptKeys = [
    "state", "source", "observed_at", "evidence_sha256", "route_sha256", "domain_sha256", "binding", "blocker_code",
  ];
  if (GOLDEN_THREAD_PLANES.has(plane)) receiptKeys.push("golden_thread_sha256");
  exactKeys(receipt, receiptKeys, `${plane} receipt`);
  if (receipt.state !== "proven" && receipt.state !== "failed") throw new Error(`${plane} receipt state is invalid`);
  if (receipt.source !== SOURCE_BY_PLANE[plane]) throw new Error(`${plane} receipt source is invalid`);
  parseTimestamp(receipt.observed_at, `${plane} observed_at`);
  requireDigest(receipt.evidence_sha256, `${plane} evidence_sha256`);
  requireDigest(receipt.route_sha256, `${plane} route_sha256`);
  requireDigest(receipt.domain_sha256, `${plane} domain_sha256`);
  if (GOLDEN_THREAD_PLANES.has(plane)) requireDigest(receipt.golden_thread_sha256, `${plane} golden_thread_sha256`);
  const observed: ObservedReceipt = {
    state: receipt.state,
    source: receipt.source as string,
    observed_at: receipt.observed_at as string,
    evidence_sha256: receipt.evidence_sha256 as string,
    route_sha256: receipt.route_sha256 as string,
    domain_sha256: receipt.domain_sha256 as string,
    ...(GOLDEN_THREAD_PLANES.has(plane)
      ? { golden_thread_sha256: receipt.golden_thread_sha256 as string }
      : {}),
    binding: validateBinding(receipt.binding, `${plane} binding`),
  };
  if (receipt.state === "failed") {
    requireCode(receipt.blocker_code, `${plane} blocker_code`);
    observed.blocker_code = receipt.blocker_code as string;
  } else if (receipt.blocker_code !== undefined) {
    throw new Error(`${plane} proven receipt cannot carry blocker_code`);
  }
  return observed;
}

function bindingsEqual(left: Binding, right: Binding): boolean {
  return Object.keys(left).every((key) => left[key as keyof Binding] === right[key as keyof Binding]);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${label} contains an unexpected field`);
}

function requireDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(`${label} must be a sha256 digest`);
}

function requireCode(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !CODE.test(value)) throw new Error(`${label} must be a bounded code`);
}

function parseTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string") throw new Error(`${label} must be an RFC3339 timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`${label} must be a normalized RFC3339 timestamp`);
  return parsed;
}

function ensureUnique(values: string[], message: string): void {
  if (new Set(values).size !== values.length) throw new Error(message);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const inputPath = resolve(root, argValue(args, "--input") ?? defaultPath(root));
  try {
    const expectedPolicyProjectionSha256 = argValue(args, "--expected-policy-projection-sha256");
    if (!expectedPolicyProjectionSha256) {
      throw new Error("--expected-policy-projection-sha256 is required from the controller trust input");
    }
    const report = compileFleetReadiness(
      JSON.parse(readFileSync(inputPath, "utf8")),
      expectedPolicyProjectionSha256,
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`fleet readiness compilation failed: ${message}\n`);
    process.exit(1);
  }
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function defaultPath(root: string): string {
  const local = resolve(root, "config/fleet-readiness.local.json");
  return existsSync(local) ? local : resolve(root, "config/fleet-readiness.example.json");
}
