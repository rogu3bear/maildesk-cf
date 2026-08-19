import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  type AccessIdentityContinuityProof,
  type CfctlReadbackAuthority,
  DARK_ACCEPTANCE_CAPABILITY_IDS,
  DARK_ACCEPTANCE_SURFACES,
  coverageDomainSha256,
  readbackAuthorizesReadiness,
} from "../../scripts/live-evidence-coverage";

const root = resolve(import.meta.dir, "../..");

describe("maildesk verifier", () => {
  test("full coverage cannot substitute arbitrary domain hashes for the desired set", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-verify-domain-binding-"));
    const desiredPath = join(dir, "desired-state.json");
    const desired = JSON.parse(
      readFileSync(resolve(root, "config/desired-state.example.json"), "utf8"),
    ) as { domains: Array<{ name: string }> };
    writeJson(desiredPath, desired);
    const domains = desired.domains.map((domain) => domain.name);
    const readback = authoritativeReadback(desiredPath, domains);
    const forged = "f".repeat(64);
    if (!readback.coverage) throw new Error("authoritative fixture lacks coverage");
    readback.coverage.selected_domain_sha256s = [forged];
    readback.coverage.observed_domain_sha256s = [forged];

    expect(readbackAuthorizesReadiness(readback, fileSha256(desiredPath), domains)).toBe(false);
  });

  test("full coverage cannot omit a required capability from every result class", () => {
    const desiredPath = resolve(root, "config/desired-state.example.json");
    const desired = JSON.parse(readFileSync(desiredPath, "utf8")) as {
      domains: Array<{ name: string }>;
    };
    const domains = desired.domains.map((domain) => domain.name);
    const readback = authoritativeReadback(desiredPath, domains);
    if (!readback.coverage) throw new Error("authoritative fixture lacks coverage");
    readback.coverage.successful_capability_ids.pop();

    expect(readbackAuthorizesReadiness(readback, fileSha256(desiredPath), domains)).toBe(false);
  });

  test("dark acceptance requires byte-exact Access identity continuity", () => {
    const desiredPath = resolve(root, "config/desired-state.example.json");
    const desired = JSON.parse(readFileSync(desiredPath, "utf8")) as {
      domains: Array<{ name: string }>;
    };
    const domains = desired.domains.map((domain) => domain.name);
    const expectedDesiredStateSha256 = fileSha256(desiredPath);

    const missingProof = authoritativeReadback(desiredPath, domains);
    if (!missingProof.coverage) throw new Error("authoritative fixture lacks coverage");
    delete missingProof.coverage.access_identity_continuity;
    expect(readbackAuthorizesReadiness(missingProof, expectedDesiredStateSha256, domains)).toBe(false);

    const mismatchedApplication = authoritativeReadback(desiredPath, domains);
    accessIdentityProof(mismatchedApplication).application_readback_app_id = "app-selector-equivalent-wrong-id";
    expect(readbackAuthorizesReadiness(mismatchedApplication, expectedDesiredStateSha256, domains)).toBe(false);

    const wrongPolicyParent = authoritativeReadback(desiredPath, domains);
    accessIdentityProof(wrongPolicyParent).policy_parent_app_id = "app-wrong-parent";
    expect(readbackAuthorizesReadiness(wrongPolicyParent, expectedDesiredStateSha256, domains)).toBe(false);

    const mismatchedPolicy = authoritativeReadback(desiredPath, domains);
    accessIdentityProof(mismatchedPolicy).policy_readback_policy_id = "policy-selector-equivalent-wrong-id";
    expect(readbackAuthorizesReadiness(mismatchedPolicy, expectedDesiredStateSha256, domains)).toBe(false);

    const missingExactPolicyRead = authoritativeReadback(desiredPath, domains);
    if (!missingExactPolicyRead.coverage) throw new Error("authoritative fixture lacks coverage");
    missingExactPolicyRead.coverage.required_capability_ids = missingExactPolicyRead.coverage.required_capability_ids
      .filter((capability) => capability !== "access-policies-get-an-access-policy");
    missingExactPolicyRead.coverage.successful_capability_ids = missingExactPolicyRead.coverage.successful_capability_ids
      .filter((capability) => capability !== "access-policies-get-an-access-policy");
    expect(readbackAuthorizesReadiness(missingExactPolicyRead, expectedDesiredStateSha256, domains)).toBe(false);
  });

  test("forged canary coverage suppresses no domain gaps", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-verify-forged-canary-"));
    const policyPath = join(dir, "policy.json");
    const desiredPath = join(dir, "desired-state.json");
    const evidencePath = join(dir, "evidence.json");
    const domains = ["selected.example.com", "unselected.example.com"];
    writeJson(policyPath, {
      domains: Object.fromEntries(domains.map((domain) => [domain, {
        role_aliases: {
          inbox: {
            operators: ["operator@example.com"],
            reply_identity: `inbox@${domain}`,
            allowed_reply_identities: [`inbox@${domain}`],
          },
        },
        personal_aliases: {},
      }])),
    });
    writeJson(desiredPath, {
      ...canonicalTopology(),
      domains: domains.map((name) => ({
        name,
        role_aliases: ["inbox"],
        personal_aliases: [],
        catch_all: false,
        inbound_mx_provider: "cloudflare_email_routing",
      })),
      sender: { mode: "disabled", candidate_domains: [] },
    });
    writeJson(evidencePath, {
      generated_at: "2026-08-18T00:00:00.000Z",
      cfctl_readback: {
        required: true,
        attempted: true,
        transaction_complete: true,
        complete: false,
        coverage: {
          mode: "canary",
          desired_state_sha256: "f".repeat(64),
          selected_domain_sha256s: [coverageDomainSha256(domains[0]!)],
        },
      },
    });

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/verify-maildesk.ts",
        "--",
        "--policy",
        policyPath,
        "--desired-state",
        desiredPath,
        "--evidence",
        evidencePath,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      gaps: Array<{ domain: string; readiness: string }>;
    };
    expect(receipt.gaps.some((gap) =>
      gap.domain === domains[1] && gap.readiness !== "local"
    )).toBe(true);
  });

  test("valid canary coverage ignores unselected domain evidence across verifier consumers", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-verify-canary-noninterference-"));
    const policyPath = join(dir, "policy.json");
    const desiredPath = join(dir, "desired-state.json");
    const baselineEvidencePath = join(dir, "baseline-evidence.json");
    const taintedEvidencePath = join(dir, "tainted-evidence.json");
    const domains = ["selected.example.com", "unselected.example.com"];
    const [selectedDomain, unselectedDomain] = domains as [string, string];
    writeJson(policyPath, {
      domains: Object.fromEntries(domains.map((domain) => [domain, {
        role_aliases: {
          inbox: {
            operators: ["operator@example.com"],
            reply_identity: `inbox@${domain}`,
            allowed_reply_identities: [`inbox@${domain}`],
          },
        },
        personal_aliases: {},
      }])),
    });
    writeJson(desiredPath, {
      ...canonicalTopology(),
      domains: domains.map((name) => ({
        name,
        role_aliases: ["inbox"],
        personal_aliases: [],
        catch_all: false,
        inbound_mx_provider: "cloudflare_email_routing",
      })),
      sender: { mode: "cloudflare_email_service", candidate_domains: domains },
    });
    const readback = canaryReadback(desiredPath, domains, [selectedDomain]);
    writeJson(baselineEvidencePath, {
      generated_at: "2026-08-18T00:00:00.000Z",
      cfctl_readback: readback,
    });
    writeJson(taintedEvidencePath, {
      generated_at: "2026-08-18T00:00:00.000Z",
      zones: [unselectedDomain],
      email_routing: {
        [unselectedDomain]: { role_aliases: ["inbox"], personal_aliases: [] },
      },
      dns_mx: {
        [unselectedDomain]: [
          "route1.mx.cloudflare.net",
          "route2.mx.cloudflare.net",
          "route3.mx.cloudflare.net",
        ],
      },
      sender_domains: { [unselectedDomain]: "verified" },
      inbound_proofs: {
        [unselectedDomain]: {
          status: "ok",
          envelope_to: `inbox@${unselectedDomain}`,
          route_kind: "role_alias",
          operator_count: 1,
          policy_sha256: fileSha256(policyPath),
          provider_message_ids: ["unselected-inbound"],
          provider_accepted_at: "2026-08-18T00:01:00.000Z",
          inbox_verified_at: "2026-08-18T00:02:00.000Z",
          default_reply_identity: `inbox@${unselectedDomain}`,
          provider: "cloudflare_email_service",
        },
      },
      outbound_proofs: {
        [unselectedDomain]: {
          status: "delivered",
          from_identity: `inbox@${unselectedDomain}`,
          provider: "cloudflare_email_service",
          provider_message_id: "unselected-outbound",
        },
      },
      cfctl_maildesk: {
        domains: {
          [unselectedDomain]: {
            email_routing: "ok",
            catch_all: "ok",
            aliases: { [`inbox@${unselectedDomain}`]: "ok" },
          },
        },
        sender_domains: { [unselectedDomain]: "ok" },
      },
      cfctl_readback: readback,
    });

    const verify = (evidencePath: string) => spawnSync(
      "bun",
      [
        "run",
        "scripts/verify-maildesk.ts",
        "--",
        "--policy",
        policyPath,
        "--desired-state",
        desiredPath,
        "--evidence",
        evidencePath,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );
    const baselineResult = verify(baselineEvidencePath);
    const taintedResult = verify(taintedEvidencePath);
    expect(baselineResult.status).toBe(0);
    expect(taintedResult.status).toBe(0);
    const baseline = JSON.parse(baselineResult.stdout) as {
      status: Record<string, boolean>;
      gaps: unknown[];
      rows: Array<Record<string, unknown> & { domain: string }>;
    };
    const tainted = JSON.parse(taintedResult.stdout) as typeof baseline;
    expect(tainted.status).toEqual(baseline.status);
    expect(tainted.gaps).toEqual(baseline.gaps);
    expect(tainted.rows).toEqual(baseline.rows);
  });

  test("the tracked canonical desired state verifies local policy without inferring edge readiness", () => {
    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/verify-maildesk.ts",
        "--",
        "--policy",
        "config/policy.example.json",
        "--desired-state",
        "config/desired-state.example.json",
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      status: { local_truth_ok: boolean; edge_ready: boolean; mail_ready: boolean };
    };
    expect(receipt.status).toEqual({
      local_truth_ok: true,
      edge_ready: false,
      mail_ready: false,
      live_evidence_present: false,
    });
  });

  test("destination-backed v2 role aliases remain consumable by the horizontal verifier", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-verify-v2-"));
    const desiredPath = join(dir, "desired.json");
    writeJson(desiredPath, {
      ...canonicalTopology(),
      domains: ["example.com", "example.net"].map((name) => ({
        name,
        role_aliases: ["security"],
        personal_aliases: [],
        catch_all: false,
        inbound_mx_provider: "cloudflare_email_routing",
      })),
      sender: { mode: "disabled", candidate_domains: [] },
    });

    const result = spawnSync("bun", [
      "run", "scripts/verify-maildesk.ts", "--",
      "--policy", "tests/fixtures/routing-policy-v2.json",
      "--desired-state", desiredPath,
      "--json",
    ], { cwd: root, encoding: "utf8" });

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      rows: Array<{ domain: string; operator_count: number }>;
    };
    expect(receipt.rows.map((row) => [row.domain, row.operator_count])).toEqual([
      ["example.com", 1],
      ["example.net", 1],
    ]);
  });

  test("policy bucket existence and a matching legacy local digest cannot stand in for active R2 readback", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-verify-"));
    const evidencePath = join(dir, "evidence.json");
    writeJson(evidencePath, {
      generated_at: "2026-07-01T00:00:00.000Z",
      r2_policy_sha256: fileSha256(resolve(root, "config/policy.example.json")),
      cfctl_maildesk: {
        storage: { r2_policy_bucket: "ok" },
      },
    });

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/verify-maildesk.ts",
        "--",
        "--policy",
        "config/policy.example.json",
        "--desired-state",
        "config/desired-state.example.json",
        "--evidence",
        evidencePath,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      status: { edge_ready: boolean };
      rows: Array<{ r2_policy: string }>;
    };
    expect(receipt.status.edge_ready).toBe(false);
    expect(receipt.rows.every((row) => row.r2_policy === "not_checked")).toBe(true);
  });

  test("partial D1 evidence cannot satisfy live evidence when governed cfctl readback is incomplete", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-verify-incomplete-readback-"));
    const evidencePath = join(dir, "evidence.json");
    writeJson(evidencePath, {
      generated_at: "2026-08-17T00:00:00.000Z",
      d1: { tables: ["runtime_state"] },
      cfctl_readback: {
        required: true,
        attempted: true,
        complete: false,
        profile_id: "profile-example",
        account_id: "account-example",
        receipts: [
          {
            capability_id: "zones-get",
            ok: false,
            performed: true,
            verification_state: "failed",
            evidence_hashes: [],
            error_code: "CFCTL_LIVE_UNAUTHORIZED",
          },
        ],
      },
    });

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/verify-maildesk.ts",
        "--",
        "--policy",
        "config/policy.example.json",
        "--desired-state",
        "config/desired-state.example.json",
        "--evidence",
        evidencePath,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      status: { live_evidence_present: boolean; edge_ready: boolean; mail_ready: boolean };
    };
    expect(receipt.status).toMatchObject({
      live_evidence_present: false,
      edge_ready: false,
      mail_ready: false,
    });
  });

  test("self-consistent remote counts cannot impersonate the selected local projection", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-verify-"));
    const evidencePath = join(dir, "evidence.json");
    const policyPath = resolve(root, "config/policy.example.json");
    const desiredPath = resolve(root, "config/desired-state.example.json");
    const activePolicy = activePolicyEvidence(policyPath, desiredPath);
    writeJson(evidencePath, {
      generated_at: "2026-07-01T00:00:00.000Z",
      active_policy: {
        ...activePolicy,
        expected_route_count: 1,
        projected_route_count: 1,
      },
    });

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/verify-maildesk.ts",
        "--",
        "--policy",
        policyPath,
        "--desired-state",
        desiredPath,
        "--evidence",
        evidencePath,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      status: { live_evidence_present: boolean; edge_ready: boolean };
      rows: Array<{ r2_policy: string }>;
    };
    expect(receipt.status.live_evidence_present).toBe(true);
    expect(receipt.status.edge_ready).toBe(false);
    expect(receipt.rows.every((row) => row.r2_policy === "drift")).toBe(true);
  });

  test("empty or partial active-policy objects do not establish live evidence", () => {
    for (const activePolicy of [
      {},
      { active_policy_sha256: "a".repeat(64) },
    ]) {
      const dir = mkdtempSync(join(tmpdir(), "maildesk-verify-active-policy-shape-"));
      const evidencePath = join(dir, "evidence.json");
      writeJson(evidencePath, {
        generated_at: "2026-08-17T00:00:00.000Z",
        active_policy: activePolicy,
      });
      const result = spawnSync(
        "bun",
        [
          "run",
          "scripts/verify-maildesk.ts",
          "--",
          "--policy",
          "config/policy.example.json",
          "--desired-state",
          "config/desired-state.example.json",
          "--evidence",
          evidencePath,
          "--json",
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      const receipt = JSON.parse(result.stdout) as {
        status: { live_evidence_present: boolean; edge_ready: boolean; mail_ready: boolean };
      };
      expect(receipt.status).toMatchObject({
        live_evidence_present: false,
        edge_ready: false,
        mail_ready: false,
      });
    }
  });

  test("empty or partial nested proof maps do not establish live evidence", () => {
    for (const proofEvidence of [
      { inbound_proofs: { "example.com": {} } },
      { outbound_proofs: { "example.com": { status: "delivered" } } },
    ]) {
      const dir = mkdtempSync(join(tmpdir(), "maildesk-verify-proof-shape-"));
      const evidencePath = join(dir, "evidence.json");
      writeJson(evidencePath, {
        generated_at: "2026-08-17T00:00:00.000Z",
        ...proofEvidence,
      });
      const result = spawnSync(
        "bun",
        [
          "run",
          "scripts/verify-maildesk.ts",
          "--",
          "--policy",
          "config/policy.example.json",
          "--desired-state",
          "config/desired-state.example.json",
          "--evidence",
          evidencePath,
          "--json",
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).status.live_evidence_present).toBe(false);
    }
  });

  test("readyz presence requires a complete typed health contract", () => {
    const cases = [
      { readyz: { checks: [{}] }, expected: false },
      { readyz: { ok: true }, expected: false },
      { readyz: { ok: false, checks: [{ name: "db_query", ok: false }] }, expected: true },
      { readyz: { ok: true, checks: [{ name: "db_query", ok: true, detail: "ready" }] }, expected: true },
    ];
    for (const { readyz, expected } of cases) {
      const dir = mkdtempSync(join(tmpdir(), "maildesk-verify-readyz-shape-"));
      const evidencePath = join(dir, "evidence.json");
      writeJson(evidencePath, { generated_at: "2026-08-17T00:00:00.000Z", readyz });
      const result = spawnSync(
        "bun",
        [
          "run",
          "scripts/verify-maildesk.ts",
          "--",
          "--policy",
          "config/policy.example.json",
          "--desired-state",
          "config/desired-state.example.json",
          "--evidence",
          evidencePath,
          "--json",
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).status.live_evidence_present).toBe(expected);
    }
  });

  test("a fully shaped mismatched inbox-relay proof is present evidence but remains drift", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-verify-proof-drift-"));
    const evidencePath = join(dir, "evidence.json");
    writeJson(evidencePath, {
      generated_at: "2026-08-17T00:00:00.000Z",
      inbound_proofs: {
        "example.com": {
          status: "ok",
          envelope_to: "founders@example.com",
          route_kind: "role_alias",
          operator_count: 2,
          policy_sha256: "b".repeat(64),
          provider_message_ids: ["provider-a", "provider-b"],
          provider_accepted_at: "2026-08-17T00:00:00.000Z",
          inbox_verified_at: "2026-08-17T00:01:00.000Z",
          default_reply_identity: "founders@example.com",
          provider: "cloudflare_email_service",
        },
      },
    });
    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/verify-maildesk.ts",
        "--",
        "--policy",
        "config/policy.example.json",
        "--desired-state",
        "config/desired-state.example.json",
        "--evidence",
        evidencePath,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      status: { live_evidence_present: boolean };
      rows: Array<{ inbound_proof: string }>;
    };
    expect(receipt.status.live_evidence_present).toBe(true);
    expect(receipt.rows[0]?.inbound_proof).toBe("drift");
  });

  test("legacy complete evidence cannot authorize edge readiness", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-verify-"));
    const policyPath = join(dir, "policy.json");
    const desiredPath = join(dir, "desired-state.json");
    const evidencePath = join(dir, "evidence.json");

    writeJson(policyPath, {
      domains: {
        "example.com": {
          role_aliases: {
            founders: {
              operators: ["operator@example.com"],
              reply_identity: "founders@example.com",
              allowed_reply_identities: ["founders@example.com"],
            },
          },
          personal_aliases: {},
        },
      },
    });
    writeJson(desiredPath, {
      ...canonicalTopology(),
      domains: [
        {
          name: "example.com",
          role_aliases: ["founders"],
          personal_aliases: [],
          inbound_mx_provider: "cloudflare_email_routing",
        },
      ],
      sender: {
        mode: "cloudflare_email_service",
        candidate_domains: ["example.com"],
      },
    });
    writeJson(evidencePath, {
      generated_at: "2026-07-01T00:00:00.000Z",
      cfctl_readback: {
        required: true,
        attempted: true,
        complete: true,
      },
      active_policy: activePolicyEvidence(policyPath, desiredPath),
      cfctl_maildesk: {
        edge_ready: true,
        mail_ready: false,
        domains: {
          "example.com": {
            email_routing: "ok",
            catch_all: "ok",
            aliases: {
              "founders@example.com": "ok",
            },
          },
        },
        workers: {
          relay_router: "ok",
          relay_outbound: "ok",
          routing_health: "ok",
        },
        storage: {
          d1_database: "ok",
          queue: "ok",
          dead_letter_queue: "ok",
          r2_policy_bucket: "ok",
          r2_spool_bucket: "ok",
        },
        sender_domains: {
          "example.com": "missing",
        },
      },
      inbound_proofs: {
        "example.com": {
          status: "ok",
          envelope_to: "founders@example.com",
          route_kind: "role_alias",
          operator_count: 1,
          policy_sha256: fileSha256(policyPath),
          provider_message_ids: ["provider-inbound-example"],
          provider_accepted_at: "2026-07-01T00:00:00.000Z",
          inbox_verified_at: "2026-07-01T00:01:00.000Z",
          default_reply_identity: "founders@example.com",
        },
      },
    });

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/verify-maildesk.ts",
        "--",
        "--policy",
        policyPath,
        "--desired-state",
        desiredPath,
        "--evidence",
        evidencePath,
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      status: { edge_ready: boolean; mail_ready: boolean };
      gaps: Array<{ readiness: string; field: string; status: string }>;
      rows: Array<{ outbound_sender: string }>;
    };

    expect(receipt.status.edge_ready).toBe(false);
    expect(receipt.status.mail_ready).toBe(false);
    expect(receipt.gaps.filter((gap) => gap.readiness === "edge")).toHaveLength(0);
    expect(receipt.gaps).toContainEqual({
      domain: "example.com",
      field: "outbound_sender",
      status: "missing",
      readiness: "mail",
      detail: "sender provider status is missing",
    });
    expect(receipt.rows[0]?.outbound_sender).toBe("missing");
  });

  test("treats disabled sender mode as an intentional no-provider contract", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-verify-"));
    const policyPath = join(dir, "policy.json");
    const desiredPath = join(dir, "desired-state.json");
    const evidencePath = join(dir, "evidence.json");

    writeJson(policyPath, {
      domains: {
        "tenant.example.com": {
          role_aliases: {
            founders: {
              operators: ["operator@tenant.example.com"],
              reply_identity: "founders@tenant.example.com",
              allowed_reply_identities: ["founders@tenant.example.com"],
            },
          },
          personal_aliases: {},
        },
      },
    });
    writeJson(desiredPath, {
      ...canonicalTopology(),
      domains: [
        {
          name: "tenant.example.com",
          role_aliases: ["founders"],
          personal_aliases: [],
          inbound_mx_provider: "cloudflare_email_routing",
        },
      ],
      sender: {
        mode: "disabled",
        candidate_domains: [],
      },
    });
    writeJson(evidencePath, {
      generated_at: "2026-07-01T00:00:00.000Z",
      cfctl_readback: authoritativeReadback(desiredPath, ["tenant.example.com"]),
      active_policy: activePolicyEvidence(policyPath, desiredPath),
      cfctl_maildesk: {
        edge_ready: true,
        mail_ready: true,
        domains: {
          "tenant.example.com": {
            email_routing: "ok",
            catch_all: "ok",
            aliases: {
              "founders@tenant.example.com": "ok",
            },
          },
        },
        workers: {
          relay_router: "ok",
          relay_outbound: "ok",
          routing_health: "ok",
        },
        storage: {
          d1_database: "ok",
          queue: "ok",
          dead_letter_queue: "ok",
          r2_policy_bucket: "ok",
          r2_spool_bucket: "ok",
        },
      },
      inbound_proofs: {
        "tenant.example.com": {
          status: "ok",
          envelope_to: "founders@tenant.example.com",
          route_kind: "role_alias",
          operator_count: 1,
          policy_sha256: fileSha256(policyPath),
          provider_message_ids: ["provider-inbound-tenant"],
          provider_accepted_at: "2026-07-01T00:00:00.000Z",
          inbox_verified_at: "2026-07-01T00:01:00.000Z",
          default_reply_identity: "founders@tenant.example.com",
        },
      },
    });

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/verify-maildesk.ts",
        "--",
        "--policy",
        policyPath,
        "--desired-state",
        desiredPath,
        "--evidence",
        evidencePath,
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      status: { mail_ready: boolean };
      gaps: Array<{ readiness: string; field: string; status: string }>;
      rows: Array<{
        outbound_sender: string;
        outbound_proof: string;
        sender_domain: { provider: string; provider_status: string };
      }>;
    };

    expect(receipt.status.mail_ready).toBe(true);
    expect(receipt.gaps.filter((gap) => gap.readiness === "mail")).toHaveLength(0);
    expect(receipt.rows[0]?.sender_domain).toMatchObject({
      provider: "disabled",
      provider_status: "disabled",
    });
    expect(receipt.rows[0]?.outbound_sender).toBe("ok");
    expect(receipt.rows[0]?.outbound_proof).toBe("ok");

    const inventoryEvidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
      cfctl_readback: CfctlReadbackAuthority;
    };
    inventoryEvidence.cfctl_readback = inventoryReadback(desiredPath, ["tenant.example.com"]);
    writeJson(evidencePath, inventoryEvidence);
    const requireLive = spawnSync(
      "bun",
      [
        "run",
        "scripts/verify-maildesk.ts",
        "--",
        "--policy",
        policyPath,
        "--desired-state",
        desiredPath,
        "--evidence",
        evidencePath,
        "--require-live",
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(requireLive.status).toBe(1);
    const inventoryReceipt = JSON.parse(requireLive.stdout) as {
      status: { mail_ready: boolean };
      gaps: unknown[];
    };
    expect(inventoryReceipt.status.mail_ready).toBe(false);
    expect(inventoryReceipt.gaps).toHaveLength(0);
  });

  test("uses Resend sender-domain readback only for resend mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-verify-"));
    const policyPath = join(dir, "policy.json");
    const desiredPath = join(dir, "desired-state.json");
    const evidencePath = join(dir, "evidence.json");

    writeJson(policyPath, {
      domains: {
        "tenant.example.com": {
          role_aliases: {
            founders: {
              operators: ["operator@tenant.example.com"],
              reply_identity: "founders@tenant.example.com",
              allowed_reply_identities: ["founders@tenant.example.com"],
            },
          },
          personal_aliases: {},
        },
      },
    });
    writeJson(desiredPath, {
      ...canonicalTopology(),
      domains: [
        {
          name: "tenant.example.com",
          role_aliases: ["founders"],
          personal_aliases: [],
          inbound_mx_provider: "cloudflare_email_routing",
        },
      ],
      sender: {
        mode: "resend",
        candidate_domains: ["tenant.example.com"],
      },
    });
    writeJson(evidencePath, {
      generated_at: "2026-07-01T00:00:00.000Z",
      cfctl_readback: authoritativeReadback(desiredPath, ["tenant.example.com"]),
      active_policy: activePolicyEvidence(policyPath, desiredPath),
      cfctl_maildesk: {
        edge_ready: true,
        mail_ready: true,
        domains: {
          "tenant.example.com": {
            email_routing: "ok",
            catch_all: "ok",
            aliases: {
              "founders@tenant.example.com": "ok",
            },
          },
        },
        workers: {
          relay_router: "ok",
          relay_outbound: "ok",
          routing_health: "ok",
        },
        storage: {
          d1_database: "ok",
          queue: "ok",
          dead_letter_queue: "ok",
          r2_policy_bucket: "ok",
          r2_spool_bucket: "ok",
        },
        sender_domains: {
          "tenant.example.com": "missing",
        },
      },
      sender_domains: {
        "tenant.example.com": "verified",
      },
      inbound_proofs: {
        "tenant.example.com": {
          status: "ok",
          envelope_to: "founders@tenant.example.com",
          route_kind: "role_alias",
          operator_count: 1,
          policy_sha256: fileSha256(policyPath),
          provider_message_ids: ["provider-inbound-tenant"],
          provider_accepted_at: "2026-07-01T00:00:00.000Z",
          inbox_verified_at: "2026-07-01T00:01:00.000Z",
          default_reply_identity: "founders@tenant.example.com",
        },
      },
      outbound_proofs: {
        "tenant.example.com": {
          status: "delivered",
          from_identity: "founders@tenant.example.com",
          provider: "resend",
          provider_message_id: "resend-message-id",
        },
      },
    });

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/verify-maildesk.ts",
        "--",
        "--policy",
        policyPath,
        "--desired-state",
        desiredPath,
        "--evidence",
        evidencePath,
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      status: { mail_ready: boolean };
      rows: Array<{ outbound_sender: string; outbound_proof: string; sender_domain: { provider: string } }>;
    };

    expect(receipt.status.mail_ready).toBe(true);
    expect(receipt.rows[0]).toMatchObject({
      outbound_sender: "ok",
      outbound_proof: "ok",
      sender_domain: { provider: "resend" },
    });
  });
});

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function activePolicyEvidence(policyPath: string, desiredPath: string) {
  const digest = fileSha256(policyPath);
  const key = `config/policy/${digest}.json`;
  const projection = projectionSummary(policyPath, desiredPath);
  return {
    active_policy_sha256: digest,
    active_policy_r2_key: key,
    revision_r2_key: key,
    object_key: key,
    object_sha256: digest,
    projection_policy_sha256: digest,
    expected_domain_count: projection.domains,
    expected_route_count: projection.routes,
    projected_domain_count: projection.domains,
    projected_route_count: projection.routes,
    active_desired_state_sha256: projection.desired_state_sha256,
    active_projection_sha256: projection.projection_sha256,
  };
}

