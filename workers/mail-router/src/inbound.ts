import {
operatorDeliveryConfig,
rawMailKey,
relaySpoolKey
} from "../../shared/contracts";
import {
assertWithinRelayLimit,
buildOperatorDelivery,
generateRelayToken,
normalizeMailbox,
parseRelayEmail,publicIdentityProfileSha256,relayAddress,
relayTokenFromRecipient,
sha256Hex,
tokenExpiresAt
} from "../../shared/inbox-relay";
import { recordAudit } from "../../shared/ingress-audit";
import { loadOrdinaryRouteAuthorization } from "../../shared/ordinary-reply";
import { loadActivePolicy } from "../../shared/policy-store";
import {
RouteDecision,
routeInbound,
} from "../../shared/router";
import { handoffSelectedWork,selectDestination,type SelectedDestination as SelectedWebDeskDisposition } from "../../shared/work-destination";
import { cloudflareEmailErrorCode,deleteOperatorDeliverySpools,operatorDeliverySpoolKey,persistOperatorDeliverySpools,recoverExistingInbound } from "./inbound-recovery";
import { Env,InboundDeliveryRow,OperatorDeliveryResult,OperatorDeliverySpool,PersistedInbound,PolicyBoundRoute,claimInboundRecipient,discardSupersededUnsentInbound,inboundDeliveryResultJob,loadInboundDelivery,loadInboundRecipient,persistInboxRelay,persistSinkRoute,persistWebDeskMetadata,projectInboundRecipientResult,recordDeliveryResults,stableId,structuredError } from "./inbound-repository";
import { acceptOperatorReply } from "./operator-reply";

export const MIME_CONTENT_TYPE = "message/rfc822";

export async function acceptEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
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
    if (boundRoute.route.disposition) {
      const selected = selectDestination(boundRoute.route);
      if (!selected) {
        message.setReject("maildesk route has no available destination");
        return;
      }
      if (selected.target.kind === "work_queue") {
        await acceptInboxWorkQueue(
          message,
          boundRoute.route,
          boundRoute.policySha256,
          selected,
          env,
        );
        return;
      }
      await acceptInboxRelay(message, {
        ...boundRoute,
        route: { ...boundRoute.route, operators: selected.target.recipients },
      }, env);
      return;
    }
    await acceptInboxRelay(message, boundRoute, env);
    return;
  }

  await acceptWebDesk(message, boundRoute.route, env);
}

export async function acceptInboxWorkQueue(
  message: ForwardableEmailMessage,
  route: RouteDecision,
  policySha256: string,
  selected: SelectedWebDeskDisposition,
  env: Env,
): Promise<void> {
  if (selected.target.kind !== "work_queue") {
    message.setReject("maildesk work queue disposition is invalid");
    return;
  }
  if (!env.RELAY_SPOOL || !selected.adapter) {
    message.setReject("maildesk work queue storage is not configured");
    return;
  }
  if (message.rawSize > operatorDeliveryConfig(env).maxEncodedMessageBytes) {
    message.setReject("maildesk relay accepts messages up to 5 MiB including attachments");
    return;
  }
  let rawBytes: ArrayBuffer;
  try {
    rawBytes = await new Response(message.raw).arrayBuffer();
  } catch {
    message.setReject("maildesk could not read the work item");
    return;
  }
  const fingerprint = await sha256Hex([
    normalizeMailbox(message.from),
    normalizeMailbox(message.to),
    await sha256Hex(rawBytes),
  ].join("\0"));
  const deliveryId = `work-item:${fingerprint}`;
  const receivedAt = new Date().toISOString();
  const rawR2Key = relaySpoolKey(deliveryId, receivedAt);
  const routeId = stableId("route", route.domain, route.localPart);
  try {
    await env.RELAY_SPOOL.put(rawR2Key, rawBytes, {
      httpMetadata: { contentType: MIME_CONTENT_TYPE },
      customMetadata: { retentionClass: "relay-spool", deliveryId },
    });
    const projected = await env.DB.prepare(
      "UPDATE route_health SET last_inbound_at = ?1, updated_at = CURRENT_TIMESTAMP WHERE route_id = ?2 AND policy_sha256 = ?3 AND EXISTS (SELECT 1 FROM runtime_state rs WHERE rs.singleton = 1 AND rs.active_policy_sha256 = ?3)",
    ).bind(receivedAt, routeId, policySha256).run();
    if (Number(projected.meta?.changes ?? 0) === 0) {
      throw new Error("active work queue route is unavailable");
    }
    await recordAudit(
      env,
      `${deliveryId}:route_disposition_selected`,
      null,
      "system",
      "route_disposition_selected",
      {
        routeRef: selected.routeRef,
        destinationRef: selected.destinationRef,
        accountableRef: selected.accountableRef,
        targetKind: selected.target.kind,
        fallbackUsed: selected.fallbackUsed,
        policySha256,
      },
    );
  } catch {
    await env.RELAY_SPOOL.delete(rawR2Key).catch(() => undefined);
    message.setReject("maildesk could not durably admit the work item");
    return;
  }
  const outcome = await handoffSelectedWork(selected, { deliveryId, rawR2Key });
  await recordAudit(env, `${deliveryId}:work_destination_result`, null, "system", "work_destination_result", {
    deliveryId, routeRef: selected.routeRef, destinationRef: selected.destinationRef,
    outcome, nextAction: outcome === "recovery_required" ? "reconcile_destination_receipt" : "none",
  });

}

