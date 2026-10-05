import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

test("the heartbeat Worker config binds D1 and has no Email binding", () => {
  const config = Bun.TOML.parse(readFileSync(resolve(import.meta.dir, "../../wrangler.mail-heartbeat.toml"), "utf8")) as Record<string, unknown>;
  expect(config.send_email).toBeUndefined();
  expect(config.d1_databases).toHaveLength(1);
  expect(config.triggers).toEqual({ crons: ["0 * * * *"] });
});
import { runHeartbeat, type HeartbeatEnv } from "../../workers/mail-heartbeat/src/index";

const now = Date.parse("2026-10-05T12:00:00Z");

test("a fresh idle canary ledger pings an external https endpoint and does not send mail", async () => {
  const db = database();
  const calls: string[] = [];
  try {
    db.run("UPDATE mail_canary_state SET last_notified_at_ms = ?, attempt_state = 'idle' WHERE singleton = 1", [now - 60_000]);
    db.run("INSERT INTO route_proof_ledger (route_id, plane, policy_sha256, verified_at_ms, updated_at_ms) VALUES ('route:example.com:postmaster', 'configuration', ?, ?, ?)", ["a".repeat(64), now, now]);
    const env = envFor(db);
    expect(await runHeartbeat(env, async (input) => {
      calls.push(String(input));
      return new Response(null, { status: 202 });
    }, now)).toBe("sent");
    expect(calls).toEqual(["https://heartbeat.example.com/maildesk"]);
    expect(JSON.stringify(env)).not.toContain("EMAIL");
  } finally { db.close(); }
});

test("dead ledger, incomplete notification, disabled mode, and non-https targets do not ping", async () => {
  const db = database();
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(null, { status: 202 });
  };
  try {
    const env = envFor(db);
    await expect(runHeartbeat(env, fetchImpl, now)).rejects.toThrow("withheld");
    db.run("UPDATE mail_canary_state SET last_notified_at_ms = ?, attempt_state = 'uncertain' WHERE singleton = 1", [now]);
    db.run("INSERT INTO route_proof_ledger (route_id, plane, policy_sha256, verified_at_ms, updated_at_ms) VALUES ('route:example.com:postmaster', 'configuration', ?, ?, ?)", ["a".repeat(64), now, now]);
    await expect(runHeartbeat(env, fetchImpl, now)).rejects.toThrow("withheld");
    db.run("UPDATE mail_canary_state SET attempt_state = 'idle'");
    db.run("UPDATE route_proof_ledger SET updated_at_ms = ?", [now - 3 * 3_600_000]);
    await expect(runHeartbeat(env, fetchImpl, now)).rejects.toThrow("withheld");
    expect(await runHeartbeat({ ...env, MAILDESK_HEARTBEAT_MODE: "disabled" }, fetchImpl, now)).toBeNull();
    await expect(runHeartbeat({ ...env, MAILDESK_HEARTBEAT_URL: "http://heartbeat.example.com/maildesk" }, fetchImpl, now)).rejects.toThrow("explicit https");
    expect(calls).toBe(0);
  } finally { db.close(); }
});

function database(): Database {
  const db = new Database(":memory:");
  const root = resolve(import.meta.dir, "../..");
  for (const file of readdirSync(resolve(root, "migrations")).sort()) {
    if (file.endsWith(".sql")) db.exec(readFileSync(resolve(root, "migrations", file), "utf8"));
  }
  db.run("INSERT INTO domains (id, domain) VALUES ('domain:example.com', 'example.com')");
  db.run("INSERT INTO identities (id, domain_id, address, kind) VALUES ('identity:postmaster%40example.com', 'domain:example.com', 'postmaster@example.com', 'role')");
  db.run("INSERT INTO policy_revisions (policy_sha256, r2_object_key, expected_domain_count, expected_route_count) VALUES (?, 'config/policy/a.json', 1, 1)", ["a".repeat(64)]);
  db.run("INSERT INTO alias_routes (id, domain_id, local_part, kind, default_reply_identity_id, policy_sha256) VALUES ('route:example.com:postmaster', 'domain:example.com', 'postmaster', 'role', 'identity:postmaster%40example.com', ?)", ["a".repeat(64)]);
  return db;
}

function envFor(db: Database): HeartbeatEnv {
  return {
    DB: {
      prepare(sql: string) {
        let values: unknown[] = [];
        return {
          bind(...next: unknown[]) { values = next; return this; },
          async first() { return db.query(sql).get(...values); },
        };
      },
    },
    MAILDESK_HEARTBEAT_MODE: "enabled",
    MAILDESK_HEARTBEAT_URL: "https://heartbeat.example.com/maildesk",
    MAILDESK_HEARTBEAT_MAX_AGE_HOURS: "2",
  } as unknown as HeartbeatEnv;
}
