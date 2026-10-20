import { json, methodNotAllowed, notFound, readiness, type MailJob, type MaildeskEnv as Env } from "../../shared/contracts";
import { queueReply } from "../../shared/legacy-reply-http";
import { processQueueBatch } from "../../shared/outbound/queue";
// Temporary compatibility exports for existing local tests and consumers.
export { processQueueBatch } from "../../shared/outbound/queue";
export { CLAIMED_REPLY_SPOOL_SQL, AUTHORIZED_OUTBOUND_REPLY_SQL, OUTBOUND_REPLY_TARGET_CANDIDATES_SQL,
  CLAIM_OUTBOUND_PROVIDER_BOUNDARY_SQL, OUTBOUND_CONTAINMENT_STATE_SQL, outboundPayloadSha256 } from "../../shared/outbound/reply-authorization";
export { CLAIMED_INBOUND_RESULT_SQL, PERSIST_INBOUND_DELIVERY_PROJECTION_SQL, CLEAR_INBOUND_CLEANUP_AUTHORITY_SQL } from "../../shared/outbound/inbound-results";
export { terminalProviderErrorCode } from "../../shared/outbound/provider-errors";

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
      if ((env.MAILDESK_REPLY_API_MODE ?? "disabled") !== "token") {
        return notFound();
      }
      return queueReply(request, env);
    }

    return notFound();
  },

  async queue(batch: MessageBatch<MailJob>, env: Env): Promise<void> {
    await processQueueBatch(batch, env);
  },
};
