import { errorDetail, MaildeskEnv, rawMailKey } from "../../shared/contracts";
import { routeInbound, RouteDecision, RouterPolicy } from "../../shared/router";

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    const task = acceptInbound(message, env);
    ctx.waitUntil(task);
    await task;
  },
};

async function acceptInbound(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const messageId = message.headers.get("message-id") ?? crypto.randomUUID();
  const deliveryId = crypto.randomUUID();
  const rawR2Key = rawMailKey(messageId, deliveryId);
  const route = await routeMessage(message, env);

  if (route instanceof Error) {
    message.setReject(route.message);
    return;
  }

  const forwardResults = await forwardToOperators(message, route);

  try {
    const rawBytes = await new Response(message.raw).arrayBuffer();
    await env.RAW_MAIL.put(rawR2Key, rawBytes, {
      httpMetadata: {
        contentType: "message/rfc822",
      },
      customMetadata: {
        envelopeFrom: message.from,
        envelopeTo: message.to,
      },
    });
  } catch (error) {
    await enqueueInbound(message, messageId, deliveryId, rawR2Key, route, forwardResults, env, errorDetail(error));
    return;
  }

  try {
    await persistInboundMetadata(message, messageId, deliveryId, rawR2Key, route, forwardResults, env);
  } catch (error) {
    console.error(`maildesk metadata persist failed for ${messageId}: ${errorDetail(error)}`);
    return;
  }

  return enqueueInbound(message, messageId, deliveryId, rawR2Key, route, forwardResults, env);
}

