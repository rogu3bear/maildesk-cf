import {
InboundDeliveryResultJob,
MaildeskEnv
} from "../../shared/contracts";
import {
normalizeMailbox,
parseRelayEmail,
sha256Hex
} from "../../shared/inbox-relay";
import { recordAudit } from "../../shared/ingress-audit";
import { loadActivePolicy } from "../../shared/policy-store";
import {
RouteDecision
} from "../../shared/router";
import { type SelectedDestination as SelectedWebDeskDisposition } from "../../shared/work-destination";

export const DISCARD_SUPERSEDED_UNSENT_RELAY_SQL =
  "DELETE FROM reply_relays WHERE id = ?1 AND EXISTS (SELECT 1 FROM runtime_state rs WHERE rs.singleton = 1 AND rs.active_policy_sha256 != ?2) AND EXISTS (SELECT 1 FROM inbound_deliveries d WHERE d.relay_id = reply_relays.id AND d.id = ?3 AND d.policy_sha256 = ?2 AND NOT EXISTS (SELECT 1 FROM inbound_recipient_deliveries rd WHERE rd.delivery_id = d.id AND rd.status != 'pending'))";

export const CLAIM_ACTIVE_INBOUND_RECIPIENT_SQL =
  "UPDATE inbound_recipient_deliveries SET status = 'sending', updated_at = CURRENT_TIMESTAMP WHERE delivery_id = ?1 AND operator_ref = ?2 AND status = 'pending' AND EXISTS (SELECT 1 FROM inbound_deliveries d JOIN runtime_state rs ON rs.singleton = 1 AND rs.active_policy_sha256 = d.policy_sha256 JOIN alias_routes ar ON ar.id = d.route_id AND ar.enabled = 1 AND ar.policy_sha256 = d.policy_sha256 WHERE d.id = inbound_recipient_deliveries.delivery_id AND d.policy_sha256 = ?3 AND d.raw_r2_key = ?4)";

export async function persistInboxRelay(
  message: ForwardableEmailMessage,
  parsed: Awaited<ReturnType<typeof parseRelayEmail>>,
  route: RouteDecision,
  relay: {
    deliveryId: string;
    messageId: string;
    relayId: string;
    tokenHash: string;
    expiresAt: string;
    receivedAt: string;
    fingerprintSha256: string;
    spoolKey: string;
    operatorRefs: string[];
    deliveryMessageIds: string[];
    deliveryPayloadKeys: string[];
    deliveryPayloadSha256s: string[];
  },
  policySha256: string,
  env: Env,
): Promise<PersistedInbound> {
  const recipient = parseMailbox(message.to);
  if (!recipient) throw new Error("invalid envelope recipient");
  const domainId = stableId("domain", recipient.domain);
  const identityId = stableId("identity", route.defaultReplyIdentity);
  const routeId = stableId("route", recipient.domain, route.localPart);
  // Bind the outward destination to the same visible sender shown in the
  // operator banner. An inbound Reply-To must not redirect a trusted operator's
  // reply to an unrelated third party.
  const externalSender = normalizeMailbox(parsed.from.address);
  const threadId = await resolveThreadId(
    env,
    routeId,
    externalSender,
    normalizeMailbox(message.to),
    relay.messageId,
    parsed.inReplyTo ?? null,
    parsed.references.join(" ") || null,
  );
  const persisted = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO threads (id, domain_id, route_id, external_sender, subject, status) SELECT ?1, ?2, ?3, ?4, NULL, 'open' FROM alias_routes ar JOIN runtime_state rs ON rs.singleton = 1 AND rs.active_policy_sha256 = ar.policy_sha256 WHERE ar.id = ?3 AND ar.domain_id = ?2 AND ar.default_reply_identity_id = ?5 AND ar.decision_kind = ?6 AND ar.enabled = 1 AND ar.policy_sha256 = ?7 ON CONFLICT(id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP",
    ).bind(threadId, domainId, routeId, externalSender, identityId, route.routeKind, policySha256),
    env.DB.prepare(
      "INSERT INTO reply_relays (id, token_sha256, thread_id, route_id, external_recipient, reply_identity, original_message_id, references_json, expires_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 FROM alias_routes ar JOIN runtime_state rs ON rs.singleton = 1 AND rs.active_policy_sha256 = ar.policy_sha256 WHERE ar.id = ?4 AND ar.enabled = 1 AND ar.policy_sha256 = ?10",
    ).bind(
      relay.relayId,
      relay.tokenHash,
      threadId,
      routeId,
      externalSender,
      route.defaultReplyIdentity,
      parsed.messageId ?? relay.messageId,
      JSON.stringify(parsed.references),
      relay.expiresAt,
      policySha256,
    ),
    env.DB.prepare(
      "INSERT INTO inbound_deliveries (id, fingerprint_sha256, relay_id, thread_id, route_id, policy_sha256, raw_r2_key, received_at, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending')",
    ).bind(
      relay.deliveryId,
      relay.fingerprintSha256,
      relay.relayId,
      threadId,
      routeId,
      policySha256,
      relay.spoolKey,
      relay.receivedAt,
    ),
    ...relay.operatorRefs.map((operatorRef, index) => env.DB.prepare(
      "INSERT INTO inbound_recipient_deliveries (delivery_id, operator_ref, delivery_message_id, delivery_payload_r2_key, delivery_payload_sha256, status) VALUES (?1, ?2, ?3, ?4, ?5, 'pending')",
    ).bind(
      relay.deliveryId,
      operatorRef,
      relay.deliveryMessageIds[index],
      relay.deliveryPayloadKeys[index],
      relay.deliveryPayloadSha256s[index],
    )),
    env.DB.prepare(
      "UPDATE route_health SET last_inbound_at = ?1, updated_at = CURRENT_TIMESTAMP WHERE route_id = ?2 AND policy_sha256 = ?3 AND EXISTS (SELECT 1 FROM runtime_state rs WHERE rs.singleton = 1 AND rs.active_policy_sha256 = ?3)",
    ).bind(relay.receivedAt, routeId, policySha256),
  ]);
  if (persisted.slice(0, 3 + relay.operatorRefs.length).some((result) => Number(result.meta?.changes ?? 0) === 0)) {
    throw new Error("active policy revision changed during inbound persistence");
  }
  await recordAudit(
    env,
    `${relay.deliveryId}:inbox_relay_created`,
    threadId,
    "system",
    "inbox_relay_created",
    {
      deliveryId: relay.deliveryId,
      routeKind: route.routeKind,
      operatorCount: route.operators.length,
      replyIdentity: route.defaultReplyIdentity,
      relayId: relay.relayId,
    },
  );
  return { deliveryId: relay.deliveryId, relayId: relay.relayId, routeId, threadId, policySha256 };
}

