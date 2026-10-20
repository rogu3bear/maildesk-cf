import { type MaildeskEnv as Env,type InboundDeliveryResultJob } from "../contracts";
import { sha256Hex } from "../inbox-relay";
import { recordAuditEvent } from "./audit";

export const CLAIMED_INBOUND_RESULT_SQL =
  "SELECT d.raw_r2_key, (SELECT json_group_array(rd.delivery_payload_r2_key) FROM inbound_recipient_deliveries rd WHERE rd.delivery_id = d.id AND rd.status = 'provider_accepted') AS accepted_payload_keys_json FROM inbound_deliveries d WHERE d.id = ?1 AND d.relay_id = ?2 AND d.thread_id = ?3 AND d.route_id = ?4 AND d.policy_sha256 = ?5 AND d.raw_r2_key = ?6 AND d.received_at = ?8 AND (SELECT COUNT(*) FROM inbound_recipient_deliveries rd WHERE rd.delivery_id = d.id) = json_array_length(?7) AND NOT EXISTS (SELECT 1 FROM inbound_recipient_deliveries rd WHERE rd.delivery_id = d.id AND NOT EXISTS (SELECT 1 FROM json_each(?7) queued WHERE json_extract(queued.value, '$.operatorRef') = rd.operator_ref AND json_extract(queued.value, '$.deliveryPayloadR2Key') = rd.delivery_payload_r2_key AND ((json_extract(queued.value, '$.ok') = 1 AND rd.status = 'provider_accepted' AND COALESCE(json_extract(queued.value, '$.providerMessageId'), '') = COALESCE(rd.provider_message_id, '')) OR (json_extract(queued.value, '$.ok') = 0 AND rd.status IN ('recovery_required', 'failed') AND COALESCE(json_extract(queued.value, '$.errorCode'), '') = COALESCE(rd.error_code, ''))))) AND NOT EXISTS (SELECT 1 FROM json_each(?7) queued WHERE NOT EXISTS (SELECT 1 FROM inbound_recipient_deliveries rd WHERE rd.delivery_id = d.id AND rd.operator_ref = json_extract(queued.value, '$.operatorRef') AND rd.delivery_payload_r2_key = json_extract(queued.value, '$.deliveryPayloadR2Key'))) AND ((?9 = 'provider_accepted' AND NOT EXISTS (SELECT 1 FROM inbound_recipient_deliveries rd WHERE rd.delivery_id = d.id AND rd.status != 'provider_accepted')) OR (?9 = 'partial_delivery' AND EXISTS (SELECT 1 FROM inbound_recipient_deliveries rd WHERE rd.delivery_id = d.id AND rd.status = 'provider_accepted') AND EXISTS (SELECT 1 FROM inbound_recipient_deliveries rd WHERE rd.delivery_id = d.id AND rd.status != 'provider_accepted')) OR (?9 = 'recovery_required' AND NOT EXISTS (SELECT 1 FROM inbound_recipient_deliveries rd WHERE rd.delivery_id = d.id AND rd.status = 'provider_accepted') AND EXISTS (SELECT 1 FROM inbound_recipient_deliveries rd WHERE rd.delivery_id = d.id AND rd.status = 'recovery_required')) OR (?9 = 'failed' AND NOT EXISTS (SELECT 1 FROM inbound_recipient_deliveries rd WHERE rd.delivery_id = d.id AND rd.status != 'failed'))) LIMIT 1";

export const PERSIST_INBOUND_DELIVERY_PROJECTION_SQL =
  "UPDATE inbound_deliveries SET status = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2 AND policy_sha256 = ?3";

export const CLEAR_INBOUND_CLEANUP_AUTHORITY_SQL =
  "UPDATE inbound_deliveries SET raw_r2_key = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND policy_sha256 = ?2 AND status = 'provider_accepted' AND raw_r2_key = ?3";