export async function acceptInboxRelay(
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
    const discarded = await discardSupersededUnsentInbound(existingInbound, env).catch((): null => null);
    if (discarded) {
      await deleteOperatorDeliverySpools(discarded, env);
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

  const routeId = stableId("route", route.domain, route.localPart);
  const quarantined = await env.DB.prepare("SELECT id FROM active_route_reply_quarantines WHERE route_id = ?1 LIMIT 1")
    .bind(routeId).first<{ id: string }>();
  const operatorSetSha256 = await sha256Hex(JSON.stringify(route.operators));
  const deliveries = await Promise.all(route.operators.map(async (operator, index) => {
    const binding = route.operatorReplyIdentities?.[operator];
    const profile = binding ? binding.identityProfile : route.identityProfile;
    const activation = profile && await loadOrdinaryRouteAuthorization({
      routeId, policySha256, identityProfileSha256: await publicIdentityProfileSha256(profile), operatorSetSha256,
    }, env);
    const replyAvailability = quarantined ? "quarantined" : activation ? "ordinary_activated" : "canary_only";
    return buildOperatorDelivery(parsed, {
      operator,
      receivedAddress: normalizeMailbox(message.to),
      replyIdentity: binding ? binding.publicAddress : route.defaultReplyIdentity,
      identityProfile: profile,
      replyProcessingMode: config.replyProcessingMode,
      replyAvailability,
      routeKind: route.routeKind,
      operatorCount: route.operators.length,
      relayAddress: replyTo,
      deliveryMessageId: deliveryMessageIds[index]!,
    });
  }));
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
  let operatorDeliverySpools: OperatorDeliverySpool[];
  try {
    operatorDeliverySpools = await persistOperatorDeliverySpools(
      candidateSpoolKey,
      deliveries,
      operatorRefs,
      deliveryId,
      env,
    );
  } catch {
    await env.RELAY_SPOOL.delete(candidateSpoolKey).catch(() => undefined);
    message.setReject("maildesk could not create durable operator-delivery recovery payloads");
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
        deliveryPayloadKeys: operatorDeliverySpools.map((spool) => spool.key),
        deliveryPayloadSha256s: operatorDeliverySpools.map((spool) => spool.sha256),
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
      await deleteOperatorDeliverySpools(operatorDeliverySpools.map((spool) => spool.key), env);
      await env.RELAY_SPOOL.delete(candidateSpoolKey).catch(() => undefined);
      await recoverExistingInbound(concurrent, env);
      return;
    }
    await deleteOperatorDeliverySpools(operatorDeliverySpools.map((spool) => spool.key), env);
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
      reply_identity: route.defaultReplyIdentity,
      token_sha256: tokenHash,
      received_at: receivedAt,
      status: "pending",
    };
    const discarded = currentPolicy
      ? await discardSupersededUnsentInbound(inbound, env).catch((): null => null)
      : null;
    if (discarded) {
      await deleteOperatorDeliverySpools(discarded, env);
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
    const deliveryPayloadR2Key = operatorDeliverySpools[index]!.key;
    let claimed = false;
    try {
      claimed = await claimInboundRecipient(
        deliveryId,
        operatorRef,
        policySha256,
        candidateSpoolKey,
        env,
      );
    } catch {
      // No provider call occurred. The durable delivery remains visible for
      // recovery rather than bypassing the recipient claim boundary.
    }
    if (!claimed) {
      results.push({ operator, deliveryPayloadR2Key, ok: false, errorCode: "recipient_claim_failed" });
      continue;
    }

    try {
      const providerResult = await env.EMAIL.send(delivery);
      const result = {
        operator,
        deliveryPayloadR2Key,
        ok: true,
        providerMessageId: providerResult?.messageId,
      } satisfies OperatorDeliveryResult;
      results.push(result);
      await projectInboundRecipientResult(deliveryId, operatorRef, result, env).catch(() => {
        // The `sending` state is intentionally ambiguous and is never
        // auto-replayed. Later reconciliation may attach provider evidence.
        structuredError("inbound_recipient_projection_failed", { deliveryId });
      });
      const projected = await loadInboundRecipient(deliveryId, operatorRef, env).catch(() => null);
      if (projected?.status === "provider_accepted") {
        await env.RELAY_SPOOL.delete(operatorDeliverySpoolKey(candidateSpoolKey, operatorRef)).catch(() => undefined);
      }
    } catch (error) {
      const result = {
        operator,
        deliveryPayloadR2Key,
        ok: false,
        errorCode: cloudflareEmailErrorCode(error),
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

export async function acceptWebDesk(
  message: ForwardableEmailMessage,
  route: RouteDecision,
  env: Env,
  preselected?: SelectedWebDeskDisposition,
): Promise<void> {
  if (!env.RAW_MAIL) {
    message.setReject("maildesk raw archive storage is not configured");
    return;
  }
  const selected = preselected ?? selectDestination(route);
  if (!selected) {
    message.setReject("maildesk route has no available destination");
    return;
  }
  const effectiveRoute: RouteDecision = selected.target.kind === "mailbox"
    ? { ...route, operators: selected.target.recipients }
    : { ...route, operators: [] };
  const messageId = message.headers.get("message-id") ?? crypto.randomUUID();
  const deliveryId = crypto.randomUUID();
  const rawR2Key = rawMailKey(messageId, deliveryId);
  const forwardResults = selected.target.kind === "mailbox"
    ? await forwardToOperators(message, effectiveRoute)
    : [];
  let rawBytes: ArrayBuffer;
  try {
    rawBytes = await new Response(message.raw).arrayBuffer();
    await env.RAW_MAIL.put(rawR2Key, rawBytes, {
      httpMetadata: { contentType: MIME_CONTENT_TYPE },
      customMetadata: { retentionClass: "archive" },
    });
    await persistWebDeskMetadata(
      message,
      messageId,
      deliveryId,
      rawR2Key,
      effectiveRoute,
      forwardResults,
      selected,
      env,
    );
  } catch {
    structuredError("maildesk metadata persist failed", { deliveryId });
    return;
  }

  try {
    if (selected.target.kind === "work_queue") {
      const outcome = await handoffSelectedWork(selected, { deliveryId, rawR2Key });
      await recordAudit(env, `${deliveryId}:work_destination_result`, null, "system", "work_destination_result", {
        deliveryId, routeRef: selected.routeRef, destinationRef: selected.destinationRef, outcome,
        nextAction: outcome === "recovery_required" ? "reconcile_destination_receipt" : "none",
      });
    } else if (env.MAIL_JOBS) await env.MAIL_JOBS.send({
      kind: "inbound_email_received",
      messageId,
      deliveryId,
      envelopeTo: message.to,
      envelopeFrom: message.from,
      routeKind: effectiveRoute.routeKind,
      forwardedTo: forwardResults.filter((result) => result.ok).map((result) => result.operator),
      forwardErrors: forwardResults
        .filter((result) => !result.ok)
        .map((result) => ({ recipient: result.operator, error: result.errorCode ?? "forward_failed" })),
      defaultReplyIdentity: effectiveRoute.defaultReplyIdentity,
      rawR2Key,
      rawSize: rawBytes.byteLength,
      receivedAt: new Date().toISOString(),
    });
  } catch {
    structuredError("web_desk_enqueue_failed", { deliveryId });
  }
}

export async function routeMessage(
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
  if (!result.ok) return new Error(result.error.message);
  const projected = activePolicy.projection.routes.find((route) =>
    route.domain === result.value.domain && route.localPart === result.value.localPart);
  return projected ? { route: projected, policySha256: activePolicy.sha256 }
    : new Error("maildesk selected route is absent from the validated projection");
}

export async function forwardToOperators(
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
