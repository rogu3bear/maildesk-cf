import { describe, expect, test } from "bun:test";

import mailApiWorker from "../../workers/mail-api/src/index";

describe("mail API outbound sender modes", () => {
  test("an authorized inbox reply derives its external target from D1 and deletes the terminal spool", async () => {
    const db = new D1Recorder({
      id: "relay-1",
      thread_id: "thread-relay",
      external_recipient: "correspondent@example.net",
      reply_identity: "security@tenant.example.com",
      original_message_id: "<original@example.net>",
      references_json: "[]",
      expires_at: "2099-01-01T00:00:00.000Z",
      revoked_at: null,
      route_address: "security@tenant.example.com",
    });
    const email = new SendEmailRecorder("provider-relay");
    const raw = new TextEncoder().encode([
      "From: Operator <operator@tenant.example.com>",
      "To: r+opaque@reply.maildesk.example.com",
      "Subject: Re: security question",
      "Message-ID: <operator-reply@tenant.example.com>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Authorized reply body",
    ].join("\r\n")).buffer;
    const deleted: string[] = [];
    const batch = new MessageBatchRecorder([{
      kind: "inbox_reply_received",
      attemptId: "relay-attempt:reply-1",
      relayId: "relay-1",
      operator: "operator@tenant.example.com",
      operatorMessageId: "<operator-reply@tenant.example.com>",
      rawR2Key: "relay-spool/reply-1.eml",
      receivedAt: "2026-08-12T00:00:00.000Z",
    }]);

    await mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
      DB: db,
      RAW_MAIL: {
        get: async () => ({ size: raw.byteLength, arrayBuffer: async () => raw }),
        delete: async (key: string) => { deleted.push(key); },
      },
      MAIL_JOBS: {},
      EMAIL: email,
      MAILDESK_POLICY_JSON: JSON.stringify({
        default_reply_mode: "role_first",
        domains: {
          "tenant.example.com": {
            role_aliases: {
              security: {
                operators: ["operator@tenant.example.com"],
                reply_identity: "security@tenant.example.com",
                allowed_reply_identities: ["security@tenant.example.com"],
              },
            },
            personal_aliases: {},
          },
        },
      }),
      MAILDESK_OUTBOUND_MODE: "cloudflare_email_service",
      MAILDESK_VERIFIED_SENDER_DOMAINS: "tenant.example.com",
      MAILDESK_OPERATOR_DELIVERY_MODE: "inbox_relay",
      MAILDESK_MAX_ENCODED_MESSAGE_BYTES: "5242880",
    } as unknown as Env);

    expect(batch.ackCount).toBe(1);
    expect(email.messages).toHaveLength(1);
    expect(email.messages[0]).toMatchObject({
      from: "security@tenant.example.com",
      to: ["correspondent@example.net"],
      replyTo: "security@tenant.example.com",
    });
    expect((email.messages[0] as { text: string }).text.trim()).toBe("Authorized reply body");
    expect(JSON.stringify(email.messages[0])).not.toContain("r+opaque");
    expect(deleted).toEqual(["relay-spool/reply-1.eml"]);
    const healthUpdate = db.statements.find((entry) => entry.sql.includes("UPDATE route_health SET reply_status"));
    expect(healthUpdate?.sql).toContain("reply_status = 'reply_verified'");
  });

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
    expect(db.auditThreadId("outbound_reply_failed")).toBe("thread-disabled");
  });

  test("redelivery does not repeat an outbound send", async () => {
    const db = new D1Recorder();
    const email = new SendEmailRecorder("cf-message-id");
    const job = {
      kind: "outbound_reply_requested" as const,
      messageId: "message-redelivery",
      threadId: "thread-redelivery",
      operator: "operator@tenant.example.com",
      envelopeTo: "founders@tenant.example.com",
      fromIdentity: "founders@tenant.example.com",
      to: ["proof@example.net"],
      bcc: ["private@example.net"],
      subject: "Redelivery proof",
      text: "sensitive body",
      headers: { "x-private-context": "sensitive" },
      queuedAt: "2026-07-01T00:00:00.000Z",
    };

    await mailApiWorker.queue(
      new MessageBatchRecorder([job, job]) as unknown as MessageBatch<MailJob>,
      {
        DB: db,
        RAW_MAIL: {},
        MAIL_JOBS: {},
        EMAIL: email,
        MAILDESK_OUTBOUND_MODE: "cloudflare_email_service",
        MAILDESK_VERIFIED_SENDER_DOMAINS: "tenant.example.com",
      } as unknown as Env,
    );

    expect(email.messages).toHaveLength(1);
    const requested = db.auditDetail("outbound_reply_requested") as Record<string, unknown>;
    expect(requested.text).toBeUndefined();
    expect(requested.html).toBeUndefined();
    expect(requested.bcc).toBeUndefined();
    expect(requested.headers).toBeUndefined();
    expect(db.auditSql("outbound_reply_requested")).toContain(
      "(SELECT id FROM threads WHERE id = ?3)",
    );
  });

  test("a transient Resend failure retries without recording a terminal failure", async () => {
    const db = new D1Recorder();
    const batch = new MessageBatchRecorder(
      [
        {
          kind: "outbound_reply_requested",
          messageId: "message-resend-retry",
          threadId: "thread-resend-retry",
          operator: "operator@tenant.example.com",
          envelopeTo: "founders@tenant.example.com",
          fromIdentity: "founders@tenant.example.com",
          to: ["proof@example.net"],
          subject: "Retry proof",
          text: "hello",
          queuedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
      1,
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ message: "temporarily unavailable" }, { status: 503 });

    try {
      await mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
        DB: db,
        RAW_MAIL: {},
        MAIL_JOBS: {},
        RESEND_API_KEY: "test-resend-key",
        MAILDESK_OUTBOUND_MODE: "resend",
        MAILDESK_VERIFIED_SENDER_DOMAINS: "tenant.example.com",
      } as unknown as Env);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(batch.ackCount).toBe(0);
    expect(batch.retryCount).toBe(1);
    expect(batch.retryDelaySeconds).toBeGreaterThan(0);
    expect(db.hasAuditAction("outbound_reply_retry_scheduled")).toBe(true);
    expect(db.hasAuditAction("outbound_reply_failed")).toBe(false);
    expect(JSON.stringify(db.auditDetail("outbound_reply_retry_scheduled"))).not.toContain(
      "temporarily unavailable",
    );
  });

  test("Resend transport exceptions are reduced to bounded non-sensitive audit metadata", async () => {
    const db = new D1Recorder();
    const batch = new MessageBatchRecorder([
      {
        kind: "outbound_reply_requested",
        messageId: "message-resend-redaction",
        threadId: "thread-resend-redaction",
        operator: "operator@tenant.example.com",
        envelopeTo: "founders@tenant.example.com",
        fromIdentity: "founders@tenant.example.com",
        to: ["proof@example.net"],
        bcc: ["private-bcc@example.net"],
        subject: "Redaction proof",
        text: "private-message-body",
        headers: { authorization: "Bearer private-header-token" },
        queuedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error(
        `private-message-body private-bcc@example.net Bearer private-header-token ${"x".repeat(20_000)}`,
      );
    };

    try {
      await mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
        DB: db,
        RAW_MAIL: {},
        MAIL_JOBS: {},
        RESEND_API_KEY: "private-provider-token",
        MAILDESK_OUTBOUND_MODE: "resend",
        MAILDESK_VERIFIED_SENDER_DOMAINS: "tenant.example.com",
      } as unknown as Env);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const auditJson = JSON.stringify(db.auditDetail("outbound_reply_retry_scheduled"));
    expect(auditJson).not.toContain("private-message-body");
    expect(auditJson).not.toContain("private-bcc@example.net");
    expect(auditJson).not.toContain("private-header-token");
    expect(auditJson).not.toContain("private-provider-token");
    expect(auditJson.length).toBeLessThan(2_000);
  });

  test("an exhausted Resend failure records a terminal result instead of retrying forever", async () => {
    const db = new D1Recorder();
    const batch = new MessageBatchRecorder(
      [
        {
          kind: "outbound_reply_requested",
          messageId: "message-resend-exhausted",
          threadId: "thread-resend-exhausted",
          operator: "operator@tenant.example.com",
          envelopeTo: "founders@tenant.example.com",
          fromIdentity: "founders@tenant.example.com",
          to: ["proof@example.net"],
          subject: "Exhaustion proof",
          text: "hello",
          queuedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
      6,
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ message: "temporarily unavailable" }, { status: 503 });

    try {
      await mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
        DB: db,
        RAW_MAIL: {},
        MAIL_JOBS: {},
        RESEND_API_KEY: "test-resend-key",
        MAILDESK_OUTBOUND_MODE: "resend",
        MAILDESK_VERIFIED_SENDER_DOMAINS: "tenant.example.com",
      } as unknown as Env);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(batch.retryCount).toBe(0);
    expect(batch.ackCount).toBe(1);
    expect(db.hasAuditAction("outbound_reply_failed")).toBe(true);
  });

  test("Resend resumes an interrupted claimed transition using the stable idempotency key", async () => {
    const db = new D1Recorder();
    db.seedAudit(
      "message-resend-resume:outbound_reply_requested",
      "outbound_reply_requested",
      { outboundMode: "resend" },
    );
    const batch = new MessageBatchRecorder([
      {
        kind: "outbound_reply_requested",
        messageId: "message-resend-resume",
        threadId: "thread-resend-resume",
        operator: "operator@tenant.example.com",
        envelopeTo: "founders@tenant.example.com",
        fromIdentity: "founders@tenant.example.com",
        to: ["proof@example.net"],
        subject: "Resume proof",
        text: "hello",
        queuedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
    const originalFetch = globalThis.fetch;
    let providerCalls = 0;
    let idempotencyKey: string | null = null;
    globalThis.fetch = async (_input, init) => {
      providerCalls += 1;
      idempotencyKey = new Headers(init?.headers).get("idempotency-key");
      return Response.json({ id: "resumed-message-id" });
    };

    try {
      await mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
        DB: db,
        RAW_MAIL: {},
        MAIL_JOBS: {},
        RESEND_API_KEY: "test-resend-key",
        MAILDESK_OUTBOUND_MODE: "resend",
        MAILDESK_VERIFIED_SENDER_DOMAINS: "tenant.example.com",
      } as unknown as Env);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(providerCalls).toBe(1);
    expect(idempotencyKey).toBe("message-resend-resume");
    expect(batch.ackCount).toBe(1);
    expect(db.hasAuditAction("outbound_reply_delivered")).toBe(true);
  });

  test("Cloudflare redelivery after an incomplete claim requires deliberate recovery without replay", async () => {
    const db = new D1Recorder();
    db.seedAudit(
      "message-cloudflare-recovery:outbound_reply_requested",
      "outbound_reply_requested",
      { outboundMode: "cloudflare_email_service" },
    );
    const email = new SendEmailRecorder("must-not-send");
    const batch = new MessageBatchRecorder([
      {
        kind: "outbound_reply_requested",
        messageId: "message-cloudflare-recovery",
        threadId: "thread-cloudflare-recovery",
        operator: "operator@tenant.example.com",
        envelopeTo: "founders@tenant.example.com",
        fromIdentity: "founders@tenant.example.com",
        to: ["proof@example.net"],
        subject: "Recovery proof",
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

    expect(email.messages).toHaveLength(0);
    expect(batch.ackCount).toBe(1);
    expect(db.hasAuditAction("outbound_reply_recovery_required")).toBe(true);
  });

  test("a claimed Cloudflare transition cannot resume through Resend after mode drift", async () => {
    const db = new D1Recorder();
    db.seedAudit(
      "message-provider-drift:outbound_reply_requested",
      "outbound_reply_requested",
      { outboundMode: "cloudflare_email_service" },
    );
    const batch = new MessageBatchRecorder([
      {
        kind: "outbound_reply_requested",
        messageId: "message-provider-drift",
        threadId: "thread-provider-drift",
        operator: "operator@tenant.example.com",
        envelopeTo: "founders@tenant.example.com",
        fromIdentity: "founders@tenant.example.com",
        to: ["proof@example.net"],
        subject: "Provider drift proof",
        text: "hello",
        queuedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
    const originalFetch = globalThis.fetch;
    let providerCalls = 0;
    globalThis.fetch = async () => {
      providerCalls += 1;
      return Response.json({ id: "must-not-send" });
    };

    try {
      await mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
        DB: db,
        RAW_MAIL: {},
        MAIL_JOBS: {},
        RESEND_API_KEY: "test-resend-key",
        MAILDESK_OUTBOUND_MODE: "resend",
        MAILDESK_VERIFIED_SENDER_DOMAINS: "tenant.example.com",
      } as unknown as Env);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(providerCalls).toBe(0);
    expect(batch.ackCount).toBe(1);
    expect(db.hasAuditAction("outbound_reply_recovery_required")).toBe(true);
  });

  test("an ambiguous Cloudflare provider failure is surfaced for recovery without automatic replay", async () => {
    const db = new D1Recorder();
    const batch = new MessageBatchRecorder([
      {
        kind: "outbound_reply_requested",
        messageId: "message-cloudflare-ambiguous",
        threadId: "thread-cloudflare-ambiguous",
        operator: "operator@tenant.example.com",
        envelopeTo: "founders@tenant.example.com",
        fromIdentity: "founders@tenant.example.com",
        to: ["proof@example.net"],
        subject: "Ambiguous provider proof",
        text: "hello",
        queuedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);

    await mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
      DB: db,
      RAW_MAIL: {},
      MAIL_JOBS: {},
      EMAIL: {
        async send() {
          throw new Error(
            `provider connection closed after submission private-message-body private-bcc@example.net Bearer private-header-token ${"x".repeat(20_000)}`,
          );
        },
      },
      MAILDESK_OUTBOUND_MODE: "cloudflare_email_service",
      MAILDESK_VERIFIED_SENDER_DOMAINS: "tenant.example.com",
    } as unknown as Env);

    expect(batch.retryCount).toBe(0);
    expect(batch.ackCount).toBe(1);
    expect(db.hasAuditAction("outbound_reply_recovery_required")).toBe(true);
    expect(db.hasAuditAction("outbound_reply_failed")).toBe(false);
    const auditJson = JSON.stringify(db.auditDetail("outbound_reply_recovery_required"));
    expect(auditJson).not.toContain("private-message-body");
    expect(auditJson).not.toContain("private-bcc@example.net");
    expect(auditJson).not.toContain("private-header-token");
    expect(auditJson.length).toBeLessThan(2_000);
  });

  test("legacy reply API is disabled unless explicitly enabled", async () => {
    const response = await mailApiWorker.fetch(
      new Request("https://maildesk.example.com/api/replies", { method: "POST" }),
      {
        DB: new D1Recorder(),
        RAW_MAIL: {},
        MAIL_JOBS: {},
        MAILDESK_API_TOKEN: "test-token",
      } as unknown as Env,
    );

    expect(response.status).toBe(404);
  });

  test("readiness rejects an explicit invalid operator delivery mode", async () => {
    const response = await mailApiWorker.fetch(
      new Request("https://maildesk.example.com/readyz"),
      {
        DB: new D1Recorder(),
        RAW_MAIL: {},
        MAIL_JOBS: {},
        MAILDESK_POLICY_JSON: JSON.stringify({ domains: {} }),
        MAILDESK_OPERATOR_DELIVERY_MODE: "inbox-relayy",
      } as unknown as Env,
    );

    expect(response.status).toBe(503);
    const report = await response.json() as {
      checks: Array<{ name: string; ok: boolean; detail?: string }>;
    };
    expect(report.checks).toContainEqual({
      name: "operator_delivery_mode",
      ok: false,
      detail: "invalid",
    });
  });

  test("readiness rejects a malformed reply domain", async () => {
    const response = await mailApiWorker.fetch(
      new Request("https://maildesk.example.com/readyz"),
      {
        DB: new D1Recorder(),
        RAW_MAIL: {},
        MAIL_JOBS: {},
        EMAIL: new SendEmailRecorder("unused"),
        MAILDESK_POLICY_JSON: JSON.stringify({ domains: {} }),
        MAILDESK_OPERATOR_DELIVERY_MODE: "inbox_relay",
        MAILDESK_REPLY_DOMAIN: "reply..maildesk.example.com",
      } as unknown as Env,
    );

    expect(response.status).toBe(503);
    const report = await response.json() as {
      checks: Array<{ name: string; ok: boolean; detail?: string }>;
    };
    expect(report.checks).toContainEqual({
      name: "reply_domain",
      ok: false,
      detail: "missing",
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

  test("runtime sender authorization rejects wildcard configuration", async () => {
    const db = new D1Recorder();
    const email = new SendEmailRecorder("must-not-send");
    const batch = new MessageBatchRecorder([
      {
        kind: "outbound_reply_requested",
        messageId: "message-wildcard-sender",
        threadId: "thread-wildcard-sender",
        operator: "operator@tenant.example.com",
        envelopeTo: "founders@tenant.example.com",
        fromIdentity: "founders@tenant.example.com",
        to: ["proof@example.net"],
        subject: "Wildcard sender proof",
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
      MAILDESK_VERIFIED_SENDER_DOMAINS: "tenant.example.com,*",
    } as unknown as Env);

    expect(email.messages).toHaveLength(0);
    expect(batch.ackCount).toBe(1);
    const result = db.auditDetail("outbound_reply_failed") as {
      result?: { provider?: string; error?: string };
    };
    expect(result.result).toMatchObject({
      provider: "cloudflare_email_service",
      error: "sender domain is not verified",
    });
  });

  test("resend mode bounds the provider request and preserves the idempotency key", async () => {
    const db = new D1Recorder();
    const batch = new MessageBatchRecorder([
      {
        kind: "outbound_reply_requested",
        messageId: "message-resend",
        threadId: "thread-resend",
        operator: "operator@tenant.example.com",
        envelopeTo: "founders@tenant.example.com",
        fromIdentity: "founders@tenant.example.com",
        to: ["proof@example.net"],
        subject: "Resend proof",
        text: "hello",
        queuedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
    const originalFetch = globalThis.fetch;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = async (_input, init) => {
      capturedInit = init;
      return Response.json({ id: "resend-message-id" });
    };

    try {
      await mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
        DB: db,
        RAW_MAIL: {},
        MAIL_JOBS: {},
        RESEND_API_KEY: "test-resend-key",
        MAILDESK_OUTBOUND_MODE: "resend",
        MAILDESK_VERIFIED_SENDER_DOMAINS: "tenant.example.com",
      } as unknown as Env);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(capturedInit?.headers).get("idempotency-key")).toBe("message-resend");
    const result = db.auditDetail("outbound_reply_delivered") as {
      result?: { provider?: string; providerMessageId?: string };
    };
    expect(result.result).toMatchObject({
      provider: "resend",
      providerMessageId: "resend-message-id",
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
      MAILDESK_REPLY_API_MODE: "token",
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
  readonly messages: Array<{
    body: MailJob;
    attempts: number;
    ack: () => void;
    retry: (options?: { delaySeconds?: number }) => void;
  }>;
  ackCount = 0;
  retryCount = 0;
  retryDelaySeconds: number | undefined;

  constructor(jobs: MailJob[], attempts = 1) {
    this.messages = jobs.map((body) => ({
      body,
      attempts,
      ack: () => {
        this.ackCount += 1;
      },
      retry: (options) => {
        this.retryCount += 1;
        this.retryDelaySeconds = options?.delaySeconds;
      },
    }));
  }
}

class D1Recorder {
  readonly statements: RecordedStatement[] = [];

  constructor(private readonly relayRow?: Record<string, unknown>) {}

  seedAudit(dedupeKey: string, action: string, detail: unknown = {}): void {
    this.statements.push({
      sql: "INSERT OR IGNORE INTO audit_events",
      binds: ["seed", dedupeKey, null, "system", action, JSON.stringify(detail)],
    });
  }

  prepare(sql: string): D1PreparedStatement {
    const statements = this.statements;
    const record: RecordedStatement = { sql, binds: [] };
    const prepared = {
      bind(...values: unknown[]) {
        record.binds = values;
        return prepared;
      },
      async run() {
        const dedupeKey = record.binds[1];
        if (
          dedupeKey &&
          statements.some(
            (existing) => existing.sql.includes("INSERT OR IGNORE INTO audit_events") && existing.binds[1] === dedupeKey,
          )
        ) {
          return { success: true, meta: { changes: 0 } };
        }
        statements.push(record);
        return { success: true, meta: { changes: 1 } };
      },
      async first() {
        statements.push(record);
        if (record.sql.includes("FROM reply_relays rr")) {
          return thisRelayRow;
        }
        if (record.sql.includes("SELECT action FROM audit_events")) {
          const dedupeKey = record.binds[0];
          const existing = statements.find(
            (entry) =>
              entry.sql.includes("INSERT OR IGNORE INTO audit_events") &&
              entry.binds[1] === dedupeKey,
          );
          return existing ? { action: existing.binds[4] } : null;
        }
        if (record.sql.includes("SELECT detail_json FROM audit_events")) {
          const dedupeKey = record.binds[0];
          const existing = statements.find(
            (entry) =>
              entry.sql.includes("INSERT OR IGNORE INTO audit_events") &&
              entry.binds[1] === dedupeKey,
          );
          return existing ? { detail_json: existing.binds[5] } : null;
        }
        return { ok: 1 };
      },
    };
    const thisRelayRow = this.relayRow ?? null;
    return prepared as unknown as D1PreparedStatement;
  }

  auditDetail(action: string): unknown {
    const statement = this.statements.find((entry) => entry.binds[4] === action);
    expect(statement).toBeTruthy();
    return JSON.parse(String(statement?.binds[5]));
  }

  auditThreadId(action: string): unknown {
    const statement = this.statements.find((entry) => entry.binds[4] === action);
    expect(statement).toBeTruthy();
    return statement?.binds[2];
  }

  auditSql(action: string): string {
    const statement = this.statements.find((entry) => entry.binds[4] === action);
    expect(statement).toBeTruthy();
    return statement?.sql ?? "";
  }

  hasAuditAction(action: string): boolean {
    return this.statements.some((entry) => entry.binds[4] === action);
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
