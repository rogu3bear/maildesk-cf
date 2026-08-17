import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

describe("sender-domain PlanV2 executor", () => {
  test("dry-runs reviewed plans without invoking cfctl", () => {
    const setup = fixture([planItem("tenant.example.com", "op-tenant")]);
    const result = run(setup, []);
    expect(result.status).toBe(0);
    expect(existsSync(setup.logPath)).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "dry_run",
      ready_count: 1,
      executed_count: 0,
      dry_run_count: 1,
      results: [{
        status: "dry_run",
        domain: "tenant.example.com",
        operation_id: "op-tenant",
        lifecycle: { run: ["cfctl", "plans", "run", "op-tenant", "--json"] },
      }],
    });
  });

  test("execute mode requires an explicit PlanV2 confirmation", () => {
    const setup = fixture([planItem("tenant.example.com", "op-tenant")]);
    const result = run(setup, ["--execute"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing --confirm-plan for --execute");
    expect(existsSync(setup.logPath)).toBe(false);
  });

  test("shows, approves, runs, and checks the exact reviewed operation", () => {
    const setup = fixture([planItem("tenant.example.com", "op-tenant")]);
    const result = run(setup, ["--execute", "--confirm-plan"]);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(setup.logPath, "utf8").trim().split("\n")).toEqual([
      "plans show op-tenant --json",
      "plans approve op-tenant --yes --json",
      "plans run op-tenant --json",
      "plans status op-tenant --json",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "execute",
      executed_count: 1,
      results: [{ status: "executed", domain: "tenant.example.com", operation_id: "op-tenant" }],
    });
  });

  test("bulk execute requires an explicit bulk PlanV2 confirmation", () => {
    const setup = fixture([
      planItem("alpha.example.com", "op-alpha"),
      planItem("bravo.example.com", "op-bravo"),
    ]);
    const result = run(setup, ["--execute", "--confirm-plan", "--all"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing --confirm-bulk-plan for bulk --execute");
    expect(existsSync(setup.logPath)).toBe(false);
  });

  test("fails closed when plans show returns a different PlanV2 content hash", () => {
    const setup = fixture([planItem("tenant.example.com", "op-tenant")], "d");
    const result = run(setup, ["--execute", "--confirm-plan"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PlanV2 show envelope mismatch");
    expect(readFileSync(setup.logPath, "utf8").trim().split("\n")).toEqual([
      "plans show op-tenant --json",
    ]);
  });
});

function fixture(items: unknown[], planHashCharacter = "c") {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-plan-execute-"));
  const manifestPath = join(dir, "plan-manifest.json");
  const logPath = join(dir, "cfctl-calls.log");
  writeJson(manifestPath, { schema_version: 2, items });
  return { manifestPath, logPath, cfctl: fakeCfctl(logPath, planHashCharacter) };
}

function planItem(target: string, operationId: string) {
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

function run(
  setup: { manifestPath: string; logPath: string; cfctl: string },
  extra: string[],
) {
  return spawnSync(
    "bun",
    [
      "run",
      "scripts/apply-sender-domain-ack-manifest.ts",
      "--",
      "--manifest",
      setup.manifestPath,
      "--cfctl",
      setup.cfctl,
      ...extra,
      "--json",
    ],
    { cwd: root, encoding: "utf8" },
  );
}

function fakeCfctl(logPath: string, planHashCharacter: string): string {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-fake-cfctl-"));
  const path = join(dir, "cfctl");
  writeFileSync(
    path,
    `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
performed=false
if [ "$1" = "plans" ] && [ "$2" = "run" ]; then performed=true; fi
if [ "$1" = "plans" ] && [ "$2" = "show" ]; then
  printf '%s\n' '{"schema_version":2,"ok":true,"performed":false,"capability_id":"email-sending-subdomains-create-sending-subdomain","operation_id":"op-tenant","result":{"plan_v2":{"schema_version":2,"content_hash":"sha256:${planHashCharacter.repeat(64)}","plan":{"schema_version":1,"operation_id":"op-tenant","profile_id":"profile-example","account_id":"account-example","capability":{"id":"email-sending-subdomains-create-sending-subdomain"},"targets":{"selectors":{"zone_id":"zone-tenant.example.com"},"account_id":"account-example"},"input":{"selectors":{"zone_id":"zone-tenant.example.com"},"query":{},"body":{"name":"tenant.example.com"}}}}},"error":null}'
else
  printf '{"schema_version":2,"ok":true,"performed":%s,"operation_id":"%s","error":null}\n' "$performed" "$3"
fi
`,
  );
  chmodSync(path, 0o700);
  return path;
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
