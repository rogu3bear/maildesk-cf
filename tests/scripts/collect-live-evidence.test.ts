import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

describe("maildesk live-evidence collector", () => {
  test("the tracked canonical desired state selects the relay-router service", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-collect-evidence-"));
    const cfctl = join(dir, "cfctl");
    const wrangler = join(dir, "wrangler");
    const out = join(dir, "evidence.json");
    writeFileSync(
      cfctl,
      `#!/bin/sh
case "$*" in
  *"maildesk-cf verify"*) echo '{"ok":false}' ;;
  *"list zone"*) echo '{"ok":true,"result":[]}' ;;
  *"list email.routing_rule"*) echo '{"ok":true,"result":[{"recipient":"security@example.com","enabled":true,"actions":[{"type":"worker","value":["maildesk-cf-router"]}]}]}' ;;
  *"list dns.record"*) echo '{"ok":true,"result":[]}' ;;
  *) echo '{"ok":false}' ;;
esac
`,
    );
    chmodSync(cfctl, 0o755);
    writeFileSync(
      wrangler,
      `#!/bin/sh
echo '[{"results":[{"route_address":"security@example.com","route_kind":"role_alias","operator_count":2,"reply_identity":"security@example.com","policy_sha256":"${"a".repeat(64)}","last_inbound_provider_accepted_at":"2026-08-13T00:00:00.000Z","last_inbound_provider_message_ids_json":"[\\"provider-a\\",\\"provider-b\\"]","last_inbox_verified_at":"2026-08-13T00:01:00.000Z"}]}]'
`,
    );
    chmodSync(wrangler, 0o755);

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/collect-live-evidence.ts",
        "--",
        "--policy",
        "config/policy.example.json",
        "--desired-state",
        "config/desired-state.example.json",
        "--cfctl",
        cfctl,
        "--wrangler",
        wrangler,
        "--out",
        out,
        "--no-resend",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    const evidence = JSON.parse(readFileSync(out, "utf8")) as {
      email_routing?: Record<string, { role_aliases: string[] }>;
      inbound_proofs?: Record<string, Record<string, unknown>>;
    };
    expect(evidence.email_routing?.["example.com"]?.role_aliases).toEqual(["security"]);
    expect(evidence.inbound_proofs?.["example.com"]).toMatchObject({
      status: "ok",
      envelope_to: "security@example.com",
      route_kind: "role_alias",
      operator_count: 2,
      provider_message_ids: ["provider-a", "provider-b"],
      default_reply_identity: "security@example.com",
    });
    expect(JSON.stringify(evidence.inbound_proofs)).not.toContain("forwarded_to");
    expect(JSON.stringify(evidence.inbound_proofs)).not.toContain("raw_r2_key");
    expect(JSON.stringify(evidence.inbound_proofs)).not.toContain("operator@");
  }, 15_000);
});
