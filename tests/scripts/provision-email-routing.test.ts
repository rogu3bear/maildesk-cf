import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dir, "../..");

interface Scenario {
  zoneFound?: boolean;
  enabled?: boolean;
  existingRuleAddresses?: string[];
  mxContent?: string;
  catchAllEnabled?: boolean;
  ruleReadFails?: boolean;
  ruleDisabled?: boolean;
  ruleProjection?: unknown;
}

describe("governed email-routing provisioning reconciler", () => {
  test("a complete multi-page projection reconciles hashed aliases without raw pagination queries", () => {
    const addresses = ["founders@example.com", "support@example.com",
      ...Array.from({ length: 100 }, (_, index) => `extra${index}@example.com`)];
    const { cfctl, state, logPath } = fixture({ zoneFound: true, enabled: true, existingRuleAddresses: addresses });
    const result = run(["--desired-state", state, "--cfctl", cfctl, "--json"]);
    expect(result.status, result.stderr).toBe(0);
    const domain = JSON.parse(result.stdout).domains[0];
    expect(domain.pending).toEqual([]);
    expect(domain.failed).toEqual([]);
    expect(domain.already).toContain("rule:founders@example.com");
    const call = readFileSync(logPath, "utf8").split("\n").find((line) => line.includes("rules-list-routing-rules"));
    expect(call).not.toContain("--query");
  });

  test("incomplete, malformed and raw rule inventories never manufacture missing aliases", () => {
    for (const ruleProjection of [[],
      { schema_version: 1, complete: false, page_size: 50, pages: 1, rule_count: 0, rules: [] },
      { schema_version: 1, complete: true, page_size: 50, pages: 1, rule_count: 1, rules: [] },
      { schema_version: 1, complete: true, page_size: 100, pages: 1, rule_count: 0, rules: [] },
      { schema_version: 1, complete: true, page_size: 50, pages: 2, rule_count: 1, rules: [{ enabled: true }] },
    ]) {
      const { cfctl, state } = fixture({ zoneFound: true, enabled: true, ruleProjection });
      const result = run(["--desired-state", state, "--cfctl", cfctl, "--json"]);
      expect(result.status).toBe(1);
      const domain = JSON.parse(result.stdout).domains[0];
      expect(domain.pending).toEqual([]);
      expect(domain.failed).toContainEqual({ item: "read:rules", reason: "routing rule inventory unavailable, malformed or incomplete" });
    }
  });

  test("duplicate projected rules are drift, not convergence", () => {
    const { cfctl, state } = fixture({ zoneFound: true, enabled: true,
      existingRuleAddresses: ["founders@example.com", "founders@example.com", "support@example.com"] });
    const result = run(["--desired-state", state, "--cfctl", cfctl, "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).domains[0].already).not.toContain("rule:founders@example.com");
  });

  test("catch-all enable and disable emit concrete requests without executing", () => {
    for (const desiredEnabled of [true, false]) {
      const { cfctl, state } = fixture({ zoneFound: true, enabled: true, catchAllEnabled: !desiredEnabled });
      const desired = JSON.parse(readFileSync(state, "utf8"));
      desired.domains[0].catch_all = desiredEnabled;
      writeFileSync(state, JSON.stringify(desired));
      const result = run(["--desired-state", state, "--cfctl", cfctl, "--json"]);
      expect(result.status).toBe(0);
      const pending = JSON.parse(result.stdout).domains[0].pending.find((item: any) => item.item === "catch-all");
      expect(pending.request).toEqual({ capability_id: "email-routing-routing-rules-update-catch-all-rule",
        selectors: { zone_id: "zone-123" }, body: { name: "maildesk:catch-all", enabled: desiredEnabled,
          matchers: [{ type: "all" }], actions: desiredEnabled ? [{ type: "worker", value: ["maildesk-cf-router"] }] : [{ type: "drop" }] } });
    }
  });

  test("failed rule reads do not manufacture create requests; disabled rules fail closed", () => {
    for (const scenario of [{ ruleReadFails: true }, { existingRuleAddresses: ["founders@example.com"], ruleDisabled: true }]) {
      const { cfctl, state } = fixture({ zoneFound: true, enabled: true, ...scenario });
      const result = run(["--desired-state", state, "--cfctl", cfctl, "--json"]);
      expect(result.status).toBe(1);
      const domain = JSON.parse(result.stdout).domains[0];
      expect(domain.failed.length).toBeGreaterThan(0);
      if ("ruleReadFails" in scenario) expect(domain.pending).toEqual([]);
      expect(domain.already).not.toContain("rule:founders@example.com (drift)");
    }
  });

  test("third-party root MX and unknown domain filters cannot produce successful convergence", () => {
    const { cfctl, state } = fixture({ zoneFound: true, enabled: true, mxContent: "aspmx.l.google.com" });
    expect(run(["--desired-state", state, "--cfctl", cfctl, "--json"]).status).toBe(1);
    const unknown = run(["--desired-state", state, "--cfctl", cfctl, "--domain", "absent.example.com", "--json"]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("absent from desired state");
  });

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

  test("idempotent: already-enabled zone with all rules present plans nothing", () => {
    const { cfctl, state } = fixture({
      zoneFound: true,
      enabled: true,
      existingRuleAddresses: ["founders@example.com", "support@example.com"],
    });
    const out = run(["--plan", "--desired-state", state, "--cfctl", cfctl, "--json"]);
    expect(out.status).toBe(0);
    const d = JSON.parse(out.stdout).domains[0];
    expect(d.applied).toEqual([]);
    expect(d.already.sort()).toEqual(["catch-all", "enable-routing", "rule:founders@example.com", "rule:support@example.com"]);
    expect(d.failed).toEqual([]);
  });

  test("non-cloudflare domains are skipped, never mutated", () => {
    const { cfctl, state } = fixture({ zoneFound: true, enabled: false, existingRuleAddresses: [] }, /*withGoogle*/ true);
    const out = run(["--plan", "--desired-state", state, "--cfctl", cfctl, "--json"]);
    const s = JSON.parse(out.stdout);
    expect(s.skipped_non_cloudflare).toEqual([{ domain: "legacy.example.net", provider: "google_workspace" }]);
    expect(s.domains.map((d: { domain: string }) => d.domain)).toEqual(["example.com"]);
  });

  test("rejects direct apply before invoking cfctl", () => {
    const { cfctl, logPath, state } = fixture({ zoneFound: true, enabled: false, existingRuleAddresses: ["founders@example.com"] });
    const out = run(["--apply", "--desired-state", state, "--cfctl", cfctl, "--json"]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("direct --apply mode is retired");
    expect(existsSync(logPath)).toBe(false);
  });

  test("unresolvable zone fails closed with a non-zero exit", () => {
    const { cfctl, state } = fixture({ zoneFound: false });
    const out = run(["--plan", "--desired-state", state, "--cfctl", cfctl, "--json"]);
    expect(out.status).toBe(1);
    const d = JSON.parse(out.stdout).domains[0];
    expect(d.zone_error).toContain("no active zone named example.com");
  });

  test("binds every governed read to the explicit profile and its account", () => {
    const { cfctl, logPath, state } = fixture({ zoneFound: true, enabled: true, existingRuleAddresses: [] });
    const out = run(["--plan", "--desired-state", state, "--cfctl", cfctl, "--json"]);
    expect(out.status, out.stderr).toBe(0);
    const log = readFileSync(logPath, "utf8");
    for (const line of log.trim().split("\n").filter((line) => line.startsWith("call "))) {
      expect(line).toContain("--profile profile-example --account account-example --json");
    }
    expect(log).not.toContain("plans approve");
    expect(log).not.toContain("plans run");
  });
});

function run(scriptArgs: string[]) {
  return spawnSync("bun", [
    "run",
    "scripts/provision-email-routing.ts",
    "--",
    ...scriptArgs,
    "--profile",
    "profile-example",
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "account-example" },
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
      relay_router: { script_name: "maildesk-cf-router", config: "wrangler.mail-router.toml" },
      relay_outbound: { script_name: "maildesk-cf-relay-outbound", config: "wrangler.mail-outbound.toml" },
      routing_health: { script_name: "maildesk-cf-routing-health", config: "wrangler.routing-health.toml" },
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
  const rules =
    (s.existingRuleAddresses ?? []).map((addr) => ({
      enabled: !s.ruleDisabled,
      matchers: [{ matcher_type: "literal", field: "to", value_sha256: `sha256:${createHash("sha256").update(addr).digest("hex")}` }],
      actions: [{ action_type: "worker", worker_targets: ["maildesk-cf-router"], value_count: 1 }],
    }));
  const projection = JSON.stringify(s.ruleProjection ?? {
    schema_version: 1, complete: true, page_size: 50, pages: Math.ceil(rules.length / 50) + 1,
    rule_count: rules.length, rules,
  });
  const zoneResult = s.zoneFound === false ? "[]" : '[{"name":"example.com","status":"active","id":"zone-123"}]';
  const mx = s.mxContent ?? "route1.mx.cloudflare.net";
  const path = join(dir, "cfctl");
  writeFileSync(
    path,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
case "$*" in
  "auth profiles --json") echo '{"schema_version":2,"ok":true,"performed":false,"result":{"profiles":[{"id":"profile-example","account_id":"account-example"}]},"error":null}' ;;
  *"call zones-get"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"zones-get","profile_id":"profile-example","account_id":"account-example","evidence":[{"content_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"result":{"result":${zoneResult}},"error":null}' ;;
  *"settings-get-email-routing-settings"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"email-routing-settings-get-email-routing-settings","profile_id":"profile-example","account_id":"account-example","evidence":[{"content_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"result":{"result":{"enabled":${enabled}}},"error":null}' ;;
  *"rules-list-routing-rules"*) echo '{"schema_version":2,"ok":${!s.ruleReadFails},"performed":true,"capability_id":"email-routing-routing-rules-list-routing-rules","profile_id":"profile-example","account_id":"account-example","evidence":[{"content_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"result":{"result":${projection.replace(/'/g, "'\\''")}},"error":null}' ;;
  *"get-catch-all-rule"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"email-routing-routing-rules-get-catch-all-rule","profile_id":"profile-example","account_id":"account-example","evidence":[{"content_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"result":{"result":{"enabled":${s.catchAllEnabled ?? false},"matchers":[{"type":"all"}],"actions":[{"type":"worker","value":["maildesk-cf-router"]}]}},"error":null}' ;;
  *"list-dns-records"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"dns-records-for-a-zone-list-dns-records","profile_id":"profile-example","account_id":"account-example","evidence":[{"content_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"result":{"result":[{"content":"${mx}"}]},"error":null}' ;;
  *) echo '{"schema_version":2,"ok":false,"performed":false,"error":{"code":"UNEXPECTED_CALL"}}' ;;
esac
`,
  );
  chmodSync(path, 0o755);
  return path;
}

test("configured account mismatch stops routing before any provider read", () => {
  const { cfctl, logPath, state } = fixture({});
  const desired = JSON.parse(readFileSync(state, "utf8")); desired.project = { account_id: "different-account" }; writeFileSync(state, JSON.stringify(desired));
  const result = spawnSync("bun", ["run", "scripts/provision-email-routing.ts", "--profile", "profile-example", "--desired-state", state, "--cfctl", cfctl], { cwd: root, encoding: "utf8", env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "" } });
  expect(result.status).toBe(1); expect(result.stderr).toContain("does not match");
  expect(readFileSync(logPath, "utf8").trim()).toBe("auth profiles --json");
});
