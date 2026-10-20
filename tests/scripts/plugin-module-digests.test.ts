import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PLUGIN_MODULE_LIMITS, pluginSha256, projectPluginModuleDigests, qualifyPluginModuleRuntime } from "../../scripts/plugin-module-digests";

const version = "11111111-1111-1111-1111-111111111111";
const module = (name: string, bytes: Uint8Array, type = "application/javascript+module") => ({
  name, content_type: type, content_base64: Buffer.from(bytes).toString("base64") });
const source = new TextEncoder().encode("export default {};\n");
const fixture = () => ({ id: version, main_module: "index.js", modules: [module("index.js", source)] });

test("the exact portable executor self-test has no provider effects or readiness grant", async () => {
  expect(await qualifyPluginModuleRuntime()).toMatchObject({ passed: true, hash_vectors: 2,
    rejection_vectors: 5, provider_requests: 0, target_content_read: false, qualifies_release: false });
});

test("portable SHA-256 and binary projection agree with independent Node vectors", async () => {
  const binary = Uint8Array.from({ length: 256 }, (_, i) => i);
  const data = { ...fixture(), modules: [module("router.wasm", binary, "application/wasm"), ...fixture().modules] };
  const result = await projectPluginModuleDigests(data, version);
  expect(await pluginSha256(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(result.modules[1]).toEqual({ name: "router.wasm", content_type: "application/wasm", byte_count: 256,
    sha256: createHash("sha256").update(binary).digest("hex") });
  expect(result).toMatchObject({ qualifies_release: false, qualifies_mail: false, static_assets_qualified: false });
  expect(JSON.stringify(result)).not.toContain("content_base64");
  expect(JSON.stringify(result)).not.toContain("export default");
  expect(result.manifest_sha256).toBe((await projectPluginModuleDigests({ ...data, modules: data.modules.toReversed() }, version)).manifest_sha256);
});

test("missing, aliased, unsafe or unknown module fields reject without echoing private cells", async () => {
  const variants: unknown[] = [
    { ...fixture(), id: "22222222-2222-2222-2222-222222222222" }, { ...fixture(), modules: [] },
    { ...fixture(), main_module: "absent.js" },
    ...["../private.js", "././index.js", "dir/../index.js", "/index.js", "private%2findex.js", "private\\index.js"].map((name) => ({ ...fixture(), modules: [module(name, source)] })),
    { ...fixture(), modules: [...fixture().modules, module("./index.js", source)] },
    { ...fixture(), modules: [{ ...fixture().modules[0], secret: "private-payload" }] },
  ];
  for (const input of variants) {
    let diagnostic = "";
    try { await projectPluginModuleDigests(input, version); } catch (error) { diagnostic = String(error); }
    expect(diagnostic).toContain("module_digest:");
    expect(diagnostic).not.toContain("private");
  }
});

test("canonical encoding, exact entrypoint, count and decoded byte bounds fail closed", async () => {
  for (const encoded of ["Zg", "Zh==", "Zg==\n", "_w==", "!!!!", "AAAA="]) {
    await expect(projectPluginModuleDigests({ ...fixture(), modules: [{ ...fixture().modules[0], content_base64: encoded }] }, version)).rejects.toThrow("module_digest:base64");
  }
  await expect(projectPluginModuleDigests({ ...fixture(), modules: [module("index.js", source, "application/wasm")] }, version)).rejects.toThrow("entrypoint_missing");
  await expect(projectPluginModuleDigests({ ...fixture(), modules: Array(PLUGIN_MODULE_LIMITS.modules + 1).fill(fixture().modules[0]) }, version)).rejects.toThrow("module_count");
  const oversized = module("index.js", new Uint8Array(PLUGIN_MODULE_LIMITS.decoded_bytes + 1));
  await expect(projectPluginModuleDigests({ ...fixture(), modules: [oversized] }, version)).rejects.toThrow("decoded_size");
});

test("source maps are validated and discarded; bindings and annotations never enter output", async () => {
  const result = await projectPluginModuleDigests({ ...fixture(), bindings: [{ text: "private-value" }], annotations: { private: "payload" },
    modules: [...fixture().modules, module("index.js.map", new TextEncoder().encode("private source map"), "application/source-map")] }, version);
  expect(result.source_maps_present).toBe(true);
  expect(result.modules).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain("private");
});
