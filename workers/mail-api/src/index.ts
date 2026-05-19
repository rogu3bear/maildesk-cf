import {
  json,
  MailJob,
  MaildeskEnv,
  methodNotAllowed,
  notFound,
  OutboundReplyRequestedJob,
  readiness,
} from "../../shared/contracts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "maildesk-cf" });
    }

    if (url.pathname === "/readyz") {
      const report = await readiness(env);
      return json(report, { status: report.ok ? 200 : 503 });
    }

    if (url.pathname === "/api/replies" && request.method !== "POST") {
      return methodNotAllowed();
    }

    if (url.pathname === "/api/replies") {
      return queueReply(request, env);
    }

    return notFound();
  },

  async queue(batch: MessageBatch<MailJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await recordQueueEvent(message.body, env);
      message.ack();
    }
  },
};

async function queueReply(request: Request, env: Env): Promise<Response> {
  const body = await request.json();

  if (!isOutboundReplyRequestedJob(body)) {
    return json({ error: "invalid_reply_request" }, { status: 400 });
  }

  await env.MAIL_JOBS.send(body);
  return json({ queued: true, messageId: body.messageId }, { status: 202 });
}

function isOutboundReplyRequestedJob(value: unknown): value is OutboundReplyRequestedJob {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Record<keyof OutboundReplyRequestedJob, unknown>>;

  return (
    candidate.kind === "outbound_reply_requested" &&
    typeof candidate.messageId === "string" &&
    typeof candidate.threadId === "string" &&
    typeof candidate.operator === "string" &&
    typeof candidate.queuedAt === "string" &&
    (candidate.requestedIdentity === undefined || typeof candidate.requestedIdentity === "string")
  );
}

async function recordQueueEvent(job: MailJob, env: Env): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_events (id, actor, action, detail_json) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(crypto.randomUUID(), "system", job.kind, JSON.stringify(job))
    .run();
}

type Env = MaildeskEnv;
