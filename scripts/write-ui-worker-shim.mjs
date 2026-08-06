#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const workerBundle = join(root, "build/index.js");
const workerWasm = join(root, "build/index_bg.wasm");
const shimPath = join(root, "build/_worker.js");

if (!existsSync(workerBundle) || !existsSync(workerWasm)) {
  console.error("[write-ui-worker-shim] worker-build did not emit build/index.js and build/index_bg.wasm");
  process.exit(1);
}

await writeFile(shimPath, [
  'import LeptosWorker from "./index.js";',
  'import { isDeskPath, verifiedAccessRequest } from "../workers/ui/access.ts";',
  "",
  "const STATIC_PATHS = new Set([",
  '  "/asset-manifest.json",',
  '  "/app-icon.svg",',
  '  "/favicon.svg",',
  '  "/site.webmanifest",',
  "]);",
  "export default class extends LeptosWorker {",
  "  async fetch(request) {",
  "    const url = new URL(request.url);",
  '    if (url.pathname.startsWith("/pkg/") || STATIC_PATHS.has(url.pathname)) {',
  "      return this.env.ASSETS.fetch(request);",
  "    }",
  '    if (isDeskPath(url.pathname) && this.env.MAILDESK_UI_AUTH_MODE === "access") {',
  "      const verifiedRequest = await verifiedAccessRequest(request, this.env);",
  "      if (verifiedRequest instanceof Response) return verifiedRequest;",
  "      request = verifiedRequest;",
  "    }",
  "    return super.fetch(request);",
  "  }",
  "}",
  "",
].join("\n"));

console.log("[write-ui-worker-shim] wrote build/_worker.js");
