import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      [
        "run",
        "scripts/plan-mail-proofs.ts",
        "--",
        "--receipt",
        receiptPath,
        "--policy",
        "config/policy.example.json",
        "--json",
      ],
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
        plan_request?: unknown;
        verify_request?: unknown;
        verify_command?: string;
      }>;
    };
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      kind: "blocked",
      blocked_by: "sender_domain_not_verified",
      plan_request: {
        schema_version: 2,
        capability_id: "email-sending-subdomains-create-sending-subdomain",
        target: {
          zone_name: "tenant.example.com",
          sending_subdomain_name: "tenant.example.com",
        },
        profile_binding: "explicit",
        account_binding: "profile_account",
        zone_binding: { capability_id: "zones-get", exact_name: "tenant.example.com" },
        body: { name: "tenant.example.com" },
      },
      verify_request: {
        schema_version: 2,
        capability_id: "email-sending-subdomains-list-sending-subdomains",
        target: {
          zone_name: "tenant.example.com",
          sending_subdomain_name: "tenant.example.com",
        },
        profile_binding: "explicit",
        account_binding: "profile_account",
      },
    });
  });

  test("uses Resend repair blockers without Cloudflare ack commands", () => {
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
              sender_domain: {
                provider: "resend",
              },
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
      summary: {
        sender_domain_blocked_count?: number;
        sender_domain_plan_missing_count?: number;
      };
      actions: Array<{
        kind: string;
        blocked_by?: string;
        plan_request?: unknown;
        verify_request?: unknown;
        verify_command?: string;
      }>;
    };

    expect(plan.summary).toMatchObject({
      sender_domain_blocked_count: 0,
      sender_domain_plan_missing_count: 0,
    });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      kind: "blocked",
      blocked_by: "resend_sender_domain_not_verified",
      verify_command: "resend domains list --json --limit 100",
    });
    expect(plan.actions[0]?.plan_request).toBeUndefined();
    expect(plan.actions[0]?.verify_request).toBeUndefined();
  });

  test("treats an absent optional plan manifest as no prepared plans", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-plan-missing-manifest-"));
    const receiptPath = join(dir, "receipt.json");
    const policyPath = join(dir, "policy.json");
    const manifestPath = join(dir, "not-created-plan-manifest.json");
    writeFileSync(
      receiptPath,
      `${JSON.stringify({
        rows: [{
          domain: "tenant.example.com",
          inbound_mx: "ok",
          inbound_mx_provider: "cloudflare_email_routing",
          inbound_proof: "ok",
          outbound_sender: "missing",
          outbound_proof: "not_checked",
        }],
        gaps: [{
          domain: "tenant.example.com",
          field: "outbound_sender",
          status: "missing",
          readiness: "mail",
        }],
      }, null, 2)}\n`,
    );
    writeFileSync(
      policyPath,
      `${JSON.stringify({
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
      }, null, 2)}\n`,
    );

    const run = (extraArgs: string[] = [], selectedManifest = manifestPath) => spawnSync(
      "bun",
      [
        "run",
        "scripts/plan-mail-proofs.ts",
        "--",
        "--receipt",
        receiptPath,
        "--policy",
        policyPath,
        "--plan-manifest",
        selectedManifest,
        ...extraArgs,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );

    const optional = run();
    expect(optional.status).toBe(0);
    const plan = JSON.parse(optional.stdout) as {
      summary: {
        sender_domain_blocked_count?: number;
        sender_domain_plan_ready_count?: number;
        sender_domain_plan_missing_count?: number;
      };
      actions: Array<{ operation_id?: string; lifecycle?: unknown }>;
    };
    expect(plan.summary).toMatchObject({
      sender_domain_blocked_count: 1,
      sender_domain_plan_ready_count: 0,
      sender_domain_plan_missing_count: 1,
    });
    expect(plan.actions[0]?.operation_id).toBeUndefined();
    expect(plan.actions[0]?.lifecycle).toBeUndefined();

    const required = run(["--require-plan-ready"]);
    expect(required.status).toBe(1);
    expect(JSON.parse(required.stdout).summary).toMatchObject(plan.summary);
    expect(required.stderr).toContain("sender-domain PlanV2 operations are not ready");

    const missingValue = spawnSync(
      "bun",
      [
        "run",
        "scripts/plan-mail-proofs.ts",
        "--",
        "--receipt",
        receiptPath,
        "--policy",
        policyPath,
        "--plan-manifest",
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(missingValue.status).toBe(1);
    expect(missingValue.stdout).toBe("");
    expect(missingValue.stderr).toContain("missing --plan-manifest <path>");

    writeFileSync(manifestPath, "{ malformed\n");
    const malformed = run();
    expect(malformed.status).toBe(1);
    expect(malformed.stdout).toBe("");

    const directoryManifestPath = join(dir, "manifest-directory");
    mkdirSync(directoryManifestPath);
    const directory = run([], directoryManifestPath);
    expect(directory.status).toBe(1);
    expect(directory.stdout).toBe("");
  });

  test("fills the exact PlanV2 lifecycle from a prepared plan manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-plan-"));
    const receiptPath = join(dir, "receipt.json");
    const policyPath = join(dir, "policy.json");
    const manifestPath = join(dir, "plan-manifest.json");
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
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          items: [
            {
              schema_version: 2,
              ok: true,
              performed: false,
              capability_id: "email-sending-subdomains-create-sending-subdomain",
              profile_id: "profile-example",
              account_id: "account-example",
              zone_id: "zone-example",
              target: "tenant.example.com",
              operation_id: "20260701T000000Z-00000-tenant",
              plan_content_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
              evidence_hashes: ["sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
            },
          ],
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
        "--plan-manifest",
        manifestPath,
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
        lifecycle?: Record<string, string[]>;
        operation_id?: string;
      }>;
    };
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      kind: "blocked",
      blocked_by: "sender_domain_not_verified",
      operation_id: "20260701T000000Z-00000-tenant",
      lifecycle: {
        show: ["cfctl", "plans", "show", "20260701T000000Z-00000-tenant", "--json"],
        approve: ["cfctl", "plans", "approve", "20260701T000000Z-00000-tenant", "--yes", "--json"],
        run: ["cfctl", "plans", "run", "20260701T000000Z-00000-tenant", "--json"],
        status: ["cfctl", "plans", "status", "20260701T000000Z-00000-tenant", "--json"],
      },
    });
  });

  test("matches a prepared subdomain plan independently of its zone identifier", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-plan-"));
    const receiptPath = join(dir, "receipt.json");
    const policyPath = join(dir, "policy.json");
    const manifestPath = join(dir, "plan-manifest.json");
    writeFileSync(
      receiptPath,
      `${JSON.stringify(
        {
          rows: [
            {
              domain: "mail.tenant.example.com",
              inbound_mx: "ok",
              inbound_mx_provider: "cloudflare_email_routing",
              inbound_proof: "ok",
              outbound_sender: "missing",
              outbound_proof: "not_checked",
            },
          ],
          gaps: [
            {
              domain: "mail.tenant.example.com",
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
            "mail.tenant.example.com": {
              role_aliases: {
                founders: {
                  operators: ["operator@mail.tenant.example.com"],
                  reply_identity: "founders@mail.tenant.example.com",
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
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          items: [
            {
              schema_version: 2,
              ok: true,
              performed: false,
              capability_id: "email-sending-subdomains-create-sending-subdomain",
              profile_id: "profile-example",
              account_id: "account-example",
              zone_id: "zone-example",
              target: "mail.tenant.example.com",
              operation_id: "20260701T000000Z-00000-subdomain",
              plan_content_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
              evidence_hashes: ["sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
            },
          ],
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
        "--plan-manifest",
        manifestPath,
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
        lifecycle?: Record<string, string[]>;
        operation_id?: string;
      }>;
    };
    expect(plan.actions[0]).toMatchObject({
      operation_id: "20260701T000000Z-00000-subdomain",
      lifecycle: {
        run: ["cfctl", "plans", "run", "20260701T000000Z-00000-subdomain", "--json"],
      },
    });
  });

  test("require plan ready fails when sender-domain blockers lack exact PlanV2 operations", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-plan-"));
    const receiptPath = join(dir, "receipt.json");
    const policyPath = join(dir, "policy.json");
    const manifestPath = join(dir, "invalid-plan-manifest.json");
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
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        items: [{
          capability_id: "email-sending-subdomains-create-sending-subdomain",
          profile_id: "profile-example",
          account_id: "account-example",
          zone_id: "zone-example",
          target: "tenant.example.com",
          operation_id: "operation-example",
          plan_content_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          evidence_hashes: ["sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
        }],
      }, null, 2)}\n`,
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
        "--plan-manifest",
        manifestPath,
        "--require-plan-ready",
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    const plan = JSON.parse(result.stdout) as {
      summary: {
        sender_domain_blocked_count?: number;
        sender_domain_plan_ready_count?: number;
        sender_domain_plan_missing_count?: number;
      };
    };
    expect(plan.summary).toMatchObject({
      sender_domain_blocked_count: 1,
      sender_domain_plan_ready_count: 0,
      sender_domain_plan_missing_count: 1,
    });
    expect(result.stderr).toContain("sender-domain PlanV2 operations are not ready");
  });
});

