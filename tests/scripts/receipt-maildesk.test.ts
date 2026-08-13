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
    const manifestPath = join(dir, "ack-manifest.json");
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
      r2_policy_sha256: fileSha256(policyPath),
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
        {
          ok: true,
          performed: false,
          target: "tenant.example.com",
          operation_id: "20260701T000000Z-00000-tenant",
          ack_command:
            "CF_TOKEN_LANE=global cfctl apply sender_domain enable --zone tenant.example.com --name tenant.example.com --ack-plan 20260701T000000Z-00000-tenant",
        },
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
        "--ack-manifest",
        manifestPath,
        "--require-ack-ready",
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
      sender_domain_ack_ready_count?: number;
      sender_domain_ack_missing_count?: number;
    };
    expect(summary).toMatchObject({
      summary_path: summaryPath,
      sender_domain_blocked_count: 1,
      sender_domain_ack_ready_count: 1,
      sender_domain_ack_missing_count: 0,
    });

    const writtenSummary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
      summary_path?: string;
      sender_domain_blocked_count?: number;
      sender_domain_ack_ready_count?: number;
      sender_domain_ack_missing_count?: number;
    };
    expect(writtenSummary).toMatchObject({
      summary_path: summaryPath,
      sender_domain_blocked_count: 1,
      sender_domain_ack_ready_count: 1,
      sender_domain_ack_missing_count: 0,
    });

    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      summary: {
        sender_domain_blocked_count?: number;
        sender_domain_ack_ready_count?: number;
        sender_domain_ack_missing_count?: number;
      };
      actions: Array<{ ack_command?: string; operation_id?: string }>;
    };
    expect(plan.summary).toMatchObject({
      sender_domain_blocked_count: 1,
      sender_domain_ack_ready_count: 1,
      sender_domain_ack_missing_count: 0,
    });
    expect(plan.actions.find((action) => action.operation_id)).toMatchObject({
      operation_id: "20260701T000000Z-00000-tenant",
      ack_command:
        "CF_TOKEN_LANE=global cfctl apply sender_domain enable --zone tenant.example.com --name tenant.example.com --ack-plan 20260701T000000Z-00000-tenant",
    });
  });
});

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function canonicalTopology() {
  return {
    workers: {
      relay_router: { script_name: "maildesk-cf-router", config: "deploy/mail-router/wrangler.toml" },
      relay_outbound: { script_name: "maildesk-cf-relay-outbound", config: "deploy/mail-outbound/wrangler.toml" },
      routing_health: { script_name: "maildesk-cf-routing-health", config: "deploy/routing-health/wrangler.toml" },
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
