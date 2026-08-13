import {
  MaildeskEnv,
  operatorDeliveryConfig,
  rawMailKey,
  relaySpoolKey,
} from "../../shared/contracts";
import {
  assertWithinRelayLimit,
  buildOperatorDelivery,
  generateRelayToken,
  normalizeMailbox,
  operatorAuthenticationPassed,
  outboundReplyPayload,
  parseRelayEmail,
  relayAddress,
  relayRecordIsActive,
  relayTokenFromRecipient,
  sha256Hex,
  tokenExpiresAt,
} from "../../shared/inbox-relay";
import {
  authorizeReplyWithPolicy,
  routeInbound,
  RouteDecision,
  RouterPolicy,
} from "../../shared/router";
import { loadActivePolicy } from "../../shared/policy-store";

const MIME_CONTENT_TYPE = "message/rfc822";

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await acceptEmail(message, env);
  },
} satisfies ExportedHandler<Env>;

async function acceptEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const config = operatorDeliveryConfig(env);
  if (config.mode === "invalid") {
    message.setReject("maildesk operator delivery mode is invalid");
    return;
  }
  if (config.mode === "inbox_relay" && config.processingMode !== "enabled") {
    message.setReject(
      config.processingMode === "invalid"
        ? "maildesk relay processing mode is invalid"
        : "maildesk relay processing is disabled",
    );
    return;
  }
  const token = config.replyDomain
    ? relayTokenFromRecipient(message.to, config.replyDomain)
    : null;
  if (token) {
    await acceptOperatorReply(message, token, env);
    return;
  }

  const route = await routeMessage(message, env);
  if (route instanceof Error) {
    message.setReject(route.message);
    return;
  }

  if (config.mode === "inbox_relay") {
    await acceptInboxRelay(message, route, env);
    return;
  }

  await acceptWebDesk(message, route, env);
}

async function acceptInboxRelay(
  message: ForwardableEmailMessage,
  route: RouteDecision,
  env: Env,
): Promise<void> {
  const config = operatorDeliveryConfig(env);
  if (!config.replyDomain || !env.EMAIL) {
    message.setReject("maildesk inbox relay is not configured");
    return;
  }
  if (route.routeKind === "sink") {
    await persistSinkRoute(message, route, env);
    return;
  }
  if (route.operators.length === 0) {
    message.setReject("maildesk route has no authorized operator");
    return;
  }
  if (message.rawSize > config.maxEncodedMessageBytes) {
    message.setReject("maildesk relay accepts messages up to 5 MiB including attachments");
    return;
  }

  let rawBytes: ArrayBuffer;
  let parsed: Awaited<ReturnType<typeof parseRelayEmail>>;
  try {
    rawBytes = await new Response(message.raw).arrayBuffer();
    parsed = await parseRelayEmail(rawBytes);
  } catch {
    message.setReject("maildesk could not safely parse this message");
    return;
  }

  const deliveryId = crypto.randomUUID();
  const messageId = message.headers.get("message-id") ?? parsed.messageId ?? `<${deliveryId}@maildesk.invalid>`;
  const token = generateRelayToken();
  const tokenHash = await sha256Hex(token);
  const replyTo = relayAddress(token, config.replyDomain);
  const relayId = `relay:${crypto.randomUUID()}`;
  const receivedAt = new Date().toISOString();
  const deliveryMessageId = (index: number) => `<${deliveryId}.${index}@${config.replyDomain}>`;

  const deliveries = route.operators.map((operator, index) =>
    buildOperatorDelivery(parsed, {
      operator,
      receivedAddress: normalizeMailbox(message.to),
      replyIdentity: route.defaultReplyIdentity,
      routeKind: route.routeKind,
      operatorCount: route.operators.length,
      relayAddress: replyTo,
      deliveryMessageId: deliveryMessageId(index),
    }),
  );
  try {
    for (const delivery of deliveries) assertWithinRelayLimit(delivery, config);
  } catch {
    message.setReject("maildesk relay accepts messages up to 5 MiB including attachments");
    return;
  }

  let persisted: PersistedInbound;
  try {
    persisted = await persistInboxRelay(
      message,
      parsed,
      route,
      {
        deliveryId,
        messageId,
        relayId,
        tokenHash,
        expiresAt: tokenExpiresAt(new Date(receivedAt), config.replyTokenTtlDays),
        receivedAt,
      },
      env,
    );
  } catch {
    structuredError("inbound_persistence_failed", { deliveryId });
    message.setReject("maildesk could not create a durable route for this message");
    return;
  }

  const settled = await Promise.allSettled(deliveries.map((delivery) => env.EMAIL!.send(delivery)));
  const results = settled.map((result, index): OperatorDeliveryResult => ({
    operator: route.operators[index] ?? "unknown",
    ok: result.status === "fulfilled",
    providerMessageId: result.status === "fulfilled" ? result.value?.messageId : undefined,
    errorCode: result.status === "rejected" ? "provider_outcome_unknown" : undefined,
  }));
  const accepted = results.filter((result) => result.ok).length;
  const status = accepted === results.length
    ? "provider_accepted"
    : accepted > 0
      ? "partial_delivery"
      : "recovery_required";

  let spoolKey: string | null = null;
  if (accepted !== results.length) {
    spoolKey = relaySpoolKey(deliveryId, receivedAt);
    try {
      await env.RAW_MAIL.put(spoolKey, rawBytes, {
        httpMetadata: { contentType: MIME_CONTENT_TYPE },
        customMetadata: { retentionClass: "relay-spool", deliveryId },
      });
    } catch {
      structuredError("inbound_recovery_spool_failed", { deliveryId });
    }
  }

  await recordDeliveryResults(persisted, results, status, spoolKey, env).catch(() => {
    structuredError("inbound_delivery_audit_failed", { deliveryId });
  });
}

