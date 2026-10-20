/** Portable projection for the Cloudflare plugin runtime. No network, file,
 * credential or provider effects. Raw code and binding values never escape.
 * Qualify these exact functions in the executor before retrieving modules.
 */
export const PLUGIN_MODULE_LIMITS = { modules: 128, decoded_bytes: 16 * 1024 * 1024,
  normalized_response_bytes: 32 * 1024 * 1024 } as const;

export async function projectPluginModuleDigests(value: unknown, expectedVersion: string) {
  const fail = (reason: string): never => { throw new Error(`module_digest:${reason}`); };
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(expectedVersion)) fail("version_selector");
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("result_shape");
  const row = value as Record<string, unknown>;
  if (row.id !== expectedVersion) fail("version_mismatch");
  if (typeof row.main_module !== "string" || !safeModuleName(row.main_module)) fail("entrypoint");
  if (!Array.isArray(row.modules) || !row.modules.length || row.modules.length > PLUGIN_MODULE_LIMITS.modules) fail("module_count");
  const modules = row.modules as unknown[];
  // This bounds the accepted normalized value. It is not an HTTP in-flight cap.
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > PLUGIN_MODULE_LIMITS.normalized_response_bytes) fail("response_size");
  const names = new Set<string>();
  const output: Array<{ name: string; content_type: string; byte_count: number; sha256: string }> = [];
  let total = 0, sourceMaps = false;
  for (const value of modules) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("module_shape");
    const module = value as Record<string, unknown>;
    if (Object.keys(module).sort().join(",") !== "content_base64,content_type,name") fail("module_fields");
    if (typeof module.name !== "string" || !safeModuleName(module.name)) fail("module_name");
    const name = module.name as string;
    const canonicalName = name.replace(/^\.\//, "");
    if (names.has(canonicalName)) fail("duplicate_module");
    names.add(canonicalName);
    if (typeof module.content_type !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(module.content_type)) fail("content_type");
    if (typeof module.content_base64 !== "string") fail("base64_shape");
    const encoded = module.content_base64 as string;
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    const size = encoded.length / 4 * 3 - padding;
    if (size > PLUGIN_MODULE_LIMITS.decoded_bytes - total) fail("decoded_size");
    if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(encoded.slice(0, encoded.length - padding))) fail("base64_shape");
    let binary: string;
    try { binary = atob(encoded); } catch { return fail("base64_decode"); }
    if (btoa(binary) !== encoded || binary.length !== size) fail("base64_noncanonical");
    total += size;
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    // The endpoint includes source maps. Count/validate their bytes and names,
    // then discard them just as the local upload manifest does.
    if (module.content_type === "application/source-map") { sourceMaps = true; continue; }
    output.push({ name, content_type: module.content_type as string, byte_count: bytes.byteLength,
      sha256: await pluginSha256(bytes) });
  }
  if (!output.some((module) => module.name === row.main_module &&
      ["application/javascript+module", "text/javascript", "application/javascript"].includes(module.content_type))) fail("entrypoint_missing");
  output.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const manifest = { schema_version: 1, version_id: expectedVersion, entrypoint: row.main_module as string,
    modules: output, source_maps_present: sourceMaps, static_assets_qualified: false };
  return { ...manifest, manifest_sha256: await pluginSha256(new TextEncoder().encode(JSON.stringify(manifest))),
    informational_only: true, qualifies_release: false, qualifies_mail: false };
}

function safeModuleName(value: string): boolean {
  if (value.length > 240 || !/^(?:\.\/)?[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*$/.test(value)) return false;
  return value.replace(/^\.\//, "").split("/").every((part) => part !== "." && part !== "..");
}

export async function pluginSha256(bytes: Uint8Array): Promise<string> {
  // Fail before a target read if the actual plugin cannot qualify this primitive.
  const result = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Synthetic executor qualification only. No target selector or API request. */
export async function qualifyPluginModuleRuntime() {
  const version = "11111111-1111-1111-1111-111111111111";
  const binary = Uint8Array.from({ length: 256 }, (_, i) => i);
  const fixture = { id: version, main_module: "index.js", modules: [
    { name: "index.js", content_type: "application/javascript+module", content_base64: "ZXhwb3J0IGRlZmF1bHQge307Cg==" },
    { name: "router.wasm", content_type: "application/wasm", content_base64: btoa(String.fromCharCode(...binary)) },
  ] };
  const projected = await projectPluginModuleDigests(fixture, version);
  if (await pluginSha256(new TextEncoder().encode("abc")) !== "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" ||
      projected.modules[1]?.sha256 !== "40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880") throw new Error("module_runtime:hash_vector");
  const negative = [
    { ...fixture, id: "22222222-2222-2222-2222-222222222222" },
    { ...fixture, modules: [...fixture.modules, { ...fixture.modules[0], name: "./index.js" }] },
    { ...fixture, modules: [{ ...fixture.modules[0], content_base64: "Zh==" }] },
    { ...fixture, modules: [{ ...fixture.modules[0], name: "../index.js" }] },
    { ...fixture, modules: [] },
  ];
  for (const value of negative) {
    let rejected = false;
    try { await projectPluginModuleDigests(value, version); } catch { rejected = true; }
    if (!rejected) throw new Error("module_runtime:negative_vector");
  }
  return { schema_version: 1, kind: "plugin_module_runtime_synthetic_qualification", passed: true,
    hash_vectors: 2, rejection_vectors: negative.length, provider_requests: 0,
    target_content_read: false, qualifies_release: false, qualifies_mail: false };
}