test("proof planner separates delivery-only inbound from Rust-selected reply identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-proof-delivery-only-"));
  const policyPath = join(dir, "policy.json"), receiptPath = join(dir, "receipt.json");
  const domain = "tenant.example.com";
  const policy = { policy_version: 3, default_reply_mode: "personal_first", domains: { [domain]: {
    role_aliases: { abuse: { operators: [`alice@${domain}`], reply_identity: `abuse@${domain}`, delivery_only: true },
      support: { operators: [`alice@${domain}`], reply_identity: `support@${domain}` } },
    personal_aliases: { alice: { operator: `alice@${domain}`, reply_identity: `alice@${domain}` } },
  } } };
  writeFileSync(policyPath, JSON.stringify(policy));
  writeFileSync(receiptPath, JSON.stringify({ status: { delivery_cleanup: "not_applicable" }, rows: [{ domain, inbound_mx: "ok", inbound_mx_provider: "cloudflare_email_routing", inbound_proof: "ok", outbound_sender: "ok", outbound_proof: "not_checked" }],
    gaps: [{ domain, field: "inbound_proof", status: "not_checked", readiness: "mail" }, { domain, field: "outbound_proof", status: "not_checked", readiness: "mail" }] }));
  const run = () => spawnSync("bun", ["run", "scripts/plan-mail-proofs.ts", "--", "--receipt", receiptPath, "--policy", policyPath, "--json"], { cwd: root, encoding: "utf8" });
  try {
    let result = run(); expect(result.status).toBe(0);
    let plan = JSON.parse(result.stdout) as { actions: Array<Record<string, string>> };
    expect(plan.actions).toContainEqual(expect.objectContaining({ kind: "targeted_inbound_probe", target: `abuse@${domain}` }));
    expect(plan.actions).toContainEqual(expect.objectContaining({ kind: "blocked", blocked_by: "delivery_cleanup_unqualified" }));
    expect(plan.actions).toContainEqual(expect.objectContaining({ kind: "targeted_outbound_reply_probe", from_identity: `alice@${domain}` }));
    policy.domains[domain].role_aliases.support.operators.push(`bob@${domain}`);
    (policy.domains[domain].personal_aliases as Record<string, { operator: string; reply_identity: string }>).bob = { operator: `bob@${domain}`, reply_identity: `bob@${domain}` };
    writeFileSync(policyPath, JSON.stringify(policy));
    result = run(); expect(result.status).toBe(0);
    plan = JSON.parse(result.stdout) as { actions: Array<Record<string, string>> };
    expect(plan.actions.some((action) => action.kind === "targeted_outbound_reply_probe")).toBe(false);
    expect(plan.actions).toContainEqual(expect.objectContaining({ kind: "blocked", blocked_by: "reply_identity_unavailable" }));
    writeFileSync(policyPath, JSON.stringify({ policy_version: 3, default_reply_mode: "role_first", domains: { [domain]: { role_aliases: { abuse: policy.domains[domain].role_aliases.abuse }, personal_aliases: {} } } }));
    result = run(); expect(result.status).toBe(0);
    plan = JSON.parse(result.stdout) as { actions: Array<Record<string, string>> };
    expect(plan.actions.some((action) => action.kind === "targeted_outbound_reply_probe")).toBe(false);
    expect(plan.actions).toContainEqual(expect.objectContaining({ kind: "blocked", blocked_by: "reply_identity_unavailable" }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
