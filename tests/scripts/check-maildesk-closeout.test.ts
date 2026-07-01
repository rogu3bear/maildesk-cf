import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
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

  test("summarizes protected action handoffs without exposing sensitive details", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-closeout-"));
    const summaryPath = join(dir, "summary.json");
    const manifestPath = join(dir, "ack-manifest.json");
    const preflight = fakePreflight(0, "", "preflight ok: production\n");

    writeJson(summaryPath, {
      local_truth_ok: true,
      live_evidence_present: true,
      edge_ready: true,
      mail_ready: false,
      domain_count: 2,
      gap_count: 4,
      proof_actions: 4,
      targeted_inbound_probes: 2,
      targeted_outbound_reply_probes: 0,
      blocked_proofs: 2,
      sender_domain_blocked_count: 2,
      sender_domain_ack_ready_count: 2,
      sender_domain_ack_missing_count: 0,
    });
    writeJson(manifestPath, {
      items: [
        {
          ok: true,
          performed: false,
          target: "tenant-a.example.com",
          operation_id: "op-a",
          ack_command:
            "CF_TOKEN_LANE=global cfctl apply sender_domain enable --zone tenant-a.example.com --name tenant-a.example.com --ack-plan op-a",
        },
        {
          ok: true,
          performed: false,
          target: "tenant-b.example.com",
          operation_id: "op-b",
          ack_command:
            "CF_TOKEN_LANE=global cfctl apply sender_domain enable --zone tenant-b.example.com --name tenant-b.example.com --ack-plan op-b",
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
    expect(result.stdout).not.toContain("tenant-a.example.com");
    expect(result.stdout).not.toContain("tenant-b.example.com");
    expect(result.stdout).not.toContain("--ack-plan");
    const closeout = JSON.parse(result.stdout) as {
      protected_actions?: {
        sender_domain_apply?: {
          count?: number;
          dry_run_ready_count?: number;
          required_flags?: string[];
          bulk_confirmation_required?: boolean;
          bulk_confirmation_flag?: string | null;
        };
        inbound_probe?: {
          count?: number;
          required_flags?: string[];
          bulk_confirmation_required?: boolean;
          bulk_confirmation_flag?: string | null;
        };
      };
    };
    expect(closeout.protected_actions?.sender_domain_apply).toMatchObject({
      count: 2,
      dry_run_ready_count: 2,
      required_flags: ["--execute", "--confirm-ack-plan"],
      bulk_confirmation_required: true,
      bulk_confirmation_flag: "--confirm-bulk-ack-plan",
    });
    expect(closeout.protected_actions?.inbound_probe).toMatchObject({
      count: 2,
      required_flags: ["--execute", "--confirm-live-send"],
      bulk_confirmation_required: true,
      bulk_confirmation_flag: "--confirm-bulk-live-send",
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

  test("purges duplicate active previews during closeout when requested", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-closeout-"));
    const summaryPath = join(dir, "summary.json");
    const manifestPath = join(dir, "ack-manifest.json");
    const refreshLogPath = join(dir, "refresh.log");
    const cleanupLogPath = join(dir, "cleanup.log");
    const preflight = fakePreflight(0, "", "preflight ok: production\n");
    const refresh = fakeAckRefresh(manifestPath, refreshLogPath);
    const cleanup = fakePreviewCleanup(cleanupLogPath);

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
        "--purge-duplicate-previews",
        "--preview-cleanup-command",
        cleanup,
        "--preflight-command",
        preflight,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(existsSync(cleanupLogPath)).toBe(true);
    expect(readFileSync(cleanupLogPath, "utf8")).toContain("cleanup invoked");
    const closeout = JSON.parse(result.stdout) as {
      preview_cleanup?: {
        ok?: boolean;
        performed?: boolean;
        purged_count?: number;
        duplicate_group_count?: number;
      };
      blockers?: Array<{ kind?: string }>;
    };
    expect(closeout.preview_cleanup).toMatchObject({
      ok: true,
      performed: true,
      purged_count: 2,
      duplicate_group_count: 1,
    });
    expect(closeout.blockers).not.toContainEqual({ kind: "preview_cleanup" });
  });

  test("purges expired previews during closeout when requested", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-closeout-"));
    const summaryPath = join(dir, "summary.json");
    const cleanupLogPath = join(dir, "expired-cleanup.log");
    const preflight = fakePreflight(0, "", "preflight ok: production\n");
    const cleanup = fakeExpiredPreviewCleanup(cleanupLogPath);

    writeJson(summaryPath, {
      local_truth_ok: true,
      live_evidence_present: true,
      edge_ready: true,
      mail_ready: false,
      domain_count: 1,
      gap_count: 1,
      targeted_inbound_probes: 0,
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
        "--purge-expired-previews",
        "--expired-preview-cleanup-command",
        cleanup,
        "--preflight-command",
        preflight,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(existsSync(cleanupLogPath)).toBe(true);
    expect(readFileSync(cleanupLogPath, "utf8")).toContain("expired cleanup invoked");
    const closeout = JSON.parse(result.stdout) as {
      preview_cleanup?: {
        ok?: boolean;
        performed?: boolean;
        purged_count?: number;
        expired_purged_count?: number;
        duplicate_group_count?: number;
      };
      blockers?: Array<{ kind?: string }>;
    };
    expect(closeout.preview_cleanup).toMatchObject({
      ok: true,
      performed: true,
      purged_count: 14,
      expired_purged_count: 14,
      duplicate_group_count: 0,
    });
    expect(closeout.blockers).not.toContainEqual({ kind: "preview_cleanup" });
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

  test("loads an explicit env file before running production preflight", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-closeout-"));
    const summaryPath = join(dir, "summary.json");
    const envDir = mkdtempSync(join(ensureVarDir(), "closeout-env-"));
    const envFile = join(envDir, ".dev.vars");
    const preflight = fakeEnvAwarePreflight();
    writeFileSync(envFile, "MAILDESK_API_TOKEN=example-maildesk-token\n");
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
    const env = { ...process.env };
    delete env.MAILDESK_API_TOKEN;
    delete env.MAILDESK_PROOF_API_TOKEN;

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
        "--env-file",
        relative(root, envFile),
        "--json",
      ],
      { cwd: root, encoding: "utf8", env },
    );

    expect(result.status).toBe(1);
    const closeout = JSON.parse(result.stdout) as {
      production_preflight?: { ok?: boolean; failures?: string[] };
      blockers?: Array<{ kind?: string }>;
    };
    expect(closeout.production_preflight).toMatchObject({
      ok: true,
      failures: [],
    });
    expect(closeout.blockers).not.toContainEqual({ kind: "production_preflight" });
  });
});

function ensureVarDir(): string {
  const dir = resolve(root, "var");
  mkdirSync(dir, { recursive: true });
  return dir;
}

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

function fakeEnvAwarePreflight(): string {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-env-aware-preflight-"));
  const path = join(dir, "preflight");
  writeFileSync(
    path,
    `#!/bin/sh
if [ -n "$MAILDESK_API_TOKEN" ]; then
  echo "preflight ok: production"
  exit 0
fi
echo "fail: missing or placeholder environment variable: MAILDESK_API_TOKEN" >&2
exit 1
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

function fakePreviewCleanup(logPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-preview-cleanup-"));
  const path = join(dir, "preview-cleanup");
  writeFileSync(
    path,
    `#!/bin/sh
echo "cleanup invoked" > ${JSON.stringify(logPath)}
cat <<'JSON'
{"ok":true,"performed":true,"summary":{"purged_count":2,"duplicate_group_count":1}}
JSON
`,
  );
  chmodSync(path, 0o700);
  return path;
}

function fakeExpiredPreviewCleanup(logPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-expired-preview-cleanup-"));
  const path = join(dir, "expired-preview-cleanup");
  writeFileSync(
    path,
    `#!/bin/sh
echo "expired cleanup invoked" > ${JSON.stringify(logPath)}
cat <<'JSON'
{"ok":true,"performed":true,"summary":{"purged_count":14}}
JSON
`,
  );
  chmodSync(path, 0o700);
  return path;
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
