import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeD1PreviewConfig } from "../../scripts/materialize-d1-preview-config";

const TEMPLATE = `name = "maildesk-cf-d1-preview"
compatibility_date = "2026-08-12"

[[d1_databases]]
binding = "DB"
database_name = "maildesk-cf-preview-db"
database_id = "00000000-0000-0000-0000-000000000000"
preview_database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "migrations"
`;

describe("private D1 preview config materializer", () => {
  test("writes one exclusive mode-0600 config without returning the private database id", () => {
    const directory = mkdtempSync(join(tmpdir(), "maildesk-preview-config-"));
    const templatePath = join(directory, "wrangler.d1-preview.toml");
    const outputPath = join(directory, "wrangler.d1-preview.production.toml");
    const databaseId = "11111111-1111-4111-8111-111111111111";
    try {
      writeFileSync(templatePath, TEMPLATE);
      const receipt = materializeD1PreviewConfig({ templatePath, outputPath, databaseId });
      const config = Bun.TOML.parse(readFileSync(outputPath, "utf8")) as Record<string, any>;

      expect(receipt).toMatchObject({
        schema_version: 1,
        kind: "maildesk_d1_preview_private_config",
        performed: true,
        mode: "0600",
        database_identity_private: true,
      });
      expect(JSON.stringify(receipt)).not.toContain(databaseId);
      expect(statSync(outputPath).mode & 0o777).toBe(0o600);
      expect(config.d1_databases).toHaveLength(1);
      expect(config.d1_databases[0].database_id).toBe(databaseId);
      expect(config.d1_databases[0].preview_database_id).toBe(databaseId);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects malformed identifiers and drifted templates without creating output", () => {
    const directory = mkdtempSync(join(tmpdir(), "maildesk-preview-config-"));
    const templatePath = join(directory, "wrangler.d1-preview.toml");
    const outputPath = join(directory, "wrangler.d1-preview.production.toml");
    try {
      writeFileSync(templatePath, TEMPLATE);
      expect(() => materializeD1PreviewConfig({
        templatePath,
        outputPath,
        databaseId: "not-a-database-id",
      })).toThrow("canonical non-placeholder UUID");

      writeFileSync(templatePath, TEMPLATE.replace('[[d1_databases]]', 'main = "worker.ts"\n\n[[d1_databases]]'));
      expect(() => materializeD1PreviewConfig({
        templatePath,
        outputPath,
        databaseId: "11111111-1111-4111-8111-111111111111",
      })).toThrow("D1-only preview contract");
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("never overwrites an existing private config", () => {
    const directory = mkdtempSync(join(tmpdir(), "maildesk-preview-config-"));
    const templatePath = join(directory, "wrangler.d1-preview.toml");
    const outputPath = join(directory, "wrangler.d1-preview.production.toml");
    try {
      writeFileSync(templatePath, TEMPLATE);
      writeFileSync(outputPath, "operator-owned");
      expect(() => materializeD1PreviewConfig({
        templatePath,
        outputPath,
        databaseId: "11111111-1111-4111-8111-111111111111",
      })).toThrow();
      expect(readFileSync(outputPath, "utf8")).toBe("operator-owned");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
