import { json, notFound, operatorDeliveryConfig, type MaildeskEnv as Env, type OutboundReplyRequestedJob } from "./contracts";
import { authorizeReplyWithPolicy } from "./router";
import { loadActivePolicy } from "./policy-store";
import { isOutboundReplyRequestedJob } from "./job-codec";

export async function queueReply(request: Request, env: Env): Promise<Response> {
  const delivery = operatorDeliveryConfig(env);
  if (delivery.mode === "invalid") {
    return json({ error: "operator_delivery_mode_invalid" }, { status: 503 });
  }
  if (delivery.mode === "inbox_relay") {
    return notFound();
  }

  if (!isAuthorizedRequest(request, env)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }

  if (!isOutboundReplyRequestedJob(body)) {
    return json({ error: "invalid_reply_request" }, { status: 400 });
  }

  const policy = (await loadActivePolicy(env))?.policy;
  if (!policy) {
    return json({ error: "policy_unavailable" }, { status: 503 });
  }

  const authorization = authorizeReplyWithPolicy(policy, {
    envelopeTo: body.envelopeTo,
    operator: body.operator,
    requestedIdentity: body.requestedIdentity || body.fromIdentity || undefined,
  });
  if (!authorization.ok) {
    if (authorization.error.kind === "invalid_request" || authorization.error.kind === "adapter_failure") {
      return json({ error: "policy_unavailable" }, { status: 503 });
    }
    return json({ error: "reply_not_authorized", detail: authorization.error.message }, { status: 403 });
  }

  const job: OutboundReplyRequestedJob = {
    ...body,
    fromIdentity: authorization.value.fromIdentity,
    queuedAt: body.queuedAt || new Date().toISOString(),
  };

  await env.MAIL_JOBS.send(job);
  return json({ queued: true, messageId: job.messageId, fromIdentity: job.fromIdentity }, { status: 202 });
}

function isAuthorizedRequest(request: Request, env: Env): boolean {
  const tokens = [env.MAILDESK_API_TOKEN, env.MAILDESK_PROOF_API_TOKEN].filter(Boolean);
  if (tokens.length === 0) return false;

  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const headerToken = request.headers.get("x-maildesk-token");
  return Boolean((bearer && tokens.includes(bearer)) || (headerToken && tokens.includes(headerToken)));
}