export async function recordDeliveryResults(
  inbound: PersistedInbound,
  results: OperatorDeliveryResult[],
  status: "provider_accepted" | "partial_delivery" | "recovery_required" | "failed",
  spoolKey: string | null,
  env: Env,
): Promise<void> {
  const acceptedCount = results.filter((result) => result.ok).length;
  const providerMessageIds = results.flatMap((result) =>
    result.providerMessageId ? [result.providerMessageId] : []
  );
  const errorCodes = [...new Set(results.flatMap((result) => result.errorCode ? [result.errorCode] : []))];
  const routeErrorCode = status === "provider_accepted"
    ? null
    : errorCodes.length === 1
      ? errorCodes[0]
      : status;
  const deliveryProjected = await env.DB.prepare(
    "UPDATE inbound_deliveries SET status = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2 AND policy_sha256 = ?3",
  ).bind(status, inbound.deliveryId, inbound.policySha256).run();
  if (Number(deliveryProjected.meta?.changes ?? 0) === 0) {
    throw new Error("inbound delivery result has no durable claim");
  }
  const projected = await env.DB.prepare(
    "UPDATE route_health SET inbound_status = CASE WHEN ?1 = 'provider_accepted' AND inbound_status = 'inbox_verified' THEN inbound_status ELSE ?1 END, last_inbound_provider_accepted_at = CASE WHEN ?2 > 0 THEN CURRENT_TIMESTAMP ELSE last_inbound_provider_accepted_at END, last_inbound_provider_message_ids_json = CASE WHEN ?2 > 0 THEN ?3 ELSE last_inbound_provider_message_ids_json END, last_error_code = ?4, updated_at = CURRENT_TIMESTAMP WHERE route_id = ?5 AND policy_sha256 = ?6 AND EXISTS (SELECT 1 FROM runtime_state rs WHERE rs.singleton = 1 AND rs.active_policy_sha256 = ?6)",
  )
    .bind(
      status,
      acceptedCount,
      JSON.stringify(providerMessageIds),
      routeErrorCode,
      inbound.routeId,
      inbound.policySha256,
    )
    .run();
  if (Number(projected.meta?.changes ?? 0) === 0) {
    throw new Error("inbound provider result belongs to a superseded policy revision");
  }
  await Promise.all(results.map(async (result, index) => {
    await recordAudit(
      env,
      `${inbound.deliveryId}:operator_delivery:${index}`,
      inbound.threadId,
      "system",
      result.ok ? "operator_delivery_recipient_provider_accepted" : "operator_delivery_recipient_recovery_required",
      {
        deliveryId: inbound.deliveryId,
        relayId: inbound.relayId,
        operatorRef: await sha256Hex(result.operator),
        providerMessageId: result.providerMessageId,
        errorCode: result.errorCode,
      },
    );
  }));
  await recordAudit(
    env,
    `${inbound.deliveryId}:operator_delivery_result`,
    inbound.threadId,
    "system",
    status === "provider_accepted" ? "operator_delivery_provider_accepted" : status,
    {
      deliveryId: inbound.deliveryId,
      relayId: inbound.relayId,
      acceptedCount,
      failedCount: results.filter((result) => !result.ok).length,
      providerMessageIds,
      recoverySpool: Boolean(spoolKey),
    },
  );
}

