import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { candidateSha256 } from "../../scripts/git-candidate";
import { preparePluginInventory, projectPluginMetadata, assertInventoryFreshness, PluginMetadataError, SCHEMA_COLUMNS_SQL, MIGRATION_NAMES_SQL } from "../../scripts/plugin-inventory-contract";

const now = Date.parse("2026-10-19T12:00:00Z");
function input() {
  const candidate = { head: "a".repeat(40), tree: "b".repeat(40), dirty: true };
  return { schema_version: 1, candidate, candidate_sha256: candidateSha256(candidate),
    source_snapshot_sha256: "sha256:" + "c".repeat(64), target_manifest_sha256: "sha256:" + "d".repeat(64),
    connector_subject: "user:" + "e".repeat(32), account_id: "a".repeat(32),
    database_id: "00000000-0000-0000-0000-000000000001",
    workers: { relay_router: "example-router", relay_outbound: "example-outbound", routing_health: "example-health" } };
}

test("dirty source can prepare bounded plugin information without granting release or mail", () => {
  const packet = preparePluginInventory(input(), now);
  expect(packet.context.candidate.dirty).toBe(true);
  expect(packet.requests).toHaveLength(5);
  expect(packet).toMatchObject({ performed: false, execution_supported: false, informational_only: true, qualifies_release: false, qualifies_mail: false });
  expect(preparePluginInventory(input(), now)).toEqual(packet);
  expect(() => preparePluginInventory({ ...input(), sql: "DELETE FROM reply_admissions" }, now)).toThrow();
  expect(() => preparePluginInventory({ ...input(), account_id: "../other" }, now)).toThrow();
  expect(() => preparePluginInventory({ ...input(), workers: { ...input().workers, relay_outbound: "example-router" } }, now)).toThrow();
});

test("fixed metadata statements inspect real migrated schema without mail data", () => {
  const db = new Database(":memory:");
  try {
    const root = resolve(import.meta.dir, "../..");
    for (const file of readdirSync(resolve(root, "migrations")).filter((name) => name.endsWith(".sql")).sort()) db.exec(readFileSync(resolve(root, "migrations", file), "utf8"));
    // Match Wrangler's actual system-table DDL, including TIMESTAMP.
    db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
    db.run("INSERT INTO d1_migrations (name) VALUES ('0001_initial.sql')");
    const columns = projectPluginMetadata("schema_columns", db.query(SCHEMA_COLUMNS_SQL).all());
    expect(columns.rows.some((row) => "table_name" in row && row.table_name === "policy_change_reviews")).toBe(true);
    expect(columns.rows.some((row) => "column_type" in row && row.column_type === "TIMESTAMP")).toBe(true);
    expect(columns.qualifies_mail).toBe(false);
    expect(projectPluginMetadata("migration_names", db.query(MIGRATION_NAMES_SQL).all()).rows).toEqual([{ name: "0001_initial.sql" }]);
  } finally { db.close(); }
});

test("rejection diagnostics identify the expected property without arbitrary private cells", () => {
  try {
    projectPluginMetadata("schema_columns", [{ table_name: "d1_migrations", column_name: "applied_at",
      column_type: "private@example.com", not_null: "private", primary_key: 0, message_body: "do not retain this" }]);
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(PluginMetadataError);
    const text = JSON.stringify((error as PluginMetadataError).diagnostic);
    expect(text).toContain("unexpected_fields"); expect(text).toContain("applied_at");
    expect(text).not.toContain("private@example.com"); expect(text).not.toContain("do not retain this");
  }
});

test("independent informational subsets have distinct scope and digests", () => {
  const schema = preparePluginInventory(input(), now, ["schema_columns"]);
  const other = preparePluginInventory(input(), now, ["migration_names", "worker_deployments"]);
  expect(schema.requests).toHaveLength(1); expect(other.requests).toHaveLength(4);
  expect(schema.proposal_sha256).not.toBe(other.proposal_sha256);
  expect(() => preparePluginInventory(input(), now, [])).toThrow();
  expect(() => preparePluginInventory(input(), now, ["migration_names", "migration_names"])).toThrow();
});

test("metadata projection rejects truncation, duplicates, private fields and malformed values", () => {
  const row = { table_name: "alias_routes", column_name: "id", column_type: "TEXT", not_null: 1, primary_key: 1 };
  for (const bad of [null, { denied: true }, [row, row], [{ ...row, message_body: "private" }], [{ ...row, not_null: "1" }], Array(1001).fill(row)]) {
    expect(() => projectPluginMetadata("schema_columns", bad)).toThrow();
  }
  expect(() => projectPluginMetadata("migration_names", [{ name: "private@example.com" }])).toThrow();
});

test("informational receipt time is bounded and never accepted after packet expiry", () => {
  const packet = preparePluginInventory(input(), now);
  expect(() => assertInventoryFreshness(packet, new Date(now + 1000).toISOString(), now + 1000)).not.toThrow();
  expect(() => assertInventoryFreshness(packet, new Date(now - 1).toISOString(), now)).toThrow();
  expect(() => assertInventoryFreshness(packet, new Date(now + 600000).toISOString(), now + 600000)).toThrow();
});
