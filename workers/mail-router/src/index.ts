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
  const rawR2Key = rawMailKey(messageId);
  const route = await routeMessage(message, env);

  if (route instanceof Error) {
    message.setReject(route.message);
    return;
  }

  try {
    await forwardToOperators(message, route);
  } catch (error) {
    message.setReject(`maildesk forward unavailable: ${errorDetail(error)}`);
    return;
  }

  try {
    await env.RAW_MAIL.put(rawR2Key, message.raw, {
      httpMetadata: {
        contentType: "message/rfc822",
      },
      customMetadata: {
        envelopeFrom: message.from,
        envelopeTo: message.to,
      },
    });
  } catch (error) {
    await enqueueInbound(message, messageId, rawR2Key, route, env, errorDetail(error));
    return;
  }

  return enqueueInbound(message, messageId, rawR2Key, route, env);
}

async function enqueueInbound(
  message: ForwardableEmailMessage,
  messageId: string,
  rawR2Key: string,
  route: RouteDecision | null,
  env: Env,
  storageError?: string,
): Promise<void> {
  await env.MAIL_JOBS.send({
    kind: "inbound_email_received",
    messageId,
    envelopeTo: message.to,
    envelopeFrom: message.from,
    routeKind: route?.routeKind,
    forwardedTo: route?.operators,
    defaultReplyIdentity: route?.defaultReplyIdentity,
    rawR2Key,
    rawSize: message.rawSize,
    storageError,
    receivedAt: new Date().toISOString(),
  });
}

async function routeMessage(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<RouteDecision | Error | null> {
  const policyJson = await loadPolicyJson(env);
  if (!policyJson) return null;

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
): Promise<void> {
  if (!route) return;

  for (const operator of route.operators) {
    await message.forward(
      operator,
      new Headers({
        "X-Maildesk-Original-To": message.to,
        "X-Maildesk-Route-Kind": route.routeKind,
        "X-Maildesk-Reply-Identity": route.defaultReplyIdentity,
      }),
    );
  }
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
}

interface RoleAliasPolicy {
  operators: string[];
  reply_identity: string;
}

interface PersonalAliasPolicy {
  operator: string;
  reply_identity: string;
}

interface RouteDecision {
  routeKind: "role_alias" | "personal_alias";
  operators: string[];
  defaultReplyIdentity: string;
}
