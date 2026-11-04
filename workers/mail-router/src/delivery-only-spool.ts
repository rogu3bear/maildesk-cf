import { assertWithinRelayLimit, normalizeMailbox, sha256Hex, type DeliveryOnlyMessage } from "../../shared/inbox-relay";
import type { MailAttachmentPayload, OperatorDeliveryConfig } from "../../shared/contracts";
import { relaySpoolKey } from "../../shared/contracts";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./inbound-recovery";

export function serializeDeliveryOnlyMessage(message: DeliveryOnlyMessage): string {
  return JSON.stringify({
    ...message,
    attachments: message.attachments?.map((attachment) => ({ ...attachment, content: arrayBufferToBase64(attachment.content) })),
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** Rehydrate only the immutable, hash-bound delivery; never accept reply headers. */
export async function deserializeDeliveryOnlyMessage(
  serialized: string,
  expected: { sha256: string; recipientRef: string; receivedAddress: string; deliveryMessageId: string },
): Promise<DeliveryOnlyMessage> {
  if (await sha256Hex(serialized) !== expected.sha256) throw new Error("delivery-only payload digest drifted");
  if (!expected.receivedAddress || normalizeMailbox(expected.receivedAddress) !== expected.receivedAddress ||
      !expected.deliveryMessageId || /[\r\n\x00-\x1f\x7f]/.test(expected.deliveryMessageId)) {
    throw new Error("delivery-only expected binding is invalid");
  }
  const value: unknown = JSON.parse(serialized);
  if (!record(value) || !exactKeys(value, ["from", "to", "subject", "text", "html", "headers", "attachments"]) ||
      !record(value.from) || !exactKeys(value.from, ["name", "email"]) ||
      typeof value.from.name !== "string" || typeof value.from.email !== "string" ||
      typeof value.to !== "string" || typeof value.subject !== "string" || typeof value.text !== "string" ||
      (value.html !== undefined && typeof value.html !== "string") || !record(value.headers) ||
      !exactKeys(value.headers, ["X-Maildesk-Delivery-ID", "X-Maildesk-Original-To"]) ||
      value.headers["X-Maildesk-Delivery-ID"] !== expected.deliveryMessageId ||
      value.headers["X-Maildesk-Original-To"] !== expected.receivedAddress ||
      normalizeMailbox(value.from.email) !== expected.receivedAddress ||
      !value.to || normalizeMailbox(value.to) !== value.to || await sha256Hex(value.to) !== expected.recipientRef ||
      (value.attachments !== undefined && !Array.isArray(value.attachments))) {
    throw new Error("delivery-only payload binding is invalid");
  }
  const attachments: MailAttachmentPayload[] = [];
  for (const attachment of value.attachments ?? []) {
    if (!record(attachment) || !exactKeys(attachment, ["disposition", "contentId", "filename", "type", "content"]) ||
        typeof attachment.filename !== "string" || typeof attachment.type !== "string" || typeof attachment.content !== "string" ||
        (attachment.disposition !== "attachment" && attachment.disposition !== "inline") ||
        (attachment.disposition === "inline" ? typeof attachment.contentId !== "string" : attachment.contentId !== undefined)) {
      throw new Error("delivery-only attachment is invalid");
    }
    const content = base64ToArrayBuffer(attachment.content);
    if (arrayBufferToBase64(content) !== attachment.content) throw new Error("delivery-only attachment encoding is invalid");
    attachments.push(attachment.disposition === "inline"
      ? { disposition: "inline", filename: attachment.filename, type: attachment.type, contentId: attachment.contentId as string, content }
      : { disposition: "attachment", filename: attachment.filename, type: attachment.type, content });
  }
  return {
    from: { name: value.from.name, email: value.from.email }, to: value.to,
    subject: value.subject, text: value.text, ...(value.html === undefined ? {} : { html: value.html }),
    headers: { "X-Maildesk-Delivery-ID": expected.deliveryMessageId, "X-Maildesk-Original-To": expected.receivedAddress },
    ...(attachments.length ? { attachments } : {}),
  };
}

export interface DeliveryOnlySpool {
  recipientRef: string;
  messageId: string;
  key: string;
  sha256: string;
}

/** Reserve a fresh raw-spool generation without overwriting an existing key. */
export async function createDeliveryOnlyGeneration(
  bucket: R2Bucket, deliveryId: string, receivedAt: string, raw: ArrayBuffer,
): Promise<string> {
  if (!/^inbound:[a-f0-9]{64}$/.test(deliveryId) || !/^\d{4}-\d{2}-\d{2}T/.test(receivedAt)) {
    throw new Error("delivery-only generation binding is invalid");
  }
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const key = relaySpoolKey(`${deliveryId}.${nonce}`, receivedAt);
  const result = await bucket.put(key, raw, {
    onlyIf: new Headers({ "If-None-Match": "*" }),
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: { retentionClass: "relay-spool", deliveryId },
  });
  if (!result) throw new Error("delivery-only spool generation already exists");
  return key;
}

/**
 * The caller must supply an exclusively owned, fresh high-entropy spool
 * generation. On an uncertain write we retain every staged object; an R2
 * error does not prove the write failed, and cleanup needs separate evidence.
 */
export async function stageDeliveryOnlyPayloads(
  bucket: R2Bucket,
  rawSpoolKey: string,
  deliveryId: string,
  messages: DeliveryOnlyMessage[],
): Promise<DeliveryOnlySpool[]> {
  if (!/^relay-spool\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9._-]+\.eml$/.test(rawSpoolKey) || !deliveryId || messages.length === 0) {
    throw new Error("delivery-only spool input is invalid");
  }
  const seen = new Set<string>();
  const prepared: Array<DeliveryOnlySpool & { serialized: string }> = [];
  for (const message of messages) {
    const recipient = normalizeMailbox(message.to);
    if (!recipient || recipient !== message.to || seen.has(recipient)) throw new Error("delivery-only recipients must be valid and unique");
    seen.add(recipient);
    const recipientRef = await sha256Hex(recipient);
    const serialized = serializeDeliveryOnlyMessage(message);
    const messageId = message.headers["X-Maildesk-Delivery-ID"];
    if (!messageId) throw new Error("delivery-only message ID is missing");
    const key = `${rawSpoolKey}.delivery-only-${recipientRef}.json`;
    const sha256 = await sha256Hex(serialized);
    await deserializeDeliveryOnlyMessage(serialized, {
      sha256, recipientRef, receivedAddress: message.headers["X-Maildesk-Original-To"] ?? "", deliveryMessageId: messageId,
    });
    prepared.push({ recipientRef, messageId, key, sha256, serialized });
  }
  for (const item of prepared) {
    const result = await bucket.put(item.key, item.serialized, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: "application/json" },
      customMetadata: { retentionClass: "relay-spool", deliveryId, recipientRef: item.recipientRef },
    });
    if (!result) throw new Error("delivery-only recipient spool already exists");
  }
  return prepared.map(({ recipientRef, messageId, key, sha256 }) => ({ recipientRef, messageId, key, sha256 }));
}

