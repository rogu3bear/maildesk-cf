import { errorDetail, MaildeskEnv, rawMailKey } from "../../shared/contracts";

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
): Promise<RouteDecision | Error | null> {
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

  const recipient = parseMailbox(message.to);
  if (!recipient) return new Error(`recipient is not a valid mailbox address: ${message.to}`);

  const domainPolicy = policy.domains[recipient.domain];
  if (!domainPolicy) return new Error(`domain is not configured: ${recipient.domain}`);

  const roleAlias = domainPolicy.role_aliases[recipient.localPart];
  if (roleAlias) {
    if (roleAlias.sink) {
      return {
        routeKind: "sink",
        operators: [],
        defaultReplyIdentity: roleAlias.reply_identity,
      };
    }

    if (roleAlias.operators.length === 0) {
      return new Error(`policy has an empty operator set for: ${message.to}`);
    }

    return {
      routeKind: "role_alias",
      operators: unique(roleAlias.operators),
      defaultReplyIdentity: roleAlias.reply_identity,
    };
  }

  const personalAlias = domainPolicy.personal_aliases[recipient.localPart];
  if (personalAlias) {
    return {
      routeKind: "personal_alias",
      operators: [personalAlias.operator],
      defaultReplyIdentity: personalAlias.reply_identity,
    };
  }

  const catchAll = domainPolicy.catch_all;
  if (catchAll) {
    if (catchAll.sink) {
      return {
        routeKind: "sink",
        operators: [],
        defaultReplyIdentity: catchAll.reply_identity,
      };
    }

    if (catchAll.operators.length === 0) {
      return new Error(`policy has an empty catch-all operator set for: ${recipient.domain}`);
    }

    return {
      routeKind: "catch_all",
      operators: unique(catchAll.operators),
      defaultReplyIdentity: catchAll.reply_identity,
    };
  }

  return new Error(`alias is not configured: ${message.to}`);
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
  const normalized = address.trim().toLowerCase();
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === normalized.length - 1) return null;

  return {
    localPart: normalized.slice(0, atIndex),
    domain: normalized.slice(atIndex + 1),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

type Env = MaildeskEnv;

interface ParsedMailbox {
  localPart: string;
  domain: string;
}

interface RouterPolicy {
  domains: Record<string, DomainPolicy>;
}

interface DomainPolicy {
  role_aliases: Record<string, RoleAliasPolicy>;
  personal_aliases: Record<string, PersonalAliasPolicy>;
  catch_all?: CatchAllPolicy;
}

interface RoleAliasPolicy {
  operators: string[];
  reply_identity: string;
  /** When true, archive inbound mail (R2 + D1) but never forward to operators. */
  sink?: boolean;
}

interface PersonalAliasPolicy {
  operator: string;
  reply_identity: string;
}

interface CatchAllPolicy {
  operators: string[];
  reply_identity: string;
  /** When true, archive unmatched mail but never forward to operators. */
  sink?: boolean;
}

interface RouteDecision {
  routeKind: "role_alias" | "personal_alias" | "catch_all" | "sink";
  operators: string[];
  defaultReplyIdentity: string;
}

interface ForwardResult {
  recipient: string;
  ok: boolean;
  error?: string;
}
