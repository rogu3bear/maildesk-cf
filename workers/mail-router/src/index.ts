import {
  InboundDeliveryResultJob,
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
  outboundReplyPayload,
  parseRelayEmail,
  relayAddress,
  relayRecordIsActive,
  relayTokenFromRecipient,
  sha256Hex,
  tokenExpiresAt,
} from "../../shared/inbox-relay";
import { verifyOperatorDkim } from "../../shared/dkim";
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
  const token = config.replyDomain
    ? relayTokenFromRecipient(message.to, config.replyDomain)
    : null;
  const selectedMode = token ? config.replyProcessingMode : config.inboundProcessingMode;
  if (config.mode === "inbox_relay" && selectedMode !== "enabled") {
    message.setReject(
      selectedMode === "invalid"
        ? "maildesk relay processing mode is invalid"
        : token
          ? "maildesk reply relay is disabled"
          : "maildesk inbound relay is disabled",
    );
    return;
  }
  if (token) {
    await acceptOperatorReply(message, token, env);
    return;
  }

  const boundRoute = await routeMessage(message, env);
  if (boundRoute instanceof Error) {
    message.setReject(boundRoute.message);
    return;
  }

  if (config.mode === "inbox_relay") {
    await acceptInboxRelay(message, boundRoute, env);
    return;
  }

  await acceptWebDesk(message, boundRoute.route, env);
}

