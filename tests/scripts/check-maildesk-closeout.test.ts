import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

describe("maildesk closeout gate", () => {
  test("reports protected sender-domain applies without applying them", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-closeout-"));
    const summaryPath = join(dir, "summary.json");
    const manifestPath = join(dir, "plan-manifest.json");
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
      sender_domain_plan_ready_count: 1,
      sender_domain_plan_missing_count: 0,
    });
    writeJson(manifestPath, {
      items: [
        planManifestItem("tenant.example.com", "op-tenant"),
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
        "--plan-manifest",
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
      ack_dry_run?: { ready_count?: number; dry_run_count?: number; executed_count?: number };
      blockers?: Array<{ kind?: string; count?: number }>;
    };
    expect(closeout.ready).toBe(false);
    expect(closeout.production_preflight?.ok).toBe(true);
    expect(closeout.ack_dry_run).toMatchObject({
      ready_count: 1,
      dry_run_count: 1,
      executed_count: 0,
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
    const manifestPath = join(dir, "plan-manifest.json");
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
      sender_domain_plan_ready_count: 1,
      sender_domain_plan_missing_count: 0,
    });
    writeJson(manifestPath, {
      items: [
        planManifestItem("tenant.example.com", "op-tenant"),
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
        "--plan-manifest",
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
      ack_dry_run?: { ready_count?: number; dry_run_count?: number; executed_count?: number; result_count?: number };
    };
    expect(closeout.sensitive_redacted).toBe(true);
    expect(closeout.ack_dry_run).toMatchObject({
      ready_count: 1,
      dry_run_count: 1,
      executed_count: 0,
      result_count: 1,
    });
  });

  test("summarizes protected action handoffs without exposing sensitive details", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-closeout-"));
    const summaryPath = join(dir, "summary.json");
    const manifestPath = join(dir, "plan-manifest.json");
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
      sender_domain_plan_ready_count: 2,
      sender_domain_plan_missing_count: 0,
    });
    writeJson(manifestPath, {
      items: [
        planManifestItem("tenant-a.example.com", "op-a"),
        planManifestItem("tenant-b.example.com", "op-b"),
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
        "--plan-manifest",
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
      required_flags: ["--execute", "--confirm-plan"],
      bulk_confirmation_required: true,
      bulk_confirmation_flag: "--confirm-bulk-plan",
    });
    expect(closeout.protected_actions?.inbound_probe).toMatchObject({
      count: 2,
      required_flags: ["--execute", "--confirm-live-send"],
      bulk_confirmation_required: true,
      bulk_confirmation_flag: "--confirm-bulk-live-send",
    });
  });

  test("emits sanitized argv commands for the next protected handoff", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-closeout-"));
    const summaryPath = join(dir, "summary.json");
    const manifestPath = join(dir, "plan-manifest.json");
    const preflight = fakePreflight(0, "", "preflight ok: production\n");
    const cfctl = "/path/to/reviewed/cfctl";

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
      sender_domain_plan_ready_count: 2,
      sender_domain_plan_missing_count: 0,
    });
    writeJson(manifestPath, {
      items: [
        planManifestItem("tenant-a.example.com", "op-a"),
        planManifestItem("tenant-b.example.com", "op-b"),
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
        "--plan-manifest",
        manifestPath,
        "--plan",
        "var/maildesk-proof-plan.json",
        "--cfctl",
        cfctl,
        "--preflight-command",
        preflight,
        "--redact-sensitive",
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("tenant-a.example.com");
    expect(result.stdout).not.toContain("op-a");
    expect(result.stdout).not.toContain("--ack-plan");
    const closeout = JSON.parse(result.stdout) as {
      protected_command_handoff?: {
        sender_domain_apply?: {
          dry_run_one?: string[];
          execute_one?: string[];
          execute_all?: string[] | null;
        };
        inbound_probe?: {
          dry_run_one?: string[];
          execute_one?: string[];
          execute_all?: string[] | null;
        };
      };
    };
    expect(closeout.protected_command_handoff?.sender_domain_apply?.dry_run_one).toEqual([
      "bun",
      "run",
      "apply:maildesk-acks",
      "--",
      "--manifest",
      relative(root, manifestPath),
      "--cfctl",
      cfctl,
      "--limit",
      "1",
      "--json",
    ]);
    expect(closeout.protected_command_handoff?.sender_domain_apply?.execute_one).toEqual([
      "bun",
      "run",
      "apply:maildesk-acks",
      "--",
      "--manifest",
      relative(root, manifestPath),
      "--cfctl",
      cfctl,
      "--execute",
      "--confirm-plan",
      "--limit",
      "1",
      "--json",
    ]);
    expect(closeout.protected_command_handoff?.sender_domain_apply?.execute_all).toContain(
      "--confirm-bulk-plan",
    );
    expect(closeout.protected_command_handoff?.inbound_probe?.execute_one).toEqual([
      "bun",
      "run",
      "send:maildesk-probes",
      "--",
      "--plan",
      "var/maildesk-proof-plan.json",
      "--kind",
      "inbound",
      "--inbound-provider",
      "<probe-provider>",
      "--from",
      "<verified-sender>",
      "--execute",
      "--confirm-live-send",
      "--limit",
      "1",
      "--json",
    ]);
    expect(closeout.protected_command_handoff?.inbound_probe?.execute_all).toContain(
      "--confirm-bulk-live-send",
    );
  });

  test("refreshes ack manifest before closeout dry-run when requested", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-closeout-"));
    const summaryPath = join(dir, "summary.json");
    const manifestPath = join(dir, "plan-manifest.json");
    const refreshLogPath = join(dir, "refresh.log");
    const preflight = fakePreflight(0, "", "preflight ok: production\n");
    const refresh = fakeAckRefresh(manifestPath, refreshLogPath);
    const cfctl = "/path/to/reviewed/cfctl";

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
      sender_domain_plan_ready_count: 1,
      sender_domain_plan_missing_count: 0,
    });
    writeJson(manifestPath, {
      items: [
        {
          ...planManifestItem("tenant.example.com", "old-op"),
          plan_expires_at: "2000-01-01T00:00:00.000Z",
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
        "--plan-manifest",
        manifestPath,
        "--refresh-acks",
        "--refresh-ack-command",
        refresh,
        "--cfctl",
        cfctl,
        "--preflight-command",
        preflight,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(readFileSync(refreshLogPath, "utf8")).toContain(`--out ${manifestPath}`);
    expect(readFileSync(refreshLogPath, "utf8")).toContain(`--cfctl ${cfctl}`);
    const closeout = JSON.parse(result.stdout) as {
      ack_refresh?: { ok?: boolean; plan_ready_count?: number };
      ack_dry_run?: { ready_count?: number; dry_run_count?: number; executed_count?: number };
      blockers?: Array<{ kind?: string; count?: number }>;
    };
    expect(closeout.ack_refresh).toMatchObject({
      ok: true,
      plan_ready_count: 1,
    });
    expect(closeout.ack_dry_run).toMatchObject({
      ready_count: 1,
      dry_run_count: 1,
      executed_count: 0,
    });
    expect(closeout.blockers).not.toContainEqual({
      kind: "sender_domain_plan_dry_run_stale",
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
      sender_domain_plan_ready_count: 0,
      sender_domain_plan_missing_count: 0,
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
      sender_domain_plan_ready_count: 0,
      sender_domain_plan_missing_count: 0,
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

  test("invalid env symlinks stop preflight and sender-plan refresh execution", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-closeout-env-boundary-"));
    const summaryPath = join(dir, "summary.json");
    const manifestPath = join(dir, "plan-manifest.json");
    const externalFile = join(dir, ".external.vars");
    const localDir = mkdtempSync(join(ensureVarDir(), "closeout-env-symlink-"));
    const localLink = join(localDir, ".dev.vars");
    const preflightMarker = join(dir, "preflight-invoked");
    const refreshMarker = join(dir, "refresh-invoked");
    writeFileSync(externalFile, "MAILDESK_API_TOKEN=secret-outside-value\n");
    symlinkSync(externalFile, localLink);
    writeJson(summaryPath, {
      local_truth_ok: true,
      live_evidence_present: true,
      edge_ready: false,
      mail_ready: false,
      domain_count: 1,
      gap_count: 1,
      local_gap_count: 0,
      edge_gap_count: 1,
      mail_gap_count: 0,
      proof_actions: 0,
      targeted_inbound_probes: 0,
      targeted_outbound_reply_probes: 0,
      blocked_proofs: 0,
      sender_domain_blocked_count: 0,
      sender_domain_plan_ready_count: 0,
      sender_domain_plan_missing_count: 0,
    });

    try {
      const result = spawnSync(
        "bun",
        [
          "run",
          "scripts/check-maildesk-closeout.ts",
          "--",
          "--summary",
          summaryPath,
          "--plan-manifest",
          manifestPath,
          "--env-file",
          relative(root, localLink),
          "--refresh-acks",
          "--preflight-command",
          fakeInvocationRecorder(preflightMarker),
          "--refresh-ack-command",
          fakeInvocationRecorder(refreshMarker),
          "--json",
        ],
        { cwd: root, encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(existsSync(preflightMarker)).toBe(false);
      expect(existsSync(refreshMarker)).toBe(false);
      expect(result.stdout).not.toContain("secret-outside-value");
      const closeout = JSON.parse(result.stdout) as {
        production_preflight?: { ok?: boolean; failures?: string[] };
        blockers?: Array<{ kind?: string; detail?: string }>;
      };
      expect(closeout.production_preflight).toMatchObject({
        ok: false,
        failures: ["env file must be under repository root"],
      });
      expect(closeout.blockers).toContainEqual({
        kind: "production_preflight",
        detail: "env file must be under repository root",
      });
    } finally {
      rmSync(localDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
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

function fakeInvocationRecorder(markerPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-invocation-recorder-"));
  const path = join(dir, "record-invocation");
  writeFileSync(
    path,
    `#!/bin/sh
touch ${JSON.stringify(markerPath)}
exit 0
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
  "schema_version": 2,
  "items": [
    {
      "schema_version": 2,
      "ok": true,
      "performed": false,
      "capability_id": "email-sending-subdomains-create-sending-subdomain",
      "profile_id": "profile-example",
      "account_id": "account-example",
      "zone_id": "zone-example",
      "target": "tenant.example.com",
      "operation_id": "new-op",
      "plan_content_hash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "evidence_hashes": ["sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]
    }
  ]
}
JSON
cat <<'JSON'
{"preview_count":1,"plan_ready_count":1,"failed_count":0}
JSON
`,
  );
  chmodSync(path, 0o700);
  return path;
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

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

test("explicit cfctl override reaches the preflight subprocess instead of ambient binary", () => {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-cfctl-context-"));
  const summary = join(dir, "summary.json"), preflight = join(dir, "preflight"), observed = join(dir, "observed");
  writeJson(summary, { local_truth_ok: true, live_evidence_present: false });
  writeFileSync(preflight, '#!/bin/sh\nprintf "%s" "$CFCTL_BIN" > "$CONTEXT_OBSERVED"\nexit 1\n', { mode: 0o755 });
  const selected = "/explicit/cfctl";
  spawnSync("bun", ["run", "scripts/check-maildesk-closeout.ts", "--summary", summary, "--preflight-command", preflight, "--cfctl", selected, "--json"], { cwd: root, encoding: "utf8", env: { ...process.env, CFCTL_BIN: "/ambient/cfctl", CONTEXT_OBSERVED: observed } });
  expect(readFileSync(observed, "utf8")).toBe(selected);
});
