import PostalMime, { type Address, type Attachment, type Mailbox } from "postal-mime";

import type { MailAttachmentPayload, OperatorDeliveryConfig } from "./contracts";

const TOKEN_BYTES = 32;
const MAX_HEADER_BYTES = 256 * 1024;
const MAX_MIME_NESTING = 64;
const MIME_OVERHEAD_BYTES = 16 * 1024;

export interface ParsedRelayEmail {
  from: Mailbox;
  subject: string;
  text: string;
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  attachments: MailAttachmentPayload[];
}

export interface OperatorDeliveryMessage {
  from: EmailAddress;
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  attachments?: MailAttachmentPayload[];
}

export interface OperatorDeliveryInput {
  operator: string;
  receivedAddress: string;
  replyIdentity: string;
  routeKind: "role_alias" | "personal_alias" | "catch_all" | "sink";
  operatorCount: number;
  relayAddress: string;
  deliveryMessageId: string;
}

export async function parseRelayEmail(raw: ArrayBuffer): Promise<ParsedRelayEmail> {
  const parsed = await PostalMime.parse(raw, {
    attachmentEncoding: "arraybuffer",
    maxHeadersSize: MAX_HEADER_BYTES,
    maxNestingDepth: MAX_MIME_NESTING,
    rfc822Attachments: true,
  });
  const from = singleMailbox(parsed.from);
  if (!from || !normalizeMailbox(from.address)) {
    throw new Error("message From header must contain one mailbox");
  }
  return {
    from: { name: boundedHeaderText(from.name, 200), address: normalizeMailbox(from.address) },
    subject: boundedHeaderText(parsed.subject || "(no subject)", 998),
    text: parsed.text || "",
    html: parsed.html || undefined,
    messageId: validMessageId(parsed.messageId) ? parsed.messageId : undefined,
    inReplyTo: validMessageId(parsed.inReplyTo) ? parsed.inReplyTo : undefined,
    references: validMessageIds(parsed.references),
    attachments: parsed.attachments.map(mailAttachment),
  };
}

export function buildOperatorDelivery(
  parsed: ParsedRelayEmail,
  input: OperatorDeliveryInput,
): OperatorDeliveryMessage {
  const senderLabel = parsed.from.name || parsed.from.address;
  const policyResult =
    input.routeKind === "personal_alias" || input.operatorCount === 1
      ? "Delivered to the designated operator"
      : `Delivered to ${input.operatorCount} authorized operators`;
  const bannerText = [
    "Maildesk route",
    "",
    `Received at: ${input.receivedAddress}`,
    `Original sender: ${formatMailbox(parsed.from)}`,
    `Policy result: ${policyResult}`,
    "",
    "Reply behavior:",
    `Reply normally in this inbox. Maildesk will authenticate your account and send the response to the correspondent from ${input.replyIdentity}.`,
    "Your personal operator address will not be sent to the correspondent.",
  ].join("\n");
  const bannerHtml = `<section style="border:1px solid #cbd5e1;border-radius:8px;padding:16px;margin:0 0 20px;font-family:system-ui,sans-serif;color:#0f172a;background:#f8fafc"><strong>Maildesk route</strong><dl><dt>Received at</dt><dd>${escapeHtml(input.receivedAddress)}</dd><dt>Original sender</dt><dd>${escapeHtml(formatMailbox(parsed.from))}</dd><dt>Policy result</dt><dd>${escapeHtml(policyResult)}</dd></dl><p><strong>Reply behavior:</strong><br>Reply normally in this inbox. Maildesk will authenticate your account and send the response to the correspondent from ${escapeHtml(input.replyIdentity)}. Your personal operator address will not be sent to the correspondent.</p></section>`;
  const headers: Record<string, string> = {
    "Message-ID": input.deliveryMessageId,
    "X-Maildesk-Original-To": input.receivedAddress,
    "X-Maildesk-Route-Kind": input.routeKind,
    "X-Maildesk-Reply-Identity": input.replyIdentity,
  };
  if (parsed.messageId) headers["In-Reply-To"] = parsed.messageId;
  const references = [...parsed.references, parsed.messageId].filter((value): value is string => Boolean(value));
  if (references.length > 0) headers.References = references.join(" ");

  return {
    from: {
      name: boundedHeaderText(`${senderLabel} via ${input.receivedAddress}`, 200),
      email: input.replyIdentity,
    },
    to: input.operator,
    replyTo: input.relayAddress,
    subject: parsed.subject,
    text: `${bannerText}\n\n--- Original message ---\n\n${parsed.text || "(HTML-only message)"}`,
    html: `${bannerHtml}<div>${parsed.html || `<pre style="white-space:pre-wrap">${escapeHtml(parsed.text)}</pre>`}</div>`,
    headers,
    attachments: parsed.attachments.length > 0 ? parsed.attachments : undefined,
  };
}

export function outboundReplyPayload(parsed: ParsedRelayEmail): {
  subject: string;
  text?: string;
  html?: string;
  attachments?: MailAttachmentPayload[];
} {
  return {
    subject: parsed.subject,
    text: parsed.text || undefined,
    html: parsed.html,
    attachments: parsed.attachments.length > 0 ? parsed.attachments : undefined,
  };
}

