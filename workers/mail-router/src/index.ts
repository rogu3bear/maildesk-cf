import { operatorDeliveryConfig,type MaildeskEnv } from "../../shared/contracts";
import { relayTokenFromRecipient } from "../../shared/inbox-relay";
import { refreshRouteStatuses } from "../../shared/status-store";
import { acceptEmail } from "./inbound";
export { ACTIVE_REPLY_ADMISSION_SQL,CLAIM_REPLY_ADMISSION_SQL,EXACT_DUPLICATE_REPLY_CLAIM_SQL,INSERT_ADMITTED_RELAY_ATTEMPT_SQL,RELAY_CONTAINMENT_BY_TOKEN_SQL,replyAttemptStagingKey } from "../../shared/reply-repository";
export { CLAIM_ACTIVE_INBOUND_RECIPIENT_SQL,DISCARD_SUPERSEDED_UNSENT_RELAY_SQL } from "./inbound-repository";

export default {
  async email(message: ForwardableEmailMessage, env: MaildeskEnv): Promise<void> {
    const config = operatorDeliveryConfig(env);
    const isReply = config.replyDomain && relayTokenFromRecipient(message.to, config.replyDomain);
    const enabled = config.mode === "inbox_relay" && (isReply ? config.replyProcessingMode : config.inboundProcessingMode) === "enabled";
    const affectedRoutes = new Set<string>();
    try { await acceptEmail(message, env, affectedRoutes); }
    finally {
      if (enabled) await refreshRouteStatuses(env, Date.now(), { routeIds: [...affectedRoutes] })
        .catch(() => console.error(JSON.stringify({ event: "status_projection_unavailable" })));
    }
  },
} satisfies ExportedHandler<MaildeskEnv>;