export async function loadInboundDelivery(
  fingerprintSha256: string,
  env: Env,
): Promise<InboundDeliveryRow | null> {
  return env.DB.prepare(
    "SELECT d.id, d.relay_id, d.thread_id, d.route_id, d.policy_sha256, d.raw_r2_key, d.received_at, d.status, rr.reply_identity, rr.token_sha256 FROM inbound_deliveries d JOIN reply_relays rr ON rr.id = d.relay_id WHERE d.fingerprint_sha256 = ?1 LIMIT 1",
  ).bind(fingerprintSha256).first<InboundDeliveryRow>();
}

export async function discardSupersededUnsentInbound(
  inbound: InboundDeliveryRow,
  env: Env,
): Promise<string[] | null> {
  const activePolicy = await loadActivePolicy(env);
  if (!activePolicy || activePolicy.sha256 === inbound.policy_sha256) return null;

  const recipients = await env.DB.prepare(
    "SELECT delivery_payload_r2_key FROM inbound_recipient_deliveries WHERE delivery_id = ?1 ORDER BY operator_ref",
  ).bind(inbound.id).all<{ delivery_payload_r2_key: string }>();
  const payloadKeys = (recipients.results ?? []).map((row) => row.delivery_payload_r2_key);
  if (payloadKeys.length === 0) return null;

  // Deleting the relay cascades through inbound_deliveries and its recipient
  // rows. One conditional statement therefore retires the entire token
  // generation or changes nothing; no partial cleanup result can poison the
  // fingerprint while leaving its relay behind.
  const discarded = await env.DB.prepare(
    DISCARD_SUPERSEDED_UNSENT_RELAY_SQL,
  ).bind(inbound.relay_id, inbound.policy_sha256, inbound.id).run();
  // SQLite-compatible runtimes may report the root relay deletion together
  // with its foreign-key cascades. Any positive count means the guarded root
  // delete won; zero means a recipient crossed the provider boundary first.
  return Number(discarded.meta?.changes ?? 0) > 0 ? payloadKeys : null;
}

export async function loadInboundRecipient(
  deliveryId: string,
  operatorRef: string,
  env: Env,
): Promise<InboundRecipientDeliveryRow | null> {
  return env.DB.prepare(
    "SELECT operator_ref, status, provider_message_id, error_code FROM inbound_recipient_deliveries WHERE delivery_id = ?1 AND operator_ref = ?2 LIMIT 1",
  ).bind(deliveryId, operatorRef).first<InboundRecipientDeliveryRow>();
}

export async function claimInboundRecipient(
  deliveryId: string,
  operatorRef: string,
  policySha256: string,
  spoolKey: string,
  env: Env,
): Promise<boolean> {
  const claimed = await env.DB.prepare(
    CLAIM_ACTIVE_INBOUND_RECIPIENT_SQL,
  ).bind(deliveryId, operatorRef, policySha256, spoolKey).run();
  return Number(claimed.meta?.changes ?? 0) > 0;
}

export async function projectInboundRecipientResult(
  deliveryId: string,
  operatorRef: string,
  result: OperatorDeliveryResult,
  env: Env,
): Promise<void> {
  const projected = await env.DB.prepare(
    "UPDATE inbound_recipient_deliveries SET status = ?1, provider_message_id = ?2, error_code = ?3, updated_at = CURRENT_TIMESTAMP WHERE delivery_id = ?4 AND operator_ref = ?5 AND status = 'sending'",
  ).bind(
    result.ok ? "provider_accepted" : "recovery_required",
    result.providerMessageId ?? null,
    result.errorCode ?? null,
    deliveryId,
    operatorRef,
  ).run();
  if (Number(projected.meta?.changes ?? 0) === 0) {
    throw new Error("inbound recipient result has no sending claim");
  }
}