function authoritativeReadback(desiredPath: string, domains: string[]): CfctlReadbackAuthority {
  const desiredStateSha256 = fileSha256(desiredPath);
  const domainHashes = domains.map(coverageDomainSha256).sort();
  const capabilities = [...DARK_ACCEPTANCE_CAPABILITY_IDS].sort();
  const surfaces = [...DARK_ACCEPTANCE_SURFACES];
  const readback: CfctlReadbackAuthority = {
    required: true,
    attempted: true,
    transaction_complete: true,
    complete: true,
    coverage: {
      mode: "full_desired_state",
      profile: "dark_acceptance_v1",
      desired_state_sha256: desiredStateSha256,
      expected_domain_count: domains.length,
      selected_domain_count: domains.length,
      observed_domain_count: domains.length,
      selected_domain_sha256s: domainHashes,
      observed_domain_sha256s: domainHashes,
      required_capability_ids: capabilities,
      successful_capability_ids: capabilities,
      failed_capability_ids: [],
      missing_capability_ids: [],
      required_acceptance_surfaces: surfaces,
      successful_acceptance_surfaces: surfaces,
      missing_acceptance_surfaces: [],
      selected_scope_complete: true,
      desired_scope_complete: true,
      acceptance_complete: true,
      blockers: [],
    },
  };
  if (!readback.coverage) throw new Error("authoritative fixture lacks coverage");
  readback.coverage.access_identity_continuity = {
    retained_app_id: "app-owned-routing-health",
    application_readback_app_id: "app-owned-routing-health",
    retained_policy_id: "policy-owned-operators",
    policy_parent_app_id: "app-owned-routing-health",
    policy_readback_app_id: "app-owned-routing-health",
    policy_readback_policy_id: "policy-owned-operators",
  };
  return readback;
}

