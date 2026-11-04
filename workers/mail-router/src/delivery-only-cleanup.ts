import type { Env } from "./inbound-repository";

/**
 * Hold early cleanup until the exact object generation can be deleted
 * conditionally. Workers R2 delete is unconditional; a prior head cannot fence
 * a replacement. The existing lifecycle remains a separate provider setting.
 */
export async function cleanupAcceptedDeliveryOnly(_env: Env, _deliveryId: string): Promise<boolean> {
  return false;
}
