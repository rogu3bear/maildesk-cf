import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

interface Scenario {
  zoneFound?: boolean;
  enabled?: boolean;
  existingRuleAddresses?: string[];
  mxContent?: string;
}

describe("governed email-routing provisioning reconciler", () => {
  test("plan mode drafts nothing and lists the deltas as pending", () => {
    const { cfctl, logPath, state } = fixture({ zoneFound: true, enabled: false, existingRuleAddresses: [] });
    const out = run(["--plan", "--desired-state", state, "--cfctl", cfctl, "--json"]);
    expect(out.status).toBe(0);
    const s = JSON.parse(out.stdout);
    expect(s.mode).toBe("plan");
    const d = s.domains[0];
    expect(d.applied).toEqual([]);
    // enable + two aliases are pending, nothing already-satisfied.
    expect(d.pending.map((p: { item: string }) => p.item).sort()).toEqual([
      "enable-routing",
      "rule:founders@example.com",
      "rule:support@example.com",
    ]);
    // plan mode never approves or runs a plan.
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    expect(log).not.toContain("plans approve");
    expect(log).not.toContain("plans run");
  });

  test("the tracked canonical desired state resolves the relay router", () => {
    const { cfctl } = fixture({ zoneFound: true, enabled: true, existingRuleAddresses: [] });
    const out = run([
      "--plan",
      "--desired-state",
      "config/desired-state.example.json",
      "--domain",
      "example.com",
      "--cfctl",
      cfctl,
      "--json",
    ]);
    expect(out.status).toBe(0);
    const summary = JSON.parse(out.stdout);
    expect(summary.worker_script).toBe("maildesk-cf-router");
    expect(summary.failed_count).toBe(0);
  });

  test("idempotent: already-enabled zone with all rules present applies nothing", () => {
    const { cfctl, state } = fixture({
      zoneFound: true,
      enabled: true,
      existingRuleAddresses: ["founders@example.com", "support@example.com"],
    });
    const out = run(["--apply", "--desired-state", state, "--cfctl", cfctl, "--json"]);
    expect(out.status).toBe(0);
    const d = JSON.parse(out.stdout).domains[0];
    expect(d.applied).toEqual([]);
    expect(d.already.sort()).toEqual(["enable-routing", "rule:founders@example.com", "rule:support@example.com"]);
    expect(d.failed).toEqual([]);
  });

  test("non-cloudflare domains are skipped, never mutated", () => {
    const { cfctl, state } = fixture({ zoneFound: true, enabled: false, existingRuleAddresses: [] }, /*withGoogle*/ true);
    const out = run(["--plan", "--desired-state", state, "--cfctl", cfctl, "--json"]);
    const s = JSON.parse(out.stdout);
    expect(s.skipped_non_cloudflare).toEqual([{ domain: "legacy.example.net", provider: "google_workspace" }]);
    expect(s.domains.map((d: { domain: string }) => d.domain)).toEqual(["example.com"]);
  });

  test("apply drafts, approves and runs each missing delta", () => {
    const { cfctl, logPath, state } = fixture({ zoneFound: true, enabled: false, existingRuleAddresses: ["founders@example.com"] });
    const out = run(["--apply", "--desired-state", state, "--cfctl", cfctl, "--json"]);
    expect(out.status).toBe(0);
    const d = JSON.parse(out.stdout).domains[0];
    // enable + the one missing rule are applied; the present rule is already.
    expect(d.applied.map((a: { item: string }) => a.item).sort()).toEqual(["enable-routing", "rule:support@example.com"]);
    expect(d.already).toContain("rule:founders@example.com");
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("plans approve");
    expect(log).toContain("plans run");
  });

  test("unresolvable zone fails closed with a non-zero exit", () => {
    const { cfctl, state } = fixture({ zoneFound: false });
    const out = run(["--apply", "--desired-state", state, "--cfctl", cfctl, "--json"]);
    expect(out.status).toBe(1);
    const d = JSON.parse(out.stdout).domains[0];
    expect(d.zone_error).toContain("no active zone named example.com");
  });
});

function run(scriptArgs: string[]) {
  return spawnSync("bun", ["run", "scripts/provision-email-routing.ts", "--", ...scriptArgs], {
    cwd: root,
    encoding: "utf8",
  });
}

function fixture(scenario: Scenario, withGoogle = false) {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-provision-"));
  const logPath = join(dir, "cfctl.log");
  const cfctl = fakeCfctl(dir, logPath, scenario);
  const state = join(dir, "desired-state.json");
  const domains: unknown[] = [
    {
      name: "example.com",
      inbound_mx_provider: "cloudflare_email_routing",
      role_aliases: ["founders", "support"],
      personal_aliases: [],
    },
  ];
  if (withGoogle) {
    domains.push({
      name: "legacy.example.net",
      inbound_mx_provider: "google_workspace",
      role_aliases: ["info"],
      personal_aliases: [],
    });
  }
  writeFileSync(state, JSON.stringify({
    domains,
    workers: {
      relay_router: { script_name: "maildesk-cf-router", config: "deploy/mail-router/wrangler.toml" },
      relay_outbound: { script_name: "maildesk-cf-relay-outbound", config: "deploy/mail-outbound/wrangler.toml" },
      routing_health: { script_name: "maildesk-cf-routing-health", config: "deploy/routing-health/wrangler.toml" },
    },
    storage: {
      d1_database: "maildesk-cf-relay-db",
      r2_policy_bucket: "maildesk-cf-policy",
      r2_spool_bucket: "maildesk-cf-relay-spool",
      queue: "maildesk-cf-relay-jobs",
      dead_letter_queue: "maildesk-cf-relay-dlq",
    },
  }));
  return { cfctl, logPath, state };
}

function fakeCfctl(dir: string, logPath: string, s: Scenario): string {
  const enabled = s.enabled ? "true" : "false";
  const rules = JSON.stringify(
    (s.existingRuleAddresses ?? []).map((addr) => ({
      name: `maildesk:${addr}`,
      matchers: [{ type: "literal", field: "to", value: addr }],
      actions: [{ type: "worker", value: ["maildesk-cf-router"] }],
    })),
  );
  const zoneResult = s.zoneFound === false ? "[]" : '[{"name":"example.com","status":"active","id":"zone-123"}]';
  const mx = s.mxContent ?? "mx.cloudflare.net";
  const path = join(dir, "cfctl");
  writeFileSync(
    path,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
case "$*" in
  *"call zones-get"*) echo '{"ok":true,"result":${zoneResult}}' ;;
  *"settings-get-email-routing-settings"*) echo '{"ok":true,"result":{"enabled":${enabled}}}' ;;
  *"rules-list-routing-rules"*) echo '{"ok":true,"result":${rules.replace(/'/g, "'\\''")}}' ;;
  *"list-dns-records"*) echo '{"ok":true,"result":[{"content":"${mx}"}]}' ;;
  *"call email-routing-settings-enable"*) echo '{"ok":true,"operation_id":"op-enable"}' ;;
  *"call email-routing-routing-rules-create"*) echo '{"ok":true,"operation_id":"op-rule"}' ;;
  *"plans approve"*) echo '{"ok":true}' ;;
  *"plans run"*) echo '{"ok":true,"performed":true}' ;;
  *) echo '{"ok":true}' ;;
esac
`,
  );
  chmodSync(path, 0o755);
  return path;
}
