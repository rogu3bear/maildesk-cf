import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

test("private-scale policy projection is split into bounded local D1 batches", () => {
  const directory = mkdtempSync(join(tmpdir(), "maildesk-policy-batches-"));
  try {
    const aliases = Object.fromEntries([
      ...Array.from({ length: 138 }, (_, index) => [
        `role-${String(index + 1).padStart(3, "0")}`,
        {
          operators: ["operator-a@example.net", "operator-b@example.net"],
          reply_identity: `role-${String(index + 1).padStart(3, "0")}@example.com`,
        },
      ] as const),
      ["team+ops", {
        operators: ["operator-a@example.net", "operator-b@example.net"],
        reply_identity: "team+ops@example.com",
      }],
      ["team_ops", {
        operators: ["operator-a@example.net", "operator-b@example.net"],
        reply_identity: "team_ops@example.com",
      }],
    ]);
    const policyPath = join(directory, "policy.json");
    const desiredPath = join(directory, "desired.json");
    const binDirectory = join(directory, "bin");
    const batchLog = join(directory, "batches.log");
    const sqlLog = join(directory, "projection.sql");
    writeFileSync(
      policyPath,
      JSON.stringify({
        domains: {
          "example.com": {
            role_aliases: aliases,
            personal_aliases: {},
            catch_all: {
              operators: ["operator-a@example.net", "operator-b@example.net"],
              reply_identity: "info@example.com",
            },
          },
        },
      }),
    );
    writeFileSync(
      desiredPath,
      JSON.stringify({
        storage: { d1_database: "maildesk-test" },
        domains: [
          {
            name: "example.com",
            inbound_mx_provider: "excluded",
            role_aliases: Object.keys(aliases),
            personal_aliases: [],
            catch_all: true,
          },
        ],
      }),
    );
    mkdirSync(binDirectory);
    const fakeBunx = join(binDirectory, "bunx");
    writeFileSync(
      fakeBunx,
      `#!/bin/sh
set -eu
file=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--file" ]; then
    shift
    file="$1"
  fi
  shift
done
[ -n "$file" ]
bytes=$(wc -c < "$file" | tr -d ' ')
[ "$bytes" -le 49152 ]
printf '%s\n' "$bytes" >> "$MAILDESK_POLICY_BATCH_LOG"
cat "$file" >> "$MAILDESK_POLICY_SQL_LOG"
`,
      { mode: 0o700 },
    );
    chmodSync(fakeBunx, 0o700);

    const result = spawnSync(
      "bun",
      [
        "scripts/sync-route-policy.ts",
        "--policy",
        policyPath,
        "--desired-state",
        desiredPath,
        "--local",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
          MAILDESK_POLICY_BATCH_LOG: batchLog,
          MAILDESK_POLICY_SQL_LOG: sqlLog,
        },
      },
    );

    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout) as { routes: number; local_batches: number };
    const batchSizes = readFileSync(batchLog, "utf8").trim().split("\n").map(Number);
    expect(summary.routes).toBe(141);
    expect(summary.local_batches).toBeGreaterThan(1);
    expect(batchSizes).toHaveLength(summary.local_batches);
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(48 * 1024);
    const sql = readFileSync(sqlLog, "utf8");
    expect(sql).toContain("route:example.com:team%2Bops");
    expect(sql).toContain("route:example.com:team_ops");
    expect(sql).toContain("'excluded'");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
