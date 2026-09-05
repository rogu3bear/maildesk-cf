import { createHash } from "node:crypto";

export const WORKER_MODULE_DIGEST_CAPABILITY = "worker-version-artifact-digest";
const HASH = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export interface ModuleDigest {
  byte_count: number;
  content_type: string;
  name: string;
  sha256: string;
}
export interface ModuleManifest {
  main_module: string;
  modules: ModuleDigest[];
  schema_version: 1;
}
export interface LocalModuleUpload {
  manifest: ModuleManifest;
  has_static_assets: boolean;
  has_source_maps: boolean;
}
export interface WorkerModuleProof {
  schema_version: 1;
  module_bytes_verified: true;
  artifact_bytes_verified: boolean;
  static_asset_bytes_verified: false;
  source_map_bytes_verified: false;
  active_version_sha256: string;
  manifest_sha256: string;
  module_count: number;
  byte_count: number;
  body_returned: false;
  provider_output_retained: false;
}
export function digest(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(): never { throw new Error("Worker module proof is incomplete or mismatched"); }

// Reconstruct only the native capability's canonical, body-free schema.
// Unknown provider fields never enter retained evidence.
export function canonicalManifest(value: unknown): ModuleManifest {
  if (!record(value) || value.schema_version !== 1 || typeof value.main_module !== "string" ||
      !Array.isArray(value.modules) || !value.modules.length || value.modules.length > 256) fail();
  const names = new Set<string>();
  let bytes = 0;
  const modules: ModuleDigest[] = value.modules.map((item: unknown) => {
    if (!record(item) || typeof item.name !== "string" || typeof item.content_type !== "string" ||
        typeof item.sha256 !== "string" || !HASH.test(item.sha256) ||
        !Number.isSafeInteger(item.byte_count) || item.byte_count < 0) fail();
    const name = item.name.startsWith("./") ? item.name.slice(2) : item.name;
    if (!name || Buffer.byteLength(item.name) > 512 || /[\\\x00-\x1f\x7f]/.test(name) ||
        name.split("/").some((part) => !part || part === "." || part === "..") || names.has(name) ||
        !/^[\x20-\x7e]{1,128}$/.test(item.content_type)) fail();
    names.add(name);
    bytes += item.byte_count;
    if (bytes > 32 * 1024 * 1024) fail();
    return { byte_count: item.byte_count, content_type: item.content_type, name: item.name, sha256: item.sha256 };
  });
  if (!modules.some((item) => item.name === value.main_module)) fail();
  modules.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  return { main_module: value.main_module, modules, schema_version: 1 };
}

export function qualifyWorkerModules(
  local: LocalModuleUpload, providerResponse: unknown, versionId: string, activeAfter: string,
): WorkerModuleProof {
  if (!UUID.test(versionId) || activeAfter !== versionId || !record(providerResponse) ||
      providerResponse.status !== 200 || providerResponse.success !== true ||
      !Array.isArray(providerResponse.errors) || providerResponse.errors.length !== 0 ||
      !record(providerResponse.result)) fail();
  const result = providerResponse.result;
  if (result.schema_version !== 1 || result.version_id !== versionId || result.complete !== true ||
      result.body_returned !== false || result.provider_output_retained !== false ||
      result.static_asset_bytes_verified !== false) fail();
  const expected = canonicalManifest(local.manifest);
  const actual = canonicalManifest(result.manifest);
  const canonical = JSON.stringify(actual);
  const hash = digest(canonical);
  const byteCount = actual.modules.reduce((sum, item) => sum + item.byte_count, 0);
  if (canonical !== JSON.stringify(expected) || hash !== result.manifest_sha256 ||
      result.module_count !== actual.modules.length || result.byte_count !== byteCount) fail();
  return {
    schema_version: 1, module_bytes_verified: true,
    artifact_bytes_verified: !local.has_static_assets && !local.has_source_maps,
    static_asset_bytes_verified: false, source_map_bytes_verified: false,
    active_version_sha256: digest(versionId).slice(7), manifest_sha256: hash,
    module_count: actual.modules.length, byte_count: byteCount,
    body_returned: false, provider_output_retained: false,
  };
}
