import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileDomainEnrollment } from "../../scripts/check-domain-enrollment";

const desiredState = {
  domains: [
    {
      name: "example.com",
      inbound_mx_provider: "cloudflare_email_routing",
      role_aliases: ["security"],
      personal_aliases: [],
    },
    {
      name: "example.net",
      inbound_mx_provider: "google_workspace",
      role_aliases: ["security"],
      personal_aliases: [],
    },
  ],
};

const policy = {
  domains: {
    "example.com": {
      role_aliases: {
        security: { operators: ["private-operator@example.invalid"] },
      },
    },
    "example.net": { role_aliases: {} },
  },
};
const root = resolve(import.meta.dir, "../..");

function ledger(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    inventory_complete: false,
    inventory_blocker_code: "associated_domain_inventory_not_reconciled",
    domains: [
      {
        name: "example.com",
        decision: "enrolled",
        registrar_custody: "external",
      },
      {
        name: "example.net",
        decision: "scheduled_for_migration",
        registrar_custody: "unknown",
        blocker_code: "cloudflare_primary_migration_not_completed",
      },
      {
        name: "example.org",
        decision: "intentionally_excluded",
        registrar_custody: "external",
        reason_code: "owner_excluded_current_scope",
      },
      {
        name: "pending.example",
        decision: "pending_owner_decision",
        registrar_custody: "unknown",
        decision_owner_ref: "founder",
      },
    ],
    ...overrides,
  };
}

describe("domain enrollment ledger", () => {
  test("joins one explicit decision to active policy and desired-state domains without exposing policy data", () => {
    const report = compileDomainEnrollment(ledger(), desiredState, policy);

    expect(report).toMatchObject({
      schema_version: 1,
      kind: "maildesk_domain_enrollment_report",
      performed: false,
      body_free: true,
      status: {
        ledger_valid: true,
        associated_domain_inventory_complete: false,
        all_active_domains_classified: true,
        full_routing_coverage_claim_allowed: false,
      },
      counts: {
        total_known_domains: 4,
        enrolled_domains: 1,
        scheduled_domains: 1,
        excluded_domains: 1,
        pending_domains: 1,
        active_policy_domains: 2,
        desired_state_domains: 2,
      },
    });
    expect(report.domains).toHaveLength(4);
    expect(report.domains.every((entry) => /^sha256:[a-f0-9]{64}$/.test(entry.domain_sha256))).toBe(true);
    expect(JSON.stringify(report)).not.toContain("example.com");
    expect(JSON.stringify(report)).not.toContain("private-operator");
    expect(JSON.stringify(report)).not.toContain('"founder"');
    expect(report.domains.find((entry) => entry.decision === "scheduled_for_migration")?.first_blocker)
      .toEqual({ plane: "enrollment", code: "cloudflare_primary_migration_not_completed" });
    expect(report.domains.find((entry) => entry.decision === "pending_owner_decision")?.first_blocker)
      .toEqual({ plane: "enrollment", code: "owner_decision_pending" });
  });

  test("keeps the tracked schema and reserved example aligned with the executable contract", () => {
    const schema = JSON.parse(
      readFileSync(resolve(root, "config/domain-enrollment.schema.json"), "utf8"),
    ) as Record<string, any>;
    const example = JSON.parse(
      readFileSync(resolve(root, "config/domain-enrollment.example.json"), "utf8"),
    );
    expect(schema.$defs.domain_decision.oneOf.map(
      (variant: Record<string, any>) => variant.properties.decision.const,
    )).toEqual([
      "enrolled",
      "scheduled_for_migration",
      "intentionally_excluded",
      "pending_owner_decision",
    ]);
    expect(schema.$defs.registrar_custody.enum).toEqual(["cloudflare", "external", "unknown"]);
    expect(() => compileDomainEnrollment(example, {
      domains: [desiredState.domains[0]],
    }, {
      domains: { "example.com": policy.domains["example.com"] },
    })).not.toThrow();
  });

  test("requires the inventory-completeness blocker only while the universe remains open", () => {
    expect(() => compileDomainEnrollment({
      ...ledger(),
      inventory_blocker_code: undefined,
    }, desiredState, policy)).toThrow("inventory_blocker_code");

    const complete = ledger({
      inventory_complete: true,
      inventory_blocker_code: undefined,
      domains: (ledger().domains as Array<Record<string, unknown>>)
        .filter((entry) => entry.decision !== "pending_owner_decision"),
    });
    expect(() => compileDomainEnrollment(complete, desiredState, policy)).not.toThrow();
  });

  test("fails closed on duplicate, omitted, or contradictory active-domain decisions", () => {
    const entries = ledger().domains as Array<Record<string, unknown>>;
    expect(() => compileDomainEnrollment({ ...ledger(), domains: [...entries, entries[0]] }, desiredState, policy))
      .toThrow("duplicate domain");
    expect(() => compileDomainEnrollment({ ...ledger(), domains: entries.slice(1) }, desiredState, policy))
      .toThrow("active domain missing");
    expect(() => compileDomainEnrollment({
      ...ledger(),
      domains: entries.map((entry) => entry.name === "example.com"
        ? { ...entry, decision: "intentionally_excluded", reason_code: "owner_excluded_current_scope" }
        : entry),
    }, desiredState, policy)).toThrow("non-active decision");
  });

  test("enforces decision-specific closed shapes and Cloudflare-primary enrollment", () => {
    const entries = ledger().domains as Array<Record<string, unknown>>;
    expect(() => compileDomainEnrollment({
      ...ledger(),
      domains: entries.map((entry) => {
        if (entry.name !== "example.net") return entry;
        const { blocker_code: _blockerCode, ...withoutBlocker } = entry;
        return { ...withoutBlocker, decision: "enrolled" };
      }),
    }, desiredState, policy)).toThrow("cloudflare_email_routing");
    expect(() => compileDomainEnrollment({
      ...ledger(),
      domains: entries.map((entry) => entry.name === "example.org"
        ? { ...entry, reason_code: undefined }
        : entry),
    }, desiredState, policy)).toThrow("reason_code");
    expect(() => compileDomainEnrollment({
      ...ledger(),
      domains: entries.map((entry) => entry.name === "pending.example"
        ? { ...entry, unexpected: true }
        : entry),
    }, desiredState, policy)).toThrow("unexpected field");
  });
});
