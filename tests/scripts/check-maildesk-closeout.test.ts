import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

describe("maildesk closeout gate", () => {
  test("reports protected sender-domain applies without applying them", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-closeout-"));
    const summaryPath = join(dir, "summary.json");
    const manifestPath = join(dir, "ack-manifest.json");
    const preflight = fakePreflight(0, "", "preflight ok: production\n");

    writeJson(summaryPath, {
      local_truth_ok: true,
      live_evidence_present: true,
      edge_ready: true,
      mail_ready: false,
      domain_count: 1,
      gap_count: 2,
      proof_actions: 2,
      targeted_inbound_probes: 1,
      targeted_outbound_reply_probes: 0,
      blocked_proofs: 1,
      sender_domain_blocked_count: 1,
      sender_domain_ack_ready_count: 1,
      sender_domain_ack_missing_count: 0,
    });
    writeJson(manifestPath, {
      items: [
        {
          ok: true,
          performed: false,
          target: "tenant.example.com",
          operation_id: "op-tenant",
          ack_command:
            "CF_TOKEN_LANE=global cfctl apply sender_domain enable --zone tenant.example.com --name tenant.example.com --ack-plan op-tenant",
        },
      ],
    });

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/check-maildesk-closeout.ts",
        "--",
        "--summary",
        summaryPath,
        "--ack-manifest",
        manifestPath,
        "--preflight-command",
        preflight,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    const closeout = JSON.parse(result.stdout) as {
      ready?: boolean;
      production_preflight?: { ok?: boolean };
      ack_dry_run?: { ready_count?: number; dry_run_count?: number; applied_count?: number };
      blockers?: Array<{ kind?: string; count?: number }>;
    };
    expect(closeout.ready).toBe(false);
    expect(closeout.production_preflight?.ok).toBe(true);
    expect(closeout.ack_dry_run).toMatchObject({
      ready_count: 1,
      dry_run_count: 1,
      applied_count: 0,
    });
    expect(closeout.blockers).toContainEqual({
      kind: "protected_sender_domain_apply",
      count: 1,
    });
    expect(closeout.blockers).toContainEqual({
      kind: "mail_ready_false",
      count: 2,
    });
  });

  test("surfaces production preflight failures as instance blockers", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-closeout-"));
    const summaryPath = join(dir, "summary.json");
    const preflight = fakePreflight(
      1,
      "fail: missing or placeholder environment variable: MAILDESK_API_TOKEN\n",
      "",
    );

    writeJson(summaryPath, {
      local_truth_ok: true,
      live_evidence_present: true,
      edge_ready: true,
      mail_ready: false,
      domain_count: 1,
      gap_count: 1,
      proof_actions: 1,
      targeted_inbound_probes: 1,
      targeted_outbound_reply_probes: 0,
      blocked_proofs: 0,
      sender_domain_blocked_count: 0,
      sender_domain_ack_ready_count: 0,
      sender_domain_ack_missing_count: 0,
    });

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/check-maildesk-closeout.ts",
        "--",
        "--summary",
        summaryPath,
        "--skip-ack-dry-run",
        "--preflight-command",
        preflight,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    const closeout = JSON.parse(result.stdout) as {
      production_preflight?: { ok?: boolean; failures?: string[] };
      blockers?: Array<{ kind?: string; detail?: string }>;
    };
    expect(closeout.production_preflight).toMatchObject({
      ok: false,
      failures: ["missing or placeholder environment variable: MAILDESK_API_TOKEN"],
    });
    expect(closeout.blockers).toContainEqual({
      kind: "production_preflight",
      detail: "missing or placeholder environment variable: MAILDESK_API_TOKEN",
    });
  });
});

function fakePreflight(status: number, stderr: string, stdout: string): string {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-preflight-"));
  const path = join(dir, "preflight");
  writeFileSync(
    path,
    `#!/bin/sh
cat <<'STDOUT'
${stdout}STDOUT
cat >&2 <<'STDERR'
${stderr}STDERR
exit ${status}
`,
  );
  chmodSync(path, 0o700);
  return path;
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
