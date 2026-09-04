import { expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");
const stableContracts = [
  "ops/cfctl/maildesk-cf.desired-state.schema.json",
  ".cfctl/operations/d1-migrations.toml",
  ".cfctl/operations/d1-policy-projections.toml",
];
const requiredTargets = [
  ".env.example",
  "Cargo.toml",
  "README.md",
  "apps/maildesk-ui/README.md",
  "config/desired-state.example.json",
  "deploy/ui/wrangler.toml",
  "docs/architecture/runtime-contract.md",
  "docs/architecture/rust-router-contract.md",
  "docs/architecture/template-standard.md",
  "docs/operations/cfctl-contract.md",
  "docs/operations/getting-started.md",
  "docs/operations/preflight.md",
  "docs/roadmap.md",
  "ops/cfctl/maildesk-cf.surface.md",
  "package.json",
  "workers/mail-api/src/index.ts",
  "workers/mail-router/src/index.ts",
  "wrangler.d1-preview.toml",
  "wrangler.mail-outbound.toml",
  "wrangler.mail-router.toml",
  "wrangler.routing-health.toml",
  "wrangler.toml",
].sort();

test.each(["acme-maildesk", "a", "a".repeat(48)])("template initializer preserves real references for project %s", (projectName) => {
  const source = readFileSync(resolve(root, "scripts/init.sh"), "utf8");
  const targetBlock = source.match(/TARGETS=\(\n([\s\S]+?)\n\)/)![1]!;
  const targets = [...targetBlock.matchAll(/^  "\$\{ROOT_DIR\}\/([^"\n]+)"/gm)]
    .map((match) => match[1]);

  expect([...targets].sort()).toEqual(requiredTargets);
  expect(new Set(targets).size).toBe(targets.length);
  for (const target of targets) {
    expect(readFileSync(resolve(root, target), "utf8").length).toBeGreaterThan(0);
  }

  const fixture = mkdtempSync(join(tmpdir(), "maildesk-init-"));
  try {
    mkdirSync(resolve(fixture, "scripts"), { recursive: true });
    writeFileSync(resolve(fixture, "scripts/init.sh"), source);
    chmodSync(resolve(fixture, "scripts/init.sh"), 0o755);
    for (const target of targets) {
      mkdirSync(dirname(resolve(fixture, target)), { recursive: true });
      copyFileSync(resolve(root, target), resolve(fixture, target));
    }

    const schemaPath = "ops/cfctl/maildesk-cf.desired-state.schema.json";
    for (const contract of stableContracts) {
      mkdirSync(dirname(resolve(fixture, contract)), { recursive: true });
      copyFileSync(resolve(root, contract), resolve(fixture, contract));
    }
    const result = spawnSync("bash", ["scripts/init.sh", projectName], {
      cwd: fixture,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Initialized template identifiers for ${projectName}.`);
    const desired = JSON.parse(readFileSync(resolve(fixture, "config/desired-state.example.json"), "utf8"));
    expect(desired.project.name).toBe(projectName);
    expect(readFileSync(resolve(fixture, "wrangler.mail-router.toml"), "utf8"))
      .toContain(`name = "${projectName}-router"`);
    for (const target of ["docs/operations/cfctl-contract.md", "ops/cfctl/maildesk-cf.surface.md"]) {
      const content = readFileSync(resolve(fixture, target), "utf8");
      const references = [...content.matchAll(/`(ops\/cfctl\/[^`]+schema\.json)`/g)];
      expect(references.length).toBeGreaterThan(0);
      for (const [, reference] of references) {
        expect(readFileSync(resolve(fixture, reference!), "utf8")).toBeTruthy();
      }
      expect(content).toContain(schemaPath);
    }
    expect(readFileSync(resolve(fixture, "docs/operations/cfctl-contract.md"), "utf8"))
      .toContain("maildesk-cf.d1-preview-migrations-apply");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});


test("initialization rejects invalid names, missing inputs, symlinks and bound configs before writes", () => {
  for (const failure of ["long-name", "extra-argument", "missing-input", "missing-contract", "symlink-input", "bound-config", "bound-preview", "bound-route", "bound-environment"]) {
    const fixture = mkdtempSync(join(tmpdir(), "maildesk-init-reject-"));
    try {
      mkdirSync(resolve(fixture, "scripts"), { recursive: true });
      copyFileSync(resolve(root, "scripts/init.sh"), resolve(fixture, "scripts/init.sh"));
      for (const target of [...requiredTargets, ...stableContracts]) {
        mkdirSync(dirname(resolve(fixture, target)), { recursive: true });
        copyFileSync(resolve(root, target), resolve(fixture, target));
      }
      const firstBefore = readFileSync(resolve(fixture, "Cargo.toml"), "utf8");
      if (failure === "missing-contract") rmSync(resolve(fixture, stableContracts[0]!));
      if (failure === "missing-input") rmSync(resolve(fixture, "apps/maildesk-ui/README.md"));
      if (failure === "symlink-input") {
        rmSync(resolve(fixture, "apps/maildesk-ui/README.md"));
        symlinkSync(resolve(fixture, "README.md"), resolve(fixture, "apps/maildesk-ui/README.md"));
      }
      if (failure === "bound-config") {
        const config = resolve(fixture, "wrangler.toml");
        writeFileSync(config, readFileSync(config, "utf8").replace("00000000-0000-0000-0000-000000000000", "11111111-1111-1111-1111-111111111111"));
      }
      if (failure === "bound-preview") {
        const config = resolve(fixture, "wrangler.d1-preview.toml");
        writeFileSync(config, readFileSync(config, "utf8").replace('preview_database_id = "00000000-0000-0000-0000-000000000000"', 'preview_database_id = "11111111-1111-1111-1111-111111111111"'));
      }
      if (failure === "bound-route" || failure === "bound-environment") {
        const config = resolve(fixture, "wrangler.toml");
        const binding = failure === "bound-route" ? 'routes = [{pattern="maildesk-cf.example.com/*", zone_name="example.com"}]\n' : '[env.production]\nname = "maildesk-cf-live"\n';
        writeFileSync(config, failure === "bound-route" ? binding + readFileSync(config, "utf8") : readFileSync(config, "utf8") + binding);
      }
      const name = failure === "long-name" ? "a".repeat(49) : "acme-maildesk";
      const args = ["scripts/init.sh", name, ...(failure === "extra-argument" ? ["unexpected"] : [])];
      const result = spawnSync("bash", args, { cwd: fixture, encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("Initialized");
      expect(readFileSync(resolve(fixture, "Cargo.toml"), "utf8")).toBe(firstBefore);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }
});
