import { createHash } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_TEMPLATE = "wrangler.d1-preview.toml";
const DEFAULT_OUTPUT = "wrangler.d1-preview.production.toml";

export interface D1PreviewConfigInput {
  templatePath: string;
  outputPath: string;
  databaseId: string;
}

export interface D1PreviewConfigReceipt {
  schema_version: 1;
  kind: "maildesk_d1_preview_private_config";
  performed: true;
  path: string;
  mode: "0600";
  template_sha256: string;
  config_sha256: string;
  database_identity_private: true;
}

export function materializeD1PreviewConfig(input: D1PreviewConfigInput): D1PreviewConfigReceipt {
  const templatePath = resolve(input.templatePath);
  const outputPath = resolve(input.outputPath);
  if (dirname(templatePath) !== dirname(outputPath)) {
    throw new Error("private preview config must remain beside its tracked template");
  }
  if (!canonicalUuid(input.databaseId) || input.databaseId === PLACEHOLDER_ID) {
    throw new Error("preview database identity must be a canonical non-placeholder UUID");
  }
  const metadata = lstatSync(templatePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1_048_576) {
    throw new Error("preview template must be a regular non-symlink file of at most 1 MiB");
  }

  const template = readFileSync(templatePath, "utf8");
  validateTemplate(template);
  if (template.split(PLACEHOLDER_ID).length - 1 !== 2) {
    throw new Error("preview template must contain exactly two closed database identity placeholders");
  }
  const config = template.replaceAll(PLACEHOLDER_ID, input.databaseId);
  validateMaterializedConfig(config, input.databaseId);

  let created = false;
  try {
    writeFileSync(outputPath, config, { encoding: "utf8", flag: "wx", mode: 0o600 });
    created = true;
    chmodSync(outputPath, 0o600);
  } catch (error) {
    if (created) rmSync(outputPath, { force: true });
    throw error;
  }

  return {
    schema_version: 1,
    kind: "maildesk_d1_preview_private_config",
    performed: true,
    path: basename(outputPath),
    mode: "0600",
    template_sha256: digest(template),
    config_sha256: digest(config),
    database_identity_private: true,
  };
}

function validateTemplate(contents: string): void {
  const parsed = parseConfig(contents);
  if (!exactKeys(parsed, ["compatibility_date", "d1_databases", "name"])) {
    throw new Error("preview template must satisfy the D1-only preview contract");
  }
  const databases = parsed.d1_databases;
  if (!Array.isArray(databases) || databases.length !== 1 || !isRecord(databases[0])) {
    throw new Error("preview template must contain exactly one D1 database binding");
  }
  const database = databases[0];
  if (
    !exactKeys(database, [
      "binding",
      "database_id",
      "database_name",
      "migrations_dir",
      "preview_database_id",
    ]) ||
    database.binding !== "DB" ||
    database.database_id !== PLACEHOLDER_ID ||
    database.preview_database_id !== PLACEHOLDER_ID ||
    database.migrations_dir !== "migrations" ||
    typeof database.database_name !== "string" ||
    database.database_name.length === 0
  ) {
    throw new Error("preview template D1 binding drifted from its closed placeholder contract");
  }
}

function validateMaterializedConfig(contents: string, databaseId: string): void {
  const parsed = parseConfig(contents);
  const databases = parsed.d1_databases;
  if (!Array.isArray(databases) || databases.length !== 1 || !isRecord(databases[0])) {
    throw new Error("materialized preview config lost its exact D1 binding");
  }
  if (
    databases[0].database_id !== databaseId ||
    databases[0].preview_database_id !== databaseId
  ) {
    throw new Error("materialized preview config did not bind one isolated database identity");
  }
}

function parseConfig(contents: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(contents);
  } catch {
    throw new Error("preview template must be valid TOML");
  }
  if (!isRecord(parsed)) throw new Error("preview template root must be a TOML table");
  return parsed;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function canonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const databaseId = (await Bun.stdin.text()).trim();
  try {
    const receipt = materializeD1PreviewConfig({
      templatePath: resolve(root, DEFAULT_TEMPLATE),
      outputPath: resolve(root, DEFAULT_OUTPUT),
      databaseId,
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`materialize D1 preview config failed: ${message}\n`);
    process.exit(1);
  }
}
