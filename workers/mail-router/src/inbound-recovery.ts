import {
InboundDeliveryResultJob,
operatorDeliveryConfig
} from "../../shared/contracts";
import {
assertWithinRelayLimit,
normalizeMailbox,
relayTokenFromRecipient,
sha256Hex,
type OperatorDeliveryMessage
} from "../../shared/inbox-relay";
import { Env,InboundDeliveryRow,InboundRecipientDeliveryRow,OperatorDeliveryResult,OperatorDeliverySpool,claimInboundRecipient,projectInboundRecipientResult } from "./inbound-repository";

export async function recoverExistingInbound(inbound: InboundDeliveryRow, env: Env): Promise<void> {
  const recipients = await env.DB.prepare(
    "SELECT operator_ref, delivery_message_id, delivery_payload_r2_key, delivery_payload_sha256, status, provider_message_id, error_code FROM inbound_recipient_deliveries WHERE delivery_id = ?1 ORDER BY operator_ref",
  ).bind(inbound.id).all<InboundRecipientDeliveryRow>();
  const rows = recipients.results ?? [];
  if (inbound.raw_r2_key) {
    for (const row of rows) {
      if (row.status === "provider_accepted") {
        await env.RELAY_SPOOL!.delete(
          row.delivery_payload_r2_key,
        ).catch(() => undefined);
        continue;
      }
      if (row.status !== "pending") continue;

      let delivery: OperatorDeliveryMessage;
      try {
        delivery = await loadOperatorDeliverySpool(row, inbound, env);
      } catch {
        continue;
      }
      const claimed = await claimInboundRecipient(
        inbound.id,
        row.operator_ref,
        inbound.policy_sha256,
        inbound.raw_r2_key,
        env,
      ).catch(() => false);
      if (!claimed) continue;

      try {
        const providerResult = await env.EMAIL!.send(delivery);
        const result = {
          operator: delivery.to,
          deliveryPayloadR2Key: row.delivery_payload_r2_key,
          ok: true,
          providerMessageId: providerResult?.messageId,
        } satisfies OperatorDeliveryResult;
        await projectInboundRecipientResult(inbound.id, row.operator_ref, result, env);
        await env.RELAY_SPOOL!.delete(
          row.delivery_payload_r2_key,
        ).catch(() => undefined);
      } catch (error) {
        const result = {
          operator: delivery.to,
          deliveryPayloadR2Key: row.delivery_payload_r2_key,
          ok: false,
          errorCode: cloudflareEmailErrorCode(error),
        } satisfies OperatorDeliveryResult;
        await projectInboundRecipientResult(inbound.id, row.operator_ref, result, env).catch(() => undefined);
      }
    }
  }
  const refreshedRecipients = await env.DB.prepare(
    "SELECT operator_ref, delivery_message_id, delivery_payload_r2_key, delivery_payload_sha256, status, provider_message_id, error_code FROM inbound_recipient_deliveries WHERE delivery_id = ?1 ORDER BY operator_ref",
  ).bind(inbound.id).all<InboundRecipientDeliveryRow>();
  const refreshedRows = refreshedRecipients.results ?? rows;
  const results: InboundDeliveryResultJob["results"] = refreshedRows.map((row) => ({
    operatorRef: row.operator_ref,
    deliveryPayloadR2Key: row.delivery_payload_r2_key,
    ok: row.status === "provider_accepted",
    providerMessageId: row.provider_message_id ?? undefined,
    errorCode: row.status === "provider_accepted"
      ? undefined
      : row.error_code ?? "provider_outcome_unknown",
  }));
  const accepted = results.filter((result) => result.ok).length;
  const status: InboundDeliveryResultJob["status"] = accepted === results.length && results.length > 0
    ? "provider_accepted"
    : accepted > 0
      ? "partial_delivery"
      : "recovery_required";

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE inbound_deliveries SET status = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
    ).bind(status, inbound.id),
    env.DB.prepare(
      "UPDATE route_health SET inbound_status = 'recovery_required', last_error_code = 'inbound_result_recovery_pending', updated_at = CURRENT_TIMESTAMP WHERE route_id = ?1 AND policy_sha256 = ?2 AND EXISTS (SELECT 1 FROM runtime_state rs WHERE rs.singleton = 1 AND rs.active_policy_sha256 = ?2)",
    ).bind(
      inbound.route_id,
      inbound.policy_sha256,
    ),
  ]).catch(() => undefined);
  if (!inbound.raw_r2_key || results.length === 0) return;
  await env.MAIL_JOBS.send({
    kind: "inbound_delivery_result",
    deliveryId: inbound.id,
    relayId: inbound.relay_id,
    threadId: inbound.thread_id,
    routeId: inbound.route_id,
    policySha256: inbound.policy_sha256,
    status,
    results,
    relaySpoolKey: inbound.raw_r2_key,
    receivedAt: inbound.received_at,
  }).catch(() => undefined);
}

export function operatorDeliverySpoolKey(rawSpoolKey: string, operatorRef: string): string {
  return `${rawSpoolKey}.operator-${operatorRef}.json`;
}

