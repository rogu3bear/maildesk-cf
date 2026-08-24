import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FLEET_EVIDENCE_MAX_AGE_SECONDS,
  FLEET_READINESS_PLANES,
  compileFleetReadiness,
  computeGraduationContractSha256,
  computePolicyProjectionReceiptSha256,
  computeRouteSetSha256,
} from "../../scripts/compile-fleet-readiness";

const sha = (character: string) => `sha256:${character.repeat(64)}`;
const DOMAIN = sha("a");
const EXCLUDED_DOMAIN = sha("b");
const ROUTE_A = sha("c");
const ROUTE_B = sha("d");
const GOLDEN_A = sha("e");
const GOLDEN_B = sha("f");
const NOW = new Date("2026-08-23T12:00:00.000Z");
const root = resolve(import.meta.dir, "../..");

const sources = {
  configured: "policy_projection",
  cloudflare_active: "cloudflare_control_plane",
  inbound_provider_accepted: "d1_inbound_audit",
  inbox_received: "apple_mail_inbox_receipt",
  reply_authorized: "d1_reply_authorization",
  outbound_provider_accepted: "outbound_provider_receipt",
  recipient_delivered: "external_recipient_receipt",
  privacy_proven: "privacy_non_exposure_receipt",
} as const;

const goldenPlanes = new Set([
  "inbound_provider_accepted",
  "inbox_received",
  "reply_authorized",
  "outbound_provider_accepted",
  "recipient_delivered",
  "privacy_proven",
]);

function staticBinding() {
  return {
    transaction_sha256: sha("1"),
    checkout_sha256: sha("2"),
    tree_sha256: sha("3"),
    policy_sha256: sha("4"),
    desired_state_sha256: sha("5"),
    enrollment_sha256: sha("6"),
    route_inventory_sha256: sha("7"),
  };
}

function observedPlanes(route: string, goldenThread: string, binding: any) {
  const timestamps = {
    configured: "2026-08-23T11:50:00.000Z",
    cloudflare_active: "2026-08-23T11:51:00.000Z",
    inbound_provider_accepted: "2026-08-23T11:52:00.000Z",
    inbox_received: "2026-08-23T11:53:00.000Z",
    reply_authorized: "2026-08-23T11:54:00.000Z",
    outbound_provider_accepted: "2026-08-23T11:55:00.000Z",
    recipient_delivered: "2026-08-23T11:56:00.000Z",
    privacy_proven: "2026-08-23T11:57:00.000Z",
  } as const;
  return Object.fromEntries(FLEET_READINESS_PLANES.map((plane, index) => [
    plane,
    {
      state: "proven",
      source: sources[plane],
      observed_at: timestamps[plane],
      evidence_sha256: sha("89abcdef"[index]),
      route_sha256: route,
      domain_sha256: DOMAIN,
      ...(goldenPlanes.has(plane) ? { golden_thread_sha256: goldenThread } : {}),
      binding: { ...binding },
    },
  ]));
}

