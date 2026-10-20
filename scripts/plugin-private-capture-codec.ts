import { pluginSha256 } from "./plugin-module-digests";

export const PRIVATE_CAPTURE_MAX_BYTES = 524288;
export const PRIVATE_CAPTURE_CHUNK_BYTES = 4096;
export interface SealedPluginCapture {
  schema_version: 1;
  algorithm: "RSA-OAEP-256+A256GCM";
  request_sha256: string;
  public_key_sha256: string;
  wrapped_key_base64: string;
  iv_base64: string;
  ciphertext_base64: string;
  plaintext_sha256: string;
}

/** Portable encrypted return channel. Only public key material enters the
 * plugin; the ephemeral AES key and plaintext never enter its tool result.
 * The execution receipt must separately bind this envelope to the actual read.
 */
export async function sealPluginCapture(value: unknown, publicKey: string, requestSha256: string): Promise<SealedPluginCapture> {
  if (!/^sha256:[a-f0-9]{64}$/.test(requestSha256)) throw new Error("private_capture:request_digest");
  const spki = captureBase64Decode(publicKey, 2048);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  if (plaintext.byteLength > PRIVATE_CAPTURE_MAX_BYTES) throw new Error("private_capture:plaintext_limit");
  const rsa = await crypto.subtle.importKey("spki", spki, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  if ((rsa.algorithm as RsaHashedKeyAlgorithm).modulusLength < 3072) throw new Error("private_capture:weak_public_key");
  const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(requestSha256);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, aes, plaintext);
  const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP", label: aad }, rsa, await crypto.subtle.exportKey("raw", aes));
  return { schema_version: 1, algorithm: "RSA-OAEP-256+A256GCM", request_sha256: requestSha256,
    public_key_sha256: await pluginSha256(spki), wrapped_key_base64: captureBase64Encode(new Uint8Array(wrapped)),
    iv_base64: captureBase64Encode(iv), ciphertext_base64: captureBase64Encode(new Uint8Array(ciphertext)),
    plaintext_sha256: await pluginSha256(plaintext) };
}

export function captureBase64Decode(value: string, maximum: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4 || value.length % 4 !== 0) throw new Error("private_capture:base64_limit");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (/[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding))) throw new Error("private_capture:base64_shape");
  let binary: string;
  try { binary = atob(value); } catch { throw new Error("private_capture:base64_decode"); }
  if (binary.length > maximum || btoa(binary) !== value) throw new Error("private_capture:base64_noncanonical");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function captureBase64Encode(value: Uint8Array): string {
  let result = "";
  for (let index = 0; index < value.length; index += 8192) result += String.fromCharCode(...value.subarray(index, index + 8192));
  return btoa(result);
}

/** Stateless bounded return: each tool result remains below the observed
 * 24,000-character truncation boundary. Every chunk binds the complete bytes.
 * Repeated source reads must have the same root digest before reassembly.
 */
export async function sealPluginCaptureChunk(value: unknown, index: number, publicKey: string, requestSha256: string) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (!bytes.length || bytes.length > PRIVATE_CAPTURE_MAX_BYTES || !Number.isSafeInteger(index) || index < 0) throw new Error("private_capture:chunk_input");
  const count = Math.ceil(bytes.length / PRIVATE_CAPTURE_CHUNK_BYTES);
  if (index >= count) throw new Error("private_capture:chunk_index");
  const root = await pluginSha256(bytes);
  const part = bytes.slice(index * PRIVATE_CAPTURE_CHUNK_BYTES, (index + 1) * PRIVATE_CAPTURE_CHUNK_BYTES);
  const envelope = await sealPluginCapture({ schema_version: 1, kind: "private_capture_chunk",
    request_sha256: requestSha256, index, count, total_bytes: bytes.length, root_sha256: root,
    chunk_base64: captureBase64Encode(part) }, publicKey, requestSha256);
  if (JSON.stringify(envelope).length > 12000) throw new Error("private_capture:chunk_envelope_limit");
  return { index, count, total_bytes: bytes.length, root_sha256: root, encrypted_capture: envelope };
}
