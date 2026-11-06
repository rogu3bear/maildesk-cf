/** Pure comparison only: callers must authenticate and independently bind receipts. */
import { createHash } from "node:crypto";

const digest = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const hex = (value: string, size: number) => typeof value === "string" && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
const MAX_RESPONSE = 4 * 1024 * 1024;
const MAX_MIGRATIONS = 100;
const MAX_OBJECTS = 500;

type Migration = { name: string; bytes: Uint8Array };
type Source = { commit: string; tree: string; bootstrap_sha256: string; expected_schema_sha256: string; migrations: Array<{ name: string; sha256: string }> };
type Target = { account: string; database: string };
type Receipt = Target & { kind: string; response_sha256: string; complete: boolean };
type Row = { type: string; name: string; tbl_name: string; sql: string };
export interface D1SchemaEvidenceInput {
  /** All source/target/receipt values must come from independently authenticated bindings. */
  source: Source; migrations: Migration[]; bootstrap: Uint8Array; expectedSchema: Row[]; target: Target;
  ledgerBytes: Uint8Array; schemaBytes: Uint8Array; ledgerReceipt: Receipt; schemaReceipt: Receipt;
}

function uniqueJson(text: string): unknown {
  let i = 0;
  const ws = () => { while (/\s/.test(text[i] ?? "") && i < text.length) i++; };
  const string = (): string => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === "\\") { i += 2; continue; }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
    throw new Error("unterminated string");
  };
  const value = (): void => {
    ws(); const ch = text[i];
    if (ch === '"') { string(); return; }
    if (ch === "{" || ch === "[") {
      i++; ws(); const object = ch === "{"; const end = object ? "}" : "]"; const keys = new Set<string>();
      if (text[i] === end) { i++; return; }
      for (;;) {
        if (object) {
          ws(); if (text[i] !== '"') throw new Error("invalid key");
          const key = string(); if (keys.has(key)) throw new Error("duplicate key"); keys.add(key);
          ws(); if (text[i++] !== ":") throw new Error("invalid colon");
        }
        value(); ws(); const next = text[i++];
        if (next === end) return;
        if (next !== ",") throw new Error("invalid delimiter");
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!match) throw new Error("invalid value"); i += match[0].length;
  };
  value(); ws(); if (i !== text.length) throw new Error("trailing JSON");
  return JSON.parse(text);
}

function rows(bytes: Uint8Array, receipt: Receipt, target: Target, kind: string, limit: number): unknown[] {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_RESPONSE ||
      receipt.kind !== kind || receipt.complete !== true || receipt.account !== target.account ||
      receipt.database !== target.database || !hex(receipt.response_sha256, 64) || digest(bytes) !== receipt.response_sha256) {
    throw new Error(`unbound or incomplete ${kind} response`);
  }
  let value: any;
  try { value = uniqueJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`invalid ${kind} response`); }
  if (!value || value.success !== true || !Array.isArray(value.errors) || value.errors.length !== 0 ||
      !Array.isArray(value.result) || value.result.length !== 1 || value.result[0]?.success !== true ||
      !Array.isArray(value.result[0]?.results) || value.result[0].results.length >= limit) throw new Error(`partial or invalid ${kind} result`);
  return value.result[0].results;
}

/**
 * Compare D1's complete fixed ledger and sqlite_master results with schema
 * independently derived and reviewed from byte-pinned source. No provider
 * access, migrations on the target, authorization, or release decision occurs.
 * SQL definitions compare exactly; equivalent provider formatting may hold.
 */
export function validateD1SchemaEvidence(input: D1SchemaEvidenceInput) {
  const { source, migrations, bootstrap, expectedSchema, target } = input;
  if (!source || !hex(source.commit, 40) || !hex(source.tree, 40) || !hex(source.bootstrap_sha256, 64) || !hex(source.expected_schema_sha256, 64) ||
      !target || !hex(target.account, 32) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(target.database) ||
      !(bootstrap instanceof Uint8Array) || bootstrap.length > 65536 || digest(bootstrap) !== source.bootstrap_sha256 ||
      !Array.isArray(source.migrations) || !Array.isArray(migrations) || migrations.length === 0 ||
      migrations.length > MAX_MIGRATIONS || migrations.length !== source.migrations.length) throw new Error("invalid source or target binding");
  let previous = "";
  for (let i = 0; i < migrations.length; i++) {
    const m = migrations[i]!, expected = source.migrations[i]!;
    if (!m || !expected || !/^\d{4}_[a-z0-9_]+\.sql$/.test(m.name) || m.name <= previous ||
        m.name !== expected.name || !(m.bytes instanceof Uint8Array) || m.bytes.length > 1_048_576 ||
        !hex(expected.sha256, 64) || digest(m.bytes) !== expected.sha256) throw new Error("migration source differs");
    previous = m.name;
  }
  const ledger = rows(input.ledgerBytes, input.ledgerReceipt, target, "ledger", MAX_MIGRATIONS);
  if (ledger.length !== migrations.length) throw new Error("migration ledger incomplete");
  let previousId = 0;
  for (let i = 0; i < ledger.length; i++) {
    const row = ledger[i] as any;
    if (!row || !Number.isSafeInteger(row.id) || row.id <= previousId || row.name !== migrations[i]!.name ||
        typeof row.applied_at !== "string" || !row.applied_at.trim()) throw new Error("migration ledger differs");
    previousId = row.id;
  }
  const observed = rows(input.schemaBytes, input.schemaReceipt, target, "schema", MAX_OBJECTS) as Row[];
  const expected = expectedSchema;
  if (!Array.isArray(expected) || expected.length === 0 || expected.length >= MAX_OBJECTS ||
      digest(JSON.stringify(expected)) !== source.expected_schema_sha256 || observed.length !== expected.length) throw new Error("schema incomplete or unbound");
  let last = "";
  for (let i = 0; i < expected.length; i++) {
    const row = observed[i], want = expected[i]!;
    const key = `${want?.type}\0${want?.name}`;
    if (!want || Object.keys(want).sort().join(",") !== "name,sql,tbl_name,type" ||
        !["table", "view", "index", "trigger"].includes(want.type) || typeof want.name !== "string" ||
        !want.name || want.name.startsWith("sqlite_") || typeof want.tbl_name !== "string" || typeof want.sql !== "string" ||
        !want.sql || key <= last || !row || Object.keys(row).sort().join(",") !== "name,sql,tbl_name,type" ||
        row.type !== want.type || row.name !== want.name || row.tbl_name !== want.tbl_name || row.sql !== want.sql) {
      throw new Error("schema definition differs");
    }
    last = key;
  }
  const comparison = JSON.stringify({ ledger: ledger.map((row: any) => ({ id: row.id, name: row.name, applied_at: row.applied_at })), schema: expected });
  return { schema: "maildesk-d1-schema-evidence/v1", source, target,
    original_response_sha256: { ledger: digest(input.ledgerBytes), schema: digest(input.schemaBytes) },
    comparison_sha256: digest(comparison), qualifies_release: false as const };
}
