import { describe, expect, test } from "bun:test";

import mailApiWorker from "../../workers/mail-api/src/index";

describe("mail API outbound sender modes", () => {
  test("disabled mode records a disabled send result without requiring sender-domain verification", async () => {
    const db = new D1Recorder();
    const batch = new MessageBatchRecorder([
      {
        kind: "outbound_reply_requested",
        messageId: "message-disabled",
        threadId: "thread-disabled",
        operator: "operator@tenant.example.com",
        envelopeTo: "founders@tenant.example.com",
        fromIdentity: "founders@tenant.example.com",
        to: ["proof@example.net"],
        subject: "Disabled proof",
        text: "hello",
        queuedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);

    await mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
      DB: db,
      RAW_MAIL: {},
      MAIL_JOBS: {},
      MAILDESK_OUTBOUND_MODE: "disabled",
    } as unknown as Env);

    expect(batch.ackCount).toBe(1);
    const result = db.auditDetail("outbound_reply_failed") as {
      result?: { provider?: string; error?: string };
    };
    expect(result.result).toMatchObject({
      provider: "disabled",
      error: "outbound sending is disabled",
    });
  });

  test("cloudflare_email_service mode sends through EMAIL and records providerMessageId", async () => {
    const db = new D1Recorder();
    const email = new SendEmailRecorder("cf-message-id");
    const batch = new MessageBatchRecorder([
      {
        kind: "outbound_reply_requested",
        messageId: "message-cloudflare",
        threadId: "thread-cloudflare",
        operator: "operator@tenant.example.com",
        envelopeTo: "founders@tenant.example.com",
        fromIdentity: "founders@tenant.example.com",
        to: ["proof@example.net"],
        subject: "Cloudflare proof",
        text: "hello",
        queuedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);

    await mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
      DB: db,
      RAW_MAIL: {},
      MAIL_JOBS: {},
      EMAIL: email,
      MAILDESK_OUTBOUND_MODE: "cloudflare_email_service",
      MAILDESK_VERIFIED_SENDER_DOMAINS: "tenant.example.com",
    } as unknown as Env);

    expect(email.messages).toHaveLength(1);
    expect(email.messages[0]).toMatchObject({
      from: "founders@tenant.example.com",
      to: ["proof@example.net"],
      subject: "Cloudflare proof",
    });
    const result = db.auditDetail("outbound_reply_delivered") as {
      result?: { provider?: string; providerMessageId?: string };
    };
    expect(result.result).toMatchObject({
      provider: "cloudflare_email_service",
      providerMessageId: "cf-message-id",
    });
  });

  test("reply authorization returns the Rust router rejection", async () => {
    const request = new Request("https://maildesk.example.com/api/replies", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "outbound_reply_requested",
        messageId: "message-unauthorized",
        threadId: "thread-unauthorized",
        operator: "outsider@example.com",
        envelopeTo: "founders@example.com",
        fromIdentity: "founders@example.com",
        to: ["sender@example.net"],
        subject: "Unauthorized reply",
        text: "hello",
        queuedAt: "2026-07-09T00:00:00.000Z",
      }),
    });

    const response = await mailApiWorker.fetch(request, {
      DB: new D1Recorder(),
      RAW_MAIL: {},
      MAIL_JOBS: {
        async send() {},
      },
      MAILDESK_API_TOKEN: "test-token",
      MAILDESK_POLICY_JSON: JSON.stringify({
        default_reply_mode: "role_first",
        domains: {
          "example.com": {
            role_aliases: {
              founders: {
                operators: ["operator@example.com"],
                reply_identity: "founders@example.com",
                allowed_reply_identities: [],
              },
            },
            personal_aliases: {},
          },
        },
      }),
    } as unknown as Env);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "reply_not_authorized",
      detail: "sender is not an operator on the route: outsider@example.com",
    });
  });
});

class MessageBatchRecorder {
  readonly messages: Array<{ body: MailJob; ack: () => void }>;
  ackCount = 0;

  constructor(jobs: MailJob[]) {
    this.messages = jobs.map((body) => ({
      body,
      ack: () => {
        this.ackCount += 1;
      },
    }));
  }
}

class D1Recorder {
  readonly statements: RecordedStatement[] = [];

  prepare(sql: string): D1PreparedStatement {
    const statements = this.statements;
    const record: RecordedStatement = { sql, binds: [] };
    const prepared = {
      bind(...values: unknown[]) {
        record.binds = values;
        return prepared;
      },
      async run() {
        statements.push(record);
        return { success: true };
      },
      async first() {
        statements.push(record);
        return { ok: 1 };
      },
    };
    return prepared as unknown as D1PreparedStatement;
  }

  auditDetail(action: string): unknown {
    const statement = this.statements.find((entry) => entry.binds[3] === action);
    expect(statement).toBeTruthy();
    return JSON.parse(String(statement?.binds[4]));
  }
}

class SendEmailRecorder {
  readonly messages: unknown[] = [];

  constructor(private readonly messageId: string) {}

  async send(message: unknown): Promise<{ messageId: string }> {
    this.messages.push(message);
    return { messageId: this.messageId };
  }
}

interface RecordedStatement {
  sql: string;
  binds: unknown[];
}

type Env = Parameters<typeof mailApiWorker.queue>[1];
type MailJob = Parameters<typeof mailApiWorker.queue>[0]["messages"][number]["body"];
