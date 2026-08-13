import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
    const policyObject = resolve(root, "config/policy.example.json");
    const desiredObject = resolve(root, "config/desired-state.example.json");
    const policySha256 = createHash("sha256").update(readFileSync(policyObject)).digest("hex");
    const policyKey = `config/policy/${policySha256}.json`;
    const projection = projectionSummary(policyObject, desiredObject);
    const d1Result = JSON.stringify([{ results: [{
      active_policy_sha256: policySha256,
      active_policy_r2_key: policyKey,
      revision_r2_key: policyKey,
      expected_domain_count: 1,
      expected_route_count: 11,
      projected_domain_count: 1,
      projected_route_count: 11,
      projection_policy_sha256: policySha256,
      active_desired_state_sha256: projection.desired_state_sha256,
      active_projection_sha256: projection.projection_sha256,
      route_address: "security@example.com",
      route_kind: "role_alias",
      operator_count: 2,
      reply_identity: "security@example.com",
      policy_sha256: policySha256,
      last_inbound_provider_accepted_at: "2026-08-13T00:00:00.000Z",
      last_inbound_provider_message_ids_json: JSON.stringify(["provider-a", "provider-b"]),
      last_inbox_verified_at: "2026-08-13T00:01:00.000Z",
    }] }]);
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
if [ "$1" = "r2" ]; then
  cat "$MAILDESK_TEST_POLICY_OBJECT"
  exit 0
fi
echo '${d1Result}'
exit 0
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
      { cwd: root, encoding: "utf8", env: { ...process.env, MAILDESK_TEST_POLICY_OBJECT: policyObject } },
    );

    expect(result.status).toBe(0);
    const evidence = JSON.parse(readFileSync(out, "utf8")) as {
      email_routing?: Record<string, { role_aliases: string[] }>;
      inbound_proofs?: Record<string, Record<string, unknown>>;
      active_policy?: Record<string, unknown>;
    };
    expect(evidence.email_routing?.["example.com"]?.role_aliases).toEqual(["security"]);
    expect(evidence.active_policy).toMatchObject({
      active_policy_sha256: policySha256,
      active_policy_r2_key: policyKey,
      revision_r2_key: policyKey,
      object_key: policyKey,
      object_sha256: policySha256,
      expected_route_count: 11,
      projected_route_count: 11,
      projection_policy_sha256: policySha256,
      active_desired_state_sha256: projection.desired_state_sha256,
      active_projection_sha256: projection.projection_sha256,
    });
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

function projectionSummary(policyPath: string, desiredPath: string) {
  const result = spawnSync(
    "bun",
    ["run", "scripts/sync-route-policy.ts", "--", "--policy", policyPath, "--desired-state", desiredPath],
    { cwd: root, encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as {
    desired_state_sha256: string;
    projection_sha256: string;
  };
}