async function enqueueInbound(
  message: ForwardableEmailMessage,
  messageId: string,
  deliveryId: string,
  rawR2Key: string,
  route: RouteDecision | null,
  forwardResults: ForwardResult[],
  env: Env,
  storageError?: string,
): Promise<void> {
  // Forwarding already happened before this point. If the queue send fails we
  // must NOT rethrow: an exception here propagates out of email(), Cloudflare
  // temp-fails the sender, and the retried inbound re-forwards — a duplicate in
  // the operator inbox. Swallow + log instead; the mail is already delivered,
  // and the audit row is best-effort (deliveryId makes the consumer idempotent
  // if the job does land more than once).
  try {
    await env.MAIL_JOBS.send({
      kind: "inbound_email_received",
      messageId,
      deliveryId,
      envelopeTo: message.to,
      envelopeFrom: message.from,
      routeKind: route?.routeKind,
      forwardedTo: forwardResults
        .filter((result) => result.ok)
        .map((result) => result.recipient),
      forwardErrors: forwardResults
        .filter((result) => !result.ok)
        .map((result) => ({
          recipient: result.recipient,
          error: result.error ?? "unknown forward error",
        })),
      defaultReplyIdentity: route?.defaultReplyIdentity,
      rawR2Key,
      rawSize: message.rawSize,
      storageError,
      receivedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`maildesk enqueue failed for ${messageId}: ${errorDetail(error)}`);
  }
}

async function routeMessage(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<RouteDecision | Error> {
  const policyJson = await loadPolicyJson(env);
  // Fail closed: a missing/unreadable policy must temp-reject (sender retries)
  // rather than silently accept-and-drop. Returning null here would store +
  // enqueue + return 250 OK with no forward — a silent black hole for every
  // domain at once. setReject lets the sender retry until policy is restored.
  if (!policyJson) return new Error("maildesk policy unavailable");

  let policy: RouterPolicy;
  try {
    policy = JSON.parse(policyJson) as RouterPolicy;
  } catch (error) {
    return new Error(`maildesk policy is invalid JSON: ${errorDetail(error)}`);
  }

  const result = routeInbound(policy, {
    envelopeTo: message.to,
    headerFrom: message.from,
    messageId: message.headers.get("message-id") ?? undefined,
    subject: message.headers.get("subject") ?? undefined,
  });

  return result.ok ? result.value : new Error(result.error.message);
}

async function persistInboundMetadata(
  message: ForwardableEmailMessage,
  messageId: string,
  deliveryId: string,
  rawR2Key: string,
  route: RouteDecision | null,
  forwardResults: ForwardResult[],
  env: Env,
): Promise<void> {
  const recipient = parseMailbox(message.to);
  if (!recipient || !route) return;

  const domainId = stableId("domain", recipient.domain);
  const identityId = stableId("identity", route.defaultReplyIdentity);
  const routeId = stableId("route", recipient.domain, recipient.localPart);
  const threadId = stableId("thread", messageId);
  const messageRowId = stableId("message", deliveryId);
  const routeKind = route.routeKind === "personal_alias" ? "personal" : "role";
  const subject = message.headers.get("subject");
  const inReplyTo = message.headers.get("in-reply-to");

  await env.DB.prepare("INSERT OR IGNORE INTO domains (id, domain) VALUES (?1, ?2)")
    .bind(domainId, recipient.domain)
    .run();

  await env.DB.prepare(
    "INSERT OR IGNORE INTO identities (id, domain_id, address, kind) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(identityId, domainId, route.defaultReplyIdentity, routeKind)
    .run();

  await env.DB.prepare(
    "INSERT OR IGNORE INTO alias_routes (id, domain_id, local_part, kind, default_reply_identity_id) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(routeId, domainId, recipient.localPart, routeKind, identityId)
    .run();

  for (const operator of route.operators) {
    const operatorId = stableId("operator", operator);
    await env.DB.prepare("INSERT OR IGNORE INTO operators (id, email) VALUES (?1, ?2)")
      .bind(operatorId, operator)
      .run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO alias_route_operators (route_id, operator_id) VALUES (?1, ?2)",
    )
      .bind(routeId, operatorId)
      .run();
  }

  await env.DB.prepare(
    "INSERT INTO threads (id, domain_id, route_id, external_sender, subject, status) VALUES (?1, ?2, ?3, ?4, ?5, 'open') ON CONFLICT(id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP",
  )
    .bind(threadId, domainId, routeId, normalizeMailbox(message.from), subject)
    .run();

  await env.DB.prepare(
    "INSERT INTO messages (id, thread_id, direction, envelope_from, envelope_to, header_message_id, in_reply_to, raw_r2_key) VALUES (?1, ?2, 'inbound', ?3, ?4, ?5, ?6, ?7) ON CONFLICT(id) DO NOTHING",
  )
    .bind(
      messageRowId,
      threadId,
      normalizeMailbox(message.from),
      normalizeMailbox(message.to),
      messageId,
      inReplyTo,
      rawR2Key,
    )
    .run();

  await env.DB.prepare(
    "INSERT INTO audit_events (id, dedupe_key, thread_id, actor, action, detail_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING",
  )
    .bind(
      crypto.randomUUID(),
      `${deliveryId}:inbound_email_accepted`,
      threadId,
      "system",
      "inbound_email_accepted",
      JSON.stringify({
        messageId,
        deliveryId,
        envelopeFrom: normalizeMailbox(message.from),
        envelopeTo: normalizeMailbox(message.to),
        routeKind: route.routeKind,
        forwardedTo: forwardResults
          .filter((result) => result.ok)
          .map((result) => result.recipient),
        forwardErrors: forwardResults
          .filter((result) => !result.ok)
          .map((result) => ({
            recipient: result.recipient,
            error: result.error ?? "unknown forward error",
          })),
        defaultReplyIdentity: route.defaultReplyIdentity,
        rawR2Key,
      }),
    )
    .run();
}

async function loadPolicyJson(env: Env): Promise<string | null> {
  if (env.MAILDESK_POLICY_JSON) return env.MAILDESK_POLICY_JSON;
  if (!env.MAILDESK_POLICY_R2_KEY) return null;

  const policyObject = await env.RAW_MAIL.get(env.MAILDESK_POLICY_R2_KEY);
  return policyObject?.text() ?? null;
}

async function forwardToOperators(
  message: ForwardableEmailMessage,
  route: RouteDecision | null,
): Promise<ForwardResult[]> {
  if (!route) return [];
  if (route.routeKind === "sink") return [];

  const recipients = route.operators;
  const settled = await Promise.allSettled(
    recipients.map((operator) =>
      message.forward(
        operator,
        new Headers({
          "X-Maildesk-Original-To": message.to,
          "X-Maildesk-Route-Kind": route.routeKind,
          "X-Maildesk-Reply-Identity": route.defaultReplyIdentity,
        }),
      ),
    ),
  );

  return settled.map((result, index) => ({
    recipient: recipients[index] ?? "unknown",
    ok: result.status === "fulfilled",
    error: result.status === "rejected" ? errorDetail(result.reason) : undefined,
  }));
}

function parseMailbox(address: string): ParsedMailbox | null {
  const normalized = normalizeMailbox(address);
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === normalized.length - 1) return null;

  return {
    localPart: normalized.slice(0, atIndex),
    domain: normalized.slice(atIndex + 1),
  };
}

function normalizeMailbox(address: string): string {
  return address.trim().toLowerCase();
}

function stableId(prefix: string, ...parts: string[]): string {
  return [prefix, ...parts.map(stablePart)].join(":");
}

function stablePart(value: string): string {
  return normalizeMailbox(value).replace(/[^a-z0-9._-]+/g, "_");
}

type Env = MaildeskEnv;

interface ParsedMailbox {
  localPart: string;
  domain: string;
}

interface ForwardResult {
  recipient: string;
  ok: boolean;
  error?: string;
}
