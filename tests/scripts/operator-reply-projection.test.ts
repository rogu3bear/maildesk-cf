import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { projectRoutes, projectionSql, type RouteProjectionDesiredState } from "../../scripts/sync-route-policy";
import { assertPolicyInventory, POLICY_INVENTORY_SQL, atomicPolicyRouteBindings, atomicPolicyRouteMatchSql, type PolicyInventoryRow } from "../../workers/shared/policy-inventory";
import { authorizeReplyWithPolicy, projectPolicy, routeInbound, type RouterPolicy } from "../../workers/shared/router";

const root = resolve(import.meta.dir, "../..");
const hash = "a".repeat(64), desiredHash = "b".repeat(64);
function fixture(): { policy: RouterPolicy; desired: RouteProjectionDesiredState } {
  return {
    policy: { default_reply_mode: "personal_first", domains: { "example.com": {
      role_aliases: { "a-support": { operators: ["operator-a@example.net", "operator-b@example.net"], reply_identity: "a-support@example.com" } },
      personal_aliases: {
        "operator-a": { operator: "operator-a@example.net", reply_identity: "operator-a@example.com" },
        "operator-b": { operator: "operator-b@example.net", reply_identity: "operator-b@example.com" },
      },
    } } },
    desired: { storage: { d1_database: "example-database" }, domains: [{ name: "example.com", inbound_mx_provider: "cloudflare_email_routing", role_aliases: ["a-support"], personal_aliases: ["operator-a", "operator-b"] }] },
  };
}
function database() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys=ON");
  for (const path of readdirSync(resolve(root, "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(resolve(root, "migrations", path), "utf8"));
  }
  return db;
}
function install(db: Database, policy: RouterPolicy, desired: RouteProjectionDesiredState) {
  const result = projectionSql(projectRoutes(policy, desired), hash, `config/policy/${hash}.json`, desiredHash);
  db.transaction(() => {
    // Generated projection statements occupy one line. Do not let a later
    // successful statement mask an earlier trigger failure in Database.exec.
    for (const line of result.sql.split("\n").filter((value) => value.trim() && !value.startsWith("--"))) db.exec(line);
  })();
}

test("personal-first projection installs exact operator mappings after all personal aliases exist", () => {
  const { policy, desired } = fixture(), db = database();
  try {
    install(db, policy, desired);
    const rows = db.query(POLICY_INVENTORY_SQL).all() as PolicyInventoryRow[];
    expect(() => assertPolicyInventory(policy, rows, hash)).not.toThrow();
    const support = rows.find((row) => row.local_part === "a-support")!;
    expect(JSON.parse(support.reply_identity_bindings_json)).toEqual([
      ["operator-a@example.net", "operator-a@example.com", "personal_first"],
      ["operator-b@example.net", "operator-b@example.com", "personal_first"],
    ]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});

test("another operator prefix and equal-count role substitutions cannot qualify the projection", () => {
  const { policy, desired } = fixture(), db = database();
  try {
    install(db, policy, desired);
    db.exec("DELETE FROM alias_route_reply_identities WHERE route_id = 'route:example.com:a-support' AND operator_id = 'operator:operator-a%40example.net'");
    expect(() => db.exec(`INSERT INTO alias_route_reply_identities VALUES ('route:example.com:a-support', 'operator:operator-a%40example.net', 'identity:operator-b%40example.com', '${hash}', 'personal_first')`)).toThrow("not in policy");
    db.exec(`INSERT INTO alias_route_reply_identities VALUES ('route:example.com:a-support', 'operator:operator-a%40example.net', 'identity:a-support%40example.com', '${hash}', 'role_first')`);
    expect(() => assertPolicyInventory(policy, db.query(POLICY_INVENTORY_SQL).all() as PolicyInventoryRow[], hash)).toThrow("identity projection");
    const decision = routeInbound(policy, { envelopeTo: "a-support@example.com", headerFrom: "outside@example.org" });
    if (!decision.ok) throw Error(decision.error.kind);
    const predicate = atomicPolicyRouteMatchSql("?6", 1);
    // This source-controlled literal is only the route selector; all expected
    // projection values remain bound parameters in the authority predicate.
    const query = predicate.replace("guard_ar.id = ?6 AND", "guard_ar.id = 'route:example.com:a-support' AND");
    const row = db.query(`SELECT ${query} AS allowed`).get(...atomicPolicyRouteBindings(decision.value)) as { allowed: number };
    expect(row.allowed).toBe(0);
  } finally { db.close(); }
});

test("group member removal removes its route mapping and fresh send-as authority", () => {
  const { policy, desired } = fixture(), db = database();
  try {
    install(db, policy, desired);
    policy.domains["example.com"]!.role_aliases["a-support"]!.operators = ["operator-b@example.net"];
    install(db, policy, desired);
    expect(() => assertPolicyInventory(policy, db.query(POLICY_INVENTORY_SQL).all() as PolicyInventoryRow[], hash)).not.toThrow();
    expect(authorizeReplyWithPolicy(policy, { envelopeTo: "a-support@example.com", operator: "operator-a@example.net" }).ok).toBe(false);
    expect(authorizeReplyWithPolicy(policy, { envelopeTo: "a-support@example.com", operator: "operator-b@example.net" })).toMatchObject({ ok: true, value: { fromIdentity: "operator-b@example.com" } });
    expect(projectPolicy(policy).ok).toBe(true);
  } finally { db.close(); }
});

test("a role default that references a personal identity cannot overwrite its identity kind by alias order", () => {
  const { policy, desired } = fixture(), db = database();
  try {
    const config = policy.domains["example.com"]!;
    config.role_aliases["z-support"] = { ...config.role_aliases["a-support"]!, reply_identity: "operator-a@example.com" };
    desired.domains[0]!.role_aliases.push("z-support");
    install(db, policy, desired);
    expect(db.query("SELECT kind FROM identities WHERE address = 'operator-a@example.com'").get()).toEqual({ kind: "personal" });
    expect(() => assertPolicyInventory(policy, db.query(POLICY_INVENTORY_SQL).all() as PolicyInventoryRow[], hash)).not.toThrow();
  } finally { db.close(); }
});