async function acceptOperatorReply(
  message: ForwardableEmailMessage,
  token: string,
  env: Env,
): Promise<void> {
  const config = operatorDeliveryConfig(env);
  if (config.mode !== "inbox_relay" || config.processingMode !== "enabled" || !config.replyDomain) {
    message.setReject("maildesk reply relay is disabled");
    return;
  }
  if (message.rawSize > config.maxEncodedMessageBytes) {
    message.setReject("maildesk replies may not exceed 5 MiB including attachments");
    return;
  }

  let rawBytes: ArrayBuffer;
  let parsed: Awaited<ReturnType<typeof parseRelayEmail>>;
  try {
    rawBytes = await new Response(message.raw).arrayBuffer();
    parsed = await parseRelayEmail(rawBytes);
  } catch {
    message.setReject("maildesk could not safely parse this reply");
    return;
  }

  const operator = normalizeMailbox(parsed.from.address);
  if (!operator || normalizeMailbox(message.from) !== operator) {
    message.setReject("maildesk reply sender identity does not match the authenticated envelope");
    return;
  }
  if (!operatorAuthenticationPassed(message.headers, operator)) {
    message.setReject("maildesk reply sender did not pass aligned email authentication");
    return;
  }

  const tokenHash = await sha256Hex(token);
  const relay = await loadActiveRelay(tokenHash, env);
  if (!relay) {
    message.setReject("maildesk reply route is unknown, expired, or revoked");
    return;
  }

  const policy = await loadPolicy(env);
  if (!policy) {
    message.setReject("maildesk policy unavailable");
    return;
  }
  const authorization = authorizeReplyWithPolicy(policy, {
    envelopeTo: relay.route_address,
    operator,
    requestedIdentity: relay.reply_identity,
  });
  if (!authorization.ok || authorization.value.fromIdentity !== relay.reply_identity) {
    message.setReject("maildesk operator is not authorized for this reply identity");
    return;
  }

  const payload = outboundReplyPayload(parsed);
  try {
    assertWithinRelayLimit(payload, config);
  } catch {
    message.setReject("maildesk replies may not exceed 5 MiB including attachments");
    return;
  }
  if (!parsed.messageId) {
    message.setReject("maildesk replies require a valid Message-ID");
    return;
  }

  const attemptDigest = await sha256Hex(`${relay.id}\0${parsed.messageId.toLowerCase()}`);
  const attemptId = `relay-attempt:${attemptDigest}`;
  const claimed = await claimRelayAttempt(attemptId, relay, operator, parsed.messageId, env);
  if (!claimed) return;

  const receivedAt = new Date().toISOString();
  const rawR2Key = relaySpoolKey(attemptId, receivedAt);
  try {
    await env.RAW_MAIL.put(rawR2Key, rawBytes, {
      httpMetadata: { contentType: MIME_CONTENT_TYPE },
      customMetadata: { retentionClass: "relay-spool", relayId: relay.id },
    });
    await env.MAIL_JOBS.send({
      kind: "inbox_reply_received",
      attemptId,
      relayId: relay.id,
      operator,
      operatorMessageId: parsed.messageId,
      rawR2Key,
      receivedAt,
    });
    await env.DB.prepare(
      "UPDATE relay_attempts SET status = 'queued', raw_r2_key = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
    )
      .bind(rawR2Key, attemptId)
      .run();
    await recordAudit(
      env,
      `${attemptId}:inbox_reply_received`,
      relay.thread_id,
      operator,
      "inbox_reply_received",
      { attemptId, relayId: relay.id, operatorMessageId: parsed.messageId },
    );
  } catch {
    await env.RAW_MAIL.delete(rawR2Key).catch(() => undefined);
    await env.DB.prepare("DELETE FROM relay_attempts WHERE id = ?1 AND status = 'receiving'")
      .bind(attemptId)
      .run()
      .catch(() => undefined);
    message.setReject("maildesk could not durably queue this reply");
  }
}

