import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

  test("redacts sensitive ack dry-run details from JSON output", () => {
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
      gap_count: 1,
      proof_actions: 1,
      targeted_inbound_probes: 0,
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
        "--redact-sensitive",
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("tenant.example.com");
    expect(result.stdout).not.toContain("ack_command");
    expect(result.stdout).not.toContain("--ack-plan");
    const closeout = JSON.parse(result.stdout) as {
      sensitive_redacted?: boolean;
      ack_dry_run?: { ready_count?: number; dry_run_count?: number; applied_count?: number; result_count?: number };
    };
    expect(closeout.sensitive_redacted).toBe(true);
    expect(closeout.ack_dry_run).toMatchObject({
      ready_count: 1,
      dry_run_count: 1,
      applied_count: 0,
      result_count: 1,
    });
  });

  test("refreshes ack manifest before closeout dry-run when requested", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-closeout-"));
    const summaryPath = join(dir, "summary.json");
    const manifestPath = join(dir, "ack-manifest.json");
    const refreshLogPath = join(dir, "refresh.log");
    const preflight = fakePreflight(0, "", "preflight ok: production\n");
    const refresh = fakeAckRefresh(manifestPath, refreshLogPath);

    writeJson(summaryPath, {
      local_truth_ok: true,
      live_evidence_present: true,
      edge_ready: true,
      mail_ready: false,
      domain_count: 1,
      gap_count: 1,
      proof_actions: 1,
      targeted_inbound_probes: 0,
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
          operation_id: "old-op",
          preview_expires_at: "2000-01-01T00:00:00.000Z",
          ack_command:
            "CF_TOKEN_LANE=global cfctl apply sender_domain enable --zone tenant.example.com --name tenant.example.com --ack-plan old-op",
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
        "--refresh-acks",
        "--refresh-ack-command",
        refresh,
        "--preflight-command",
        preflight,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(readFileSync(refreshLogPath, "utf8")).toContain(`--out ${manifestPath}`);
    const closeout = JSON.parse(result.stdout) as {
      ack_refresh?: { ok?: boolean; ack_ready_count?: number };
      ack_dry_run?: { ready_count?: number; dry_run_count?: number; applied_count?: number };
      blockers?: Array<{ kind?: string; count?: number }>;
    };
    expect(closeout.ack_refresh).toMatchObject({
      ok: true,
      ack_ready_count: 1,
    });
    expect(closeout.ack_dry_run).toMatchObject({
      ready_count: 1,
      dry_run_count: 1,
      applied_count: 0,
    });
    expect(closeout.blockers).not.toContainEqual({
      kind: "sender_domain_ack_dry_run_stale",
      count: 1,
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

function fakeAckRefresh(manifestPath: string, logPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-refresh-"));
  const path = join(dir, "refresh-acks");
  writeFileSync(
    path,
    `#!/bin/sh
echo "$@" > ${JSON.stringify(logPath)}
cat > ${JSON.stringify(manifestPath)} <<'JSON'
{
  "items": [
    {
      "ok": true,
      "performed": false,
      "target": "tenant.example.com",
      "operation_id": "new-op",
      "ack_command": "CF_TOKEN_LANE=global cfctl apply sender_domain enable --zone tenant.example.com --name tenant.example.com --ack-plan new-op"
    }
  ]
}
JSON
cat <<'JSON'
{"preview_count":1,"ack_ready_count":1,"failed_count":0}
JSON
`,
  );
  chmodSync(path, 0o700);
  return path;
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
