import type { MailJob, MaildeskEnv } from "../../shared/contracts";
import { processQueueBatch } from "../../mail-api/src/index";

export default {
  async queue(batch: MessageBatch<MailJob>, env: MaildeskEnv): Promise<void> {
    await processQueueBatch(batch, env);
  },
} satisfies ExportedHandler<MaildeskEnv, MailJob>;