async function acceptWebDesk(
  message: ForwardableEmailMessage,
  route: RouteDecision,
  env: Env,
): Promise<void> {
  const messageId = message.headers.get("message-id") ?? crypto.randomUUID();
  const deliveryId = crypto.randomUUID();
  const rawR2Key = rawMailKey(messageId, deliveryId);
  const forwardResults = await forwardToOperators(message, route);
  let rawBytes: ArrayBuffer;
  try {
    rawBytes = await new Response(message.raw).arrayBuffer();
    await env.RAW_MAIL.put(rawR2Key, rawBytes, {
      httpMetadata: { contentType: MIME_CONTENT_TYPE },
      customMetadata: { retentionClass: "archive" },
    });
    await persistWebDeskMetadata(message, messageId, deliveryId, rawR2Key, route, forwardResults, env);
  } catch {
    structuredError("maildesk metadata persist failed", { deliveryId });
    return;
  }

  try {
    await env.MAIL_JOBS.send({
      kind: "inbound_email_received",
      messageId,
      deliveryId,
      envelopeTo: message.to,
      envelopeFrom: message.from,
      routeKind: route.routeKind,
      forwardedTo: forwardResults.filter((result) => result.ok).map((result) => result.operator),
      forwardErrors: forwardResults
        .filter((result) => !result.ok)
        .map((result) => ({ recipient: result.operator, error: result.errorCode ?? "forward_failed" })),
      defaultReplyIdentity: route.defaultReplyIdentity,
      rawR2Key,
      rawSize: rawBytes.byteLength,
      receivedAt: new Date().toISOString(),
    });
  } catch {
    structuredError("web_desk_enqueue_failed", { deliveryId });
  }
}

async function persistInboxRelay(
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
  },
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
  const messageRowId = stableId("message", relay.deliveryId);
  const storageKind = route.routeKind === "personal_alias" ? "personal" : "role";

  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO domains (id, domain) VALUES (?1, ?2)").bind(domainId, recipient.domain),
    env.DB.prepare(
      "INSERT OR IGNORE INTO identities (id, domain_id, address, kind) VALUES (?1, ?2, ?3, ?4)",
    ).bind(identityId, domainId, route.defaultReplyIdentity, storageKind),
    env.DB.prepare(
      "INSERT INTO alias_routes (id, domain_id, local_part, kind, default_reply_identity_id, decision_kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, default_reply_identity_id = excluded.default_reply_identity_id, decision_kind = excluded.decision_kind",
    ).bind(routeId, domainId, route.localPart, storageKind, identityId, route.routeKind),
  ]);
  for (const operator of route.operators) {
    const operatorId = stableId("operator", operator);
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO operators (id, email) VALUES (?1, ?2)").bind(operatorId, operator),
      env.DB.prepare(
        "INSERT OR IGNORE INTO alias_route_operators (route_id, operator_id) VALUES (?1, ?2)",
      ).bind(routeId, operatorId),
    ]);
  }
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO threads (id, domain_id, route_id, external_sender, subject, status) VALUES (?1, ?2, ?3, ?4, ?5, 'open') ON CONFLICT(id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP",
    ).bind(threadId, domainId, routeId, externalSender, parsed.subject),
    env.DB.prepare(
      "INSERT INTO messages (id, thread_id, direction, envelope_from, envelope_to, header_message_id, in_reply_to, raw_r2_key, delivery_status, retention_class) VALUES (?1, ?2, 'inbound', ?3, ?4, ?5, ?6, NULL, 'received', 'none') ON CONFLICT(id) DO NOTHING",
    ).bind(messageRowId, threadId, normalizeMailbox(message.from), normalizeMailbox(message.to), relay.messageId, parsed.inReplyTo ?? null),
    env.DB.prepare(
      "INSERT INTO reply_relays (id, token_sha256, thread_id, route_id, external_recipient, reply_identity, original_message_id, references_json, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
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
    ),
    env.DB.prepare(
      "INSERT INTO route_health (route_id, route_address, decision_kind, desired_provider, operator_count, reply_identity, inbound_status, reply_status, last_inbound_at, updated_at) VALUES (?1, ?2, ?3, 'cloudflare_email_routing', ?4, ?5, 'local_policy_valid', 'declared', ?6, CURRENT_TIMESTAMP) ON CONFLICT(route_id) DO UPDATE SET route_address = excluded.route_address, decision_kind = excluded.decision_kind, operator_count = excluded.operator_count, reply_identity = excluded.reply_identity, last_inbound_at = excluded.last_inbound_at, updated_at = CURRENT_TIMESTAMP",
    ).bind(routeId, `${route.localPart}@${recipient.domain}`, route.routeKind, route.operators.length, route.defaultReplyIdentity, relay.receivedAt),
  ]);
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
  return { deliveryId: relay.deliveryId, relayId: relay.relayId, routeId, threadId };
}