function input(): any {
  const routes = [
    {
      route_sha256: ROUTE_A,
      domain_sha256: DOMAIN,
      route_kind: "role_alias",
      delivery_contract: "bidirectional_reply",
    },
    {
      route_sha256: ROUTE_B,
      domain_sha256: DOMAIN,
      route_kind: "personal_alias",
      delivery_contract: "bidirectional_reply",
    },
  ];
  const routeSetSha256 = computeRouteSetSha256(routes);
  const binding = { ...staticBinding(), route_inventory_sha256: routeSetSha256 };
  const policyProjectionFields = {
    schema_version: 1,
    kind: "maildesk_policy_projection_inventory_receipt",
    performed: false,
    body_free: true,
    transaction_sha256: binding.transaction_sha256,
    checkout_sha256: binding.checkout_sha256,
    tree_sha256: binding.tree_sha256,
    policy_sha256: binding.policy_sha256,
    desired_state_sha256: binding.desired_state_sha256,
    enrollment_sha256: binding.enrollment_sha256,
    configured_route_count: routes.length,
    route_set_sha256: routeSetSha256,
  };
  return {
    schema_version: 1,
    binding,
    enrollment: {
      schema_version: 1,
      kind: "maildesk_domain_enrollment_report",
      performed: false,
      body_free: true,
      enrollment_sha256: binding.enrollment_sha256,
      status: {
        ledger_valid: true,
        associated_domain_inventory_complete: true,
        all_active_domains_classified: true,
        full_routing_coverage_claim_allowed: false,
        inventory_blocker_code: null,
      },
      counts: {
        total_known_domains: 2,
        enrolled_domains: 1,
        scheduled_domains: 0,
        excluded_domains: 1,
        pending_domains: 0,
        active_policy_domains: 1,
        desired_state_domains: 1,
      },
      domains: [
        {
          domain_sha256: DOMAIN,
          decision: "enrolled",
          registrar_custody: "external",
          desired_inbound_provider: "cloudflare_email_routing",
          active_policy: true,
          configured: true,
          reason_code: null,
          blocker_code: null,
          decision_owner_ref_sha256: null,
          first_blocker: null,
        },
        {
          domain_sha256: EXCLUDED_DOMAIN,
          decision: "intentionally_excluded",
          registrar_custody: "external",
          desired_inbound_provider: null,
          active_policy: false,
          configured: false,
          reason_code: "owner_excluded_current_scope",
          blocker_code: null,
          decision_owner_ref_sha256: null,
          first_blocker: null,
        },
      ],
    },
    route_inventory: {
      schema_version: 1,
      coverage_mode: "full_policy",
      declared_route_count: routes.length,
      route_set_sha256: routeSetSha256,
      binding: { ...binding },
      policy_projection_receipt: {
        schema_version: 1,
        kind: "maildesk_policy_projection_inventory_receipt",
        performed: false,
        body_free: true,
        configured_route_count: routes.length,
        route_set_sha256: routeSetSha256,
        evidence_sha256: computePolicyProjectionReceiptSha256(policyProjectionFields),
        binding: { ...binding },
      },
      routes,
    },
    route_evidence: [
      {
        schema_version: 1,
        route_sha256: ROUTE_A,
        domain_sha256: DOMAIN,
        golden_thread_sha256: GOLDEN_A,
        planes: observedPlanes(ROUTE_A, GOLDEN_A, binding),
      },
      {
        schema_version: 1,
        route_sha256: ROUTE_B,
        domain_sha256: DOMAIN,
        golden_thread_sha256: GOLDEN_B,
        planes: observedPlanes(ROUTE_B, GOLDEN_B, binding),
      },
    ],
  };
}

function evidenceFor(value: any, route: string) {
  return value.route_evidence.find((entry: any) => entry.route_sha256 === route)!;
}

function expectedPolicyProjectionSha256(value: any): string {
  const receipt = value.route_inventory.policy_projection_receipt;
  const receiptBinding = receipt.binding;
  return computePolicyProjectionReceiptSha256({
    schema_version: receipt.schema_version,
    kind: receipt.kind,
    performed: receipt.performed,
    body_free: receipt.body_free,
    transaction_sha256: receiptBinding.transaction_sha256,
    checkout_sha256: receiptBinding.checkout_sha256,
    tree_sha256: receiptBinding.tree_sha256,
    policy_sha256: receiptBinding.policy_sha256,
    desired_state_sha256: receiptBinding.desired_state_sha256,
    enrollment_sha256: receiptBinding.enrollment_sha256,
    configured_route_count: receipt.configured_route_count,
    route_set_sha256: receipt.route_set_sha256,
  });
}

function compile(value: any, now = NOW, expected = expectedPolicyProjectionSha256(value)) {
  return compileFleetReadiness(value, expected, now);
}

function rebindRouteSet(value: any): void {
  const digest = computeRouteSetSha256(value.route_inventory.routes);
  value.binding.route_inventory_sha256 = digest;
  value.route_inventory.route_set_sha256 = digest;
  value.route_inventory.binding = { ...value.binding };
  value.route_inventory.declared_route_count = value.route_inventory.routes.length;
  value.route_inventory.policy_projection_receipt.configured_route_count = value.route_inventory.routes.length;
  value.route_inventory.policy_projection_receipt.route_set_sha256 = digest;
  value.route_inventory.policy_projection_receipt.binding = { ...value.binding };
  value.route_inventory.policy_projection_receipt.evidence_sha256 = expectedPolicyProjectionSha256(value);
  for (const evidence of value.route_evidence) {
    for (const receipt of Object.values(evidence.planes) as any[]) {
      if (receipt.binding) receipt.binding = { ...value.binding };
    }
  }
}

