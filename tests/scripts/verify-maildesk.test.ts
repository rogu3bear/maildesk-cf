import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

describe("maildesk verifier", () => {
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

  test("uses cfctl lifecycle evidence for edge readiness without hiding sender drift", () => {
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

    expect(receipt.status.edge_ready).toBe(true);
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