/** A successful object lookup returned no payload; this does not establish why. */
export class DeliveryOnlyPayloadMissing extends Error {}

/** Load a stored recipient payload only when its generation, metadata and digest agree. */
export async function loadDeliveryOnlySpool(
  bucket: R2Bucket,
  binding: { deliveryId: string; rawSpoolKey: string; recipientRef: string; payloadKey: string;
    payloadSha256: string; receivedAddress: string; messageId: string },
  config: OperatorDeliveryConfig,
): Promise<DeliveryOnlyMessage> {
  if (!/^inbound:[a-f0-9]{64}$/.test(binding.deliveryId) || !/^[a-f0-9]{64}$/.test(binding.recipientRef) ||
      binding.payloadKey !== `${binding.rawSpoolKey}.delivery-only-${binding.recipientRef}.json` ||
      !Number.isSafeInteger(config.maxEncodedMessageBytes) || config.maxEncodedMessageBytes <= 0) {
    throw new Error("delivery-only recovery binding is invalid");
  }
  const object = await bucket.get(binding.payloadKey);
  if (!object) throw new DeliveryOnlyPayloadMissing("delivery-only recovery payload missing");
  const maxSerializedBytes = config.maxEncodedMessageBytes * 2 + 65536;
  if (object.customMetadata?.retentionClass !== "relay-spool" ||
      object.customMetadata?.deliveryId !== binding.deliveryId || object.customMetadata?.recipientRef !== binding.recipientRef ||
      !Number.isSafeInteger(object.size) || object.size > maxSerializedBytes) {
    throw new Error("delivery-only recovery payload is unavailable or unbound");
  }
  const serialized = await object.text();
  if (new TextEncoder().encode(serialized).byteLength !== object.size) throw new Error("delivery-only recovery payload size drifted");
  const message = await deserializeDeliveryOnlyMessage(serialized, { sha256: binding.payloadSha256,
    recipientRef: binding.recipientRef, receivedAddress: binding.receivedAddress, deliveryMessageId: binding.messageId });
  assertWithinRelayLimit(message, config);
  return message;
}