async function recordDeliveryResults(
  inbound: PersistedInbound,
  results: OperatorDeliveryResult[],
  status: "provider_accepted" | "partial_delivery" | "recovery_required",
  spoolKey: string | null,
  env: Env,
): Promise<void> {
  const acceptedCount = results.filter((result) => result.ok).length;
  await env.DB.prepare(
    "UPDATE route_health SET inbound_status = CASE WHEN ?1 = 'provider_accepted' AND inbound_status = 'inbox_verified' THEN inbound_status ELSE ?1 END, last_inbound_provider_accepted_at = CASE WHEN ?2 > 0 THEN CURRENT_TIMESTAMP ELSE last_inbound_provider_accepted_at END, last_error_code = ?3, updated_at = CURRENT_TIMESTAMP WHERE route_id = ?4",
  )
    .bind(status, acceptedCount, status === "provider_accepted" ? null : status, inbound.routeId)
    .run();
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
      providerMessageIds: results.flatMap((result) => result.providerMessageId ? [result.providerMessageId] : []),
      recoverySpool: Boolean(spoolKey),
    },
  );
}

async function persistSinkRoute(
  message: ForwardableEmailMessage,
  route: RouteDecision,
  env: Env,
): Promise<void> {
  const recipient = parseMailbox(message.to);
  if (!recipient) return;
  const domainId = stableId("domain", recipient.domain);
  const identityId = stableId("identity", route.defaultReplyIdentity);
  const routeId = stableId("route", recipient.domain, route.localPart);
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO domains (id, domain) VALUES (?1, ?2)").bind(domainId, recipient.domain),
    env.DB.prepare(
      "INSERT OR IGNORE INTO identities (id, domain_id, address, kind) VALUES (?1, ?2, ?3, 'role')",
    ).bind(identityId, domainId, route.defaultReplyIdentity),
    env.DB.prepare(
      "INSERT INTO alias_routes (id, domain_id, local_part, kind, default_reply_identity_id, decision_kind) VALUES (?1, ?2, ?3, 'role', ?4, 'sink') ON CONFLICT(id) DO UPDATE SET decision_kind = 'sink'",
    ).bind(routeId, domainId, route.localPart, identityId),
    env.DB.prepare(
      "INSERT INTO route_health (route_id, route_address, decision_kind, desired_provider, operator_count, reply_identity, inbound_status, reply_status, last_inbound_at, updated_at) VALUES (?1, ?2, 'sink', 'cloudflare_email_routing', 0, ?3, 'intentionally_excluded', 'intentionally_excluded', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(route_id) DO UPDATE SET inbound_status = 'intentionally_excluded', reply_status = 'intentionally_excluded', last_inbound_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP",
    ).bind(routeId, `${route.localPart}@${recipient.domain}`, route.defaultReplyIdentity),
  ]);
}

async function loadActiveRelay(tokenHash: string, env: Env): Promise<ReplyRelayRow | null> {
  const relay = await env.DB.prepare(
    "SELECT rr.id, rr.thread_id, rr.route_id, rr.external_recipient, rr.reply_identity, rr.original_message_id, rr.references_json, rr.expires_at, rr.revoked_at, lower(ar.local_part || '@' || d.domain) AS route_address FROM reply_relays rr JOIN alias_routes ar ON ar.id = rr.route_id JOIN domains d ON d.id = ar.domain_id JOIN runtime_state rs ON rs.singleton = 1 AND rs.active_policy_sha256 = ar.policy_sha256 WHERE rr.token_sha256 = ?1 AND ar.enabled = 1 LIMIT 1",
  )
    .bind(tokenHash)
    .first<ReplyRelayRow>();
  if (!relay || !relayRecordIsActive(relay.expires_at, relay.revoked_at)) return null;
  return relay;
}

