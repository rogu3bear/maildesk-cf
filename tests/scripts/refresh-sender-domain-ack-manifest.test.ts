import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

describe("sender-domain ack manifest refresher", () => {
  test("refreshes ack manifest from proof-plan preview commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-ack-refresh-"));
    const planPath = join(dir, "proof-plan.json");
    const outPath = join(dir, "ack-manifest.json");
    const previewDir = join(dir, "previews");
    const logPath = join(dir, "cfctl-calls.log");
    const cfctl = fakeCfctl(logPath);

    writeJson(planPath, {
      actions: [
        {
          kind: "blocked",
          domain: "tenant.example.com",
          blocked_by: "sender_domain_not_verified",
          preview_command:
            "CF_TOKEN_LANE=global cfctl apply sender_domain enable --zone tenant.example.com --name tenant.example.com --plan",
        },
        {
          kind: "blocked",
          domain: "mail.tenant.example.com",
          blocked_by: "sender_domain_not_verified",
          preview_command:
            "CF_TOKEN_LANE=global cfctl apply sender_domain enable --zone tenant.example.com --name mail.tenant.example.com --plan",
        },
        {
          kind: "targeted_inbound_probe",
          domain: "tenant.example.com",
          target: "founders@tenant.example.com",
        },
      ],
    });

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/refresh-sender-domain-ack-manifest.ts",
        "--",
        "--plan",
        planPath,
        "--out",
        outPath,
        "--preview-dir",
        previewDir,
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
    const summary = JSON.parse(result.stdout) as {
      preview_count?: number;
      ack_ready_count?: number;
      manifest_path?: string;
    };
    expect(summary).toMatchObject({
      preview_count: 2,
      ack_ready_count: 2,
      manifest_path: outPath,
    });

    const manifest = JSON.parse(readFileSync(outPath, "utf8")) as {
      items: Array<{
        ok: boolean;
        performed: boolean;
        plan_mode: boolean;
        lane: string;
        operation_id: string;
        preview_expires_at: string;
        ack_command: string;
      }>;
    };
    expect(manifest.items).toHaveLength(2);
    expect(manifest.items[0]).toMatchObject({
      ok: true,
      performed: false,
      plan_mode: true,
      lane: "global",
      operation_id: "op-tenant.example.com",
      preview_expires_at: "2099-01-01T00:00:00Z",
      ack_command:
        "CF_TOKEN_LANE=global cfctl apply sender_domain enable --zone tenant.example.com --name tenant.example.com --ack-plan op-tenant.example.com",
    });
    expect(manifest.items[1]).toMatchObject({
      operation_id: "op-mail.tenant.example.com",
      ack_command:
        "CF_TOKEN_LANE=global cfctl apply sender_domain enable --zone tenant.example.com --name mail.tenant.example.com --ack-plan op-mail.tenant.example.com",
    });

    expect(readdirSync(previewDir).sort()).toEqual(["preview-01.json", "preview-02.json"]);
    const calls = readFileSync(logPath, "utf8");
    expect(calls).toContain("apply sender_domain enable --zone tenant.example.com --name tenant.example.com --plan");
    expect(calls).not.toContain("--ack-plan");
  });
});

function fakeCfctl(logPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-fake-cfctl-"));
  const path = join(dir, "cfctl");
  writeFileSync(
    path,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
name=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--name" ]; then
    shift
    name="$1"
  fi
  shift
done
cat <<JSON
{
  "ok": true,
  "performed": false,
  "operation_id": "op-$name",
  "summary": {
    "plan_mode": true
  },
  "trust": {
    "preview_expires_at": "2099-01-01T00:00:00Z"
  }
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
