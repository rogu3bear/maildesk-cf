import { addressParser } from "postal-mime";
import { messageIdentity } from "./message-identity";
import type { OperatorAuthenticationResult } from "./contracts";
import { normalizeMailbox, sha256Hex } from "./inbox-relay";
import { RequestDeadlineError, withRequestDeadline } from "./request-deadline";

export const DKIM_VERIFICATION_TIMEOUT_MS = 5_000;
const MAX_DNS_TTL_SECONDS = 300;
const keyCache = new Map<string, { expiresAt: number; spki: ArrayBuffer }>();

interface RawHeader {
  name: string;
  raw: string;
  unfoldedValue: string;
}

interface DkimSignature {
  header: RawHeader;
  tags: Map<string, string>;
}

export interface DkimVerificationOptions {
  fetcher?: typeof fetch;
  now?: Date;
  binding?: { recipient: string; messageId: string };
}

export async function verifyOperatorDkim(
  rawMessage: ArrayBuffer,
  operator: string,
  options: DkimVerificationOptions = {},
): Promise<OperatorAuthenticationResult> {
  const verifiedAt = (options.now ?? new Date()).toISOString();
  const mailbox = normalizeMailbox(operator);
  const operatorDomain = mailbox.split("@")[1];
  if (!operatorDomain) return rejected("invalid_operator", verifiedAt);

  let parsed: ReturnType<typeof parseRawMessage>;
  try {
    parsed = parseRawMessage(rawMessage);
  } catch {
    return rejected("malformed_message", verifiedAt);
  }
  if (parsed.headers.filter((header) => singletonHeader(header.name)).some((header, index, all) =>
      all.findIndex((other) => other.name === header.name) !== index)) {
    return rejected("ambiguous_singleton_headers", verifiedAt);
  }
  const signatures = parsed.headers
    .filter((header) => header.name === "dkim-signature")
    .map((header) => ({ header, tags: parseTags(header.unfoldedValue) }));
  if (signatures.length > 8) return rejected("dkim_signature_limit", verifiedAt);
  if (signatures.some((signature) => signature.tags.has("invalid-duplicate-tag"))) return rejected("dkim_duplicate_tag", verifiedAt);
  if (signatures.length === 0) return rejected("dkim_missing", verifiedAt);

  try {
    return await withRequestDeadline(DKIM_VERIFICATION_TIMEOUT_MS, async (signal) => {
      let verifiedWithoutBinding: OperatorAuthenticationResult | null = null;
      let sawIndeterminate = false;
      let lastRejection: OperatorAuthenticationResult | null = null;
      for (const signature of signatures) {
        signal.throwIfAborted();
        const result = await verifySignature(parsed.headers, parsed.body, signature, mailbox, operatorDomain, {
          fetcher: options.fetcher ?? fetch,
          now: options.now ?? new Date(),
          verifiedAt, binding: options.binding, signal,
        });
        signal.throwIfAborted();
        if (result.status === "verified") {
          if (!options.binding || result.ordinaryBinding) return result;
          verifiedWithoutBinding = result;
        }
        if (result.status === "indeterminate") sawIndeterminate = true;
        if (result.status === "rejected") lastRejection = result;
      }
      if (verifiedWithoutBinding) return verifiedWithoutBinding;
      return sawIndeterminate
        ? indeterminate("dkim_key_unavailable", verifiedAt)
        : lastRejection ?? rejected("dkim_verification_failed", verifiedAt);
    });
  } catch (error) {
    if (!(error instanceof RequestDeadlineError)) throw error;
    return indeterminate("dkim_key_unavailable", verifiedAt);
  }
}

