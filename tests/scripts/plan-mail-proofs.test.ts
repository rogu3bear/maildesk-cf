import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

describe("mail proof planner", () => {
  test("blocks live probes for reserved template domains", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-plan-"));
    const receiptPath = join(dir, "receipt.json");
    writeFileSync(
      receiptPath,
      `${JSON.stringify(
        {
          rows: [
            {
              domain: "example.com",
              inbound_mx: "not_checked",
              inbound_mx_provider: "cloudflare_email_routing",
              inbound_proof: "not_checked",
              outbound_sender: "missing",
              outbound_proof: "not_checked",
            },
          ],
          gaps: [
            {
              domain: "example.com",
              field: "inbound_proof",
              status: "not_checked",
              readiness: "mail",
            },
            {
              domain: "example.com",
              field: "outbound_sender",
              status: "missing",
              readiness: "mail",
            },
            {
              domain: "example.com",
              field: "outbound_proof",
              status: "not_checked",
              readiness: "mail",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const result = spawnSync(
      "bun",
      ["run", "scripts/plan-mail-proofs.ts", "--", "--receipt", receiptPath, "--json"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout) as {
      actions: Array<{ kind: string; blocked_by?: string; description: string }>;
    };
    expect(plan.actions).toHaveLength(3);
    expect(plan.actions.every((action) => action.kind === "blocked")).toBe(true);
    expect(plan.actions.every((action) => action.blocked_by === "template_desired_state")).toBe(true);
    expect(plan.actions.every((action) => action.description.includes("config/desired-state.local.json"))).toBe(true);
  });

  test("includes cfctl sender-domain repair commands for real domains", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-plan-"));
    const receiptPath = join(dir, "receipt.json");
    const policyPath = join(dir, "policy.json");
    writeFileSync(
      receiptPath,
      `${JSON.stringify(
        {
          rows: [
            {
              domain: "tenant.example.com",
              inbound_mx: "ok",
              inbound_mx_provider: "cloudflare_email_routing",
              inbound_proof: "ok",
              outbound_sender: "missing",
              outbound_proof: "not_checked",
            },
          ],
          gaps: [
            {
              domain: "tenant.example.com",
              field: "outbound_sender",
              status: "missing",
              readiness: "mail",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      policyPath,
      `${JSON.stringify(
        {
          domains: {
            "tenant.example.com": {
              role_aliases: {
                founders: {
                  operators: ["operator@tenant.example.com"],
                  reply_identity: "founders@tenant.example.com",
                },
              },
              personal_aliases: {},
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/plan-mail-proofs.ts",
        "--",
        "--receipt",
        receiptPath,
        "--policy",
        policyPath,
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout) as {
      actions: Array<{
        kind: string;
        blocked_by?: string;
        preview_command?: string;
        ack_command_template?: string;
        verify_command?: string;
      }>;
    };
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      kind: "blocked",
      blocked_by: "sender_domain_not_verified",
      preview_command:
        "CF_TOKEN_LANE=global cfctl apply sender_domain enable --zone tenant.example.com --name tenant.example.com --plan",
      ack_command_template:
        "CF_TOKEN_LANE=global cfctl apply sender_domain enable --zone tenant.example.com --name tenant.example.com --ack-plan <operation-id>",
      verify_command: "cfctl maildesk-cf verify --file config/desired-state.local.json",
    });
  });
});
