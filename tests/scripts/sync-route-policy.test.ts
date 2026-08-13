import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

test("private-scale policy projection activates one immutable revision atomically", () => {
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
    const sqlLog = join(directory, "projection.sql");
    const outputSql = join(directory, "governed-projection.sql");
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
        "--out",
        outputSql,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
          MAILDESK_POLICY_SQL_LOG: sqlLog,
        },
      },
    );

    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout) as {
      routes: number;
      policy_sha256: string;
      desired_state_sha256: string;
      policy_r2_key: string;
      projection_sha256: string;
    };
    expect(summary.routes).toBe(141);
    expect(summary.policy_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(summary.desired_state_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(summary.policy_r2_key).toBe(`config/policy/${summary.policy_sha256}.json`);
    expect(summary.projection_sha256).toMatch(/^[a-f0-9]{64}$/);
    const sql = readFileSync(sqlLog, "utf8");
    expect(readFileSync(outputSql, "utf8")).toBe(sql);
    expect(sql.match(/BEGIN TRANSACTION;/g)).toHaveLength(1);
    expect(sql.match(/COMMIT;/g)).toHaveLength(1);
    expect(sql.indexOf("UPDATE alias_routes SET enabled = 0")).toBeLessThan(sql.indexOf("enabled, policy_sha256"));
    expect(sql.lastIndexOf("INSERT INTO runtime_state")).toBeGreaterThan(sql.lastIndexOf("INSERT INTO route_health"));
    expect(sql.lastIndexOf("INSERT INTO policy_projection_state")).toBeGreaterThan(sql.lastIndexOf("INSERT INTO runtime_state"));
    expect(sql).toContain(summary.projection_sha256);
    expect(sql).toContain(summary.policy_r2_key);
    expect(sql).toContain("route:example.com:team%2Bops");
    expect(sql).toContain("route:example.com:team_ops");
    expect(sql).toContain("'excluded'");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
