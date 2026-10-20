import type { MaildeskEnv,OutboundReplyRequestedJob } from "../contracts";
import { sha256Hex } from "../inbox-relay";
import { projectPolicy,type RouterPolicy } from "../router";
import { canonicalConversationHeaders } from "./conversation";

export function outboundPrivacyFailure(job: OutboundReplyRequestedJob, policy: RouterPolicy): string | null {
  // Opaque outbound attachments cannot be proven free of operator identities:
  // an address may be compressed, embedded in document structure, image metadata,
  // or encoded in a format that a byte/text scan cannot interpret. Fail closed
  // until a format-aware attachment policy exists.
  if ((job.attachments?.length ?? 0) > 0) {
    return "outbound attachments are disabled until format-aware privacy inspection is configured";
  }
  const projection = projectPolicy(policy);
  if (!projection.ok) return "outbound privacy policy is invalid";
  const visible = outwardVisibleValues(job).map(normalizedVisibleValue);
  const protectedIdentities = projection.value.protectedOperators.map(normalizedVisibleValue);
  if ([...visible, ...protectedIdentities].some((value) => !value.complete)) {
    return "outbound content encoding exceeds privacy inspection limits";
  }
  if (visible.some(({ value }) => /r\+[a-f0-9]{62}(?:[a-f0-9]{2})?(?![a-f0-9])/i.test(value))) {
    return "outbound content contains an opaque relay recipient";
  }
  return protectedIdentities.some((protectedIdentity) =>
    protectedIdentity.value && visible.some((value) => value.value.includes(protectedIdentity.value))
  )
    ? "outbound content contains a private operator identity"
    : null;
}

function outwardVisibleValues(job: OutboundReplyRequestedJob): string[] {
  return [
    job.fromIdentity,
    job.replyTo ?? job.fromIdentity,
    ...job.to,
    ...(job.cc ?? []),
    ...(job.bcc ?? []),
    job.subject,
    job.text ?? "",
    job.html ?? "",
    htmlVisibleText(job.html ?? ""),
    ...Object.entries(canonicalConversationHeaders(job)).flat(),
  ];
}

/** Inspect known opaque tokens without materializing stored plaintext tokens.
 * An unrelated SHA-256 in authored prose is not automatically a secret.
 */
export async function outboundOpaqueTokenFailure(job: OutboundReplyRequestedJob, env: Pick<MaildeskEnv, "DB">): Promise<string | null> {
  const candidates = new Set(outwardVisibleValues(job).flatMap((value) =>
    normalizedVisibleValue(value).value.match(/(?<![a-f0-9])[a-f0-9]{62}(?:[a-f0-9]{2})?(?![a-f0-9])/g) ?? []));
  if (candidates.size > 32) return "outbound token inspection limit exceeded";
  for (const candidate of candidates) {
    try {
      const match = await env.DB.prepare("SELECT id FROM reply_relays WHERE token_sha256 = ?1 LIMIT 1")
        .bind(await sha256Hex(candidate)).first<{ id: string }>();
      if (match) return "outbound content contains a private relay token";
    } catch { return "outbound token inspection is unavailable"; }
  }
  return null;
}

export function htmlVisibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<[^>]*>/g, "");
}

export const MAX_PRIVACY_DECODING_ROUNDS = 4;

export const PRIVACY_UTF8_DECODER = new TextDecoder();

export interface NormalizedVisibleValue {
  value: string;
  complete: boolean;
}

export function normalizedVisibleValue(value: string): NormalizedVisibleValue {
  let current = canonicalVisibleText(value);
  for (let round = 0; round < MAX_PRIVACY_DECODING_ROUNDS; round += 1) {
    const next = canonicalVisibleText(decodePercentEncodedBytes(decodeHtmlEntities(current)));
    if (next === current) return { value: current, complete: true };
    current = next;
  }

  const next = canonicalVisibleText(decodePercentEncodedBytes(decodeHtmlEntities(current)));
  return { value: current, complete: next === current };
}

export function decodeHtmlEntities(value: string): string {
  // HTML parsers consume numeric references even when the semicolon is omitted.
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (entity: string, hex: string) =>
      decodeHtmlCodePoint(entity, hex, 16)
    )
    .replace(/&#([0-9]+);?/g, (entity: string, decimal: string) =>
      decodeHtmlCodePoint(entity, decimal, 10)
    )
    .replace(/&tab;/gi, "\t")
    .replace(/&newline;/gi, "\n")
    .replace(/&commat;/gi, "@")
    .replace(/&period;/gi, ".")
    .replace(/&percnt;/gi, "%")
    .replace(/&amp;/gi, "&");
}

export function decodeHtmlCodePoint(entity: string, digits: string, radix: number): string {
  const codePoint = Number.parseInt(digits, radix);
  if (
    !Number.isSafeInteger(codePoint) ||
    codePoint <= 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return entity;
  }
  return String.fromCodePoint(codePoint);
}

export function decodePercentEncodedBytes(value: string): string {
  return value.replace(/(?:%[0-9a-f]{2})+/gi, (encoded: string) => {
    const bytes = new Uint8Array(encoded.length / 3);
    for (let offset = 0; offset < encoded.length; offset += 3) {
      bytes[offset / 3] = Number.parseInt(encoded.slice(offset + 1, offset + 3), 16);
    }
    return PRIVACY_UTF8_DECODER.decode(bytes);
  });
}

export function canonicalVisibleText(value: string): string {
  // WHATWG URL preprocessing removes these controls before interpreting href values.
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .replace(/[\t\n\r]/g, "");
}
