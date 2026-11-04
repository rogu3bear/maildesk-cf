import { expect, test } from "bun:test";
import { buildDeliveryOnlyMessage, sha256Hex, type ParsedRelayEmail } from "../../workers/shared/inbox-relay";
import { deserializeDeliveryOnlyMessage, serializeDeliveryOnlyMessage } from "../../workers/mail-router/src/delivery-only-spool";

async function fixture() {
  const parsed: ParsedRelayEmail = { from: { address: "sender@example.net" }, subject: "report", text: "body", references: [], attachments: [
    { disposition: "attachment", filename: "report.xml", type: "application/xml", content: new TextEncoder().encode("report").buffer },
  ] };
  const message = buildDeliveryOnlyMessage(parsed, { recipient: "reports@example.net", receivedAddress: "dmarc@example.com", deliveryMessageId: "delivery:1" });
  const serialized = serializeDeliveryOnlyMessage(message);
  return { serialized, expected: { sha256: await sha256Hex(serialized), recipientRef: await sha256Hex(message.to), receivedAddress: "dmarc@example.com", deliveryMessageId: "delivery:1" } };
}

test("delivery-only recovery round trips report payload without reply authority", async () => {
  const { serialized, expected } = await fixture();
  const message = await deserializeDeliveryOnlyMessage(serialized, expected);
  expect(message.to).toBe("reports@example.net");
  expect(new TextDecoder().decode(message.attachments?.[0]?.content)).toBe("report");
  expect("replyTo" in message).toBe(false);
});

test("delivery-only recovery refuses drift and hidden reply addresses", async () => {
  const { serialized, expected } = await fixture();
  await expect(deserializeDeliveryOnlyMessage(serialized, { ...expected, sha256: "0".repeat(64) })).rejects.toThrow();
  await expect(deserializeDeliveryOnlyMessage(serialized, { ...expected, recipientRef: "0".repeat(64) })).rejects.toThrow();
  await expect(deserializeDeliveryOnlyMessage(serialized, { ...expected, receivedAddress: "other@example.com" })).rejects.toThrow();
  await expect(deserializeDeliveryOnlyMessage(serialized, { ...expected, deliveryMessageId: "other" })).rejects.toThrow();
  await expect(deserializeDeliveryOnlyMessage(serialized, { ...expected, receivedAddress: "" })).rejects.toThrow();
  const altered = JSON.parse(serialized); altered.replyTo = "r+token@example.com";
  const tampered = JSON.stringify(altered);
  await expect(deserializeDeliveryOnlyMessage(tampered, { ...expected, sha256: await sha256Hex(tampered) })).rejects.toThrow();
});

test("spool staging uses recipient-bound keys and retains uncertain writes", async () => {
  const { stageDeliveryOnlyPayloads } = await import("../../workers/mail-router/src/delivery-only-spool");
  const { serialized } = await fixture();
  const data = JSON.parse(serialized);
  const original = await deserializeDeliveryOnlyMessage(serialized, {
    sha256: await sha256Hex(serialized), recipientRef: await sha256Hex(data.to),
    receivedAddress: "dmarc@example.com", deliveryMessageId: "delivery:1",
  });
  const writes: string[] = [], deletes: string[] = [];
  const bucket = { put: async (key: string, _value: unknown, options: R2PutOptions) => { writes.push(key); expect((options.onlyIf as Headers).get("If-None-Match")).toBe("*"); if (writes.length === 2) throw new Error("unknown write"); return {}; }, delete: async (key: string) => { deletes.push(key); } } as unknown as R2Bucket;
  const second = { ...original, to: "other@example.net" };
  await expect(stageDeliveryOnlyPayloads(bucket, "relay-spool/2026-01-01/fresh-generation.eml", "delivery:1", [original, second])).rejects.toThrow();
  expect(writes).toHaveLength(2);
  expect(writes[0]).toContain(await sha256Hex(original.to));
  expect(writes[1]).toContain(await sha256Hex(second.to));
  expect(deletes).toEqual([]);
});

test("raw generation uses a conditional create and never retries a collision", async () => {
  const { createDeliveryOnlyGeneration } = await import("../../workers/mail-router/src/delivery-only-spool");
  const keys: string[] = [];
  const bucket = { put: async (key: string, _value: unknown, options: R2PutOptions) => {
    keys.push(key); expect((options.onlyIf as Headers).get("If-None-Match")).toBe("*"); return null;
  } } as unknown as R2Bucket;
  await expect(createDeliveryOnlyGeneration(bucket, `inbound:${"a".repeat(64)}`, "2026-01-01T00:00:00Z", new ArrayBuffer(1))).rejects.toThrow();
  expect(keys).toHaveLength(1);
  expect(keys[0]).toMatch(/^relay-spool\/2026-01-01\/.+\.[a-f0-9]{64}\.eml$/);
});

test("stored delivery-only payload must match its generation and metadata before recovery", async () => {
  const { loadDeliveryOnlySpool } = await import("../../workers/mail-router/src/delivery-only-spool");
  const { serialized, expected } = await fixture();
  const deliveryId = `inbound:${"a".repeat(64)}`;
  const rawSpoolKey = "relay-spool/2026-01-01/generation.eml";
  const binding = { deliveryId, rawSpoolKey, recipientRef: expected.recipientRef,
    payloadKey: `${rawSpoolKey}.delivery-only-${expected.recipientRef}.json`, payloadSha256: expected.sha256,
    receivedAddress: expected.receivedAddress, messageId: expected.deliveryMessageId };
  const metadata = { retentionClass: "relay-spool", deliveryId, recipientRef: expected.recipientRef };
  const size = new TextEncoder().encode(serialized).byteLength;
  const bucket = (object: unknown) => ({ get: async () => object }) as unknown as R2Bucket;
  const object = { size, customMetadata: metadata, text: async () => serialized };
  const config = { maxEncodedMessageBytes: 5 * 1024 * 1024 } as import("../../workers/shared/contracts").OperatorDeliveryConfig;
  expect((await loadDeliveryOnlySpool(bucket(object), binding, config)).to).toBe("reports@example.net");
  await expect(loadDeliveryOnlySpool(bucket(object), { ...binding, payloadKey: "other" }, config)).rejects.toThrow();
  await expect(loadDeliveryOnlySpool(bucket({ ...object, customMetadata: { ...metadata, deliveryId: "other" } }), binding, config)).rejects.toThrow();
  await expect(loadDeliveryOnlySpool(bucket({ ...object, size: size + 1 }), binding, config)).rejects.toThrow();
  await expect(loadDeliveryOnlySpool(bucket(object), { ...binding, payloadSha256: "0".repeat(64) }, config)).rejects.toThrow();
  await expect(loadDeliveryOnlySpool(bucket(null), binding, config)).rejects.toThrow();
});
