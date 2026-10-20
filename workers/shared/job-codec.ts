import type { MailJob, OutboundReplyRequestedJob } from "./contracts";
import { replyAuthorizationKind } from "./ordinary-reply";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 1024): value is string => typeof value === "string" && value.length <= max;
const digest = (value: unknown): boolean => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const strings = (value: unknown): boolean => Array.isArray(value) && value.length <= 100 && value.every((item) => text(item));
const optional = (row: RecordValue, keys: string[], check: (value: unknown) => boolean): boolean =>
  keys.every((key) => row[key] === undefined || check(row[key]));
const required = (row: RecordValue, keys: string[], check: (value: unknown) => boolean = text): boolean =>
  keys.every((key) => check(row[key]));
const closed = (row: RecordValue, keys: string[]): boolean => Object.keys(row).every((key) => keys.includes(key));
const authorizationFields = ["schemaVersion", "payloadVersion", "admissionKind", "activationId"];
const transactionFields = ["transactionSha256", "attemptSha256", "claimedPayloadSha256", "desiredStateSha256", "identityProfileSha256"];

function authorizationShape(row: RecordValue): boolean {
  const kind = replyAuthorizationKind(row);
  if (!kind) return false;
  if (row.schemaVersion === undefined) return row.payloadVersion === undefined;
  return kind === "ordinary" ? row.payloadVersion === 2
    : row.payloadVersion === 1 || row.payloadVersion === 2;
}

/** Queue data is untrusted. Closed variants preserve legacy meaning, reject
 * unknown versions, and prevent arbitrary objects from becoming audit records.
 */
export function decodeMailJob(value: unknown): MailJob | null {
  if (!record(value) || !text(value.kind)) return null;
  let valid = false;
  switch (value.kind) {
    case "inbox_reply_received": {
      const keys = ["kind", "attemptId", "admissionId", "relayId", "operator", "operatorMessageId", "rawR2Key", "rawSha256", "receivedAt", ...transactionFields, ...authorizationFields];
      valid = closed(value, keys) && authorizationShape(value) && required(value,
        ["attemptId", "admissionId", "relayId", "operator", "operatorMessageId", "rawR2Key", "receivedAt"])
        && required(value, [...transactionFields, "rawSha256"], digest);
      break;
    }
    case "outbound_reply_requested": {
      const keys = ["kind", "messageId", "threadId", "operator", "envelopeTo", "fromIdentity", "to", "cc", "bcc", "replyTo", "subject", "text", "html", "headers", "attachments", "policySha256", "admissionId", "relayAttemptId", "relaySpoolKey", "queuedAt", "requestedIdentity", "fromDisplayName", "identityProfileRef", "signatureProfileRef", "senderAdapter", ...transactionFields, ...authorizationFields];
      valid = closed(value, keys) && authorizationShape(value) && required(value,
        ["messageId", "threadId", "operator", "envelopeTo", "fromIdentity", "queuedAt", "subject"])
        && strings(value.to) && optional(value, ["cc", "bcc"], strings)
        && optional(value, ["replyTo", "admissionId", "relayAttemptId", "relaySpoolKey", "requestedIdentity", "fromDisplayName", "identityProfileRef", "signatureProfileRef"], text)
        && optional(value, [...transactionFields, "policySha256"], digest)
        && optional(value, ["text", "html"], (item) => text(item, 5 * 1024 * 1024))
        && (typeof value.text === "string" || typeof value.html === "string")
        && optional(value, ["headers"], (item) => record(item) && Object.keys(item).length <= 100 && Object.entries(item).every(([key, entry]) => text(key, 256) && text(entry, 8192)))
        && optional(value, ["attachments"], isAttachmentArray)
        && optional(value, ["senderAdapter"], (item) => item === "resend" || item === "cloudflare_email_service");
      break;
    }
    case "inbound_email_received":
      valid = closed(value, ["kind", "messageId", "deliveryId", "envelopeTo", "envelopeFrom", "routeKind", "forwardedTo", "forwardErrors", "defaultReplyIdentity", "rawR2Key", "rawSize", "storageError", "receivedAt"])
        && required(value, ["messageId", "deliveryId", "envelopeTo", "envelopeFrom", "rawR2Key", "receivedAt"])
        && Number.isSafeInteger(value.rawSize) && Number(value.rawSize) >= 0
        && optional(value, ["defaultReplyIdentity", "storageError"], text)
        && optional(value, ["forwardedTo"], strings)
        && optional(value, ["routeKind"], (item) => ["role_alias", "personal_alias", "catch_all", "sink"].includes(String(item)))
        && optional(value, ["forwardErrors"], (item) => Array.isArray(item) && item.length <= 100 && item.every((entry) => record(entry) && closed(entry, ["recipient", "error"]) && required(entry, ["recipient", "error"])));
      break;
    case "inbound_email_persisted":
      valid = closed(value, ["kind", "messageId", "threadId", "routeId", "queuedAt"])
        && required(value, ["messageId", "threadId", "routeId", "queuedAt"]);
      break;
    case "inbound_work_item_received":
      valid = closed(value, ["kind", "messageId", "deliveryId", "queueRef", "routeRef", "destinationRef", "accountableRef", "rawR2Key", "receivedAt"])
        && required(value, ["messageId", "deliveryId", "queueRef", "routeRef", "destinationRef", "accountableRef", "rawR2Key", "receivedAt"]);
      break;
    case "inbound_delivery_result":
      valid = closed(value, ["kind", "deliveryId", "relayId", "threadId", "routeId", "policySha256", "status", "results", "relaySpoolKey", "receivedAt"])
        && required(value, ["deliveryId", "relayId", "threadId", "routeId", "relaySpoolKey", "receivedAt"])
        && digest(value.policySha256) && ["provider_accepted", "partial_delivery", "recovery_required", "failed"].includes(String(value.status))
        && Array.isArray(value.results) && value.results.length <= 100 && value.results.every((entry) => record(entry)
          && closed(entry, ["operatorRef", "deliveryPayloadR2Key", "ok", "providerMessageId", "errorCode"])
          && required(entry, ["operatorRef", "deliveryPayloadR2Key"]) && typeof entry.ok === "boolean"
          && optional(entry, ["providerMessageId", "errorCode"], text));
      break;
  }
  return valid ? value as unknown as MailJob : null;
}

export function isOutboundReplyRequestedJob(value: unknown): value is OutboundReplyRequestedJob {
  return decodeMailJob(value)?.kind === "outbound_reply_requested";
}

function isAttachmentArray(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 100 && value.every((entry) => record(entry)
    && closed(entry, ["disposition", "filename", "type", "content", "contentId"])
    && required(entry, ["filename", "type"]) && entry.content instanceof ArrayBuffer
    && entry.content.byteLength <= 5 * 1024 * 1024
    && (entry.disposition === "inline" ? text(entry.contentId) : entry.disposition === "attachment" && entry.contentId === undefined));
}
