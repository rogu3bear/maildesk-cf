import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateD1SchemaEvidence } from "../../scripts/d1-schema-evidence";

const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const dir = resolve(import.meta.dir, "../../migrations");
const bootstrap = 'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)';
function fixture() {
  const files = readdirSync(dir).filter(x => /^\d{4}_[a-z0-9_]+\.sql$/.test(x)).sort();
  const migrations = files.map(name => ({ name, bytes: readFileSync(resolve(dir, name)) }));
  const db = new Database(":memory:");
  db.exec(bootstrap);
  for (const m of migrations) db.exec(m.bytes.toString("utf8"));
  const rows = db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','view','index','trigger') AND name NOT GLOB 'sqlite_*' ORDER BY type,name").all();
  db.close();
  const source = { commit: "a".repeat(40), tree: "b".repeat(40), bootstrap_sha256: sha(bootstrap), expected_schema_sha256: sha(JSON.stringify(rows)),
    migrations: migrations.map(m => ({ name: m.name, sha256: sha(m.bytes) })) };
  const ledger = files.map((name, i) => ({ id: i + 1, name, applied_at: "2026-01-01 00:00:00" }));
  const raw = (results: unknown[]) => Buffer.from(JSON.stringify({ success: true, errors: [], result: [{ success: true, results }] }));
  const ledgerBytes = raw(ledger), schemaBytes = raw(rows);
  const target = { account: "c".repeat(32), database: "dddddddd-dddd-dddd-dddd-dddddddddddd" };
  const receipt = (kind: string, bytes: Uint8Array) => ({ kind, ...target, response_sha256: sha(bytes), complete: true });
  return { source, migrations, bootstrap: Buffer.from(bootstrap), expectedSchema: rows as any[], target, ledgerBytes, schemaBytes,
    ledgerReceipt: receipt("ledger", ledgerBytes), schemaReceipt: receipt("schema", schemaBytes), ledger, rows, raw, receipt };
}

test("binds complete source, target, original response bytes and exact schema", () => {
  const f = fixture(); const result = validateD1SchemaEvidence(f);
  expect(result.schema).toBe("maildesk-d1-schema-evidence/v1");
  expect(result.source).toEqual(f.source);
  expect(result.original_response_sha256).toEqual({ ledger: sha(f.ledgerBytes), schema: sha(f.schemaBytes) });
  expect(result.comparison_sha256).not.toBe(sha(f.schemaBytes));
  expect(result.qualifies_release).toBe(false);
  const reformatted = Buffer.from(JSON.stringify(JSON.parse(f.schemaBytes.toString()), null, 2));
  const second = validateD1SchemaEvidence({ ...f, schemaBytes: reformatted, schemaReceipt: f.receipt("schema", reformatted) });
  expect(second.comparison_sha256).toBe(result.comparison_sha256);
  expect(second.original_response_sha256.schema).not.toBe(result.original_response_sha256.schema);
});

test("holds partial, duplicated, truncated, wrong-target and changed source or definitions", () => {
  const f = fixture();
  const schema = (rows: unknown[]) => { const schemaBytes = f.raw(rows); return { ...f, schemaBytes, schemaReceipt: f.receipt("schema", schemaBytes) }; };
  const ledger = (rows: unknown[]) => { const ledgerBytes = f.raw(rows); return { ...f, ledgerBytes, ledgerReceipt: f.receipt("ledger", ledgerBytes) }; };
  expect(() => validateD1SchemaEvidence(ledger(f.ledger.slice(0, -1)))).toThrow();
  expect(() => validateD1SchemaEvidence(ledger([...f.ledger, f.ledger[0]]))).toThrow();
  expect(() => validateD1SchemaEvidence(schema(f.rows.slice(0, -1)))).toThrow();
  expect(() => validateD1SchemaEvidence(schema([...f.rows, f.rows[0]]))).toThrow();
  expect(() => validateD1SchemaEvidence({ ...f, schemaBytes: f.schemaBytes.subarray(0, 40) })).toThrow();
  expect(() => validateD1SchemaEvidence({ ...f, schemaReceipt: { ...f.schemaReceipt, database: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" } })).toThrow();
  expect(() => validateD1SchemaEvidence({ ...f, ledgerReceipt: { ...f.ledgerReceipt, complete: false } })).toThrow();
  expect(() => validateD1SchemaEvidence({ ...f, expectedSchema: f.expectedSchema.slice(1) })).toThrow();
  const duplicateKey = Buffer.from('{"success":true,"success":true,"errors":[],"result":[{"success":true,"results":[]}]}');
  expect(() => validateD1SchemaEvidence({ ...f, schemaBytes: duplicateKey, schemaReceipt: f.receipt("schema", duplicateKey) })).toThrow();
  const badUtf8 = Buffer.from([0xff]);
  expect(() => validateD1SchemaEvidence({ ...f, schemaBytes: badUtf8, schemaReceipt: f.receipt("schema", badUtf8) })).toThrow();
  const reordered = [...f.ledger]; [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
  expect(() => validateD1SchemaEvidence(ledger(reordered))).toThrow();
  expect(() => validateD1SchemaEvidence({ ...f, migrations: f.migrations.map((m, i) => i === 17 ? { ...m, bytes: Buffer.from("SELECT 1;") } : m) })).toThrow();
  for (const name of ["delivery_only_recipient_no_reopen", "delivery_only_fingerprint_excludes_inbound", "inbound_fingerprint_excludes_delivery_only"]) {
    expect(() => validateD1SchemaEvidence(schema(f.rows.map((r: any) => r.name === name ? { ...r, sql: r.sql.replace("RAISE(ABORT", "RAISE(IGNORE") } : r)))).toThrow();
  }
});

test("separately bound migration naming is not borrowed across consumers", () => {
  const f = fixture();
  const migrations = f.migrations.map((m, i) => i === 17 ? { ...m, name: "0018_private_claims.sql" } : m);
  const source = { ...f.source, commit: "e".repeat(40), tree: "f".repeat(40),
    migrations: migrations.map(m => ({ name: m.name, sha256: sha(m.bytes) })) };
  const ledger = f.ledger.map((row, i) => i === 17 ? { ...row, name: migrations[i]!.name } : row);
  const ledgerBytes = f.raw(ledger);
  expect(() => validateD1SchemaEvidence({ ...f, source, migrations })).toThrow();
  expect(validateD1SchemaEvidence({ ...f, source, migrations, ledgerBytes,
    ledgerReceipt: f.receipt("ledger", ledgerBytes) }).qualifies_release).toBe(false);
});