async function acceptInboxRelay(
  message: ForwardableEmailMessage,
  boundRoute: PolicyBoundRoute,
  env: Env,
): Promise<void> {
  const { route, policySha256 } = boundRoute;
  const config = operatorDeliveryConfig(env);
  if (!config.replyDomain || !env.EMAIL) {
    message.setReject("maildesk inbox relay is not configured");
    return;
  }
  if (!env.RELAY_SPOOL || !env.POLICY_STORE) {
    message.setReject("maildesk inbox relay storage is not configured");
    return;
  }
  if (route.routeKind === "sink") {
    try {
      await persistSinkRoute(message, route, policySha256, env);
    } catch {
      message.setReject("maildesk policy changed before the sink route was recorded");
    }
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

  const rawSha256 = await sha256Hex(rawBytes);
  const fingerprintSha256 = await sha256Hex([
    normalizeMailbox(message.from),
    normalizeMailbox(message.to),
    rawSha256,
  ].join("\0"));
  let existingInbound: InboundDeliveryRow | null;
  try {
    existingInbound = await loadInboundDelivery(fingerprintSha256, env);
  } catch {
    message.setReject("maildesk could not verify inbound delivery idempotency");
    return;
  }
  if (existingInbound) {
    const discarded = await discardSupersededUnsentInbound(existingInbound, env).catch(() => false);
    if (discarded) {
      if (existingInbound.raw_r2_key) {
        await env.RELAY_SPOOL.delete(existingInbound.raw_r2_key).catch(() => undefined);
      }
      existingInbound = null;
    } else {
      await recoverExistingInbound(existingInbound, env);
      return;
    }
  }

  const deliveryId = `inbound:${fingerprintSha256}`;
  const messageId = message.headers.get("message-id") ?? parsed.messageId ?? `<${deliveryId}@maildesk.invalid>`;
  const token = generateRelayToken();
  const tokenHash = await sha256Hex(token);
  const replyTo = relayAddress(token, config.replyDomain);
  const relayId = `relay:${fingerprintSha256}`;
  const receivedAt = new Date().toISOString();
  const operatorRefs = await Promise.all(route.operators.map((operator) => sha256Hex(operator)));
  const deliveryMessageIds = operatorRefs.map((operatorRef) =>
    `<inbound.${fingerprintSha256}.${operatorRef.slice(0, 16)}@${config.replyDomain}>`
  );

  const deliveries = route.operators.map((operator, index) =>
    buildOperatorDelivery(parsed, {
      operator,
      receivedAddress: normalizeMailbox(message.to),
      replyIdentity: route.defaultReplyIdentity,
      routeKind: route.routeKind,
      operatorCount: route.operators.length,
      relayAddress: replyTo,
      deliveryMessageId: deliveryMessageIds[index]!,
    }),
  );
  try {
    for (const delivery of deliveries) assertWithinRelayLimit(delivery, config);
  } catch {
    message.setReject("maildesk relay accepts messages up to 5 MiB including attachments");
    return;
  }

  // A random token-hash suffix isolates each pre-send attempt. If an entirely
  // unsent claim is retired after policy supersession, delayed cleanup for the
  // old claim cannot delete the replacement attempt's spool object.
  const candidateSpoolKey = relaySpoolKey(`${deliveryId}.${tokenHash.slice(0, 16)}`, receivedAt);
  try {
    await env.RELAY_SPOOL.put(candidateSpoolKey, rawBytes, {
      httpMetadata: { contentType: MIME_CONTENT_TYPE },
      customMetadata: { retentionClass: "relay-spool", deliveryId },
    });
  } catch {
    message.setReject("maildesk could not create a durable operator-delivery spool");
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
        fingerprintSha256,
        spoolKey: candidateSpoolKey,
        operatorRefs,
        deliveryMessageIds,
      },
      policySha256,
      env,
    );
  } catch {
    structuredError("inbound_persistence_failed", { deliveryId });
    const concurrent = await loadInboundDelivery(fingerprintSha256, env).catch(() => null);
    if (concurrent) {
      // A simultaneous provider delivery may have won the unique fingerprint
      // claim after our initial read. Delete only this invocation's unique
      // spool below; the winning claim points at a different immutable key.
      await env.RELAY_SPOOL.delete(candidateSpoolKey).catch(() => undefined);
      await recoverExistingInbound(concurrent, env);
      return;
    }
    await env.RELAY_SPOOL.delete(candidateSpoolKey).catch(() => undefined);
    message.setReject("maildesk could not create a durable route for this message");
    return;
  }

  const currentPolicy = await loadActivePolicy(env);
  if (!currentPolicy || currentPolicy.sha256 !== policySha256) {
    const inbound: InboundDeliveryRow = {
      id: deliveryId,
      relay_id: relayId,
      thread_id: persisted.threadId,
      route_id: persisted.routeId,
      policy_sha256: policySha256,
      raw_r2_key: candidateSpoolKey,
      received_at: receivedAt,
      status: "pending",
    };
    const discarded = currentPolicy
      ? await discardSupersededUnsentInbound(inbound, env).catch(() => false)
      : false;
    if (discarded) {
      await env.RELAY_SPOOL.delete(candidateSpoolKey).catch(() => undefined);
      message.setReject("maildesk policy changed before operator delivery");
    } else {
      // If any recipient already crossed into `sending`, provider outcome is
      // ambiguous. Preserve the claim and spool; never invite SMTP replay.
      await recoverExistingInbound(inbound, env);
    }
    return;
  }

  const results: OperatorDeliveryResult[] = [];
  for (const [index, delivery] of deliveries.entries()) {
    const operator = route.operators[index] ?? "unknown";
    const operatorRef = operatorRefs[index]!;
    let claimed = false;
    try {
      claimed = await claimInboundRecipient(deliveryId, operatorRef, policySha256, env);
    } catch {
      // No provider call occurred. The durable delivery remains visible for
      // recovery rather than bypassing the recipient claim boundary.
    }
    if (!claimed) {
      results.push({ operator, ok: false, errorCode: "recipient_claim_failed" });
      continue;
    }

    try {
      const providerResult = await env.EMAIL.send(delivery);
      const result = {
        operator,
        ok: true,
        providerMessageId: providerResult?.messageId,
      } satisfies OperatorDeliveryResult;
      results.push(result);
      await projectInboundRecipientResult(deliveryId, operatorRef, result, env).catch(() => {
        // The `sending` state is intentionally ambiguous and is never
        // auto-replayed. Later reconciliation may attach provider evidence.
        structuredError("inbound_recipient_projection_failed", { deliveryId });
      });
    } catch {
      const result = {
        operator,
        ok: false,
        errorCode: "provider_outcome_unknown",
      } satisfies OperatorDeliveryResult;
      results.push(result);
      await projectInboundRecipientResult(deliveryId, operatorRef, result, env).catch(() => {
        structuredError("inbound_recipient_projection_failed", { deliveryId });
      });
    }
  }
  const accepted = results.filter((result) => result.ok).length;
  let status: "provider_accepted" | "partial_delivery" | "recovery_required" | "failed" = accepted === results.length
    ? "provider_accepted"
    : accepted > 0
      ? "partial_delivery"
      : "recovery_required";

  try {
    await recordDeliveryResults(persisted, results, status, candidateSpoolKey, env);
    if (status === "provider_accepted") {
      try {
        await env.RELAY_SPOOL.delete(candidateSpoolKey);
        await env.DB.prepare(
          "UPDATE inbound_deliveries SET raw_r2_key = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?1 AND policy_sha256 = ?2",
        ).bind(deliveryId, policySha256).run();
      } catch {
        structuredError("inbound_terminal_spool_cleanup_failed", { deliveryId });
      }
    }
  } catch {
    structuredError("inbound_delivery_audit_failed", { deliveryId });
    const recoveryJob = await inboundDeliveryResultJob(
      persisted,
      results,
      status,
      candidateSpoolKey,
      receivedAt,
    );
    await env.MAIL_JOBS.send(recoveryJob).catch(() => {
      // The pre-send spool remains as the bounded recovery artifact even when
      // both D1 projection and Queue submission are unavailable.
      structuredError("inbound_delivery_recovery_enqueue_failed", { deliveryId });
    });
  }
}

