import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

describe("sender-domain PlanV2 manifest refresher", () => {
  test("creates profile/account/capability-bound plans from typed proof actions", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-plan-refresh-"));
    const planPath = join(dir, "proof-plan.json");
    const outPath = join(dir, "plan-manifest.json");
    const previewDir = join(dir, "previews");
    const logPath = join(dir, "cfctl-calls.log");
    const cfctl = fakeCfctl(logPath);

    writeJson(planPath, {
      actions: [
        planAction("tenant.example.com"),
        planAction("mail.tenant.example.com"),
        { kind: "targeted_inbound_probe", domain: "tenant.example.com" },
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
        "--profile",
        "profile-example",
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      preview_count: 2,
      plan_ready_count: 2,
      manifest_path: outPath,
    });

    const manifest = JSON.parse(readFileSync(outPath, "utf8")) as {
      schema_version: number;
      items: Array<Record<string, any>>;
    };
    expect(manifest.schema_version).toBe(2);
    expect(manifest.items).toHaveLength(2);
    expect(manifest.items[0]).toMatchObject({
      schema_version: 2,
      ok: true,
      performed: false,
      capability_id: "email-sending-subdomains-create-sending-subdomain",
      profile_id: "profile-example",
      account_id: "account-example",
      zone_id: "zone-tenant.example.com",
      target: "tenant.example.com",
      operation_id: "op-tenant.example.com",
      plan_content_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      plan_expires_at: "2099-01-01T00:00:00Z",
      lifecycle: {
        run: ["cfctl", "plans", "run", "op-tenant.example.com", "--json"],
      },
    });
    expect(manifest.items[1]).toMatchObject({
      zone_id: "zone-mail.tenant.example.com",
      target: "mail.tenant.example.com",
      operation_id: "op-mail.tenant.example.com",
    });
    expect(readdirSync(previewDir).sort()).toEqual(["plan-01.json", "plan-02.json"]);

    const calls = readFileSync(logPath, "utf8");
    expect(calls).toContain("auth profiles --json");
    expect(calls).toContain(
      "call zones-get --query name=tenant.example.com --query account.id=account-example --query page=1 --query per_page=5 --profile profile-example --account account-example --json",
    );
    expect(calls).toContain(
      "call email-sending-subdomains-create-sending-subdomain --selector zone_id=zone-tenant.example.com --profile profile-example --account account-example --body-stdin --json body={\"name\":\"tenant.example.com\"}",
    );
    expect(calls).not.toMatch(/maildesk-cf|--ack-plan|\bapply\b|CF_TOKEN_LANE/);
  });

  test("fails before cfctl when no explicit profile is provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-plan-refresh-"));
    const planPath = join(dir, "proof-plan.json");
    writeJson(planPath, { actions: [planAction("tenant.example.com")] });
    const result = spawnSync(
      "bun",
      ["run", "scripts/refresh-sender-domain-ack-manifest.ts", "--", "--plan", planPath, "--json"],
      { cwd: root, encoding: "utf8", env: { ...process.env, MAILDESK_CFCTL_PROFILE: "" } },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing explicit cfctl profile");
  });
});

function planAction(domain: string) {
  return {
    kind: "blocked",
    domain,
    blocked_by: "sender_domain_not_verified",
    plan_request: {
      schema_version: 2,
      capability_id: "email-sending-subdomains-create-sending-subdomain",
      target: { zone_name: domain, sending_subdomain_name: domain },
      profile_binding: "explicit",
      account_binding: "profile_account",
      zone_binding: { capability_id: "zones-get", exact_name: domain },
      body: { name: domain },
    },
  };
}

function fakeCfctl(logPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-fake-cfctl-"));
  const path = join(dir, "cfctl");
  writeFileSync(
    path,
    `#!/bin/sh
body=""
if [ "$1" = "call" ] && [ "$2" = "email-sending-subdomains-create-sending-subdomain" ]; then
  IFS= read -r body
fi
printf '%s body=%s\n' "$*" "$body" >> ${JSON.stringify(logPath)}
if [ "$1" = "auth" ]; then
  printf '%s\n' '{"schema_version":2,"ok":true,"performed":false,"result":{"profiles":[{"id":"profile-example","account_id":"account-example"}]},"error":null}'
elif [ "$2" = "zones-get" ]; then
  domain=""
  previous=""
  for value in "$@"; do
    if [ "$previous" = "--query" ]; then case "$value" in name=*) domain="\${value#name=}" ;; esac; fi
    previous="$value"
  done
  cat <<JSON
{"schema_version":2,"ok":true,"performed":true,"capability_id":"zones-get","profile_id":"profile-example","account_id":"account-example","evidence":[{"content_hash":"sha256:${"a".repeat(64)}"}],"result":{"result":[{"id":"zone-$domain","name":"$domain","status":"active"}]},"error":null}
JSON
else
  name=$(printf '%s' "$body" | sed -E 's/.*"name":"([^"]+)".*/\\1/')
  cat <<JSON
{"schema_version":2,"ok":true,"performed":false,"capability_id":"email-sending-subdomains-create-sending-subdomain","operation_id":"op-$name","profile_id":"profile-example","account_id":"account-example","evidence":[{"content_hash":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}],"result":{"expires_at":"2099-01-01T00:00:00Z","plan_v2":{"schema_version":2,"content_hash":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","plan":{"schema_version":1,"operation_id":"op-$name","profile_id":"profile-example","account_id":"account-example","capability":{"id":"email-sending-subdomains-create-sending-subdomain"},"targets":{"selectors":{"zone_id":"zone-$name"},"account_id":"account-example"},"input":{"selectors":{"zone_id":"zone-$name"},"query":{},"body":{"name":"$name"}}}}},"error":null}
JSON
fi
`,
  );
  chmodSync(path, 0o700);
  return path;
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