export function encodedMessageUpperBound(input: {
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: MailAttachmentPayload[];
}): number {
  const encoder = new TextEncoder();
  let size = MIME_OVERHEAD_BYTES;
  // Quoted-printable can expand an arbitrary UTF-8 byte to three bytes and
  // also inserts soft line breaks. Four times the source byte length is a
  // deliberately conservative ceiling for every provider-selected text/header
  // transfer encoding, including CRLF normalization.
  const encodedTextCeiling = (value: string) => encoder.encode(value).byteLength * 4;
  size += encodedTextCeiling(input.subject);
  size += encodedTextCeiling(input.text ?? "");
  size += encodedTextCeiling(input.html ?? "");
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    size += encoder.encode(name).byteLength + encodedTextCeiling(value) + 4;
  }
  for (const attachment of input.attachments ?? []) {
    const bytes = attachment.content.byteLength;
    const base64Bytes = Math.ceil(bytes / 3) * 4;
    const base64LineBreaks = Math.ceil(base64Bytes / 76) * 2;
    size += base64Bytes + base64LineBreaks;
    size += encodedTextCeiling(attachment.filename);
    size += encodedTextCeiling(attachment.type);
    size += encodedTextCeiling(attachment.contentId ?? "");
    size += 1024;
  }
  return size;
}

export function assertWithinRelayLimit(
  input: Parameters<typeof encodedMessageUpperBound>[0],
  config: OperatorDeliveryConfig,
): void {
  if (encodedMessageUpperBound(input) > config.maxEncodedMessageBytes) {
    throw new Error("maildesk relay message exceeds the configured encoded-size limit");
  }
}

export function generateRelayToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

export async function sha256Hex(value: string | ArrayBuffer | ArrayBufferView): Promise<string> {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : copiedBytes(value);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export function relayAddress(token: string, replyDomain: string): string {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("relay token is invalid");
  return `r+${token}@${replyDomain}`;
}

export function relayTokenFromRecipient(recipient: string, replyDomain: string): string | null {
  const mailbox = normalizeMailbox(recipient);
  const suffix = `@${replyDomain}`;
  if (!mailbox.endsWith(suffix)) return null;
  const localPart = mailbox.slice(0, -suffix.length);
  const match = /^r\+([a-f0-9]{64})$/.exec(localPart);
  return match?.[1] ?? null;
}

export function tokenExpiresAt(now: Date, ttlDays: number): string {
  return new Date(now.getTime() + ttlDays * 86_400_000).toISOString();
}

export function relayRecordIsActive(
  expiresAt: string,
  revokedAt: string | null,
  nowMs = Date.now(),
): boolean {
  if (revokedAt) return false;
  const expiryMs = Date.parse(expiresAt);
  return Number.isFinite(expiryMs) && expiryMs > nowMs;
}

export function normalizeMailbox(value: string): string {
  const mailbox = value.trim().toLowerCase();
  const at = mailbox.lastIndexOf("@");
  const domain = mailbox.slice(at + 1);
  if (
    at <= 0 ||
    at === mailbox.length - 1 ||
    mailbox.length > 320 ||
    domain.includes("@") ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(domain) ||
    /[\s\x00-\x1f\x7f]/.test(mailbox)
  ) {
    return "";
  }
  return mailbox;
}

export function safeConversationHeaders(parsed: ParsedRelayEmail): Record<string, string> {
  const headers: Record<string, string> = {};
  if (parsed.inReplyTo) headers["In-Reply-To"] = parsed.inReplyTo;
  if (parsed.references.length > 0) headers.References = parsed.references.join(" ");
  return headers;
}

function singleMailbox(address: Address | undefined): Mailbox | null {
  if (!address || "group" in address) return null;
  return address;
}

function mailAttachment(attachment: Attachment): MailAttachmentPayload {
  const decoded = attachment.content;
  const content = decoded instanceof ArrayBuffer
    ? decoded
    : ArrayBuffer.isView(decoded)
      ? copiedBytes(decoded).buffer
      : null;
  if (!content) throw new Error("attachment decoder returned an unsupported payload");
  const disposition = attachment.disposition === "inline" && attachment.contentId ? "inline" : "attachment";
  const base = {
    filename: safeFilename(attachment.filename),
    type: safeContentType(attachment.mimeType),
    content,
  };
  return disposition === "inline"
    ? { ...base, disposition, contentId: boundedHeaderText(attachment.contentId || "", 200) }
    : { ...base, disposition };
}

function safeFilename(value: string | null): string {
  const filename = (value || "attachment.bin").replace(/[\r\n\\/]/g, "_").trim();
  return boundedHeaderText(filename || "attachment.bin", 255);
}

function safeContentType(value: string): string {
  const contentType = value.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType)
    ? contentType
    : "application/octet-stream";
}

function validMessageId(value: string | undefined): boolean {
  return Boolean(value && value.length <= 998 && /^<[^<>\s]+>$/.test(value));
}

function validMessageIds(value: string | undefined): string[] {
  if (!value || value.length > 8_000) return [];
  return [...new Set(value.match(/<[^<>\s]+>/g) ?? [])].slice(-50);
}

function boundedHeaderText(value: string, maxLength: number): string {
  return value.replace(/[\r\n\x00-\x1f\x7f]+/g, " ").trim().slice(0, maxLength);
}

function formatMailbox(mailbox: Mailbox): string {
  return mailbox.name ? `${mailbox.name} <${mailbox.address}>` : mailbox.address;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function copiedBytes(value: ArrayBufferView): Uint8Array<ArrayBuffer> {
  const source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}