async function acceptOperatorReply(
  message: ForwardableEmailMessage,
  token: string,
  env: Env,
): Promise<void> {
  const config = operatorDeliveryConfig(env);
  if (config.mode !== "inbox_relay" || config.replyProcessingMode !== "enabled" || !config.replyDomain) {
    message.setReject("maildesk reply relay is disabled");
    return;
  }
  if (!env.RELAY_SPOOL || !env.POLICY_STORE) {
    message.setReject("maildesk reply relay storage is not configured");
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
  const authentication = await verifyOperatorDkim(rawBytes, operator);
  if (authentication.status !== "verified") {
    structuredError("reply_authentication_rejected", {
      status: authentication.status,
      errorCode: authentication.boundedErrorCode ?? "dkim_rejected",
    });
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

  let payload: ReturnType<typeof outboundReplyPayload>;
  try {
    payload = outboundReplyPayload(parsed);
  } catch {
    message.setReject("maildesk replies require a plaintext message alternative");
    return;
  }
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
  const receivedAt = new Date().toISOString();
  const rawR2Key = relaySpoolKey(attemptId, receivedAt);

  const existingAttempt = await loadRelayAttempt(attemptId, env);
  if (existingAttempt && existingAttempt.status !== "receiving") return;

  try {
    await env.RELAY_SPOOL.put(rawR2Key, rawBytes, {
      httpMetadata: { contentType: MIME_CONTENT_TYPE },
      customMetadata: { retentionClass: "relay-spool", relayId: relay.id },
    });
  } catch {
    message.setReject("maildesk could not durably spool this reply");
    return;
  }

  const claimed = existingAttempt
    ? existingAttempt
    : await claimRelayAttempt(attemptId, relay, operator, parsed.messageId, rawR2Key, env);
  if (!claimed) {
    message.setReject("maildesk could not durably claim this reply");
    return;
  }
  if (claimed.status !== "receiving") return;

  try {
    await env.MAIL_JOBS.send({
      kind: "inbox_reply_received",
      attemptId,
      relayId: relay.id,
      operator,
      operatorMessageId: parsed.messageId,
      rawR2Key,
      receivedAt,
    });
  } catch {
    // Preserve both the receiving claim and deterministic spool. A provider
    // redelivery can safely resume the Queue send for this same attempt ID.
    message.setReject("maildesk could not durably queue this reply");
    return;
  }

  try {
    await env.DB.prepare(
      "UPDATE relay_attempts SET status = 'queued', raw_r2_key = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
    )
      .bind(rawR2Key, attemptId)
      .run();
    await recordAudit(
      env,
      `${attemptId}:inbox_reply_received`,
      relay.thread_id,
      `operator:${await sha256Hex(operator)}`,
      "inbox_reply_received",
      {
        attemptId,
        relayId: relay.id,
        operatorMessageId: parsed.messageId,
        authentication: {
          status: authentication.status,
          method: authentication.method,
          signingDomain: authentication.signingDomain,
          selectorHash: authentication.selectorHash,
          alignedOperatorId: authentication.alignedOperatorId,
          verifiedAt: authentication.verifiedAt,
        },
      },
    );
  } catch {
    // Queue acceptance is already durable. Never delete its spool or claim.
    // A duplicate Queue delivery is idempotent at the outbound audit boundary,
    // and a provider redelivery may safely enqueue this attempt again.
    structuredError("reply_queue_state_update_failed", { attemptId });
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
    fingerprintSha256: string;
    spoolKey: string;
    operatorRefs: string[];
    deliveryMessageIds: string[];
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
      "INSERT INTO inbound_recipient_deliveries (delivery_id, operator_ref, delivery_message_id, status) VALUES (?1, ?2, ?3, 'pending')",
    ).bind(relay.deliveryId, operatorRef, relay.deliveryMessageIds[index])),
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

async function recordDeliveryResults(
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
      status === "provider_accepted" ? null : status,
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

async function loadInboundDelivery(
  fingerprintSha256: string,
  env: Env,
): Promise<InboundDeliveryRow | null> {
  return env.DB.prepare(
    "SELECT id, relay_id, thread_id, route_id, policy_sha256, raw_r2_key, received_at, status FROM inbound_deliveries WHERE fingerprint_sha256 = ?1 LIMIT 1",
  ).bind(fingerprintSha256).first<InboundDeliveryRow>();
}

async function discardSupersededUnsentInbound(
  inbound: InboundDeliveryRow,
  env: Env,
): Promise<boolean> {
  const activePolicy = await loadActivePolicy(env);
  if (!activePolicy || activePolicy.sha256 === inbound.policy_sha256) return false;

  // Deleting the relay cascades through inbound_deliveries and its recipient
  // rows. One conditional statement therefore retires the entire token
  // generation or changes nothing; no partial cleanup result can poison the
  // fingerprint while leaving its relay behind.
  const discarded = await env.DB.prepare(
    "DELETE FROM reply_relays WHERE id = ?1 AND policy_sha256 = ?2 AND EXISTS (SELECT 1 FROM runtime_state rs WHERE rs.singleton = 1 AND rs.active_policy_sha256 != ?2) AND EXISTS (SELECT 1 FROM inbound_deliveries d WHERE d.relay_id = reply_relays.id AND d.id = ?3 AND d.policy_sha256 = ?2 AND NOT EXISTS (SELECT 1 FROM inbound_recipient_deliveries rd WHERE rd.delivery_id = d.id AND rd.status != 'pending'))",
  ).bind(inbound.relay_id, inbound.policy_sha256, inbound.id).run();
  return Number(discarded.meta?.changes ?? 0) === 1;
}

async function recoverExistingInbound(inbound: InboundDeliveryRow, env: Env): Promise<void> {
  const recipients = await env.DB.prepare(
    "SELECT operator_ref, status, provider_message_id, error_code FROM inbound_recipient_deliveries WHERE delivery_id = ?1 ORDER BY operator_ref",
  ).bind(inbound.id).all<InboundRecipientDeliveryRow>();
  const rows = recipients.results ?? [];
  const results: InboundDeliveryResultJob["results"] = rows.map((row) => ({
    operatorRef: row.operator_ref,
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

async function claimInboundRecipient(
  deliveryId: string,
  operatorRef: string,
  policySha256: string,
  env: Env,
): Promise<boolean> {
  const claimed = await env.DB.prepare(
    "UPDATE inbound_recipient_deliveries SET status = 'sending', updated_at = CURRENT_TIMESTAMP WHERE delivery_id = ?1 AND operator_ref = ?2 AND status = 'pending' AND EXISTS (SELECT 1 FROM inbound_deliveries d WHERE d.id = inbound_recipient_deliveries.delivery_id AND d.policy_sha256 = ?3)",
  ).bind(deliveryId, operatorRef, policySha256).run();
  return Number(claimed.meta?.changes ?? 0) === 1;
}

async function projectInboundRecipientResult(
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
  if (Number(projected.meta?.changes ?? 0) !== 1) {
    throw new Error("inbound recipient result has no sending claim");
  }
}

async function inboundDeliveryResultJob(
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
    results: await Promise.all(results.map(async (result) => ({
      operatorRef: await sha256Hex(result.operator),
      ok: result.ok,
      providerMessageId: result.providerMessageId,
      errorCode: result.errorCode,
    }))),
    relaySpoolKey,
    receivedAt,
  };
}

async function persistSinkRoute(
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
  rawR2Key: string,
  env: Env,
): Promise<RelayAttemptRow | null> {
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO relay_attempts (id, relay_id, operator, operator_message_id, raw_r2_key, status) VALUES (?1, ?2, ?3, ?4, ?5, 'receiving')",
  )
    .bind(attemptId, relay.id, operator, operatorMessageId, rawR2Key)
    .run();
  if (Number(result.meta.changes ?? 0) > 0) {
    return { status: "receiving", raw_r2_key: rawR2Key };
  }
  return loadRelayAttempt(attemptId, env);
}

async function loadRelayAttempt(attemptId: string, env: Env): Promise<RelayAttemptRow | null> {
  return env.DB.prepare(
    "SELECT status, raw_r2_key FROM relay_attempts WHERE id = ?1 LIMIT 1",
  )
    .bind(attemptId)
    .first<RelayAttemptRow>();
}

async function routeMessage(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<PolicyBoundRoute | Error> {
  const activePolicy = await loadActivePolicy(env);
  if (!activePolicy) return new Error("maildesk policy unavailable");
  const result = routeInbound(activePolicy.policy, {
    envelopeTo: message.to,
    headerFrom: message.from,
    messageId: message.headers.get("message-id") ?? undefined,
    subject: message.headers.get("subject") ?? undefined,
  });
  return result.ok
    ? { route: result.value, policySha256: activePolicy.sha256 }
    : new Error(result.error.message);
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
  policySha256: string;
}

interface InboundDeliveryRow {
  id: string;
  relay_id: string;
  thread_id: string;
  route_id: string;
  policy_sha256: string;
  raw_r2_key: string | null;
  received_at: string;
  status: "pending" | "sending" | "provider_accepted" | "partial_delivery" | "recovery_required" | "failed";
}

interface InboundRecipientDeliveryRow {
  operator_ref: string;
  status: "pending" | "sending" | "provider_accepted" | "recovery_required" | "failed";
  provider_message_id: string | null;
  error_code: string | null;
}

interface PolicyBoundRoute {
  route: RouteDecision;
  policySha256: string;
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

interface RelayAttemptRow {
  status: "receiving" | "queued" | "authorized" | "provider_accepted" | "failed" | "recovery_required";
  raw_r2_key: string | null;
}
