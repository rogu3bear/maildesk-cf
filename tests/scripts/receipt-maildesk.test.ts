import { describe, expect, test } from "bun:test";
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
        authenticated_domains: ["tenant.example.com"],
      },
    });
    writeJson(evidencePath, {
      generated_at: "2026-07-01T00:00:00.000Z",
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
          mail_api: "ok",
          mail_router: "ok",
        },
        storage: {
          d1_database: "ok",
          queue: "ok",
          r2_raw_mail_bucket: "ok",
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
          forwarded_to: ["operator@tenant.example.com"],
          forward_errors: [],
          default_reply_identity: "founders@tenant.example.com",
          raw_r2_key: "raw/example",
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
    expect(plan.actions[0]).toMatchObject({
      operation_id: "20260701T000000Z-00000-tenant",
      ack_command:
        "CF_TOKEN_LANE=global cfctl apply sender_domain enable --zone tenant.example.com --name tenant.example.com --ack-plan 20260701T000000Z-00000-tenant",
    });
  });
});

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
