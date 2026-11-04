import { operatorDeliveryConfig } from "../../shared/contracts";
import { assertWithinRelayLimit, buildDeliveryOnlyMessage, normalizeMailbox, parseRelayEmail, sha256Hex, type DeliveryOnlyMessage } from "../../shared/inbox-relay";
import { loadActivePolicy } from "../../shared/policy-store";
import { selectDestination } from "../../shared/work-destination";
import { serializeDeliveryOnlyMessage } from "./delivery-only-spool";
import type { DeliveryOnlyDispatchBinding } from "./delivery-only-dispatch";
import type { Env } from "./inbound-repository";

/** Rebuild in memory only when the complete output matches the immutable claim. */
export async function rebuildDeliveryOnlyPayload(env: Env, binding: DeliveryOnlyDispatchBinding): Promise<DeliveryOnlyMessage> {
  if (!env.RELAY_SPOOL) throw new Error("raw recovery spool unavailable");
  const active = await loadActivePolicy(env);
  if (!active || active.sha256 !== binding.policySha256) throw new Error("recovery policy unavailable or changed");
  const route = active.projection.routes.find((item) => `${item.localPart}@${item.domain}` === binding.receivedAddress);
  if (!route || !route.deliveryOnly) throw new Error("recovery route unavailable or changed");
  const destination = selectDestination(route);
  if (!destination || destination.target.kind !== "mailbox") throw new Error("recovery destination unavailable");
  const matching: string[] = [];
  for (const recipient of destination.target.recipients) {
    const normalized = normalizeMailbox(recipient);
    if (normalized && await sha256Hex(normalized) === binding.recipientRef) matching.push(normalized);
  }
  if (matching.length !== 1) throw new Error("recovery recipient binding unavailable or ambiguous");
  const config = operatorDeliveryConfig(env);
  if (!/^inbound:[a-f0-9]{64}$/.test(binding.deliveryId) ||
      !/^relay-spool\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9._-]+\.eml$/.test(binding.rawSpoolKey) ||
      binding.payloadKey !== `${binding.rawSpoolKey}.delivery-only-${binding.recipientRef}.json`) throw new Error("recovery spool binding invalid");
  const object = await env.RELAY_SPOOL.get(binding.rawSpoolKey);
  if (!object || object.customMetadata?.retentionClass !== "relay-spool" || object.customMetadata?.deliveryId !== binding.deliveryId ||
      !Number.isSafeInteger(object.size) || object.size < 0 || object.size > config.maxEncodedMessageBytes) throw new Error("raw recovery spool unavailable or unbound");
  const raw = await object.arrayBuffer();
  if (raw.byteLength !== object.size) throw new Error("raw recovery spool size drifted");
  const parsed = await parseRelayEmail(raw);
  const message = buildDeliveryOnlyMessage(parsed, { recipient: matching[0]!, receivedAddress: binding.receivedAddress, deliveryMessageId: binding.messageId });
  assertWithinRelayLimit(message, config);
  if (await sha256Hex(serializeDeliveryOnlyMessage(message)) !== binding.payloadSha256) throw new Error("rebuilt payload digest mismatch");
  return message;
}