async function verifySignature(
  headers: RawHeader[],
  body: Uint8Array,
  signature: DkimSignature,
  operator: string,
  operatorDomain: string,
  options: { fetcher: typeof fetch; now: Date; verifiedAt: string; binding?: DkimVerificationOptions["binding"]; signal: AbortSignal },
): Promise<OperatorAuthenticationResult> {
  const { tags } = signature;
  if (tags.has("l")) return rejected("dkim_partial_body_unsupported", options.verifiedAt);
  const algorithm = tags.get("a")?.toLowerCase();
  const signingDomain = tags.get("d")?.toLowerCase();
  const selector = tags.get("s")?.toLowerCase();
  const signedHeaders = tags.get("h")?.toLowerCase().split(":").map((value) => value.trim()).filter(Boolean) ?? [];
  if (algorithm !== "rsa-sha256") return rejected("dkim_algorithm_rejected", options.verifiedAt);
  if (!signingDomain || signingDomain !== operatorDomain) return rejected("dkim_domain_unaligned", options.verifiedAt);
  if (!selector || !/^[a-z0-9_-]{1,63}$/.test(selector)) return rejected("dkim_selector_invalid", options.verifiedAt);
  if (!headers.some((header) => header.name === "from")) return rejected("dkim_from_missing", options.verifiedAt);
  if (!signedHeaders.includes("from")) return rejected("dkim_from_unsigned", options.verifiedAt);
  const signedFrom = singleHeaderMailbox(headers, "from");
  if (signedFrom !== operator) return rejected("dkim_from_operator_mismatch", options.verifiedAt);
  const expiration = Number(tags.get("x"));
  if (tags.has("x") && (!Number.isSafeInteger(expiration) || expiration * 1000 <= options.now.getTime())) {
    return rejected("dkim_signature_expired", options.verifiedAt);
  }
  const bodyHash = tags.get("bh");
  const signatureBytes = decodeBase64(tags.get("b") ?? "");
  if (!bodyHash || !signatureBytes) return rejected("dkim_signature_malformed", options.verifiedAt);

  const [headerMode, bodyMode] = canonicalization(tags.get("c"));
  if (!headerMode || !bodyMode) return rejected("dkim_canonicalization_unsupported", options.verifiedAt);
  const canonicalBody = canonicalizeBody(body, bodyMode);
  const computedBodyHash = encodeBase64(await crypto.subtle.digest("SHA-256", canonicalBody));
  if (!constantTimeEqual(computedBodyHash, bodyHash.replace(/\s+/g, ""))) {
    return rejected("dkim_body_hash_mismatch", options.verifiedAt);
  }

  const signedData = canonicalizeSignedHeaders(headers, signature, signedHeaders, headerMode);
  if (!signedData) return rejected("dkim_signed_header_missing", options.verifiedAt);
  let spki: ArrayBuffer;
  try {
    spki = await resolveDkimKey(selector, signingDomain, options.fetcher, options.now.getTime(), options.signal);
  } catch {
    return indeterminate("dkim_key_unavailable", options.verifiedAt, signingDomain);
  }
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const modulusLength = (key.algorithm as { name: string; modulusLength?: number }).modulusLength;
    if (!Number.isSafeInteger(modulusLength) || (modulusLength ?? 0) < 2048) {
      return rejected("dkim_key_weak", options.verifiedAt);
    }
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signatureBytes, signedData);
    if (!ok) return rejected("dkim_signature_invalid", options.verifiedAt);
    return {
      status: "verified",
      method: "dkim",
      signingDomain,
      selectorHash: await sha256Hex(selector),
      alignedOperatorId: await sha256Hex(`operator\0${operator}`),
      verifiedAt: options.verifiedAt,
      ...await ordinaryBinding(headers, signedHeaders, options.binding),
    };
  } catch {
    return rejected("dkim_key_invalid", options.verifiedAt);
  }
}