export async function inboundDeliveryResultJob(
  inbound: PersistedInbound,
  results: OperatorDeliveryResult[],
  status: InboundDeliveryResultJob["status"],
  relaySpoolKey: string,
  receivedAt: string,
): Promise<InboundDeliveryResultJob> {
  return {
    kind: "inbound_delivery_result",
    deliveryId: inbound.deliveryId,
    relayId: inbound.relayId,
    threadId: inbound.threadId,
    routeId: inbound.routeId,
    policySha256: inbound.policySha256,
    status,
    results: await Promise.all(results.map(async (result) => {
      if (!result.deliveryPayloadR2Key) {
        throw new Error("inbox relay result is missing its recovery payload key");
      }
      return {
        operatorRef: await sha256Hex(result.operator),
        deliveryPayloadR2Key: result.deliveryPayloadR2Key,
        ok: result.ok,
        providerMessageId: result.providerMessageId,
        errorCode: result.errorCode,
      };
    })),
    relaySpoolKey,
    receivedAt,
  };
}

export async function persistSinkRoute(
  message: ForwardableEmailMessage,
  route: RouteDecision,
  policySha256: string,
  env: Env,
): Promise<void> {
  const recipient = parseMailbox(message.to);
  if (!recipient) return;
  const routeId = stableId("route", recipient.domain, route.localPart);
  const result = await env.DB.prepare(
    "UPDATE route_health SET inbound_status = 'intentionally_excluded', reply_status = 'intentionally_excluded', last_inbound_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE route_id = ?1 AND policy_sha256 = ?2 AND EXISTS (SELECT 1 FROM runtime_state rs JOIN alias_routes ar ON ar.id = ?1 AND ar.enabled = 1 AND ar.decision_kind = 'sink' AND ar.policy_sha256 = rs.active_policy_sha256 WHERE rs.singleton = 1 AND rs.active_policy_sha256 = ?2)",
  ).bind(routeId, policySha256).run();
  if (Number(result.meta?.changes ?? 0) === 0) throw new Error("active sink policy changed");
}

export async function resolveThreadId(
  env: Env,
  routeId: string,
  externalSender: string,
  envelopeTo: string,
  messageId: string,
  inReplyTo: string | null,
  references: string | null,
): Promise<string> {
  for (const referencedId of referencedMessageIds(inReplyTo, references)) {
    const existing = await env.DB.prepare(
      "SELECT m.thread_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.header_message_id = ?1 AND t.route_id = ?2 AND lower(t.external_sender) = lower(?3) LIMIT 1",
    )
      .bind(referencedId, routeId, externalSender)
      .first<{ thread_id: string }>();
    if (existing?.thread_id) return existing.thread_id;
  }
  return collisionResistantId("thread", envelopeTo, externalSender, messageId.trim());
}

