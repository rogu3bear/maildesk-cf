#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const required = [
  "build/_worker.js",
  "build/index.js",
  "build/index_bg.wasm",
  "target/site/asset-manifest.json",
  "target/site/favicon.svg",
];

for (const relative of required) {
  if (!existsSync(join(root, relative))) {
    throw new Error(`required UI build artifact is missing: ${relative}`);
  }
}

const manifest = JSON.parse(readFileSync(join(root, "target/site/asset-manifest.json"), "utf8"));
for (const key of ["js", "wasm", "css"]) {
  const relative = String(manifest[key] ?? "").replace(/^\//, "");
  if (!relative || !existsSync(join(root, "target/site", relative.replace(/^pkg\//, "pkg/")))) {
    throw new Error(`hashed ${key} asset is missing`);
  }
}

const clientModulePath = join(root, "target/site", String(manifest.js).replace(/^\//, ""));
const clientModule = await import(pathToFileURL(clientModulePath).href);
if (typeof clientModule.default !== "function" || typeof clientModule.hydrate !== "function") {
  throw new Error("hashed UI client module must export both wasm initialization and hydrate entry points");
}

const shim = readFileSync(join(root, "build/_worker.js"), "utf8");
if (!shim.includes("this.env.ASSETS.fetch(request)")) {
  throw new Error("UI Worker shim does not preserve the Workers Assets boundary");
}
if (!shim.includes("verifiedAccessRequest(request, this.env)")) {
  throw new Error("UI Worker shim does not mark the verified Access boundary for Rust");
}

const accessAdapter = readFileSync(join(root, "workers/ui/access.ts"), "utf8");
if (!accessAdapter.includes("jwtVerify(token, jwks") || !accessAdapter.includes('algorithms: ["RS256"]')) {
  throw new Error("UI Worker adapter does not cryptographically validate Cloudflare Access JWTs");
}
if (!accessAdapter.includes('teamDomain.hostname.endsWith(".cloudflareaccess.com")')) {
  throw new Error("UI Worker adapter does not constrain the Access JWKS origin");
}
if (!accessAdapter.includes('headers.set("x-maildesk-access-validated", "1")')) {
  throw new Error("UI Worker adapter does not mark the verified Access boundary for Rust");
}

console.log("[verify-ui-build] hashed assets and Worker shim verified");
