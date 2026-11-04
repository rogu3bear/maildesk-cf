import { normalizeMailbox } from "../../shared/inbox-relay";
import { cleanupAcceptedDeliveryOnly } from "./delivery-only-cleanup";
import { dispatchDeliveryOnlyRecipient } from "./delivery-only-dispatch";
import type { Env } from "./inbound-repository";

export const LOAD_DELIVERY_ONLY_RECOVERY_SQL =
  "SELECT d.id, d.fingerprint_sha256, d.policy_sha256, d.raw_r2_key, d.recipient_count, d.status AS delivery_status, ar.local_part, dom.domain, r.recipient_ref, r.delivery_message_id, r.delivery_payload_r2_key, r.delivery_payload_sha256, r.status FROM delivery_only_deliveries d JOIN alias_routes ar ON ar.id = d.route_id JOIN domains dom ON dom.id = ar.domain_id LEFT JOIN delivery_only_recipient_deliveries r ON r.delivery_id = d.id WHERE d.fingerprint_sha256 = ?1 ORDER BY r.recipient_ref";

export const REFRESH_DELIVERY_ONLY_STATUS_SQL =
  "UPDATE delivery_only_deliveries SET status = CASE WHEN (SELECT COUNT(*) FROM delivery_only_recipient_deliveries r WHERE r.delivery_id = delivery_only_deliveries.id AND r.status = 'provider_accepted') = recipient_count AND (SELECT COUNT(*) FROM delivery_only_recipient_deliveries r WHERE r.delivery_id = delivery_only_deliveries.id) = recipient_count THEN 'provider_accepted' WHEN EXISTS (SELECT 1 FROM delivery_only_recipient_deliveries r WHERE r.delivery_id = delivery_only_deliveries.id AND r.status = 'provider_accepted') THEN 'partial_delivery' ELSE 'recovery_required' END, updated_at = CURRENT_TIMESTAMP WHERE id = ?1";

interface RecoveryRow {
  id: string; fingerprint_sha256: string; policy_sha256: string; raw_r2_key: string | null;
  recipient_count: number; delivery_status: string; local_part: string; domain: string; recipient_ref: string | null;
  delivery_message_id: string | null; delivery_payload_r2_key: string | null;
  delivery_payload_sha256: string | null; status: string | null;
}

/**
 * Recover only the immutable pending set. Existing attempted outcomes are held
 * and never replayed. No result here proves destination receipt or permits
 * deletion of a spool; absent state is not proof of an uncertain rollback.
 */
export async function recoverDeliveryOnlyByFingerprint(
  env: Env, fingerprint: string,
): Promise<"absent" | "held" | "processed"> {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) return "held";
  const response = await env.DB.withSession("first-primary").prepare(LOAD_DELIVERY_ONLY_RECOVERY_SQL)
    .bind(fingerprint).all<RecoveryRow>();
  if (!response.success) return "held";
  const rows = response.results ?? [];
  if (rows.length === 0) return "absent";
  const first = rows[0]!;
  const address = normalizeMailbox(`${first.local_part}@${first.domain}`);
  if (!address || !Number.isSafeInteger(first.recipient_count) ||
      first.recipient_count <= 0 || rows.length !== first.recipient_count ||
      rows.some((row) => row.id !== first.id || row.fingerprint_sha256 !== fingerprint ||
        row.policy_sha256 !== first.policy_sha256 || row.raw_r2_key !== first.raw_r2_key ||
        row.recipient_count !== first.recipient_count || row.delivery_status !== first.delivery_status || row.local_part !== first.local_part || row.domain !== first.domain ||
        !row.recipient_ref || !row.delivery_message_id || !row.delivery_payload_r2_key || !row.delivery_payload_sha256 || !row.status)) {
    return "held";
  }
  if (!first.raw_r2_key) {
    return first.delivery_status === "provider_accepted" && rows.every((row) => row.status === "provider_accepted") ? "processed" : "held";
  }
  for (const row of rows) {
    if (row.status !== "pending") continue;
    await dispatchDeliveryOnlyRecipient(env, {
      deliveryId: first.id, policySha256: first.policy_sha256, rawSpoolKey: first.raw_r2_key,
      recipientRef: row.recipient_ref!, payloadKey: row.delivery_payload_r2_key!, payloadSha256: row.delivery_payload_sha256!,
      receivedAddress: address, messageId: row.delivery_message_id!,
    });
  }
  const result = await env.DB.prepare(REFRESH_DELIVERY_ONLY_STATUS_SQL).bind(first.id).run();
  if (!result.success || Number(result.meta?.changes ?? 0) < 1) return "held";
  // Cleanup is independently guarded and only eligible after all acceptances;
  // failures retain D1 authority and are retried by later recovery.
  await cleanupAcceptedDeliveryOnly(env, first.id).catch(() => false);
  return "processed";
}
