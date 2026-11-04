import { operatorDeliveryConfig } from "../../shared/contracts";
import { assertWithinRelayLimit, buildDeliveryOnlyMessage, normalizeMailbox, parseRelayEmail, sha256Hex } from "../../shared/inbox-relay";
import { selectDestination } from "../../shared/work-destination";
import { persistDeliveryOnlyClaim, readDeliveryOnlyClaim, type DeliveryOnlyClaimInput } from "./delivery-only-claims";
import { recoverDeliveryOnlyByFingerprint } from "./delivery-only-recovery";
import { createDeliveryOnlyGeneration, stageDeliveryOnlyPayloads } from "./delivery-only-spool";
import { recoverExistingInbound } from "./inbound-recovery";
import { loadInboundDelivery, stableId, type Env, type PolicyBoundRoute } from "./inbound-repository";

/** Admission for delivery-only mail. All uncertain staged objects are retained. */
export async function acceptDeliveryOnly(
  message: ForwardableEmailMessage, bound: PolicyBoundRoute, env: Env,
): Promise<void> {
  const config = operatorDeliveryConfig(env);
  const selected = selectDestination(bound.route);
  if (config.mode !== "inbox_relay" || !env.RELAY_SPOOL || !env.EMAIL || !selected || selected.target.kind !== "mailbox") {
    message.setReject("maildesk delivery-only destination is unavailable"); return;
  }
  if (message.rawSize > config.maxEncodedMessageBytes) {
    message.setReject("maildesk relay accepts messages up to 5 MiB including attachments"); return;
  }
  const receivedAddress = normalizeMailbox(message.to);
  if (!receivedAddress || receivedAddress !== `${bound.route.localPart}@${bound.route.domain}`) {
    message.setReject("maildesk delivery-only route does not match recipient"); return;
  }
  let raw: ArrayBuffer;
  let parsed: Awaited<ReturnType<typeof parseRelayEmail>>;
  try { raw = await new Response(message.raw).arrayBuffer(); parsed = await parseRelayEmail(raw); }
  catch { message.setReject("maildesk could not safely parse this message"); return; }
  const fingerprint = await sha256Hex([normalizeMailbox(message.from), receivedAddress, await sha256Hex(raw)].join("\0"));
  try {
    const existing = await recoverDeliveryOnlyByFingerprint(env, fingerprint);
    if (existing === "processed") return;
    if (existing === "held") { message.setReject("maildesk delivery-only recovery requires reconciliation"); return; }
    const ordinary = await loadInboundDelivery(fingerprint, env);
    if (ordinary) { await recoverExistingInbound(ordinary, env); return; }
  } catch { message.setReject("maildesk could not verify inbound delivery idempotency"); return; }

  const deliveryId = `inbound:${fingerprint}`;
  const receivedAt = new Date().toISOString();
  let input: DeliveryOnlyClaimInput;
  try {
    const messages = await Promise.all(selected.target.recipients.map(async (recipient) => {
      const normalized = normalizeMailbox(recipient);
      const ref = await sha256Hex(normalized);
      const delivery = buildDeliveryOnlyMessage(parsed, { recipient: normalized, receivedAddress,
        deliveryMessageId: `<inbound.${fingerprint}.${ref.slice(0, 16)}@${bound.route.domain}>` });
      assertWithinRelayLimit(delivery, config);
      return delivery;
    }));
    const rawSpoolKey = await createDeliveryOnlyGeneration(env.RELAY_SPOOL, deliveryId, receivedAt, raw);
    const spools = await stageDeliveryOnlyPayloads(env.RELAY_SPOOL, rawSpoolKey, deliveryId, messages);
    input = { deliveryId, fingerprintSha256: fingerprint, routeId: stableId("route", bound.route.domain, bound.route.localPart),
      policySha256: bound.policySha256, rawSpoolKey, receivedAt,
      recipients: spools.map((spool) => ({ ref: spool.recipientRef, messageId: spool.messageId, payloadKey: spool.key, payloadSha256: spool.sha256 })) };
  } catch { message.setReject("maildesk could not stage delivery-only recovery data"); return; }

  try { await persistDeliveryOnlyClaim(env.DB, input); }
  catch {
    // A lost acknowledgement or competing claim is reconciled without replay
    // or deletion of this generation. An absent readback is still uncertain.
    try {
      const exact = await readDeliveryOnlyClaim(env.DB, input);
      if (exact.kind !== "matched") {
        const competing = await recoverDeliveryOnlyByFingerprint(env, fingerprint);
        if (competing === "processed") return;
        message.setReject("maildesk delivery-only persistence requires reconciliation"); return;
      }
    } catch { message.setReject("maildesk delivery-only persistence requires reconciliation"); return; }
  }
  // The claim is durable; a dispatch failure remains visible for recovery and
  // must not trigger a second provider attempt via SMTP replay.
  await recoverDeliveryOnlyByFingerprint(env, fingerprint).catch(() => "held");
}
