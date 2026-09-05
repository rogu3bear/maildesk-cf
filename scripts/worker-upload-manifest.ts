import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { canonicalManifest, digest, type LocalModuleUpload, type ModuleDigest } from "./worker-module-proof";
import { deploymentArtifactSha256 } from "./worker-runtime-provenance";

// Parse Wrangler's actual serialized upload, not filesystem basename guesses.
export async function parseWorkerUpload(bytes: Uint8Array, hasAssets: boolean): Promise<LocalModuleUpload> {
  if (bytes.length === 0 || bytes.length > 64 * 1024 * 1024) throw new Error("Worker upload size invalid");
  const firstLine = Buffer.from(bytes).subarray(0, 256).toString("utf8").split("\r\n")[0];
  if (!/^--[a-zA-Z0-9-]{1,200}$/.test(firstLine)) throw new Error("Worker upload boundary invalid");
  const boundary = Buffer.from(firstLine);
  const buffer = Buffer.from(bytes);
  const modules: ModuleDigest[] = [];
  let hasSourceMaps = false;
  let metadata: Record<string, any> | undefined;
  let offset = boundary.length;
  let parts = 0;
  const delimiter = Buffer.from(`\r\n${firstLine}`);
  while (buffer.subarray(offset, offset + 2).toString() !== "--") {
    if (++parts > 513 || buffer.subarray(offset, offset + 2).toString() !== "\r\n") {
      throw new Error("Worker upload framing invalid");
    }
    const headerStart = offset + 2;
    const headerEnd = buffer.indexOf("\r\n\r\n", headerStart);
    if (headerEnd < headerStart || headerEnd - headerStart > 16_384) throw new Error("Worker upload headers invalid");
    const headers = buffer.subarray(headerStart, headerEnd).toString("utf8").split("\r\n");
    const disposition = headers.filter((line) => /^content-disposition:/i.test(line));
    const types = headers.filter((line) => /^content-type:/i.test(line));
    if (disposition.length !== 1 || types.length > 1 || headers.length !== disposition.length + types.length) {
      throw new Error("Worker upload headers ambiguous");
    }
    const match = /^Content-Disposition: form-data; name="([^"\r\n]+)"(?:; filename="([^"\r\n]+)")?$/i.exec(disposition[0]);
    if (!match) throw new Error("Worker upload disposition unsupported");
    const end = buffer.indexOf(delimiter, headerEnd + 4);
    if (end < 0) throw new Error("Worker upload truncated");
    const content = buffer.subarray(headerEnd + 4, end);
    if (match[1] === "metadata") {
      if (metadata || match[2] !== undefined) throw new Error("Worker upload metadata ambiguous");
      metadata = JSON.parse(content.toString("utf8"));
      if (!metadata || typeof metadata.main_module !== "string" || metadata.body_part !== undefined) {
        throw new Error("Worker upload must declare one module entry point");
      }
    } else {
      if (!match[2] || types.length !== 1) throw new Error("Worker upload module must be a typed file");
      const contentType = types[0].slice(types[0].indexOf(":") + 1).trim();
      if (contentType === "application/source-map") hasSourceMaps = true;
      else modules.push({ name: match[1], content_type: contentType, byte_count: content.length, sha256: digest(content) });
    }
    offset = end + delimiter.length;
  }
  const tail = buffer.subarray(offset + 2).toString();
  if ((tail !== "" && tail !== "\r\n") || !metadata) throw new Error("Worker upload closing boundary invalid");

  return { manifest: canonicalManifest({ schema_version: 1, main_module: metadata.main_module, modules }),
    has_static_assets: hasAssets || metadata.assets !== undefined || metadata.keep_assets === true,
    has_source_maps: hasSourceMaps };
}

export async function buildWorkerUploadManifest(root: string, configPath: string): Promise<LocalModuleUpload & { artifact_sha256: string; config_sha256: string }> {
  const config = resolve(root, configPath);
  const logical = relative(realpathSync(root), realpathSync(config));
  if (!logical || logical.startsWith("..") || isAbsolute(logical) || lstatSync(config).isSymbolicLink()) {
    throw new Error("Worker config must be a regular repository file");
  }
  const configBytes = readFileSync(config);
  const parsed = Bun.TOML.parse(configBytes.toString("utf8"));
  const before = deploymentArtifactSha256(root, configPath);
  const directory = mkdtempSync(join(tmpdir(), "maildesk-upload-"));
  chmodSync(directory, 0o700);
  try {
    const outfile = join(directory, "worker.bundle");
    const result = spawnSync(resolve(root, "node_modules/.bin/wrangler"), [
      "deploy", "--dry-run", "--config", config, "--outfile", outfile,
    ], { cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(directory, "wrangler.log") } });
    // Build logs may contain private binding values. Never include them in errors.
    if (result.status !== 0 || result.error) throw new Error("Worker upload dry-run failed");
    if (digest(configBytes) !== digest(readFileSync(config)) || before !== deploymentArtifactSha256(root, configPath)) {
      throw new Error("Worker upload inputs changed during dry-run");
    }
    if (lstatSync(outfile).size > 64 * 1024 * 1024) throw new Error("Worker upload size invalid");
    return { ...await parseWorkerUpload(readFileSync(outfile), parsed.assets !== undefined),
      artifact_sha256: before, config_sha256: digest(configBytes) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
