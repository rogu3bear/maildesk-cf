import { describe, expect, test } from "bun:test";
import { canonicalManifest, digest, qualifyWorkerModules } from "../../scripts/worker-module-proof";
import { parseWorkerUpload } from "../../scripts/worker-upload-manifest";

const version = "11111111-2222-4333-8444-555555555555";
const manifest = canonicalManifest({ schema_version: 1, main_module: "index.js", modules: [
  { name: "index.js", content_type: "application/javascript+module", byte_count: 1, sha256: digest("x") },
  { name: "./hash-router.wasm", content_type: "application/wasm", byte_count: 1, sha256: digest("y") },
] });
const local = { manifest, has_static_assets: false, has_source_maps: false };
function response() {
  return { status: 200, success: true, errors: [], result: {
    schema_version: 1, version_id: version, complete: true, body_returned: false,
    provider_output_retained: false, static_asset_bytes_verified: false,
    manifest: structuredClone(manifest), manifest_sha256: digest(JSON.stringify(manifest)),
    byte_count: 2, module_count: 2,
  } };
}

describe("authenticated Worker module comparison", () => {
  test("admits the complete exact manifest without retaining provider fields", () => {
    const provider = { ...response(), private_provider_field: "must not persist" };
    const proof = qualifyWorkerModules(local, provider, version, version);
    expect(proof.artifact_bytes_verified).toBe(true);
    expect(proof.module_bytes_verified).toBe(true);
    expect(JSON.stringify(proof)).not.toContain("must not persist");
    expect(proof.manifest_sha256).toBe(digest(JSON.stringify(manifest)));
  });
  test("keeps source maps and static assets outside module-only qualification", () => {
    for (const flags of [{ has_static_assets: true }, { has_source_maps: true }]) {
      expect(qualifyWorkerModules({ ...local, ...flags }, response(), version, version).artifact_bytes_verified).toBe(false);
    }
  });
  test("rejects version drift, partial results, changed bytes and incomplete manifests", () => {
    expect(() => qualifyWorkerModules(local, response(), version, "99999999-2222-4333-8444-555555555555")).toThrow();
    const changes = [
      (r: any) => { r.result.version_id = "99999999-2222-4333-8444-555555555555"; },
      (r: any) => { r.result.complete = false; },
      (r: any) => { r.success = false; },
      (r: any) => { r.result.body_returned = true; },
      (r: any) => { r.result.provider_output_retained = true; },
      (r: any) => { r.result.manifest.modules[0].sha256 = digest("z"); },
      (r: any) => { r.result.manifest.modules[0].content_type = "text/plain"; },
      (r: any) => { r.result.manifest.modules.pop(); },
      (r: any) => { r.result.manifest.modules.push({ ...manifest.modules[0], name: "extra.wasm" }); },
      (r: any) => { r.result.manifest_sha256 = digest("other"); },
      (r: any) => { r.result.byte_count = 3; },
      (r: any) => { r.result.module_count = 1; },
    ];
    for (const change of changes) { const r = response(); change(r); expect(() => qualifyWorkerModules(local, r, version, version)).toThrow(); }
  });
  test("rejects aliases, traversal and unbounded modules without normalizing upload names", () => {
    expect(manifest.modules[0].name).toBe("./hash-router.wasm");
    for (const name of ["../x", "./../x", "././x", "/x", "a//x", "a\\x"]) {
      expect(() => canonicalManifest({ ...manifest, modules: [{ ...manifest.modules[1], name }] })).toThrow();
    }
    expect(() => canonicalManifest({ ...manifest, modules: [...manifest.modules, { ...manifest.modules[0], name: "hash-router.wasm" }] })).toThrow();
    expect(() => canonicalManifest({ ...manifest, modules: [{ ...manifest.modules[1], byte_count: 33 * 1024 * 1024 }] })).toThrow();
  });
});

describe("Wrangler multipart upload correspondence", () => {
  test("hashes actual field names and bytes, excluding metadata and identifying source maps", async () => {
    const form = new FormData();
    form.set("metadata", JSON.stringify({ main_module: "index.js", bindings: [{ name: "PRIVATE", text: "not retained" }] }));
    form.set("index.js", new File(["x"], "index.js", { type: "application/javascript+module" }));
    form.set("./hash-router.wasm", new File(["y"], "./hash-router.wasm", { type: "application/wasm" }));
    form.set("index.js.map", new File(["map"], "index.js.map", { type: "application/source-map" }));
    const bytes = new Uint8Array(await new Response(form).arrayBuffer());
    const parsed = await parseWorkerUpload(bytes, false);
    expect(parsed.manifest).toEqual(manifest);
    expect(parsed.has_source_maps).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain("not retained");
  });
  test("rejects missing main and duplicate upload fields", async () => {
    const form = new FormData();
    form.set("metadata", JSON.stringify({ main_module: "missing.js" }));
    form.set("index.js", new File(["x"], "index.js", { type: "application/javascript+module" }));
    await expect(parseWorkerUpload(new Uint8Array(await new Response(form).arrayBuffer()), false)).rejects.toThrow();
    form.set("metadata", JSON.stringify({ main_module: "index.js" }));
    form.append("index.js", new File(["z"], "index.js", { type: "application/javascript+module" }));
    await expect(parseWorkerUpload(new Uint8Array(await new Response(form).arrayBuffer()), false)).rejects.toThrow();
  });
});