async function resolveDkimKey(
  selector: string,
  domain: string,
  fetcher: typeof fetch,
  nowMs: number,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  signal.throwIfAborted();
  const name = `${selector}._domainkey.${domain}`;
  const cached = keyCache.get(name);
  if (cached && cached.expiresAt > nowMs) return cached.spki.slice(0);
  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.searchParams.set("name", name);
  url.searchParams.set("type", "TXT");
  const response = await fetcher(url, { headers: { accept: "application/dns-json" }, signal });
  if (!response.ok) throw new Error("dns_http_error");
  const payload = await response.json() as {
    Status?: number;
    Answer?: Array<{ type?: number; TTL?: number; data?: string }>;
  };
  if (payload.Status !== 0) throw new Error("dns_status_error");
  const answer = payload.Answer?.find((entry) => entry.type === 16 && typeof entry.data === "string");
  if (!answer?.data) throw new Error("dns_key_missing");
  const record = answer.data.replace(/"\s*"/g, "").replace(/^"|"$/g, "");
  const tags = parseTags(record);
  if ((tags.get("v") ?? "DKIM1").toUpperCase() !== "DKIM1") throw new Error("dns_key_version");
  if ((tags.get("k") ?? "rsa").toLowerCase() !== "rsa") throw new Error("dns_key_algorithm");
  const spki = decodeBase64(tags.get("p") ?? "");
  if (!spki || spki.byteLength < 128) throw new Error("dns_key_invalid");
  const ttl = Math.max(0, Math.min(MAX_DNS_TTL_SECONDS, Number(answer.TTL) || 0));
  signal.throwIfAborted();
  if (keyCache.size >= 512) keyCache.clear();
  keyCache.set(name, { expiresAt: nowMs + ttl * 1000, spki: spki.slice(0) });
  return spki;
}

