import { operatorDeliveryConfig } from "../../shared/contracts";
import { refreshRouteStatuses } from "../../shared/status-store";
import { recoverDeliveryOnlyByFingerprint } from "./delivery-only-recovery";
import type { Env } from "./inbound-repository";

const MAX_DELIVERIES_PER_SWEEP = 20;
const NEXT_PENDING_SQL = `SELECT d.fingerprint_sha256, d.route_id FROM delivery_only_deliveries d
  WHERE d.fingerprint_sha256 > ?1 AND (EXISTS (
    SELECT 1 FROM delivery_only_recipient_deliveries r WHERE r.delivery_id = d.id AND r.status = 'pending'
  )) ORDER BY d.fingerprint_sha256 LIMIT ?2`;

/** Sweep pending recipients; attempted and unknown sends are never reopened. */
export async function sweepDeliveryOnly(env: Env): Promise<void> {
  const config = operatorDeliveryConfig(env);
  if (config.mode !== "inbox_relay" || config.inboundProcessingMode !== "enabled") return;
  const db = env.DB.withSession("first-primary");
  const cursor = await db.prepare("SELECT after_fingerprint FROM delivery_only_recovery_cursor WHERE singleton = 1")
    .first<{ after_fingerprint: string }>();
  if (!cursor || typeof cursor.after_fingerprint !== "string") throw new Error("delivery-only recovery cursor unavailable");
  const result = await db.prepare(NEXT_PENDING_SQL).bind(cursor.after_fingerprint, MAX_DELIVERIES_PER_SWEEP)
    .all<{ fingerprint_sha256: string; route_id: string }>();
  if (!result.success) throw new Error("delivery-only recovery scan failed");
  const rows = result.results ?? [];
  if (rows.length === 0) {
    const reset = await db.prepare("UPDATE delivery_only_recovery_cursor SET after_fingerprint = '' WHERE singleton = 1 AND after_fingerprint = ?1")
      .bind(cursor.after_fingerprint).run();
    if (!reset.success) throw new Error("delivery-only recovery cursor reset failed");
    return;
  }
  let previous = cursor.after_fingerprint;
  const affectedRoutes = new Set<string>();
  try {
    for (const row of rows) {
      if (!/^[a-f0-9]{64}$/.test(row.fingerprint_sha256)) throw new Error("invalid delivery-only recovery fingerprint");
      const advance = await db.prepare("UPDATE delivery_only_recovery_cursor SET after_fingerprint = ?1 WHERE singleton = 1 AND after_fingerprint = ?2")
        .bind(row.fingerprint_sha256, previous).run();
      if (!advance.success) throw new Error("delivery-only recovery cursor advance failed");
      if (Number(advance.meta?.changes ?? 0) !== 1) return;
      previous = row.fingerprint_sha256;
      affectedRoutes.add(row.route_id);
      await recoverDeliveryOnlyByFingerprint(env, row.fingerprint_sha256).catch(() => "held");
    }
  } finally {
    if (affectedRoutes.size) await refreshRouteStatuses(env, Date.now(), { routeIds: [...affectedRoutes] })
      .catch(() => console.error(JSON.stringify({ event: "status_projection_unavailable" })));
  }
}