function accessIdentityProof(readback: CfctlReadbackAuthority): AccessIdentityContinuityProof {
  if (!readback.coverage) throw new Error("authoritative fixture lacks coverage");
  const proof = readback.coverage.access_identity_continuity;
  if (!proof) {
    throw new Error("authoritative fixture lacks Access identity proof");
  }
  return proof;
}

function inventoryReadback(desiredPath: string, domains: string[]): CfctlReadbackAuthority {
  const desiredStateSha256 = fileSha256(desiredPath);
  const domainHashes = domains.map(coverageDomainSha256).sort();
  return {
    required: true,
    attempted: true,
    transaction_complete: true,
    complete: false,
    coverage: {
      mode: "full_desired_state",
      profile: "inventory_v1",
      desired_state_sha256: desiredStateSha256,
      expected_domain_count: domains.length,
      selected_domain_count: domains.length,
      observed_domain_count: domains.length,
      selected_domain_sha256s: domainHashes,
      observed_domain_sha256s: domainHashes,
      required_capability_ids: [],
      successful_capability_ids: [],
      failed_capability_ids: [],
      missing_capability_ids: [],
      required_acceptance_surfaces: [],
      successful_acceptance_surfaces: [],
      missing_acceptance_surfaces: [],
      selected_scope_complete: true,
      desired_scope_complete: true,
      acceptance_complete: false,
      blockers: [{ code: "ACCEPTANCE_PROFILE_INVENTORY_ONLY" }],
    },
  };
}

