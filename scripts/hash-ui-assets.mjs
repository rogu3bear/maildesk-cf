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

export function hashUiAssets(outputName, jsBuffer, wasmBuffer, cssBuffer) {
  const hashes = { wasm: shortHash(wasmBuffer), css: shortHash(cssBuffer) };
  const names = { wasm: `${outputName}.${hashes.wasm}.wasm`, css: `${outputName}.${hashes.css}.css` };
  const escaped = outputName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reference = new RegExp(`new URL\\(\\s*(["'])${escaped}(?:_bg)?\\.wasm\\1\\s*,\\s*import\\.meta\\.url\\s*\\)`, "g");
  const js = new TextDecoder().decode(jsBuffer);
  if ([...js.matchAll(reference)].length !== 1) throw new Error("expected exactly one known generated WASM URL");
  const rewrittenJs = js.replace(reference, `new URL("${names.wasm}",import.meta.url)`);
  hashes.js = shortHash(Buffer.from(rewrittenJs));
  names.js = `${outputName}.${hashes.js}.js`;
  return { hashes, names, rewrittenJs };
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



  const jsBuffer = await readFile(paths.js);
  const wasmBuffer = await readFile(paths.wasm);
  const cssBuffer = await readFile(paths.css);
  const { hashes, names, rewrittenJs } = hashUiAssets(outputName, jsBuffer, wasmBuffer, cssBuffer);
  for (const extension of ["js", "wasm", "css"]) {
    await removeStaleHashedFiles(pkgDir, outputName, extension);
  }
  await writeFile(join(pkgDir, names.js), rewrittenJs);
  await writeFile(join(pkgDir, names.css), cssBuffer);
  await rename(paths.wasm, join(pkgDir, names.wasm));
  await rm(paths.js, { force: true });
  await rm(paths.css, { force: true });

  for (const extension of ["js", "wasm", "css"]) {
    if (shortHash(await readFile(join(pkgDir, names[extension]))) !== hashes[extension]) {
      throw new Error(`written ${extension} bytes do not match the asset manifest digest`);
    }
  }

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

if (import.meta.main) main().catch((error) => {
  console.error(`[hash-ui-assets] ${error.message}`);
  process.exit(1);
});
