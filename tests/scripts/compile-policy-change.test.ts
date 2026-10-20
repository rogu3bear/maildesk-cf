import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { compilePolicyChange } from "../../scripts/compile-policy-change";
import { projectRoutes, projectionSql } from "../../scripts/sync-route-policy";
import { authorizeReplyWithPolicy, type RouterPolicy } from "../../workers/shared/router";
import { assertPolicyInventory, POLICY_INVENTORY_SQL, type PolicyInventoryRow } from "../../workers/shared/policy-inventory";

const root = resolve(import.meta.dir, "../..");
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const desired = JSON.stringify({ storage: { d1_database: "fixture" }, domains: [{
  name: "example.com", inbound_mx_provider: "cloudflare_email_routing",
  role_aliases: ["support", "info", "privacy"], personal_aliases: ["owner"],
}] });
function policy(members = ["operator-a@example.net", "operator-b@example.net"]): RouterPolicy {
  return { policy_version: 2, default_reply_mode: "role_first", accountables: { "team:ops": { kind: "team" } },
    destinations: { shared: { accountable_ref: "team:ops", target: { kind: "mailbox", recipients: members } } },
    domains: { "example.com": { role_aliases: {
      support: { destination_ref: "shared", reply_identity: "support@example.com" },
      info: { destination_ref: "shared", reply_identity: "info@example.com" },
      privacy: { operators: ["operator-a@example.net"], reply_identity: "privacy@example.com" },
    }, personal_aliases: { owner: { operator: "operator-a@example.net", reply_identity: "owner@example.com" } } } } };
}
const base = JSON.stringify(policy());
const candidate = JSON.stringify(policy(["operator-a@example.net", "operator-c@example.net"]));
function compile(next = candidate, prior = base, baseDesired = desired, nextDesired = desired) {
  return compilePolicyChange({ basePolicy: prior, baseDesiredState: baseDesired,
    candidatePolicy: next, candidateDesiredState: nextDesired });
}
function database() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(join(root, "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(root, "migrations", name), "utf8"));
  }
  const routes = projectRoutes(JSON.parse(base), JSON.parse(desired));
  db.transaction(() => db.exec(projectionSql(routes, digest(base), `config/policy/${digest(base)}.json`, digest(desired)).sql))();
  return db;
}

function apply(db: Database, sql: string) {
  // Generated projection statements are one per line. Execute individually
  // inside one transaction: Bun exec() can lose an early trigger error when a
  // later statement succeeds, which would not model an atomic D1 batch/import.
  return db.transaction(() => {
    for (const statement of sql.trim().split("\n")) db.query(statement).run();
  })();
}

test("shared-group review lists exact changed aliases and preserves restricted/personal routes", () => {
  const result = compile();
  expect(result.review.affected_routes.map((change) => change.after?.localPart)).toEqual(["info", "support"]);
  for (const change of result.review.affected_routes) {
    expect(change.added_members).toEqual(["operator-c@example.net"]);
    expect(change.removed_members).toEqual(["operator-b@example.net"]);
    expect(change.after?.defaultReplyIdentity).toBe(change.before?.defaultReplyIdentity!);
  }
  expect(result.review.unchanged_routes).toBe(2);
  expect(result.review.requires_route_requalification).toHaveLength(4);
  expect(compile()).toEqual(result);
  expect(result.review.sql_sha256).toBe(digest(result.sql));
  expect(result.sql.indexOf("INSERT INTO policy_change_reviews")).toBeLessThan(result.sql.indexOf("UPDATE alias_routes"));
  expect(result.review).toMatchObject({ performed: false, execution_supported: false, status: "proposed" });
});