export async function projectInboundDeliveryResult(
  job: InboundDeliveryResultJob,
  env: Env,
): Promise<void> {
  const claimed = await loadClaimedInboundResult(job, env);
  if (!claimed) {
    if (await inboundCleanupAlreadyComplete(job, env)) return;
    throw new Error("inbound result does not match its durable delivery claim");
  }
  const acceptedCount = job.results.filter((result) => result.ok).length;
  const providerMessageIds = job.results.flatMap((result) =>
    result.providerMessageId ? [result.providerMessageId] : []
  );
  const projected = await env.DB.prepare(
    "UPDATE route_health SET inbound_status = CASE WHEN ?1 = 'provider_accepted' AND inbound_status = 'inbox_verified' THEN inbound_status ELSE ?1 END, last_inbound_provider_accepted_at = CASE WHEN ?2 > 0 THEN CURRENT_TIMESTAMP ELSE last_inbound_provider_accepted_at END, last_inbound_provider_message_ids_json = CASE WHEN ?2 > 0 THEN ?3 ELSE last_inbound_provider_message_ids_json END, last_error_code = ?4, updated_at = CURRENT_TIMESTAMP WHERE route_id = ?5 AND policy_sha256 = ?6 AND EXISTS (SELECT 1 FROM runtime_state rs WHERE rs.singleton = 1 AND rs.active_policy_sha256 = ?6)",
  )
    .bind(
      job.status,
      acceptedCount,
      JSON.stringify(providerMessageIds),
      job.status === "provider_accepted" ? null : job.status,
      job.routeId,
      job.policySha256,
    )
    .run();
  if (Number(projected.meta?.changes ?? 0) === 0) {
    const runtime = await env.DB.prepare(
      "SELECT active_policy_sha256 FROM runtime_state WHERE singleton = 1",
    ).first<{ active_policy_sha256: string }>();
    if (!runtime?.active_policy_sha256 || runtime.active_policy_sha256 === job.policySha256) {
      throw new Error("active route health revision is unavailable for inbound result projection");
    }
    await recordAuditEvent(
      env,
      "system",
      "operator_delivery_result_superseded",
      {
        deliveryId: job.deliveryId,
        relayId: job.relayId,
        routeId: job.routeId,
        policySha256: job.policySha256,
        acceptedCount,
        failedCount: job.results.length - acceptedCount,
        providerMessageIds,
      },
      `${job.deliveryId}:operator_delivery_result_superseded`,
      job.threadId,
    );
    await persistInboundDeliveryProjection(job, env);
    await deleteAcceptedInboundPayloads(claimed.acceptedPayloadKeys, env);
    if (job.status === "provider_accepted") {
      if (!env.RELAY_SPOOL) throw new Error("relay spool binding unavailable");
      await env.RELAY_SPOOL.delete(claimed.rawR2Key);
      await recordInboundCleanupComplete(job, env);
      await clearInboundCleanupAuthority(job, env);
    }
    return;
  }
  for (const [index, result] of job.results.entries()) {
    await recordAuditEvent(
      env,
      "system",
      result.ok ? "operator_delivery_recipient_provider_accepted" : "operator_delivery_recipient_recovery_required",
      {
        deliveryId: job.deliveryId,
        relayId: job.relayId,
        operatorRef: result.operatorRef,
        providerMessageId: result.providerMessageId,
        errorCode: result.errorCode,
      },
      `${job.deliveryId}:operator_delivery:${index}`,
      job.threadId,
    );
  }
  await recordAuditEvent(
    env,
    "system",
    job.status === "provider_accepted" ? "operator_delivery_provider_accepted" : job.status,
    {
      deliveryId: job.deliveryId,
      relayId: job.relayId,
      acceptedCount,
      failedCount: job.results.length - acceptedCount,
      providerMessageIds,
      recoverySpool: true,
    },
    `${job.deliveryId}:operator_delivery_result`,
    job.threadId,
  );
  await persistInboundDeliveryProjection(job, env);
  await deleteAcceptedInboundPayloads(claimed.acceptedPayloadKeys, env);
  if (job.status === "provider_accepted") {
    if (!env.RELAY_SPOOL) throw new Error("relay spool binding unavailable");
    await env.RELAY_SPOOL.delete(claimed.rawR2Key);
    await recordInboundCleanupComplete(job, env);
    await clearInboundCleanupAuthority(job, env);
  }
}

