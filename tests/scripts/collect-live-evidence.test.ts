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
        "--out",
        out,
        "--no-resend",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    const evidence = JSON.parse(readFileSync(out, "utf8")) as {
      email_routing?: Record<string, { role_aliases: string[] }>;
    };
    expect(evidence.email_routing?.["example.com"]?.role_aliases).toEqual(["security"]);
  }, 15_000);
});
