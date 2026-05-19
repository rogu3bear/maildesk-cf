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
    message.setReject(`maildesk storage unavailable: ${errorDetail(error)}`);
    return;
  }

  return enqueueInbound(message, messageId, rawR2Key, env);
}

async function enqueueInbound(
  message: ForwardableEmailMessage,
  messageId: string,
  rawR2Key: string,
  env: Env,
): Promise<void> {
  await env.MAIL_JOBS.send({
    kind: "inbound_email_received",
    messageId,
    envelopeTo: message.to,
    envelopeFrom: message.from,
    rawR2Key,
    rawSize: message.rawSize,
    receivedAt: new Date().toISOString(),
  });
}

type Env = MaildeskEnv;