export async function persistOperatorDeliverySpools(
  rawSpoolKey: string,
  deliveries: OperatorDeliveryMessage[],
  operatorRefs: string[],
  deliveryId: string,
  env: Env,
): Promise<OperatorDeliverySpool[]> {
  const spools = await Promise.all(deliveries.map(async (delivery, index) => {
    const operatorRef = operatorRefs[index]!;
    const key = operatorDeliverySpoolKey(rawSpoolKey, operatorRef);
    const value = serializeOperatorDelivery(delivery);
    return { key, value, sha256: await sha256Hex(value), operatorRef };
  }));
  try {
    for (const spool of spools) {
      await env.RELAY_SPOOL!.put(spool.key, spool.value, {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { retentionClass: "relay-spool", deliveryId, operatorRef: spool.operatorRef },
      });
    }
  } catch (error) {
    await deleteOperatorDeliverySpools(spools.map((spool) => spool.key), env);
    throw error;
  }
  return spools;
}

export async function deleteOperatorDeliverySpools(
  keys: string[],
  env: Env,
): Promise<void> {
  await Promise.all(keys.map((key) =>
    env.RELAY_SPOOL!.delete(key).catch(() => undefined)
  ));
}

export async function loadOperatorDeliverySpool(
  row: InboundRecipientDeliveryRow,
  inbound: InboundDeliveryRow,
  env: Env,
): Promise<OperatorDeliveryMessage> {
  if (!inbound.raw_r2_key) throw new Error("operator delivery recovery generation is missing");
  const expectedKey = operatorDeliverySpoolKey(inbound.raw_r2_key, row.operator_ref);
  if (row.delivery_payload_r2_key !== expectedKey) throw new Error("operator delivery recovery key drifted");
  const object = await env.RELAY_SPOOL!.get(row.delivery_payload_r2_key);
  if (!object) throw new Error("operator delivery recovery payload is missing");
  const serialized = await object.text();
  if (await sha256Hex(serialized) !== row.delivery_payload_sha256) {
    throw new Error("operator delivery recovery payload digest drifted");
  }
  const delivery = deserializeOperatorDelivery(serialized);
  const config = operatorDeliveryConfig(env);
  const token = config.replyDomain ? relayTokenFromRecipient(delivery.replyTo, config.replyDomain) : null;
  // The verified payload digest freezes the Rust-selected identity for this
  // recipient. Personal-first deliveries need not use the relay's role identity;
  // neither recovery nor a later policy may replace the original payload.
  if (
    await sha256Hex(normalizeMailbox(delivery.to)) !== row.operator_ref ||
    delivery.headers["X-Maildesk-Delivery-ID"] !== row.delivery_message_id ||
    normalizeMailbox(delivery.from.email) !== delivery.headers["X-Maildesk-Reply-Identity"] ||
    !token ||
    await sha256Hex(token) !== inbound.token_sha256
  ) {
    throw new Error("operator delivery recovery authorization drifted");
  }
  assertWithinRelayLimit(delivery, config);
  return delivery;
}

export function serializeOperatorDelivery(delivery: OperatorDeliveryMessage): string {
  return JSON.stringify({
    ...delivery,
    attachments: delivery.attachments?.map((attachment) => ({
      ...attachment,
      content: arrayBufferToBase64(attachment.content),
    })),
  });
}

export function deserializeOperatorDelivery(value: string): OperatorDeliveryMessage {
  const parsed = JSON.parse(value) as Partial<Omit<OperatorDeliveryMessage, "attachments">> & {
    attachments?: Array<Omit<NonNullable<OperatorDeliveryMessage["attachments"]>[number], "content"> & {
      content: string;
    }>;
  };
  if (
    !parsed.from || typeof parsed.from.email !== "string" ||
    typeof parsed.to !== "string" || typeof parsed.replyTo !== "string" ||
    typeof parsed.subject !== "string" || typeof parsed.text !== "string" ||
    typeof parsed.html !== "string" || !parsed.headers ||
    Object.entries(parsed.headers).some(([name, header]) => !name || typeof header !== "string") ||
    (parsed.attachments && parsed.attachments.some((attachment) =>
      typeof attachment.filename !== "string" || typeof attachment.type !== "string" ||
      typeof attachment.content !== "string" ||
      (attachment.disposition !== "attachment" && attachment.disposition !== "inline") ||
      (attachment.disposition === "inline" && typeof attachment.contentId !== "string")
    ))
  ) {
    throw new Error("operator delivery recovery payload is malformed");
  }
  return {
    from: parsed.from,
    to: parsed.to,
    replyTo: parsed.replyTo,
    subject: parsed.subject,
    text: parsed.text,
    html: parsed.html,
    headers: parsed.headers,
    attachments: parsed.attachments?.map((attachment) => ({
      ...attachment,
      content: base64ToArrayBuffer(attachment.content),
    })) as OperatorDeliveryMessage["attachments"],
  };
}

export function arrayBufferToBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

export function cloudflareEmailErrorCode(error: unknown): string {
  if (
    typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" && /^E_[A-Z0-9_]{1,96}$/.test(error.code)
  ) {
    return error.code;
  }
  return "provider_outcome_unknown";
}
