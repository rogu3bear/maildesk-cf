import { expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginCaptureKey, openPluginCapture, assemblePluginCaptureChunks } from "../../scripts/plugin-private-capture";
import { PRIVATE_CAPTURE_MAX_BYTES, sealPluginCapture, sealPluginCaptureChunk } from "../../scripts/plugin-private-capture-codec";

const request = `sha256:${"a".repeat(64)}`;
test("plugin encryption returns only ciphertext; host verifies request, key, bytes and exclusive custody", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "maildesk-private-capture-")));
  try {
    const key = createPluginCaptureKey(join(root, "key"));
    const input = { schema_version: 1, rows: [{ sql: "CREATE TABLE private_name (value TEXT DEFAULT 'private-value')" }], binary: "AAECA/8=" };
    const envelope = await sealPluginCapture(input, key.public_key_spki_base64, request);
    expect(JSON.stringify(envelope)).not.toContain("private-value");
    expect(JSON.stringify(envelope)).not.toContain("private_name");
    const path = join(key.directory, "schema.private.json");
    const result = openPluginCapture(envelope, key.private_key_path, request, path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(input);
    expect(result).toMatchObject({ captured: true, qualifies_release: false, qualifies_mail: false });
    for (const name of [path, key.private_key_path, join(key.directory, "capture-public.json")]) {
      expect(lstatSync(name).mode & 0o777).toBe(0o600);
      expect(lstatSync(name).nlink).toBe(1);
    }
    expect(() => openPluginCapture(envelope, key.private_key_path, request, path)).toThrow();
    expect(() => createPluginCaptureKey(key.directory)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tampering, wrong request/key, symlink and loose permissions cannot create a capture", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "maildesk-private-capture-")));
  try {
    const key = createPluginCaptureKey(join(root, "key"));
    const other = createPluginCaptureKey(join(root, "other"));
    const envelope = await sealPluginCapture({ sql: "private-value" }, key.public_key_spki_base64, request);
    const output = join(key.directory, "result.json");
    expect(() => openPluginCapture(envelope, key.private_key_path, `sha256:${"b".repeat(64)}`, output)).toThrow("binding");
    expect(() => openPluginCapture(envelope, other.private_key_path, request, output)).toThrow("authentication_failed");
    const changed = { ...envelope, ciphertext_base64: (envelope.ciphertext_base64[0] === "A" ? "B" : "A") + envelope.ciphertext_base64.slice(1) };
    expect(() => openPluginCapture(changed, key.private_key_path, request, output)).toThrow("authentication_failed");
    symlinkSync(key.private_key_path, output);
    expect(() => openPluginCapture(envelope, key.private_key_path, request, output)).toThrow();
    chmodSync(key.private_key_path, 0o644);
    expect(() => openPluginCapture(envelope, key.private_key_path, request, join(key.directory, "new.json"))).toThrow("file_custody");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("private capture rejects oversized plaintext, invalid public keys and request shapes", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "maildesk-private-capture-")));
  try {
    const key = createPluginCaptureKey(join(root, "key"));
    await expect(sealPluginCapture("x".repeat(PRIVATE_CAPTURE_MAX_BYTES), key.public_key_spki_base64, request)).rejects.toThrow("plaintext_limit");
    await expect(sealPluginCapture({}, key.public_key_spki_base64, "latest")).rejects.toThrow("request_digest");
    await expect(sealPluginCapture({}, "not-base64", request)).rejects.toThrow("base64");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bounded encrypted chunks reassemble exact Unicode bytes and reject incomplete, reordered or changed roots", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "maildesk-private-chunks-")));
  try {
    const key = createPluginCaptureKey(join(root, "key"));
    const value = { schema: "λ\u0000\n".repeat(6000) };
    const first = await sealPluginCaptureChunk(value, 0, key.public_key_spki_base64, request);
    const paths: string[] = [];
    for (let index = 0; index < first.count; index++) {
      const part = index === 0 ? first : await sealPluginCaptureChunk(value, index, key.public_key_spki_base64, request);
      expect(JSON.stringify(part).length).toBeLessThan(12000);
      const path = join(key.directory, `chunk-${index}.json`);
      openPluginCapture(part.encrypted_capture, key.private_key_path, request, path); paths.push(path);
    }
    expect(() => assemblePluginCaptureChunks(paths.slice(1), request, join(key.directory, "missing.json"))).toThrow("chunk_incomplete");
    expect(() => assemblePluginCaptureChunks(paths.toReversed(), request, join(key.directory, "reversed.json"))).toThrow("chunk_binding");
    const other = await sealPluginCaptureChunk({ schema: "μ\u0000\n".repeat(6000) }, 0, key.public_key_spki_base64, request);
    const changed = join(key.directory, "changed.json");openPluginCapture(other.encrypted_capture, key.private_key_path, request, changed);
    expect(() => assemblePluginCaptureChunks([changed, ...paths.slice(1)], request, join(key.directory, "changed-root.json"))).toThrow("chunk_binding");
    const output = join(key.directory, "complete.json");
    expect(assemblePluginCaptureChunks(paths, request, output)).toMatchObject({ captured: true, chunks: first.count });
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(value);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