async function claimRelayAttempt(
  attemptId: string,
  relay: ReplyRelayRow,
  operator: string,
  operatorMessageId: string,
  env: Env,
): Promise<boolean> {
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO relay_attempts (id, relay_id, operator, operator_message_id, status) VALUES (?1, ?2, ?3, ?4, 'receiving')",
  )
    .bind(attemptId, relay.id, operator, operatorMessageId)
    .run();
  return Number(result.meta.changes ?? 0) > 0;
}

async function routeMessage(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<RouteDecision | Error> {
  const policy = await loadPolicy(env);
  if (!policy) return new Error("maildesk policy unavailable");
  const result = routeInbound(policy, {
    envelopeTo: message.to,
    headerFrom: message.from,
    messageId: message.headers.get("message-id") ?? undefined,
    subject: message.headers.get("subject") ?? undefined,
  });
  return result.ok ? result.value : new Error(result.error.message);
}

async function loadPolicy(env: Env): Promise<RouterPolicy | null> {
  return (await loadActivePolicy(env))?.policy ?? null;
}

async function resolveThreadId(
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

async function persistWebDeskMetadata(
  message: ForwardableEmailMessage,
  messageId: string,
  deliveryId: string,
  rawR2Key: string,
  route: RouteDecision,
  results: OperatorDeliveryResult[],
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
}

async function forwardToOperators(
  message: ForwardableEmailMessage,
  route: RouteDecision,
): Promise<OperatorDeliveryResult[]> {
  if (route.routeKind === "sink") return [];
  const settled = await Promise.allSettled(
    route.operators.map((operator) => message.forward(operator, new Headers({
      "X-Maildesk-Original-To": message.to,
      "X-Maildesk-Route-Kind": route.routeKind,
      "X-Maildesk-Reply-Identity": route.defaultReplyIdentity,
    }))),
  );
  return settled.map((result, index) => ({
    operator: route.operators[index] ?? "unknown",
    ok: result.status === "fulfilled",
    providerMessageId: result.status === "fulfilled" ? result.value?.messageId : undefined,
    errorCode: result.status === "rejected" ? "forward_failed" : undefined,
  }));
}

async function recordAudit(
  env: Env,
  dedupeKey: string,
  threadId: string | null,
  actor: string,
  action: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_events (id, dedupe_key, thread_id, actor, action, detail_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING",
  ).bind(crypto.randomUUID(), dedupeKey, threadId, actor, action, JSON.stringify(detail)).run();
}

function referencedMessageIds(inReplyTo: string | null, references: string | null): string[] {
  return [...new Set([...extractMessageIds(inReplyTo), ...extractMessageIds(references).reverse()])];
}

function extractMessageIds(value: string | null): string[] {
  if (!value || value.length > 8_000) return [];
  return value.match(/<[^<>\s]+>/g) ?? [];
}

function parseMailbox(address: string): ParsedMailbox | null {
  const normalized = normalizeMailbox(address);
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex <= 0) return null;
  return { localPart: normalized.slice(0, atIndex), domain: normalized.slice(atIndex + 1) };
}

function stableId(prefix: string, ...parts: string[]): string {
  return [prefix, ...parts.map((value) => encodeURIComponent(value.trim().toLowerCase()))].join(":");
}

async function collisionResistantId(prefix: string, ...parts: string[]): Promise<string> {
  return `${prefix}:${await sha256Hex(new TextEncoder().encode(parts.join("\0")))}`;
}

function structuredError(event: string, detail: Record<string, string>): void {
  console.error(JSON.stringify({ event, ...detail }));
}

type Env = MaildeskEnv;

interface ParsedMailbox {
  localPart: string;
  domain: string;
}

interface PersistedInbound {
  deliveryId: string;
  relayId: string;
  routeId: string;
  threadId: string;
}

interface OperatorDeliveryResult {
  operator: string;
  ok: boolean;
  providerMessageId?: string;
  errorCode?: string;
}

interface ReplyRelayRow {
  id: string;
  thread_id: string;
  route_id: string;
  route_address: string;
  external_recipient: string;
  reply_identity: string;
  original_message_id: string | null;
  references_json: string;
  expires_at: string;
  revoked_at: string | null;
}
