import { expect, test } from "bun:test";
import { dispatchDeliveryOnlyRecipient } from "../../workers/mail-router/src/delivery-only-dispatch";
import { serializeDeliveryOnlyMessage } from "../../workers/mail-router/src/delivery-only-spool";
import { buildDeliveryOnlyMessage, sha256Hex, type ParsedRelayEmail } from "../../workers/shared/inbox-relay";
import type { Env } from "../../workers/mail-router/src/inbound-repository";

async function fixture() {
  const parsed: ParsedRelayEmail = { from: { address: "sender@example.net" }, subject: "report", text: "body", references: [], attachments: [] };
  const message = buildDeliveryOnlyMessage(parsed, { recipient: "reports@example.net", receivedAddress: "dmarc@example.com", deliveryMessageId: "id" });
  const serialized = serializeDeliveryOnlyMessage(message);
  const recipientRef = await sha256Hex(message.to), deliveryId = `inbound:${"a".repeat(64)}`;
  const rawSpoolKey = "relay-spool/2026-01-01/generation.eml";
  const binding = { deliveryId, policySha256: "b".repeat(64), rawSpoolKey, recipientRef,
    payloadKey: `${rawSpoolKey}.delivery-only-${recipientRef}.json`, payloadSha256: await sha256Hex(serialized), receivedAddress: "dmarc@example.com", messageId: "id" };
  let status = "pending", sends = 0, failProjection = false, failSend = false;
  const env = {
    RELAY_SPOOL: { get: async () => ({ size: new TextEncoder().encode(serialized).byteLength,
      customMetadata: { retentionClass: "relay-spool", deliveryId, recipientRef }, text: async () => serialized }) },
    DB: { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ run: async () => {
      if (sql.includes("SET error_code = ?1")) return { success: true, meta: { changes: 0 } };
      if (sql.includes("SET status = 'sending'")) {
        const changed = status === "pending"; if (changed) status = "sending";
        return { success: true, meta: { changes: Number(changed) } };
      }
      if (failProjection) throw new Error("projection unknown");
      const changed = status === "sending"; if (changed) status = values[0] as string;
      return { success: true, meta: { changes: Number(changed) } };
    } }) }) },
    EMAIL: { send: async () => { sends++; if (failSend) throw new Error("unknown"); return { messageId: "provider-id" }; } },
  } as unknown as Env;
  return { env, binding, status: () => status, sends: () => sends,
    failProjection: () => { failProjection = true; }, failSend: () => { failSend = true; } };
}

test("dispatch verifies spool and sends once after a successful claim", async () => {
  const f = await fixture();
  expect(await dispatchDeliveryOnlyRecipient(f.env, { ...f.binding, payloadSha256: "0".repeat(64) })).toBe("held");
  expect(f.status()).toBe("pending"); expect(f.sends()).toBe(0);
  expect(await dispatchDeliveryOnlyRecipient(f.env, f.binding)).toBe("accepted");
  expect(f.status()).toBe("provider_accepted");
  expect(await dispatchDeliveryOnlyRecipient(f.env, f.binding)).toBe("held"); expect(f.sends()).toBe(1);
});

test("provider and projection uncertainty never reopen a send", async () => {
  const provider = await fixture(); provider.failSend();
  expect(await dispatchDeliveryOnlyRecipient(provider.env, provider.binding)).toBe("held");
  expect(provider.status()).toBe("recovery_required");
  expect(await dispatchDeliveryOnlyRecipient(provider.env, provider.binding)).toBe("held"); expect(provider.sends()).toBe(1);
  const projection = await fixture(); projection.failProjection();
  expect(await dispatchDeliveryOnlyRecipient(projection.env, projection.binding)).toBe("held");
  expect(projection.status()).toBe("sending");
  expect(await dispatchDeliveryOnlyRecipient(projection.env, projection.binding)).toBe("held"); expect(projection.sends()).toBe(1);
});