export async function persistWebDeskMetadata(
  message: ForwardableEmailMessage,
  messageId: string,
  deliveryId: string,
  rawR2Key: string,
  route: RouteDecision,
  results: OperatorDeliveryResult[],
  disposition: SelectedWebDeskDisposition,
  env: Env,
): Promise<void> {
  const recipient = parseMailbox(message.to);
  if (!recipient) return;
  const domainId = stableId("domain", recipient.domain);
  const identityId = stableId("identity", route.defaultReplyIdentity);
  const routeId = stableId("route", recipient.domain, route.localPart);
  const threadId = await resolveThreadId(
    env,
    routeId,
    normalizeMailbox(message.from),
    normalizeMailbox(message.to),
    messageId,
    message.headers.get("in-reply-to"),
    message.headers.get("references"),
  );
  const messageRowId = stableId("message", deliveryId);
  const storageKind = route.routeKind === "personal_alias" ? "personal" : "role";
  await env.DB.prepare("INSERT OR IGNORE INTO domains (id, domain) VALUES (?1, ?2)").bind(domainId, recipient.domain).run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO identities (id, domain_id, address, kind) VALUES (?1, ?2, ?3, ?4)",
  ).bind(identityId, domainId, route.defaultReplyIdentity, storageKind).run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO alias_routes (id, domain_id, local_part, kind, default_reply_identity_id, decision_kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).bind(routeId, domainId, route.localPart, storageKind, identityId, route.routeKind).run();
  await env.DB.prepare(
    "UPDATE alias_routes SET kind = ?1, default_reply_identity_id = ?2, decision_kind = ?3 WHERE id = ?4",
  ).bind(storageKind, identityId, route.routeKind, routeId).run();
  for (const operator of route.operators) {
    const operatorId = stableId("operator", operator);
    await env.DB.prepare("INSERT OR IGNORE INTO operators (id, email) VALUES (?1, ?2)").bind(operatorId, operator).run();
    await env.DB.prepare("INSERT OR IGNORE INTO alias_route_operators (route_id, operator_id) VALUES (?1, ?2)").bind(routeId, operatorId).run();
  }
  await env.DB.prepare(
    "INSERT INTO threads (id, domain_id, route_id, external_sender, subject, status) VALUES (?1, ?2, ?3, ?4, ?5, 'open') ON CONFLICT(id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP",
  ).bind(threadId, domainId, routeId, normalizeMailbox(message.from), message.headers.get("subject")).run();
  await env.DB.prepare(
    "INSERT INTO messages (id, thread_id, direction, envelope_from, envelope_to, header_message_id, in_reply_to, raw_r2_key, delivery_status, retention_class) VALUES (?1, ?2, 'inbound', ?3, ?4, ?5, ?6, ?7, 'received', 'archive') ON CONFLICT(id) DO NOTHING",
  ).bind(messageRowId, threadId, normalizeMailbox(message.from), normalizeMailbox(message.to), messageId, message.headers.get("in-reply-to"), rawR2Key).run();
  await recordAudit(env, `${deliveryId}:inbound_email_accepted`, threadId, "system", "inbound_email_accepted", {
    deliveryId,
    routeKind: route.routeKind,
    acceptedCount: results.filter((result) => result.ok).length,
    failedCount: results.filter((result) => !result.ok).length,
  });
  if (route.disposition) {
    await recordAudit(
      env,
      `${deliveryId}:route_disposition_selected`,
      threadId,
      "system",
      "route_disposition_selected",
      {
        routeRef: disposition.routeRef,
        destinationRef: disposition.destinationRef,
        accountableRef: disposition.accountableRef,
        targetKind: disposition.target.kind,
        fallbackUsed: disposition.fallbackUsed,
      },
    );
  }
}

export function referencedMessageIds(inReplyTo: string | null, references: string | null): string[] {
  return [...new Set([...extractMessageIds(inReplyTo), ...extractMessageIds(references).reverse()])];
}

export function extractMessageIds(value: string | null): string[] {
  if (!value || value.length > 8_000) return [];
  return value.match(/<[^<>\s]+>/g) ?? [];
}

export function parseMailbox(address: string): ParsedMailbox | null {
  const normalized = normalizeMailbox(address);
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex <= 0) return null;
  return { localPart: normalized.slice(0, atIndex), domain: normalized.slice(atIndex + 1) };
}

export function stableId(prefix: string, ...parts: string[]): string {
  return [prefix, ...parts.map((value) => encodeURIComponent(value.trim().toLowerCase()))].join(":");
}

export async function collisionResistantId(prefix: string, ...parts: string[]): Promise<string> {
  return `${prefix}:${await sha256Hex(new TextEncoder().encode(parts.join("\0")))}`;
}

export function structuredError(event: string, detail: Record<string, string>): void {
  console.error(JSON.stringify({ event, ...detail }));
}

export type Env = MaildeskEnv;

export interface ParsedMailbox {
  localPart: string;
  domain: string;
}

export interface PersistedInbound {
  deliveryId: string;
  relayId: string;
  routeId: string;
  threadId: string;
  policySha256: string;
}

export interface InboundDeliveryRow {
  id: string;
  relay_id: string;
  thread_id: string;
  route_id: string;
  policy_sha256: string;
  raw_r2_key: string | null;
  reply_identity: string;
  token_sha256: string;
  received_at: string;
  status: "pending" | "sending" | "provider_accepted" | "partial_delivery" | "recovery_required" | "failed";
}

export interface InboundRecipientDeliveryRow {
  operator_ref: string;
  delivery_message_id: string;
  delivery_payload_r2_key: string;
  delivery_payload_sha256: string;
  status: "pending" | "sending" | "provider_accepted" | "recovery_required" | "failed";
  provider_message_id: string | null;
  error_code: string | null;
}

export interface PolicyBoundRoute {
  route: RouteDecision;
  policySha256: string;
}

export interface OperatorDeliveryResult {
  operator: string;
  deliveryPayloadR2Key?: string;
  ok: boolean;
  providerMessageId?: string;
  errorCode?: string;
}

export interface OperatorDeliverySpool {
  key: string;
  value: string;
  sha256: string;
  operatorRef: string;
}