test("atomic membership transition preserves prior policy bytes, exact inventory and reply isolation", () => {
  const db = database();
  try {
    const old = db.query("SELECT * FROM policy_revisions").get();
    apply(db, compile().sql);
    const rows = db.query(POLICY_INVENTORY_SQL).all() as PolicyInventoryRow[];
    expect(() => assertPolicyInventory(JSON.parse(candidate), rows, digest(candidate))).not.toThrow();
    expect(db.query("SELECT active_policy_sha256 FROM runtime_state").get()).toEqual({ active_policy_sha256: digest(candidate) });
    const historical = db.query("SELECT * FROM policy_revisions WHERE policy_sha256=?").get(digest(base)) as Record<string, unknown>;
    const { superseded_at: _oldSuperseded, ...immutable } = old as Record<string, unknown>;
    expect(historical).toMatchObject(immutable);
    expect(historical.superseded_at).toBeString();
    expect(db.query("SELECT count(*) AS n FROM policy_change_reviews").get()).toEqual({ n: 1 });
    expect(authorizeReplyWithPolicy(JSON.parse(candidate), { envelopeTo: "support@example.com", operator: "operator-b@example.net" }).ok).toBe(false);
    expect(authorizeReplyWithPolicy(JSON.parse(candidate), { envelopeTo: "support@example.com", operator: "operator-c@example.net", requestedIdentity: "privacy@example.com" }).ok).toBe(false);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});

for (const field of ["policy", "desired"] as const) {
  test(`review against stale ${field} aborts before any replacement`, () => {
    const db = database();
    try {
      if (field === "desired") db.run("UPDATE policy_projection_state SET value=? WHERE key='active_desired_state_sha256'", ["e".repeat(64)]);
      const result = field === "policy" ? compile(candidate, JSON.stringify(policy(["operator-a@example.net"]))) : compile();
      const snapshot = db.serialize();
      expect(() => apply(db, result.sql)).toThrow("policy change base changed");
      expect(db.serialize()).toEqual(snapshot);
    } finally { db.close(); }
  });
}

test("a later failure rolls back membership, runtime pointer and review record together", () => {
  const db = database();
  try {
    const before = db.serialize();
    expect(() => apply(db, compile().sql + "\nINSERT INTO nonexistent_table VALUES (1);")).toThrow();
    expect(db.serialize()).toEqual(before);
    apply(db, compile().sql);
    expect(() => apply(db, compile().sql)).toThrow();
    expect(() => db.run("DELETE FROM policy_change_reviews")).toThrow("history must be retained");
    expect(() => db.run("UPDATE policy_change_reviews SET applied_at='changed'")).toThrow("immutable");
  } finally { db.close(); }
});

test("invalid or empty group is rejected before producing an import", () => {
  expect(() => compile(JSON.stringify(policy([])))).toThrow();
  expect(() => compile("{}" )).toThrow();
});

test("removed aliases and changed inbound providers appear in the review", () => {
  const nextPolicy = policy(); delete nextPolicy.domains["example.com"]!.role_aliases.info;
  const nextDesired = JSON.parse(desired); nextDesired.domains[0].role_aliases = ["support", "privacy"];
  nextDesired.domains[0].inbound_mx_provider = "excluded";
  const result = compile(JSON.stringify(nextPolicy), base, desired, JSON.stringify(nextDesired));
  expect(result.review.affected_routes).toHaveLength(4);
  expect(result.review.affected_routes.find((change) => change.before?.localPart === "info")?.after).toBeNull();
});

test("CLI writes private exclusive artifacts, exposes no members and refuses remote execution", () => {
  const dir = mkdtempSync(join(tmpdir(), "maildesk-policy-change-"));
  try {
    const values = { "base-policy": base, "base-desired-state": desired, policy: candidate, "desired-state": desired };
    const args = Object.entries(values).flatMap(([name, value]) => {
      const path = join(dir, name + ".json"); writeFileSync(path, value); return ["--" + name, path];
    });
    const output = join(dir, "review"); args.push("--out-dir", output);
    const run = (extra: string[] = []) => spawnSync("bun", ["scripts/compile-policy-change.ts", ...args, ...extra], { cwd: root, encoding: "utf8" });
    const result = run(); expect(result.status).toBe(0); expect(result.stdout).not.toContain("operator-");
    expect(statSync(join(output, "review.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(output, "projection.sql")).mode & 0o777).toBe(0o600);
    const old = readFileSync(join(output, "review.json"), "utf8");
    expect(run().status).toBe(1); expect(readFileSync(join(output, "review.json"), "utf8")).toBe(old);
    expect(run(["--remote"]).status).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
