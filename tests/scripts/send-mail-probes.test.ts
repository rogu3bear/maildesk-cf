import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

describe("mail probe sender", () => {
  test("dry-runs inbound probes without a Resend CLI dependency", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-probes-"));
    const planPath = join(dir, "plan.json");
    const policyPath = join(dir, "policy.json");
    const emptyBinDir = join(dir, "bin");

    mkdirSync(emptyBinDir);
    writeJson(planPath, {
      actions: [
        {
          kind: "targeted_inbound_probe",
          domain: "tenant.example.com",
          target: "founders@tenant.example.com",
          description: "send one targeted inbound proof message",
        },
      ],
    });
    writeJson(policyPath, { domains: {} });

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/send-mail-probes.ts",
        "--",
        "--plan",
        planPath,
        "--policy",
        policyPath,
        "--from",
        "proof@example.com",
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${emptyBinDir}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout) as {
      inbound_provider?: string;
      results: Array<{ status: string; provider: string }>;
    };
    expect(summary.inbound_provider).toBe("manual");
    expect(summary.results[0]).toMatchObject({
      status: "dry_run",
      provider: "manual",
    });
  });

  test("live inbound probes require an explicit executable provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-probes-"));
    const planPath = join(dir, "plan.json");
    const policyPath = join(dir, "policy.json");

    writeJson(planPath, {
      actions: [
        {
          kind: "targeted_inbound_probe",
          domain: "tenant.example.com",
          target: "founders@tenant.example.com",
          description: "send one targeted inbound proof message",
        },
      ],
    });
    writeJson(policyPath, { domains: {} });

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/send-mail-probes.ts",
        "--",
        "--plan",
        planPath,
        "--policy",
        policyPath,
        "--execute",
        "--confirm-live-send",
        "--from",
        "proof@example.com",
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("manual inbound probes cannot execute");
  });

  test("requires explicit confirmation before live probe execution", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-probes-"));
    const planPath = join(dir, "plan.json");
    const policyPath = join(dir, "policy.json");
    const binDir = join(dir, "bin");
    const resendLogPath = join(dir, "resend.log");
    const resendPath = join(binDir, "resend");

    mkdirSync(binDir);
    writeJson(planPath, {
      actions: [
        {
          kind: "targeted_inbound_probe",
          domain: "tenant.example.com",
          target: "founders@tenant.example.com",
          description: "send one targeted inbound proof message",
        },
      ],
    });
    writeJson(policyPath, { domains: {} });
    writeFileSync(
      resendPath,
      `#!/bin/sh
echo "$@" > ${JSON.stringify(resendLogPath)}
cat <<'JSON'
{"id":"fake-message"}
JSON
`,
      { mode: 0o700 },
    );
    chmodSync(resendPath, 0o700);

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/send-mail-probes.ts",
        "--",
        "--plan",
        planPath,
        "--policy",
        policyPath,
        "--execute",
        "--from",
        "proof@example.com",
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing --confirm-live-send for --execute");
    expect(existsSync(resendLogPath)).toBe(false);
  });

  test("bulk live probe execution requires explicit bulk confirmation", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-probes-"));
    const planPath = join(dir, "plan.json");
    const policyPath = join(dir, "policy.json");
    const binDir = join(dir, "bin");
    const resendLogPath = join(dir, "resend.log");
    const resendPath = join(binDir, "resend");

    mkdirSync(binDir);
    writeJson(planPath, {
      actions: [
        {
          kind: "targeted_inbound_probe",
          domain: "tenant-a.example.com",
          target: "founders@tenant-a.example.com",
          description: "send one targeted inbound proof message",
        },
        {
          kind: "targeted_inbound_probe",
          domain: "tenant-b.example.com",
          target: "founders@tenant-b.example.com",
          description: "send one targeted inbound proof message",
        },
      ],
    });
    writeJson(policyPath, { domains: {} });
    writeFileSync(
      resendPath,
      `#!/bin/sh
echo "$@" >> ${JSON.stringify(resendLogPath)}
cat <<'JSON'
{"id":"fake-message"}
JSON
`,
      { mode: 0o700 },
    );
    chmodSync(resendPath, 0o700);

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/send-mail-probes.ts",
        "--",
        "--plan",
        planPath,
        "--policy",
        policyPath,
        "--execute",
        "--confirm-live-send",
        "--all",
        "--from",
        "proof@example.com",
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing --confirm-bulk-live-send for bulk --execute");
    expect(existsSync(resendLogPath)).toBe(false);
  });
});

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
