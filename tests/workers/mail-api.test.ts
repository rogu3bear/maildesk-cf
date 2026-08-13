import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import mailApiWorker from "../../workers/mail-api/src/index";

describe("mail API outbound sender modes", () => {
  test("an inbound result recovery job projects provider outcomes and cleans the spool without sending", async () => {
    const db = new D1Recorder();
    const email = new SendEmailRecorder("must-not-send");
    const deleted: string[] = [];
    const batch = new MessageBatchRecorder([{
      kind: "inbound_delivery_result",
      deliveryId: "delivery-recovery",
      relayId: "relay-recovery",
      threadId: "thread-recovery",
      routeId: "route:tenant.example.com:security",
      policySha256: "a".repeat(64),
      status: "provider_accepted",
      results: [
        { operatorRef: "operator-ref-a", deliveryPayloadR2Key: "relay-spool/delivery-recovery.a.json", ok: true, providerMessageId: "provider-a" },
        { operatorRef: "operator-ref-b", deliveryPayloadR2Key: "relay-spool/delivery-recovery.b.json", ok: true, providerMessageId: "provider-b" },
      ],
      relaySpoolKey: "relay-spool/delivery-recovery.eml",
      receivedAt: "2026-08-12T00:00:00.000Z",
    }]);

    await mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
      DB: db,
      RAW_MAIL: {},
      RELAY_SPOOL: { delete: async (key: string) => { deleted.push(key); } },
      MAIL_JOBS: {},
      EMAIL: email,
      MAILDESK_OUTBOUND_MODE: "cloudflare_email_service",
      MAILDESK_VERIFIED_SENDER_DOMAINS: "tenant.example.com",
    } as unknown as Env);

    expect(batch.ackCount).toBe(1);
    expect(email.messages).toHaveLength(0);
    expect(deleted).toEqual([
      "relay-spool/delivery-recovery.a.json",
      "relay-spool/delivery-recovery.b.json",
      "relay-spool/delivery-recovery.eml",
    ]);
    expect(db.hasAuditAction("operator_delivery_provider_accepted")).toBe(true);
    const healthUpdate = db.statements.find((entry) => entry.sql.includes("UPDATE route_health SET inbound_status"));
    expect(healthUpdate?.binds.slice(0, 3)).toEqual([
      "provider_accepted",
      2,
      JSON.stringify(["provider-a", "provider-b"]),
    ]);
    expect(healthUpdate?.sql).toContain("policy_sha256 = ?6");
    expect(healthUpdate?.sql).toContain("rs.active_policy_sha256 = ?6");
    expect(healthUpdate?.binds[5]).toBe("a".repeat(64));
    const deliveryUpdate = db.statements.find((entry) => entry.sql.includes("UPDATE inbound_deliveries SET status"));
    expect(deliveryUpdate?.sql).toContain("raw_r2_key = CASE WHEN ?1 = 'provider_accepted' THEN NULL");
    expect(deliveryUpdate?.binds).toEqual([
      "provider_accepted",
      "delivery-recovery",
      "a".repeat(64),
    ]);
  });

  test("a delayed inbound result cannot advance a superseding policy revision", async () => {
    const db = new D1Recorder(
      undefined,
      undefined,
      undefined,
      "UPDATE route_health SET inbound_status",
      "b".repeat(64),
    );
    const email = new SendEmailRecorder("must-not-send");
    const deleted: string[] = [];
    const batch = new MessageBatchRecorder([{
      kind: "inbound_delivery_result",
      deliveryId: "delivery-policy-a",
      relayId: "relay-policy-a",
      threadId: "thread-policy-a",
      routeId: "route:tenant.example.com:security",
      policySha256: "a".repeat(64),
      status: "provider_accepted",
      results: [{ operatorRef: "operator-ref-a", deliveryPayloadR2Key: "relay-spool/delivery-policy-a.a.json", ok: true, providerMessageId: "provider-a" }],
      relaySpoolKey: "relay-spool/delivery-policy-a.eml",
      receivedAt: "2026-08-12T00:00:00.000Z",
    }]);

    await mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
      DB: db,
      RAW_MAIL: {},
      RELAY_SPOOL: { delete: async (key: string) => { deleted.push(key); } },
      MAIL_JOBS: {},
      EMAIL: email,
      MAILDESK_OUTBOUND_MODE: "cloudflare_email_service",
      MAILDESK_VERIFIED_SENDER_DOMAINS: "tenant.example.com",
    } as unknown as Env);

    expect(batch.ackCount).toBe(1);
    expect(email.messages).toHaveLength(0);
    expect(deleted).toEqual([
      "relay-spool/delivery-policy-a.a.json",
      "relay-spool/delivery-policy-a.eml",
    ]);
    expect(db.hasAuditAction("operator_delivery_result_superseded")).toBe(true);
    expect(db.hasAuditAction("operator_delivery_provider_accepted")).toBe(false);
    const healthUpdate = db.statements.find((entry) => entry.sql.includes("UPDATE route_health SET inbound_status"));
    expect(healthUpdate?.binds[5]).toBe("a".repeat(64));
  });

  test("a superseded ambiguous inbound result retains its recovery spool", async () => {
    const db = new D1Recorder(
      undefined,
      undefined,
      undefined,
      "UPDATE route_health SET inbound_status",
      "b".repeat(64),
    );
    const deleted: string[] = [];
    const batch = new MessageBatchRecorder([{
      kind: "inbound_delivery_result",
      deliveryId: "delivery-policy-a-ambiguous",
      relayId: "relay-policy-a-ambiguous",
      threadId: "thread-policy-a-ambiguous",
      routeId: "route:tenant.example.com:security",
      policySha256: "a".repeat(64),
      status: "recovery_required",
      results: [{ operatorRef: "operator-ref-a", deliveryPayloadR2Key: "relay-spool/delivery-policy-a-ambiguous.a.json", ok: false, errorCode: "provider_outcome_unknown" }],
      relaySpoolKey: "relay-spool/delivery-policy-a-ambiguous.eml",
      receivedAt: "2026-08-12T00:00:00.000Z",
    }]);

    await mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
      DB: db,
      RAW_MAIL: {},
      RELAY_SPOOL: { delete: async (key: string) => { deleted.push(key); } },
      MAIL_JOBS: {},
      MAILDESK_OUTBOUND_MODE: "disabled",
    } as unknown as Env);

    expect(batch.ackCount).toBe(1);
    expect(deleted).toHaveLength(0);
    expect(db.hasAuditAction("operator_delivery_result_superseded")).toBe(true);
    const deliveryUpdate = db.statements.find((entry) =>
      entry.sql.includes("UPDATE inbound_deliveries SET status") &&
      entry.binds[0] === "recovery_required"
    );
    expect(deliveryUpdate?.sql).toContain(
      "raw_r2_key = CASE WHEN ?1 = 'provider_accepted' THEN NULL ELSE raw_r2_key END",
    );
  });

  test("a missing active-revision health row retains recovery state for retry", async () => {
    const db = new D1Recorder(
      undefined,
      undefined,
      undefined,
      "UPDATE route_health SET inbound_status",
      "a".repeat(64),
    );
    const deleted: string[] = [];
    const batch = new MessageBatchRecorder([{
      kind: "inbound_delivery_result",
      deliveryId: "delivery-active-recovery",
      relayId: "relay-active-recovery",
      threadId: "thread-active-recovery",
      routeId: "route:tenant.example.com:security",
      policySha256: "a".repeat(64),
      status: "provider_accepted",
      results: [{ operatorRef: "operator-ref-a", deliveryPayloadR2Key: "relay-spool/delivery-active-recovery.a.json", ok: true, providerMessageId: "provider-a" }],
      relaySpoolKey: "relay-spool/delivery-active-recovery.eml",
      receivedAt: "2026-08-12T00:00:00.000Z",
    }]);

    await expect(mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
      DB: db,
      RAW_MAIL: {},
      RELAY_SPOOL: { delete: async (key: string) => { deleted.push(key); } },
      MAIL_JOBS: {},
      MAILDESK_OUTBOUND_MODE: "disabled",
    } as unknown as Env)).rejects.toThrow("active route health revision is unavailable");

    expect(batch.ackCount).toBe(0);
    expect(deleted).toHaveLength(0);
    expect(db.hasAuditAction("operator_delivery_result_superseded")).toBe(false);
  });

  test("an authorized inbox reply derives its external target from D1 and deletes the terminal spool", async () => {
    const policyJson = inboxRelayPolicyJson();
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
    }, policyJson);
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
      rawSha256: createHash("sha256").update(new Uint8Array(raw)).digest("hex"),
      receivedAt: "2026-08-12T00:00:00.000Z",
    }]);

    await mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
      DB: db,
      RAW_MAIL: {
        get: async () => ({ size: raw.byteLength, arrayBuffer: async () => raw }),
        delete: async (key: string) => { deleted.push(key); },
      },
      RELAY_SPOOL: {
        get: async () => ({ size: raw.byteLength, arrayBuffer: async () => raw }),
        delete: async (key: string) => { deleted.push(key); },
      },
      POLICY_STORE: policyStore(policyJson),
      MAIL_JOBS: {},
      EMAIL: email,
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
    expect(healthUpdate?.sql).toContain("policy_sha256 = ?5");
    expect(healthUpdate?.sql).toContain("rs.active_policy_sha256 = ?5");
    expect(healthUpdate?.binds[4]).toBe(
      createHash("sha256").update(policyJson).digest("hex"),
    );
  });

  test("changed reply-spool bytes fail closed before parsing or outbound delivery", async () => {
    const policyJson = inboxRelayPolicyJson();
    const db = new D1Recorder({
      id: "relay-integrity",
      thread_id: "thread-integrity",
      external_recipient: "correspondent@example.net",
      reply_identity: "security@tenant.example.com",
      original_message_id: "<original@example.net>",
      references_json: "[]",
      expires_at: "2099-01-01T00:00:00.000Z",
      revoked_at: null,
      route_address: "security@tenant.example.com",
    }, policyJson);
    const email = new SendEmailRecorder("must-not-send");
    const authenticated = new TextEncoder().encode([
      "From: Operator <operator@tenant.example.com>",
      "To: r+opaque@reply.maildesk.example.com",
      "Subject: Re: security question",
      "Message-ID: <operator-integrity@tenant.example.com>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Authenticated reply body",
    ].join("\r\n"));
    const changed = new TextEncoder().encode([
      "From: Operator <operator@tenant.example.com>",
      "To: r+opaque@reply.maildesk.example.com",
      "Subject: Re: security question",
      "Message-ID: <operator-integrity@tenant.example.com>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "CHANGED AFTER AUTHENTICATION",
    ].join("\r\n"));
    const batch = new MessageBatchRecorder([{
      kind: "inbox_reply_received",
      attemptId: "relay-attempt:integrity",
      relayId: "relay-integrity",
      operator: "operator@tenant.example.com",
      operatorMessageId: "<operator-integrity@tenant.example.com>",
      rawR2Key: "relay-spool/integrity.eml",
      rawSha256: createHash("sha256").update(authenticated).digest("hex"),
      receivedAt: "2026-08-12T00:00:00.000Z",
    }]);

    await mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
      DB: db,
      RAW_MAIL: {},
      RELAY_SPOOL: {
        get: async () => ({
          size: changed.byteLength,
          arrayBuffer: async () => changed.buffer,
        }),
      },
      POLICY_STORE: policyStore(policyJson),
      MAIL_JOBS: {},
      EMAIL: email,
      MAILDESK_OUTBOUND_MODE: "cloudflare_email_service",
      MAILDESK_VERIFIED_SENDER_DOMAINS: "tenant.example.com",
      MAILDESK_OPERATOR_DELIVERY_MODE: "inbox_relay",
      MAILDESK_MAX_ENCODED_MESSAGE_BYTES: "5242880",
    } as unknown as Env);

    expect(batch.ackCount).toBe(1);
    expect(email.messages).toHaveLength(0);
    expect(db.auditDetail("inbox_reply_failed")).toMatchObject({
      errorCode: "relay_spool_digest_mismatch",
    });
  });

  test("redelivery resumes terminal D1 projection and spool cleanup without sending twice", async () => {
    const db = new D1Recorder(undefined, undefined, "UPDATE relay_attempts SET status = ?1");
    const email = new SendEmailRecorder("provider-terminal-resume");
    const deleted: string[] = [];
    const job: MailJob = {
      kind: "outbound_reply_requested",
      messageId: "message-terminal-resume",
      threadId: "thread-terminal-resume",
      operator: "operator@tenant.example.com",
      envelopeTo: "security@tenant.example.com",
      fromIdentity: "security@tenant.example.com",
      to: ["correspondent@example.net"],
      replyTo: "security@tenant.example.com",
      subject: "Terminal resume proof",
      text: "Authorized reply body",
      requestedIdentity: "security@tenant.example.com",
      policySha256: "a".repeat(64),
      relayAttemptId: "relay-attempt:terminal-resume",
      relaySpoolKey: "relay-spool/terminal-resume.eml",
      queuedAt: "2026-08-12T00:00:00.000Z",
    };
    const env = {
      DB: db,
      RAW_MAIL: {},
      RELAY_SPOOL: {
        delete: async (key: string) => { deleted.push(key); },
      },
      MAIL_JOBS: {},
      EMAIL: email,
      MAILDESK_OUTBOUND_MODE: "cloudflare_email_service",
      MAILDESK_VERIFIED_SENDER_DOMAINS: "tenant.example.com",
    } as unknown as Env;

    const first = new MessageBatchRecorder([job]);
    await expect(
      mailApiWorker.queue(first as unknown as MessageBatch<MailJob>, env),
    ).rejects.toThrow("forced D1 failure");

    expect(email.messages).toHaveLength(1);
    expect(first.ackCount).toBe(0);
    expect(db.hasAuditAction("outbound_reply_delivered")).toBe(true);
    expect(deleted).toEqual([]);

    const redelivery = new MessageBatchRecorder([job], 2);
    await mailApiWorker.queue(redelivery as unknown as MessageBatch<MailJob>, env);

    expect(email.messages).toHaveLength(1);
    expect(redelivery.ackCount).toBe(1);
    expect(deleted).toEqual(["relay-spool/terminal-resume.eml"]);
    expect(db.statements.some((entry) =>
      entry.sql.includes("UPDATE relay_attempts SET status = ?1") &&
      entry.binds[0] === "provider_accepted"
    )).toBe(true);
    expect(db.statements.some((entry) =>
      entry.sql.includes("UPDATE relay_attempts SET raw_r2_key = NULL")
    )).toBe(true);
  });

  test("terminal redelivery cannot advance a superseding policy revision", async () => {
    const db = new D1Recorder(
      undefined,
      undefined,
      undefined,
      "UPDATE route_health SET reply_status",
      "b".repeat(64),
    );
    db.seedAudit(
      "message-policy-a:outbound_reply_requested",
      "outbound_reply_requested",
    );
    db.seedAudit(
      "message-policy-a:outbound_reply_result",
      "outbound_reply_delivered",
      {
        result: {
          ok: true,
          provider: "cloudflare_email_service",
          providerMessageId: "provider-from-policy-a",
        },
      },
    );
    const email = new SendEmailRecorder("must-not-send");
    const deleted: string[] = [];
    const job: MailJob = {
      kind: "outbound_reply_requested",
      messageId: "message-policy-a",
      threadId: "thread-policy-a",
      operator: "operator@tenant.example.com",
      envelopeTo: "security@tenant.example.com",
      fromIdentity: "security@tenant.example.com",
      to: ["correspondent@example.net"],
      subject: "Superseded terminal result",
      text: "Already delivered under policy A",
      requestedIdentity: "security@tenant.example.com",
      policySha256: "a".repeat(64),
      relayAttemptId: "relay-attempt:policy-a",
      relaySpoolKey: "relay-spool/policy-a.eml",
      queuedAt: "2026-08-12T00:00:00.000Z",
    };

    const batch = new MessageBatchRecorder([job], 2);
    await mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
      DB: db,
      RAW_MAIL: {},
      RELAY_SPOOL: { delete: async (key: string) => { deleted.push(key); } },
      MAIL_JOBS: {},
      EMAIL: email,
      MAILDESK_OUTBOUND_MODE: "cloudflare_email_service",
      MAILDESK_VERIFIED_SENDER_DOMAINS: "tenant.example.com",
    } as unknown as Env);

    expect(batch.ackCount).toBe(1);
    expect(email.messages).toHaveLength(0);
    expect(deleted).toEqual(["relay-spool/policy-a.eml"]);
    expect(db.hasAuditAction("outbound_reply_result_superseded")).toBe(true);
    const healthUpdate = db.statements.find((entry) => entry.sql.includes("UPDATE route_health SET reply_status"));
    expect(healthUpdate?.binds[4]).toBe("a".repeat(64));
    expect(healthUpdate?.sql).toContain("policy_sha256 = ?5");
    expect(healthUpdate?.sql).toContain("rs.active_policy_sha256 = ?5");
  });

  test("a superseded policy job cannot reach the outbound provider", async () => {
    const policyJson = inboxRelayPolicyJson();
    const db = new D1Recorder(undefined, policyJson);
    const email = new SendEmailRecorder("must-not-send");
    const job: MailJob = {
      kind: "outbound_reply_requested",
      messageId: "message-stale-policy-send",
      threadId: "thread-stale-policy-send",
      operator: "operator@tenant.example.com",
      envelopeTo: "security@tenant.example.com",
      fromIdentity: "security@tenant.example.com",
      to: ["correspondent@example.net"],
      subject: "Stale policy send",
      text: "Must not reach the provider",
      requestedIdentity: "security@tenant.example.com",
      policySha256: "a".repeat(64),
      relayAttemptId: "relay-attempt:stale-policy-send",
      relaySpoolKey: "relay-spool/stale-policy-send.eml",
      queuedAt: "2026-08-12T00:00:00.000Z",
    };

    const batch = new MessageBatchRecorder([job]);
    await mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
      DB: db,
      RAW_MAIL: {},
      RELAY_SPOOL: {},
      POLICY_STORE: policyStore(policyJson),
      MAIL_JOBS: {},
      EMAIL: email,
      MAILDESK_OPERATOR_DELIVERY_MODE: "inbox_relay",
      MAILDESK_OUTBOUND_MODE: "cloudflare_email_service",
      MAILDESK_VERIFIED_SENDER_DOMAINS: "tenant.example.com",
    } as unknown as Env);

    expect(email.messages).toHaveLength(0);
    expect(batch.ackCount).toBe(1);
    expect(batch.retryCount).toBe(0);
    expect(db.auditDetail("outbound_reply_failed")).toMatchObject({
      result: { error: "relay policy revision is no longer active" },
    });
  });

  test("missing active-revision reply health retains terminal recovery for retry", async () => {
    const db = new D1Recorder(
      undefined,
      undefined,
      undefined,
      "UPDATE route_health SET reply_status",
      "a".repeat(64),
    );
    db.seedAudit(
      "message-active-policy:outbound_reply_requested",
      "outbound_reply_requested",
    );
    db.seedAudit(
      "message-active-policy:outbound_reply_result",
      "outbound_reply_delivered",
      {
        result: {
          ok: true,
          provider: "cloudflare_email_service",
          providerMessageId: "provider-active-policy",
        },
      },
    );
    const deleted: string[] = [];
    const job: MailJob = {
      kind: "outbound_reply_requested",
      messageId: "message-active-policy",
      threadId: "thread-active-policy",
      operator: "operator@tenant.example.com",
      envelopeTo: "security@tenant.example.com",
      fromIdentity: "security@tenant.example.com",
      to: ["correspondent@example.net"],
      subject: "Active terminal recovery",
      text: "Already delivered under active policy",
      requestedIdentity: "security@tenant.example.com",
      policySha256: "a".repeat(64),
      relayAttemptId: "relay-attempt:active-policy",
      relaySpoolKey: "relay-spool/active-policy.eml",
      queuedAt: "2026-08-12T00:00:00.000Z",
    };

    const batch = new MessageBatchRecorder([job], 2);
    await expect(mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
      DB: db,
      RAW_MAIL: {},
      RELAY_SPOOL: { delete: async (key: string) => { deleted.push(key); } },
      MAIL_JOBS: {},
      MAILDESK_OUTBOUND_MODE: "disabled",
    } as unknown as Env)).rejects.toThrow("active route health revision is unavailable");

    expect(batch.ackCount).toBe(0);
    expect(deleted).toHaveLength(0);
    expect(db.hasAuditAction("outbound_reply_result_superseded")).toBe(false);
  });

  test("inbox relay rejects opaque outbound attachments before provider send", async () => {
    const policyJson = inboxRelayPolicyJson();
    const db = new D1Recorder({
      id: "relay-leak",
      thread_id: "thread-leak",
      external_recipient: "correspondent@example.net",
      reply_identity: "security@tenant.example.com",
      original_message_id: "<original@example.net>",
      references_json: "[]",
      expires_at: "2099-01-01T00:00:00.000Z",
      revoked_at: null,
      route_address: "security@tenant.example.com",
    }, policyJson);
    const email = new SendEmailRecorder("must-not-send");
    const raw = new TextEncoder().encode([
      "From: Operator <operator@tenant.example.com>",
      "To: relay@example.net",
      "Subject: Re: security question",
      "Message-ID: <operator-leak@tenant.example.com>",
      'Content-Type: multipart/mixed; boundary="reply-boundary"',
      "",
      "--reply-boundary",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Safe reply body",
      "--reply-boundary",
      'Content-Type: text/plain; name="notes.txt"',
      'Content-Disposition: attachment; filename="notes.txt"',
      "Content-Transfer-Encoding: base64",
      "",
      "b3BlcmF0b3JAdGVuYW50LmV4YW1wbGUuY29t",
      "--reply-boundary--",
    ].join("\r\n")).buffer;
    const batch = new MessageBatchRecorder([{
      kind: "inbox_reply_received",
      attemptId: "relay-attempt:leak",
      relayId: "relay-leak",
      operator: "operator@tenant.example.com",
      operatorMessageId: "<operator-leak@tenant.example.com>",
      rawR2Key: "relay-spool/leak.eml",
      rawSha256: createHash("sha256").update(new Uint8Array(raw)).digest("hex"),
      receivedAt: "2026-08-12T00:00:00.000Z",
    }]);

    await mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
      DB: db,
      RAW_MAIL: { get: async () => ({ size: raw.byteLength, arrayBuffer: async () => raw }) },
      RELAY_SPOOL: { get: async () => ({ size: raw.byteLength, arrayBuffer: async () => raw }) },
      POLICY_STORE: policyStore(policyJson),
      MAIL_JOBS: {},
      EMAIL: email,
      MAILDESK_OUTBOUND_MODE: "cloudflare_email_service",
      MAILDESK_VERIFIED_SENDER_DOMAINS: "tenant.example.com",
      MAILDESK_OPERATOR_DELIVERY_MODE: "inbox_relay",
      MAILDESK_MAX_ENCODED_MESSAGE_BYTES: "5242880",
    } as unknown as Env);

    expect(email.messages).toHaveLength(0);
    expect(batch.ackCount).toBe(1);
    const result = db.auditDetail("outbound_reply_failed") as { result?: { error?: string } };
    expect(result.result?.error).toBe(
      "outbound attachments are disabled until format-aware privacy inspection is configured",
    );
  });

  test("inbox relay rejects normalized private operator identity in visible content", async () => {
    const policyJson = inboxRelayPolicyJson();
    const db = new D1Recorder({
      id: "relay-visible-leak",
      thread_id: "thread-visible-leak",
      external_recipient: "correspondent@example.net",
      reply_identity: "security@tenant.example.com",
      original_message_id: "<original@example.net>",
      references_json: "[]",
      expires_at: "2099-01-01T00:00:00.000Z",
      revoked_at: null,
      route_address: "security@tenant.example.com",
    }, policyJson);
    const email = new SendEmailRecorder("must-not-send");
    const raw = new TextEncoder().encode([
      "From: Operator <operator@tenant.example.com>",
      "To: relay@example.net",
      "Subject: Re: security question",
      "Message-ID: <operator-visible-leak@tenant.example.com>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Contact operator\u2060@tenant.example.com",
    ].join("\r\n")).buffer;
    const batch = new MessageBatchRecorder([{
      kind: "inbox_reply_received",
      attemptId: "relay-attempt:visible-leak",
      relayId: "relay-visible-leak",
      operator: "operator@tenant.example.com",
      operatorMessageId: "<operator-visible-leak@tenant.example.com>",
      rawR2Key: "relay-spool/visible-leak.eml",
      rawSha256: createHash("sha256").update(new Uint8Array(raw)).digest("hex"),
      receivedAt: "2026-08-12T00:00:00.000Z",
    }]);

    await mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
      DB: db,
      RAW_MAIL: { get: async () => ({ size: raw.byteLength, arrayBuffer: async () => raw }) },
      RELAY_SPOOL: { get: async () => ({ size: raw.byteLength, arrayBuffer: async () => raw }) },
      POLICY_STORE: policyStore(policyJson),
      MAIL_JOBS: {},
      EMAIL: email,
      MAILDESK_OUTBOUND_MODE: "cloudflare_email_service",
      MAILDESK_VERIFIED_SENDER_DOMAINS: "tenant.example.com",
      MAILDESK_OPERATOR_DELIVERY_MODE: "inbox_relay",
      MAILDESK_MAX_ENCODED_MESSAGE_BYTES: "5242880",
    } as unknown as Env);

    expect(email.messages).toHaveLength(0);
    expect(batch.ackCount).toBe(1);
    const result = db.auditDetail("outbound_reply_failed") as { result?: { error?: string } };
    expect(result.result?.error).toBe("outbound content contains a private operator identity");
  });

  test("inbox relay rejects Unicode compatibility forms of a private operator identity", async () => {
    const policyJson = inboxRelayPolicyJson();
    const db = new D1Recorder(undefined, policyJson);
    const email = new SendEmailRecorder("must-not-send");
    const batch = new MessageBatchRecorder([{
      kind: "outbound_reply_requested",
      messageId: "compatibility-leak",
      threadId: "thread-compatibility-leak",
      operator: "operator@tenant.example.com",
      envelopeTo: "security@tenant.example.com",
      fromIdentity: "security@tenant.example.com",
      to: ["correspondent@example.net"],
      subject: "Reply",
      text: "Contact ｏｐｅｒａｔｏｒ＠ｔｅｎａｎｔ．ｅｘａｍｐｌｅ．ｃｏｍ",
      queuedAt: "2026-08-12T00:00:00.000Z",
    }]);

    await mailApiWorker.queue(batch as unknown as MessageBatch<MailJob>, {
      DB: db,
      RAW_MAIL: {},
      POLICY_STORE: policyStore(policyJson),
      MAIL_JOBS: {},
      EMAIL: email,
      MAILDESK_OUTBOUND_MODE: "cloudflare_email_service",
      MAILDESK_VERIFIED_SENDER_DOMAINS: "tenant.example.com",
      MAILDESK_OPERATOR_DELIVERY_MODE: "inbox_relay",
    } as unknown as Env);

    expect(email.messages).toHaveLength(0);
    const result = db.auditDetail("outbound_reply_failed") as { result?: { error?: string } };
    expect(result.result?.error).toBe("outbound content contains a private operator identity");
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

  test("an exhausted Resend failure records a terminal result and enters the configured DLQ", async () => {
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

    expect(batch.retryCount).toBe(1);
    expect(batch.retryDelaySeconds).toBe(0);
    expect(batch.ackCount).toBe(0);
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

  test("readiness rejects an explicit invalid relay processing mode", async () => {
    const response = await mailApiWorker.fetch(
      new Request("https://maildesk.example.com/readyz"),
      {
        DB: new D1Recorder(),
        RAW_MAIL: {},
        MAIL_JOBS: {},
        EMAIL: new SendEmailRecorder("unused"),
        MAILDESK_POLICY_JSON: JSON.stringify({ domains: {} }),
        MAILDESK_OPERATOR_DELIVERY_MODE: "inbox_relay",
        MAILDESK_RELAY_PROCESSING_MODE: "enabledd",
        MAILDESK_REPLY_DOMAIN: "reply.maildesk.example.com",
      } as unknown as Env,
    );

    expect(response.status).toBe(503);
    const report = await response.json() as {
      checks: Array<{ name: string; ok: boolean; detail?: string }>;
    };
    expect(report.checks).toContainEqual({
      name: "inbound_relay_mode",
      ok: false,
      detail: "invalid",
    });
    expect(report.checks).toContainEqual({
      name: "reply_relay_mode",
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
  private failedOnce = false;

  constructor(
    private readonly relayRow?: Record<string, unknown>,
    private readonly activePolicyJson?: string,
    private readonly failOnceSql?: string,
    private readonly zeroChangesSql?: string,
    private readonly runtimePolicySha256?: string,
  ) {}

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
        if (!recorder.failedOnce && recorder.failOnceSql && sql.includes(recorder.failOnceSql)) {
          recorder.failedOnce = true;
          throw new Error(`forced D1 failure for ${recorder.failOnceSql}`);
        }
        if (recorder.zeroChangesSql && sql.includes(recorder.zeroChangesSql)) {
          statements.push(record);
          return { success: true, meta: { changes: 0 } };
        }
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
        if (record.sql.includes("SELECT active_policy_sha256 FROM runtime_state")) {
          return recorder.runtimePolicySha256
            ? { active_policy_sha256: recorder.runtimePolicySha256 }
            : null;
        }
        if (record.sql.includes("SELECT rs.active_policy_sha256") && activePolicyJson) {
          const digest = createHash("sha256").update(activePolicyJson).digest("hex");
          return {
            active_policy_sha256: digest,
            active_policy_r2_key: `config/policy/${digest}.json`,
            revision_sha256: digest,
            revision_r2_key: `config/policy/${digest}.json`,
            expected_domain_count: 1,
            expected_route_count: 1,
            projected_route_count: 1,
            projected_domain_count: 1,
          };
        }
        if (record.sql.includes("FROM reply_relays rr")) {
          return thisRelayRow;
        }
        if (record.sql.includes("SELECT action, detail_json FROM audit_events")) {
          const dedupeKey = record.binds[0];
          const existing = statements.find(
            (entry) =>
              entry.sql.includes("INSERT OR IGNORE INTO audit_events") &&
              entry.binds[1] === dedupeKey,
          );
          return existing ? { action: existing.binds[4], detail_json: existing.binds[5] } : null;
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
    const recorder = this;
    const thisRelayRow = this.relayRow ?? null;
    const activePolicyJson = this.activePolicyJson;
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

function policyStore(policyJson: string): R2Bucket {
  const digest = createHash("sha256").update(policyJson).digest("hex");
  return {
    get: async (key: string) => key === `config/policy/${digest}.json`
      ? { arrayBuffer: async () => new TextEncoder().encode(policyJson).buffer }
      : null,
  } as unknown as R2Bucket;
}

function inboxRelayPolicyJson(): string {
  return JSON.stringify({
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
  });
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