function makeSink(value: any): void {
  const route = value.route_inventory.routes.find((entry: any) => entry.route_sha256 === ROUTE_A)!;
  route.route_kind = "sink";
  route.delivery_contract = "inbound_only_v1";
  const contractFields = {
    schema_version: 1,
    route_sha256: ROUTE_A,
    reason_code: "intentional_inbound_sink",
    owner_ref_sha256: sha("9"),
    expires_at: "2026-09-23T12:00:00.000Z",
  };
  route.graduation_contract = {
    ...contractFields,
    contract_sha256: computeGraduationContractSha256(contractFields),
  };
  rebindRouteSet(value);
  for (const plane of ["reply_authorized", "outbound_provider_accepted", "recipient_delivered", "privacy_proven"]) {
    evidenceFor(value, ROUTE_A).planes[plane] = {
      state: "not_applicable",
      source: "graduation_contract",
      route_sha256: ROUTE_A,
      domain_sha256: DOMAIN,
      golden_thread_sha256: GOLDEN_A,
      evidence_sha256: route.graduation_contract.contract_sha256,
      graduation_contract_sha256: route.graduation_contract.contract_sha256,
    };
  }
}

describe("body-free fleet readiness compiler", () => {
  test("keeps the tracked schema and reserved example aligned with the executable contract", () => {
    const schema = JSON.parse(readFileSync(resolve(root, "config/fleet-readiness.schema.json"), "utf8"));
    const example = JSON.parse(readFileSync(resolve(root, "config/fleet-readiness.example.json"), "utf8"));
    expect(Object.keys(schema.$defs.planes.properties)).toEqual(FLEET_READINESS_PLANES);
    expect(schema.$defs.route_inventory.properties.coverage_mode.enum).toEqual(["full_policy", "canary"]);
    expect(schema.$defs.control_proven_receipt.required).not.toContain("blocker_code");
    expect(schema.$defs.control_proven_receipt.properties.blocker_code).toBeUndefined();
    expect(schema.$defs.control_failed_receipt.required).toContain("blocker_code");
    expect(schema.$defs.golden_failed_receipt.required).toContain("blocker_code");
    expect(compile(example).kind).toBe("maildesk_fleet_readiness_report");
    expect(FLEET_EVIDENCE_MAX_AGE_SECONDS).toBe(15 * 60);
  });

  test("proves full coverage only for a complete, coherent, fresh full-policy fleet", () => {
    const report = compile(input());
    expect(report).toMatchObject({
      schema_version: 1,
      kind: "maildesk_fleet_readiness_report",
      performed: false,
      body_free: true,
      coverage: {
        mode: "full_policy",
        inventory_complete: true,
        route_set_attested: true,
        all_enrolled_routes_present: true,
        transaction_coherent: true,
        all_required_planes_proven_and_fresh: true,
        full_coverage_proven: true,
      },
      counts: {
        configured: 2,
        cloudflare_active: 2,
        inbox_received: 2,
        reply_proven: 2,
        failed_or_stale: 0,
        required_routes: 2,
        ready_routes: 2,
      },
      first_blocker: null,
    });
  });

  test("recomputes a canonical route set and rejects omission even when local declared count is adjusted", () => {
    const value = input();
    expect(computeRouteSetSha256([...value.route_inventory.routes].reverse()))
      .toBe(value.route_inventory.route_set_sha256);
    value.route_inventory.routes = value.route_inventory.routes.filter((route: any) => route.route_sha256 !== ROUTE_B);
    value.route_evidence = value.route_evidence.filter((route: any) => route.route_sha256 !== ROUTE_B);
    value.route_inventory.declared_route_count = 1;

    const report = compile(value);
    expect(report.coverage.route_set_attested).toBe(false);
    expect(report.coverage.full_coverage_proven).toBe(false);
    expect(report.first_blocker).toEqual({ plane: "configured", code: "route_set_digest_mismatch" });
  });

  test("requires the independently supplied canonical policy-projection digest", () => {
    const value = input();
    const independentlyBoundExpected = expectedPolicyProjectionSha256(value);
    value.route_inventory.routes = value.route_inventory.routes.filter((route: any) => route.route_sha256 !== ROUTE_B);
    value.route_evidence = value.route_evidence.filter((route: any) => route.route_sha256 !== ROUTE_B);
    rebindRouteSet(value);
    expect(value.route_inventory.policy_projection_receipt.evidence_sha256)
      .toBe(expectedPolicyProjectionSha256(value));

    const report = compile(value, NOW, independentlyBoundExpected);
    expect(report.coverage.full_coverage_proven).toBe(false);
    expect(report.first_blocker).toEqual({
      plane: "configured",
      code: "policy_projection_expected_digest_mismatch",
    });
  });

  test("does not hide one failed route behind another route on the same domain", () => {
    const value = input();
    evidenceFor(value, ROUTE_B).planes.inbox_received.state = "failed";
    evidenceFor(value, ROUTE_B).planes.inbox_received.blocker_code = "inbox_receipt_rejected";
    const report = compile(value);
    expect(report.counts).toMatchObject({ required_routes: 2, ready_routes: 1, blocked_routes: 1 });
    expect(report.routes.find((route) => route.route_sha256 === ROUTE_B)?.first_blocker)
      .toEqual({ plane: "inbox_received", code: "inbox_receipt_rejected" });
  });

  test("keeps all evidence planes independent", () => {
    const value = input();
    delete evidenceFor(value, ROUTE_A).planes.inbox_received;
    delete evidenceFor(value, ROUTE_B).planes.recipient_delivered;
    const report = compile(value);
    const routeA = report.routes.find((entry) => entry.route_sha256 === ROUTE_A)!;
    const routeB = report.routes.find((entry) => entry.route_sha256 === ROUTE_B)!;
    expect(routeA.planes.inbound_provider_accepted.state).toBe("proven");
    expect(routeA.planes.inbox_received.state).toBe("missing");
    expect(routeB.planes.outbound_provider_accepted.state).toBe("proven");
    expect(routeB.planes.recipient_delivered.state).toBe("missing");
    expect(routeB.planes.privacy_proven.state).toBe("proven");
  });

  test("rejects a copied route or golden-thread receipt without erasing other observations", () => {
    const value = input();
    evidenceFor(value, ROUTE_B).planes.inbox_received = {
      ...evidenceFor(value, ROUTE_A).planes.inbox_received,
    };
    const route = compile(value).routes.find((entry) => entry.route_sha256 === ROUTE_B)!;
    expect(route.planes.inbox_received).toMatchObject({
      state: "binding_mismatch",
      blocker_code: "receipt_route_binding_mismatch",
    });
    expect(route.planes.reply_authorized.state).toBe("proven");

    const goldenCopy = input();
    evidenceFor(goldenCopy, ROUTE_B).planes.inbox_received.golden_thread_sha256 = GOLDEN_A;
    expect(compile(goldenCopy).routes.find((entry) => entry.route_sha256 === ROUTE_B)?.planes.inbox_received)
      .toMatchObject({ state: "binding_mismatch", blocker_code: "golden_thread_binding_mismatch" });
  });

  test("uses a trusted runtime clock and a fixed freshness window", () => {
    const value = input();
    value.evaluated_at = "2026-08-23T11:27:01.000Z";
    expect(() => compile(value)).toThrow("unexpected field");

    const stale = input();
    const report = compile(stale, new Date("2026-08-23T12:10:01.000Z"));
    expect(report.routes[0].planes.configured).toMatchObject({ state: "stale", blocker_code: "evidence_stale" });
    expect(report.max_evidence_age_seconds).toBe(900);
  });

  test("preserves higher-plane proof when a lower plane is missing and reports deterministic fleet order", () => {
    const value = input();
    delete evidenceFor(value, ROUTE_A).planes.recipient_delivered;
    delete evidenceFor(value, ROUTE_B).planes.cloudflare_active;
    const report = compile(value);
    expect(report.routes.find((route) => route.route_sha256 === ROUTE_B)?.planes.inbox_received.state).toBe("proven");
    expect(report.first_blocker).toEqual({
      route_sha256: ROUTE_B,
      plane: "cloudflare_active",
      code: "evidence_missing",
    });
  });

  test("fails mismatched transaction bindings", () => {
    const value = input();
    evidenceFor(value, ROUTE_A).planes.reply_authorized.binding.policy_sha256 = sha("9");
    const report = compile(value);
    expect(report.routes.find((entry) => entry.route_sha256 === ROUTE_A)?.planes.reply_authorized)
      .toMatchObject({ state: "binding_mismatch", blocker_code: "receipt_binding_mismatch" });
    expect(report.coverage.transaction_coherent).toBe(false);
  });

  test("keeps an excluded domain and its reason visible without counting failure", () => {
    const report = compile(input());
    expect(report.domains.find((domain) => domain.domain_sha256 === EXCLUDED_DOMAIN)).toMatchObject({
      decision: "intentionally_excluded",
      status: "excluded",
      reason_code: "owner_excluded_current_scope",
      required_route_count: 0,
    });
    expect(report.counts.excluded_domains).toBe(1);
    expect(report.counts.blocked_routes).toBe(0);
  });

  test("re-enforces contradictory enrollment decisions", () => {
    const enrolled = input();
    enrolled.enrollment.domains[0].configured = false;
    expect(() => compile(enrolled)).toThrow("enrolled domain");

    const excluded = input();
    excluded.enrollment.domains[1].reason_code = null;
    expect(() => compile(excluded)).toThrow("excluded domain");

    const scheduled = input();
    scheduled.enrollment.domains[1] = {
      ...scheduled.enrollment.domains[1],
      decision: "scheduled_for_migration",
      desired_inbound_provider: "google_workspace",
      active_policy: true,
      configured: true,
      reason_code: null,
      blocker_code: null,
      first_blocker: null,
    };
    scheduled.enrollment.counts.excluded_domains = 0;
    scheduled.enrollment.counts.scheduled_domains = 1;
    expect(() => compile(scheduled)).toThrow("scheduled domain");

    const pending = input();
    pending.enrollment.domains[1] = {
      ...pending.enrollment.domains[1],
      decision: "pending_owner_decision",
      reason_code: null,
      decision_owner_ref_sha256: null,
      first_blocker: { plane: "enrollment", code: "owner_decision_pending" },
    };
    pending.enrollment.counts.excluded_domains = 0;
    pending.enrollment.counts.pending_domains = 1;
    expect(() => compile(pending)).toThrow("pending domain");
  });

  test("blocks complete fleet coverage for valid pending or scheduled domains", () => {
    const scheduled = input();
    scheduled.enrollment.domains[1] = {
      ...scheduled.enrollment.domains[1],
      decision: "scheduled_for_migration",
      desired_inbound_provider: "google_workspace",
      active_policy: true,
      configured: true,
      reason_code: null,
      blocker_code: "cloudflare_primary_migration_not_completed",
      first_blocker: { plane: "enrollment", code: "cloudflare_primary_migration_not_completed" },
    };
    scheduled.enrollment.counts.excluded_domains = 0;
    scheduled.enrollment.counts.scheduled_domains = 1;
    expect(compile(scheduled).first_blocker?.plane).toBe("enrollment");

    const pending = input();
    pending.enrollment.domains[1] = {
      ...pending.enrollment.domains[1],
      decision: "pending_owner_decision",
      registrar_custody: "unknown",
      reason_code: null,
      decision_owner_ref_sha256: sha("9"),
      first_blocker: { plane: "enrollment", code: "owner_decision_pending" },
    };
    pending.enrollment.counts.excluded_domains = 0;
    pending.enrollment.counts.pending_domains = 1;
    expect(compile(pending).coverage.full_coverage_proven).toBe(false);
  });

  test("reports omitted route evidence at configured plane", () => {
    const value = input();
    value.route_evidence = value.route_evidence.filter((entry: any) => entry.route_sha256 !== ROUTE_A);
    const report = compile(value);
    expect(report.coverage.all_enrolled_routes_present).toBe(false);
    expect(report.routes.find((entry) => entry.route_sha256 === ROUTE_A)?.first_blocker)
      .toEqual({ plane: "configured", code: "route_evidence_missing" });
  });

  test("a canary cannot authorize fleet coverage", () => {
    const value = input();
    value.route_inventory.coverage_mode = "canary";
    const report = compile(value);
    expect(report.coverage.all_required_planes_proven_and_fresh).toBe(true);
    expect(report.coverage.full_coverage_proven).toBe(false);
    expect(report.first_blocker).toEqual({ plane: "configured", code: "canary_scope_cannot_authorize_fleet" });
  });

  test("allows an explicit sink waiver, including outbound privacy N/A, but rejects an ordinary-role waiver", () => {
    const sink = input();
    makeSink(sink);
    const route = compile(sink).routes.find((entry) => entry.route_sha256 === ROUTE_A)!;
    expect(route.status).toBe("ready");
    expect(route.planes.privacy_proven.state).toBe("not_applicable");

    const ordinary = input();
    makeSink(ordinary);
    ordinary.route_inventory.routes[0].route_kind = "role_alias";
    rebindRouteSet(ordinary);
    expect(() => compile(ordinary)).toThrow("inbound_only_v1 is restricted to sink routes");

    const forged = input();
    makeSink(forged);
    forged.route_inventory.routes[0].graduation_contract.reason_code = "changed_without_rehash";
    rebindRouteSet(forged);
    const forgedReport = compile(forged);
    expect(forgedReport.routes.find((entry) => entry.route_sha256 === ROUTE_A)?.first_blocker)
      .toEqual({ plane: "reply_authorized", code: "graduation_contract_digest_mismatch" });
  });

  test("rejects impossible golden-thread chronology as a binding mismatch", () => {
    const value = input();
    evidenceFor(value, ROUTE_A).planes.inbox_received.observed_at = "2026-08-23T11:51:00.000Z";
    const report = compile(value);
    const route = report.routes.find((entry) => entry.route_sha256 === ROUTE_A)!;
    expect(route.planes.inbox_received).toMatchObject({
      state: "binding_mismatch",
      blocker_code: "golden_thread_chronology_mismatch",
    });
    expect(report.coverage.transaction_coherent).toBe(false);
  });

  test("emits exact AC-62 counts without inferring across planes", () => {
    const value = input();
    evidenceFor(value, ROUTE_B).planes.cloudflare_active.observed_at = "2026-08-23T11:00:00.000Z";
    const report = compile(value);
    expect(report.counts).toMatchObject({
      configured: 2,
      cloudflare_active: 1,
      inbox_received: 2,
      reply_proven: 2,
      failed_or_stale: 1,
    });
  });

  test("kills only closed identity-exposure blocker codes", () => {
    const privateExposure = input();
    privateExposure.route_evidence[0].planes.privacy_proven.state = "failed";
    privateExposure.route_evidence[0].planes.privacy_proven.blocker_code = "private_identity_exposed";
    expect(compile(privateExposure).routes[0].status).toBe("killed");

    const wrongIdentity = input();
    wrongIdentity.route_evidence[0].planes.recipient_delivered.state = "failed";
    wrongIdentity.route_evidence[0].planes.recipient_delivered.blocker_code = "wrong_public_identity";
    wrongIdentity.route_evidence[0].planes.recipient_delivered.observed_at = "2026-08-23T12:01:00.000Z";
    expect(compile(wrongIdentity).routes[0].status).toBe("killed");

    const ordinaryPrivacyFailure = input();
    ordinaryPrivacyFailure.route_evidence[0].planes.privacy_proven.state = "failed";
    ordinaryPrivacyFailure.route_evidence[0].planes.privacy_proven.blocker_code = "privacy_receipt_unavailable";
    expect(compile(ordinaryPrivacyFailure).routes[0].status).toBe("blocked");
  });

  test("emits no raw address, content, provider payload, token, or account identifier", () => {
    const serialized = JSON.stringify(compile(input()));
    for (const forbidden of ["@", ".com", '"subject":', '"message_body":', '"provider_payload":', '"raw_token":', '"account_id":', "private-operator"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
    const rejected = input();
    rejected.route_evidence[0].planes.configured.raw_provider_payload = { secret: "not admissible" };
    expect(() => compile(rejected)).toThrow("unexpected field");
  });
});