export async function persistInboundDeliveryProjection(
  job: InboundDeliveryResultJob,
  env: Env,
): Promise<void> {
  const projected = await env.DB.prepare(PERSIST_INBOUND_DELIVERY_PROJECTION_SQL)
    .bind(job.status, job.deliveryId, job.policySha256).run();
  if (Number(projected.meta?.changes ?? 0) === 0) {
    throw new Error("inbound result delivery projection lost its durable claim");
  }
}

export async function clearInboundCleanupAuthority(
  job: InboundDeliveryResultJob,
  env: Env,
): Promise<void> {
  const cleared = await env.DB.prepare(CLEAR_INBOUND_CLEANUP_AUTHORITY_SQL)
    .bind(job.deliveryId, job.policySha256, job.relaySpoolKey).run();
  if (Number(cleared.meta?.changes ?? 0) === 0) {
    throw new Error("inbound result cleanup authority could not be retired");
  }
}

export async function recordInboundCleanupComplete(
  job: InboundDeliveryResultJob,
  env: Env,
): Promise<void> {
  const inserted = await recordAuditEvent(
    env,
    "system",
    "operator_delivery_cleanup_complete",
    { deliveryId: job.deliveryId, resultSha256: await inboundResultSha256(job) },
    `${job.deliveryId}:operator_delivery_cleanup_complete`,
    job.threadId,
  );
  if (!inserted && !(await inboundCleanupAlreadyComplete(job, env))) {
    throw new Error("inbound result cleanup receipt conflicts with durable state");
  }
}

export async function inboundCleanupAlreadyComplete(
  job: InboundDeliveryResultJob,
  env: Env,
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT action, detail_json FROM audit_events WHERE dedupe_key = ?1 LIMIT 1",
  ).bind(`${job.deliveryId}:operator_delivery_cleanup_complete`).first<{
    action: string;
    detail_json: string;
  }>();
  if (row?.action !== "operator_delivery_cleanup_complete") return false;
  try {
    const detail = JSON.parse(row.detail_json) as Record<string, unknown>;
    return detail.deliveryId === job.deliveryId &&
      detail.resultSha256 === await inboundResultSha256(job);
  } catch {
    return false;
  }
}

export async function inboundResultSha256(job: InboundDeliveryResultJob): Promise<string> {
  const results = job.results.map((result) => ({
    operatorRef: result.operatorRef,
    deliveryPayloadR2Key: result.deliveryPayloadR2Key,
    ok: result.ok,
    providerMessageId: result.providerMessageId ?? null,
    errorCode: result.errorCode ?? null,
  })).sort((left, right) =>
    left.operatorRef.localeCompare(right.operatorRef) ||
    left.deliveryPayloadR2Key.localeCompare(right.deliveryPayloadR2Key)
  );
  return sha256Hex(JSON.stringify({
    deliveryId: job.deliveryId,
    relayId: job.relayId,
    threadId: job.threadId,
    routeId: job.routeId,
    policySha256: job.policySha256,
    status: job.status,
    results,
    relaySpoolKey: job.relaySpoolKey,
    receivedAt: job.receivedAt,
  }));
}

export async function deleteAcceptedInboundPayloads(
  keys: string[],
  env: Env,
): Promise<void> {
  if (keys.length === 0) return;
  if (!env.RELAY_SPOOL) throw new Error("relay spool binding unavailable");
  for (const key of keys) await env.RELAY_SPOOL.delete(key);
}

export async function loadClaimedInboundResult(
  job: InboundDeliveryResultJob,
  env: Env,
): Promise<{ rawR2Key: string; acceptedPayloadKeys: string[] } | null> {
  const resultsJson = JSON.stringify(job.results);
  const row = await env.DB.prepare(CLAIMED_INBOUND_RESULT_SQL)
    .bind(
      job.deliveryId,
      job.relayId,
      job.threadId,
      job.routeId,
      job.policySha256,
      job.relaySpoolKey,
      resultsJson,
      job.receivedAt,
      job.status,
    )
    .first<{ raw_r2_key: string; accepted_payload_keys_json: string }>();
  if (!row?.raw_r2_key) return null;
  let keys: unknown;
  try {
    keys = JSON.parse(row.accepted_payload_keys_json);
  } catch {
    return null;
  }
  if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string")) return null;
  return { rawR2Key: row.raw_r2_key, acceptedPayloadKeys: keys };
}
