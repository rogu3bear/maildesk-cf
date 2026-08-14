import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");
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

test("template initializer rewrites every declared authority without phantom paths", () => {
  const source = readFileSync(resolve(root, "scripts/init.sh"), "utf8");
  const targets = [...source.matchAll(/replace_in_file "\$\{ROOT_DIR\}\/([^"\n]+)"/g)]
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
      writeFileSync(resolve(fixture, target), "maildesk-cf\n");
    }

    const result = spawnSync("bash", ["scripts/init.sh", "acme-maildesk"], {
      cwd: fixture,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Initialized template identifiers for acme-maildesk.");
    for (const target of targets) {
      expect(readFileSync(resolve(fixture, target), "utf8"), target).toBe("acme-maildesk\n");
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
