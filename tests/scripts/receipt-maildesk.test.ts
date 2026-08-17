import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

describe("maildesk receipt workflow", () => {
  test("forwards ack manifest readiness into the proof plan", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-receipt-"));
    const policyPath = join(dir, "policy.json");
    const desiredPath = join(dir, "desired-state.json");
    const evidencePath = join(dir, "evidence.json");
    const manifestPath = join(dir, "plan-manifest.json");
    const receiptPath = join(dir, "receipt.json");
    const planPath = join(dir, "proof-plan.json");
    const summaryPath = join(dir, "receipt-summary.json");

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
        mode: "cloudflare_email_service",
        candidate_domains: ["tenant.example.com"],
      },
    });
    writeJson(evidencePath, {
      generated_at: "2026-07-01T00:00:00.000Z",
      active_policy: activePolicyEvidence(policyPath, desiredPath),
      cfctl_maildesk: {
        edge_ready: true,
        mail_ready: false,
        domains: {
          "tenant.example.com": {
            email_routing: "ok",
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
          status: "ok",
          from_identity: "founders@tenant.example.com",
          provider: "cloudflare_email_service",
          provider_message_id: "example-message-id",
        },
      },
    });
    writeJson(manifestPath, {
      items: [
        planManifestItem("tenant.example.com", "20260701T000000Z-00000-tenant"),
      ],
    });

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/receipt-maildesk.ts",
        "--",
        "--skip-collect",
        "--policy",
        policyPath,
        "--desired-state",
        desiredPath,
        "--evidence",
        evidencePath,
        "--plan-manifest",
        manifestPath,
        "--require-plan-ready",
        "--receipt",
        receiptPath,
        "--plan",
        planPath,
        "--summary",
        summaryPath,
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout) as {
      sender_domain_blocked_count?: number;
      sender_domain_plan_ready_count?: number;
      sender_domain_plan_missing_count?: number;
    };
    expect(summary).toMatchObject({
      summary_path: summaryPath,
      sender_domain_blocked_count: 1,
      sender_domain_plan_ready_count: 1,
      sender_domain_plan_missing_count: 0,
    });

    const writtenSummary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
      summary_path?: string;
      sender_domain_blocked_count?: number;
      sender_domain_plan_ready_count?: number;
      sender_domain_plan_missing_count?: number;
    };
    expect(writtenSummary).toMatchObject({
      summary_path: summaryPath,
      sender_domain_blocked_count: 1,
      sender_domain_plan_ready_count: 1,
      sender_domain_plan_missing_count: 0,
    });

    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      summary: {
        sender_domain_blocked_count?: number;
        sender_domain_plan_ready_count?: number;
        sender_domain_plan_missing_count?: number;
      };
      actions: Array<{ lifecycle?: Record<string, string[]>; operation_id?: string }>;
    };
    expect(plan.summary).toMatchObject({
      sender_domain_blocked_count: 1,
      sender_domain_plan_ready_count: 1,
      sender_domain_plan_missing_count: 0,
    });
    expect(plan.actions.find((action) => action.operation_id)).toMatchObject({
      operation_id: "20260701T000000Z-00000-tenant",
      lifecycle: {
        run: [
          "cfctl",
          "plans",
          "run",
          "20260701T000000Z-00000-tenant",
          "--json",
        ],
      },
    });
  });
});

function planManifestItem(target: string, operationId: string) {
  return {
    schema_version: 2,
    ok: true,
    performed: false,
    capability_id: "email-sending-subdomains-create-sending-subdomain",
    profile_id: "profile-example",
    account_id: "account-example",
    zone_id: `zone-${target}`,
    target,
    operation_id: operationId,
    plan_content_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    evidence_hashes: ["sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    plan_expires_at: "2099-01-01T00:00:00Z",
  };
}

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