function canaryReadback(
  desiredPath: string,
  domains: string[],
  selectedDomains: string[],
): CfctlReadbackAuthority {
  const selectedHashes = selectedDomains.map(coverageDomainSha256).sort();
  return {
    required: true,
    attempted: true,
    transaction_complete: true,
    complete: false,
    coverage: {
      mode: "canary",
      profile: "inventory_v1",
      desired_state_sha256: fileSha256(desiredPath),
      scope_manifest_sha256: "c".repeat(64),
      expected_domain_count: domains.length,
      selected_domain_count: selectedDomains.length,
      observed_domain_count: selectedDomains.length,
      selected_domain_sha256s: selectedHashes,
      observed_domain_sha256s: selectedHashes,
      required_capability_ids: [],
      successful_capability_ids: [],
      failed_capability_ids: [],
      missing_capability_ids: [],
      required_acceptance_surfaces: [],
      successful_acceptance_surfaces: [],
      missing_acceptance_surfaces: [],
      selected_scope_complete: true,
      desired_scope_complete: false,
      acceptance_complete: false,
      blockers: [
        { code: "PARTIAL_DESIRED_SCOPE" },
        { code: "ACCEPTANCE_PROFILE_INVENTORY_ONLY" },
      ],
    },
  };
}

function projectionSummary(policyPath: string, desiredPath: string) {
  const result = spawnSync(
    "bun",
    ["run", "scripts/sync-route-policy.ts", "--", "--policy", policyPath, "--desired-state", desiredPath],
    { cwd: root, encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as {
    domains: number;
    routes: number;
    desired_state_sha256: string;
    projection_sha256: string;
  };
}

function canonicalTopology() {
  return {
    workers: {
      relay_router: { script_name: "maildesk-cf-router", config: "wrangler.mail-router.toml" },
      relay_outbound: { script_name: "maildesk-cf-relay-outbound", config: "wrangler.mail-outbound.toml" },
      routing_health: { script_name: "maildesk-cf-routing-health", config: "wrangler.routing-health.toml" },
    },
    storage: {
      d1_database: "maildesk-cf-relay-db",
      r2_policy_bucket: "maildesk-cf-policy",
      r2_spool_bucket: "maildesk-cf-relay-spool",
      queue: "maildesk-cf-relay-jobs",
      dead_letter_queue: "maildesk-cf-relay-dlq",
    },
  };
}
