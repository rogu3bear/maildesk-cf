import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, privateDecrypt, constants as cryptoConstants, createDecipheriv } from "node:crypto";
import { dirname, resolve } from "node:path";
import { captureBase64Decode, PRIVATE_CAPTURE_MAX_BYTES, PRIVATE_CAPTURE_CHUNK_BYTES, type SealedPluginCapture } from "./plugin-private-capture-codec";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** New private directory only. Never replaces existing keys, captures or paths. */
export function createPluginCaptureKey(directory: string) {
  const path = resolve(directory);
  if (realpathSync(dirname(path)) !== dirname(path)) throw new Error("private_capture:parent_symlink");
  mkdirSync(path, { mode: 0o700 });
  assertDirectory(path);
  const pair = generateKeyPairSync("rsa", { modulusLength: 3072,
    publicKeyEncoding: { format: "der", type: "spki" }, privateKeyEncoding: { format: "der", type: "pkcs8" } });
  const privatePath = resolve(path, "capture-key.pk8");
  writeExclusive(privatePath, pair.privateKey);
  const publicInfo = { schema_version: 1, public_key_spki_base64: pair.publicKey.toString("base64"),
    public_key_sha256: sha(pair.publicKey) };
  writeExclusive(resolve(path, "capture-public.json"), Buffer.from(JSON.stringify(publicInfo) + "\n"));
  return { directory: path, private_key_path: privatePath, ...publicInfo };
}

/** Decrypt only an envelope whose request and executor receipt were admitted
 * separately. File custody and cryptographic integrity do not prove provenance.
 */
export function openPluginCapture(value: unknown, privateKeyPath: string, expectedRequest: string, outputPath: string) {
  const keys = ["schema_version", "algorithm", "request_sha256", "public_key_sha256", "wrapped_key_base64", "iv_base64", "ciphertext_base64", "plaintext_sha256"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys.sort().join(",")) throw new Error("private_capture:envelope_shape");
  const row = value as SealedPluginCapture;
  if (row.schema_version !== 1 || row.algorithm !== "RSA-OAEP-256+A256GCM" || row.request_sha256 !== expectedRequest ||
      !/^sha256:[a-f0-9]{64}$/.test(expectedRequest) || !/^[a-f0-9]{64}$/.test(row.plaintext_sha256) || !/^[a-f0-9]{64}$/.test(row.public_key_sha256)) throw new Error("private_capture:binding");
  const keyPath = resolve(privateKeyPath), destination = resolve(outputPath);
  assertDirectory(dirname(keyPath)); assertDirectory(dirname(destination));
  const key = readPrivateFile(keyPath);
  let plaintext: Buffer;
  try {
    const privateKey = createPrivateKey({ key, format: "der", type: "pkcs8" });
    const publicDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
    if (sha(publicDer) !== row.public_key_sha256) throw new Error("key mismatch");
    const aad = Buffer.from(expectedRequest);
    const aes = privateDecrypt({ key: privateKey, oaepHash: "sha256", oaepLabel: aad,
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING }, captureBase64Decode(row.wrapped_key_base64, 1024));
    const iv = captureBase64Decode(row.iv_base64, 12), ciphertext = captureBase64Decode(row.ciphertext_base64, PRIVATE_CAPTURE_MAX_BYTES + 16);
    if (aes.length !== 32 || iv.length !== 12 || ciphertext.length < 16) throw new Error("cipher shape");
    const decipher = createDecipheriv("aes-256-gcm", aes, iv);
    decipher.setAAD(aad); decipher.setAuthTag(ciphertext.subarray(-16));
    plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
    aes.fill(0);
    if (sha(plaintext) !== row.plaintext_sha256) throw new Error("digest mismatch");
  } catch { throw new Error("private_capture:authentication_failed"); }
  finally { key.fill(0); }
  writeExclusive(destination, plaintext);
  return { captured: true, path: destination, sha256: sha(plaintext), byte_count: plaintext.length,
    request_sha256: expectedRequest, qualifies_release: false, qualifies_mail: false };
}

/** Assemble only independently authenticated private chunk files. A missing,
 * duplicate, reordered or changed-root set never becomes a complete capture.
 */
export function assemblePluginCaptureChunks(paths: string[], expectedRequest: string, outputPath: string) {
  if (!paths.length || paths.length > Math.ceil(PRIVATE_CAPTURE_MAX_BYTES / PRIVATE_CAPTURE_CHUNK_BYTES)) throw new Error("private_capture:chunk_count");
  const chunks = paths.map((path) => {
    const absolute = resolve(path); assertDirectory(dirname(absolute));
    let row: Record<string, unknown>;
    try { row = JSON.parse(readPrivateFile(absolute).toString("utf8")); } catch { throw new Error("private_capture:chunk_json"); }
    const keys = ["schema_version", "kind", "request_sha256", "index", "count", "total_bytes", "root_sha256", "chunk_base64"];
    if (!row || typeof row !== "object" || Object.keys(row).sort().join(",") !== keys.sort().join(",") ||
        row.schema_version !== 1 || row.kind !== "private_capture_chunk" || row.request_sha256 !== expectedRequest ||
        !Number.isSafeInteger(row.index) || !Number.isSafeInteger(row.count) || !Number.isSafeInteger(row.total_bytes) ||
        !/^[a-f0-9]{64}$/.test(String(row.root_sha256)) || typeof row.chunk_base64 !== "string") throw new Error("private_capture:chunk_shape");
    return row;
  });
  const first = chunks[0]!;
  const total = Number(first.total_bytes), count = Math.ceil(total / PRIVATE_CAPTURE_CHUNK_BYTES);
  if (total < 1 || total > PRIVATE_CAPTURE_MAX_BYTES || first.count !== count || chunks.length !== count) throw new Error("private_capture:chunk_incomplete");
  const buffers = chunks.map((row, index) => {
    if (row.index !== index || row.count !== count || row.total_bytes !== total || row.root_sha256 !== first.root_sha256) throw new Error("private_capture:chunk_binding");
    const bytes = captureBase64Decode(row.chunk_base64 as string, PRIVATE_CAPTURE_CHUNK_BYTES);
    if (bytes.length !== Math.min(PRIVATE_CAPTURE_CHUNK_BYTES, total - index * PRIVATE_CAPTURE_CHUNK_BYTES)) throw new Error("private_capture:chunk_size");
    return Buffer.from(bytes);
  });
  const result = Buffer.concat(buffers);
  if (result.length !== total || sha(result) !== first.root_sha256) throw new Error("private_capture:chunk_root");
  const destination = resolve(outputPath); assertDirectory(dirname(destination)); writeExclusive(destination, result);
  return { captured: true, path: destination, byte_count: total, chunks: count, sha256: sha(result),
    request_sha256: expectedRequest, qualifies_release: false, qualifies_mail: false };
}

function assertDirectory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 ||
      stat.uid !== process.getuid?.() || realpathSync(path) !== path) throw new Error("private_capture:directory_custody");
}

function writeExclusive(path: string, bytes: Uint8Array) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { assertPrivateStat(fd); writeFileSync(fd, bytes); } finally { closeSync(fd); }
}

function readPrivateFile(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { assertPrivateStat(fd); return readFileSync(fd); } finally { closeSync(fd); }
}

function assertPrivateStat(fd: number) {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error("private_capture:file_custody");
}
