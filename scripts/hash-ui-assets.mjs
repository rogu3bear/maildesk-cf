#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

function runOrThrow(cmd, args) {
  const proc = Bun.spawnSync([cmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
  });
  if (proc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    throw new Error(stderr || `${cmd} exited with code ${proc.exitCode}`);
  }
  return new TextDecoder().decode(proc.stdout);
}

function shortHash(buffer) {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

async function removeStaleHashedFiles(pkgDir, outputName, extension) {
  const escaped = outputName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}\\.[a-f0-9]{16}\\.${extension}$`);
  for (const entry of readdirSync(pkgDir)) {
    if (pattern.test(entry)) await rm(join(pkgDir, entry), { force: true });
  }
}

async function main() {
  const metadata = JSON.parse(runOrThrow("cargo", ["metadata", "--no-deps", "--format-version", "1"]));
  const workspaceRoot = metadata.workspace_root;
  const manifestPath = join(workspaceRoot, "Cargo.toml");
  const rootPackage = metadata.packages.find((pkg) => pkg.manifest_path === manifestPath);
  if (!rootPackage) throw new Error("failed to resolve root package metadata");

  const leptos = rootPackage.metadata?.leptos;
  if (!leptos) throw new Error("missing package.metadata.leptos");

  const outputName = leptos["output-name"];
  const siteRoot = join(workspaceRoot, leptos["site-root"]);
  const pkgDir = join(siteRoot, leptos["site-pkg-dir"]);
  const paths = {
    js: join(pkgDir, `${outputName}.js`),
    wasm: join(pkgDir, `${outputName}.wasm`),
    css: join(pkgDir, `${outputName}.css`),
  };
  for (const requiredPath of Object.values(paths)) {
    if (!existsSync(requiredPath)) throw new Error(`expected build artifact is missing: ${requiredPath}`);
  }

  for (const extension of ["js", "wasm", "css"]) {
    await removeStaleHashedFiles(pkgDir, outputName, extension);
  }

  const jsBuffer = await readFile(paths.js);
  const wasmBuffer = await readFile(paths.wasm);
  const cssBuffer = await readFile(paths.css);
  const hashes = {
    js: shortHash(jsBuffer),
    wasm: shortHash(wasmBuffer),
    css: shortHash(cssBuffer),
  };
  const names = {
    js: `${outputName}.${hashes.js}.js`,
    wasm: `${outputName}.${hashes.wasm}.wasm`,
    css: `${outputName}.${hashes.css}.css`,
  };

  const rewrittenJs = new TextDecoder().decode(jsBuffer).replace(
    /new URL\("([^"]+\.wasm)",import\.meta\.url\)/,
    `new URL("${names.wasm}",import.meta.url)`,
  );
  await writeFile(join(pkgDir, names.js), rewrittenJs);
  await writeFile(join(pkgDir, names.css), cssBuffer);
  await rename(paths.wasm, join(pkgDir, names.wasm));
  await rm(paths.js, { force: true });
  await rm(paths.css, { force: true });

  await writeFile(join(siteRoot, "asset-manifest.json"), `${JSON.stringify({
    js: `/pkg/${names.js}`,
    wasm: `/pkg/${names.wasm}`,
    css: `/pkg/${names.css}`,
    hashes,
  }, null, 2)}\n`);

  await writeFile(join(workspaceRoot, "target/ui-asset-hashes.env"), [
    `export LEPTOS_EDGE_JS_HASH="${hashes.js}"`,
    `export LEPTOS_EDGE_WASM_HASH="${hashes.wasm}"`,
    `export LEPTOS_EDGE_CSS_HASH="${hashes.css}"`,
    "",
  ].join("\n"));
}

main().catch((error) => {
  console.error(`[hash-ui-assets] ${error.message}`);
  process.exit(1);
});
