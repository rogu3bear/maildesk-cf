import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

describe("sender-domain ack manifest applier", () => {
  test("dry-runs reviewed ack commands without invoking cfctl", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-ack-apply-"));
    const manifestPath = join(dir, "ack-manifest.json");
    const logPath = join(dir, "cfctl-calls.log");
    const cfctl = fakeCfctl(logPath);

    writeJson(manifestPath, {
      items: [
        {
          ok: true,
          performed: false,
          lane: "global",
          zone: "tenant.example.com",
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
        "scripts/apply-sender-domain-ack-manifest.ts",
        "--",
        "--manifest",
        manifestPath,
        "--cfctl",
        cfctl,
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(existsSync(logPath)).toBe(false);
    const summary = JSON.parse(result.stdout) as {
      mode?: string;
      ready_count?: number;
      applied_count?: number;
      dry_run_count?: number;
      results?: Array<{ status?: string; domain?: string; operation_id?: string }>;
    };
    expect(summary).toMatchObject({
      mode: "dry_run",
      ready_count: 1,
      applied_count: 0,
      dry_run_count: 1,
    });
    expect(summary.results?.[0]).toMatchObject({
      status: "dry_run",
      domain: "tenant.example.com",
      operation_id: "op-tenant",
    });
  });

  test("execute mode requires an explicit ack-plan confirmation", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-ack-apply-"));
    const manifestPath = join(dir, "ack-manifest.json");
    const logPath = join(dir, "cfctl-calls.log");
    const cfctl = fakeCfctl(logPath);

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
        "scripts/apply-sender-domain-ack-manifest.ts",
        "--",
        "--manifest",
        manifestPath,
        "--cfctl",
        cfctl,
        "--execute",
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing --confirm-ack-plan for --execute");
    expect(existsSync(logPath)).toBe(false);
  });

  test("executes reviewed ack commands only when explicitly confirmed", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-ack-apply-"));
    const manifestPath = join(dir, "ack-manifest.json");
    const logPath = join(dir, "cfctl-calls.log");
    const cfctl = fakeCfctl(logPath);

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
        "scripts/apply-sender-domain-ack-manifest.ts",
        "--",
        "--manifest",
        manifestPath,
        "--cfctl",
        cfctl,
        "--execute",
        "--confirm-ack-plan",
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(logPath, "utf8")).toContain(
      "lane=global args=apply sender_domain enable --zone tenant.example.com --name tenant.example.com --ack-plan op-tenant",
    );
    const summary = JSON.parse(result.stdout) as {
      mode?: string;
      applied_count?: number;
      results?: Array<{ status?: string; domain?: string; operation_id?: string }>;
    };
    expect(summary).toMatchObject({
      mode: "execute",
      applied_count: 1,
    });
    expect(summary.results?.[0]).toMatchObject({
      status: "applied",
      domain: "tenant.example.com",
      operation_id: "op-tenant",
    });
  });

  test("bulk execute requires an explicit bulk ack-plan confirmation", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-ack-apply-"));
    const manifestPath = join(dir, "ack-manifest.json");
    const logPath = join(dir, "cfctl-calls.log");
    const cfctl = fakeCfctl(logPath);

    writeJson(manifestPath, {
      items: [
        {
          ok: true,
          performed: false,
          target: "alpha.example.com",
          operation_id: "op-alpha",
          ack_command:
            "CF_TOKEN_LANE=global cfctl apply sender_domain enable --zone alpha.example.com --name alpha.example.com --ack-plan op-alpha",
        },
        {
          ok: true,
          performed: false,
          target: "bravo.example.com",
          operation_id: "op-bravo",
          ack_command:
            "CF_TOKEN_LANE=global cfctl apply sender_domain enable --zone bravo.example.com --name bravo.example.com --ack-plan op-bravo",
        },
      ],
    });

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/apply-sender-domain-ack-manifest.ts",
        "--",
        "--manifest",
        manifestPath,
        "--cfctl",
        cfctl,
        "--execute",
        "--confirm-ack-plan",
        "--all",
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing --confirm-bulk-ack-plan for bulk --execute");
    expect(existsSync(logPath)).toBe(false);
  });
});

function fakeCfctl(logPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-fake-cfctl-"));
  const path = join(dir, "cfctl");
  writeFileSync(
    path,
    `#!/bin/sh
printf 'lane=%s args=%s\\n' "$CF_TOKEN_LANE" "$*" >> ${JSON.stringify(logPath)}
cat <<JSON
{
  "ok": true,
  "performed": true,
  "operation_id": "applied-op"
}
JSON
`,
  );
  chmodSync(path, 0o700);
  return path;
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
