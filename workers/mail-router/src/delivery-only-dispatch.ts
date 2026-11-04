import { operatorDeliveryConfig } from "../../shared/contracts";
import { claimDeliveryOnlyRecipient, projectDeliveryOnlyOutcome } from "./delivery-only-claims";
import { DeliveryOnlyPayloadMissing, loadDeliveryOnlySpool } from "./delivery-only-spool";
import { cloudflareEmailErrorCode } from "./inbound-recovery";
import { rebuildDeliveryOnlyPayload } from "./delivery-only-rebuild";
import type { Env } from "./inbound-repository";

export interface DeliveryOnlyDispatchBinding {
  deliveryId: string;
  policySha256: string;
  rawSpoolKey: string;
  recipientRef: string;
  payloadKey: string;
  payloadSha256: string;
  receivedAddress: string;
  messageId: string;
}

/**
 * Load and validate before claiming. Only a successful pending-to-sending
 * transition permits a provider call. Once claimed, failures or an unknown
 * projection remain held; this function never retries or deletes the spool.
 */
export async function dispatchDeliveryOnlyRecipient(
  env: Env, binding: DeliveryOnlyDispatchBinding,
): Promise<"accepted" | "held"> {
  if (!env.RELAY_SPOOL || !env.EMAIL) return "held";
  let message;
  let fromOriginalPayload = true;
  try {
    message = await loadDeliveryOnlySpool(env.RELAY_SPOOL, binding, operatorDeliveryConfig(env));
  } catch (error) {
    if (!(error instanceof DeliveryOnlyPayloadMissing)) return "held";
    await recordPayloadObservation(env, binding, "delivery_payload_missing_observed").catch(() => undefined);
    try { message = await rebuildDeliveryOnlyPayload(env, binding); fromOriginalPayload = false; }
    catch { return "held"; }
  }
  if (fromOriginalPayload) {
    try { await recordPayloadObservation(env, binding, null); }
    catch { return "held"; }
  }
  let claimed: boolean;
  try {
    claimed = await claimDeliveryOnlyRecipient(env.DB, binding);
  } catch {
    return "held";
  }
  if (!claimed) return "held";

  let providerMessageId: string | undefined;
  try {
    const response = await env.EMAIL.send(message);
    providerMessageId = response?.messageId;
  } catch (error) {
    await projectDeliveryOnlyOutcome(env.DB, binding, { kind: "unknown", errorCode: cloudflareEmailErrorCode(error) }).catch(() => undefined);
    return "held";
  }
  try {
    await projectDeliveryOnlyOutcome(env.DB, binding, { kind: "accepted", providerMessageId });
    return "accepted";
  } catch {
    // The provider may have accepted; sending must never be reopened.
    return "held";
  }
}

/** Update only a matching unattempted claim; this is an observation, not an outcome. */
async function recordPayloadObservation(env: Env, binding: DeliveryOnlyDispatchBinding, code: string | null): Promise<void> {
  const result = await env.DB.prepare(`UPDATE delivery_only_recipient_deliveries SET error_code = ?1, updated_at = CURRENT_TIMESTAMP
    WHERE delivery_id = ?2 AND recipient_ref = ?3 AND delivery_payload_sha256 = ?4 AND delivery_payload_r2_key = ?5
      AND status = 'pending' AND error_code IS NOT ?1`).bind(code, binding.deliveryId, binding.recipientRef, binding.payloadSha256, binding.payloadKey).run();
  if (!result.success) throw new Error("delivery-only payload observation unavailable");
}