function parseRawMessage(rawMessage: ArrayBuffer): { headers: RawHeader[]; body: Uint8Array } {
  if (rawMessage.byteLength > 5 * 1024 * 1024) throw new Error("message_limit");
  const input = byteString(new Uint8Array(rawMessage));
  if (/\r(?!\n)/.test(input)) throw new Error("ambiguous_line_endings");
  const normalized = input.replace(/\r?\n/g, "\r\n");
  const boundary = normalized.indexOf("\r\n\r\n");
  if (boundary < 0) throw new Error("header_boundary_missing");
  if (boundary > 256 * 1024) throw new Error("header_limit");
  const headerText = normalized.slice(0, boundary);
  const bodyText = normalized.slice(boundary + 4);
  const blocks = headerText.split(/\r\n(?=[^ \t])/);
  const headers = blocks.map((raw): RawHeader => {
    const colon = raw.indexOf(":");
    if (colon <= 0 || !/^[!#-9;-~]+$/.test(raw.slice(0, colon))) throw new Error("header_malformed");
    return {
      name: raw.slice(0, colon).trim().toLowerCase(),
      raw,
      unfoldedValue: raw.slice(colon + 1).replace(/\r\n[ \t]+/g, " ").trim(),
    };
  });
  return { headers, body: byteArray(bodyText) };
}

function parseTags(value: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const section of value.split(";")) {
    const equals = section.indexOf("=");
    if (equals <= 0) continue;
    const name = section.slice(0, equals).trim().toLowerCase();
    if (tags.has(name)) tags.set("invalid-duplicate-tag", "true");
    else tags.set(name, section.slice(equals + 1).trim());
  }
  return tags;
}

function canonicalization(value: string | undefined): ["simple" | "relaxed" | null, "simple" | "relaxed" | null] {
  const [header = "simple", body = "simple"] = (value ?? "simple/simple").toLowerCase().split("/");
  return [mode(header), mode(body)];
}

function mode(value: string): "simple" | "relaxed" | null {
  return value === "simple" || value === "relaxed" ? value : null;
}

function canonicalizeBody(body: Uint8Array, mode: "simple" | "relaxed"): Uint8Array {
  const lines = byteString(body).replace(/\r?\n/g, "\r\n").split("\r\n");
  const canonical = mode === "relaxed"
    ? lines.map((line) => line.replace(/[ \t]+/g, " ").replace(/[ \t]+$/g, ""))
    : lines;
  while (canonical.length > 0 && canonical[canonical.length - 1] === "") canonical.pop();
  return byteArray(`${canonical.join("\r\n")}\r\n`);
}

function canonicalizeSignedHeaders(
  headers: RawHeader[],
  signature: DkimSignature,
  signedNames: string[],
  mode: "simple" | "relaxed",
): Uint8Array | null {
  const consumed = new Map<string, number>();
  const selected: string[] = [];
  for (const name of signedNames) {
    const matches = headers.filter((header) => header.name === name);
    const used = consumed.get(name) ?? 0;
    const header = matches[matches.length - 1 - used];
    consumed.set(name, used + 1);
    // RFC 6376 section 5.4 permits a signer to list a header more times than
    // it exists. The nonexistent occurrence contributes the null string and
    // thereby prevents an intermediary from injecting another field later.
    if (!header) continue;
    selected.push(canonicalizeHeader(header.raw, mode));
  }
  const withoutSignature = signature.header.raw.replace(/\bb\s*=\s*([^;\r\n]*(?:\r\n[ \t]+[^;\r\n]*)*)/i, "b=");
  // RFC 6376 section 3.7 hashes the DKIM-Signature field itself after
  // removing b=, but excludes that final field's trailing CRLF.
  selected.push(canonicalizeHeader(withoutSignature, mode, false));
  return byteArray(selected.join(""));
}

function canonicalizeHeader(raw: string, mode: "simple" | "relaxed", appendCrlf = true): string {
  if (mode === "simple") return `${raw}${appendCrlf ? "\r\n" : ""}`;
  const colon = raw.indexOf(":");
  const name = raw.slice(0, colon).trim().toLowerCase();
  const value = raw.slice(colon + 1)
    .replace(/\r\n[ \t]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
  return `${name}:${value}${appendCrlf ? "\r\n" : ""}`;
}

function decodeBase64(value: string): ArrayBuffer | null {
  try {
    const binary = atob(value.replace(/\s+/g, ""));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytes.buffer;
  } catch {
    return null;
  }
}

function encodeBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function rejected(code: string, verifiedAt: string): OperatorAuthenticationResult {
  return { status: "rejected", method: "dkim", boundedErrorCode: code, verifiedAt };
}

function indeterminate(
  code: string,
  verifiedAt: string,
  signingDomain?: string,
): OperatorAuthenticationResult {
  return {
    status: "indeterminate",
    method: "dkim",
    signingDomain,
    boundedErrorCode: code,
    verifiedAt,
  };
}

function byteString(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return value;
}

function byteArray(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function singletonHeader(name: string): boolean {
  return ["from", "sender", "to", "cc", "bcc", "reply-to", "message-id", "subject", "date", "mime-version", "in-reply-to", "references"].includes(name) || name.startsWith("content-");
}

function singleHeaderMailbox(headers: RawHeader[], name: string): string | null {
  const values = headers.filter((header) => header.name === name);
  if (values.length !== 1) return null;
  const addresses = addressParser(values[0]!.unfoldedValue);
  return addresses.length === 1 && addresses[0]?.address
    ? normalizeMailbox(addresses[0].address) || null : null;
}

async function ordinaryBinding(
  headers: RawHeader[], signed: string[], binding: DkimVerificationOptions["binding"],
): Promise<Pick<OperatorAuthenticationResult, "ordinaryBinding" | "ordinaryBindingError">> {
  if (!binding) return {};
  const required = new Set(["from", "to", "message-id"]);
  for (const header of headers) {
    if (header.name === "subject" || header.name === "mime-version" || header.name.startsWith("content-")) {
      required.add(header.name);
    }
  }
  if ([...required].some((name) => !signed.includes(name))) return { ordinaryBindingError: "ordinary_consumed_header_unsigned" };
  const recipient = singleHeaderMailbox(headers, "to");
  const messageId = headers.find((header) => header.name === "message-id")?.unfoldedValue;
  if (!recipient || recipient !== normalizeMailbox(binding.recipient)) return { ordinaryBindingError: "ordinary_relay_recipient_mismatch" };
  if (!messageIdentity(messageId) || messageId !== binding.messageId) return { ordinaryBindingError: "ordinary_message_identity_mismatch" };
  return { ordinaryBinding: { schemaVersion: 1, recipientSha256: await sha256Hex(recipient), messageIdSha256: await sha256Hex(messageId) } };
}
