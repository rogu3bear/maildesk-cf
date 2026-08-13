import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import mailRouterWorker from "../../workers/mail-router/src/index";
import type { RouterPolicy } from "../../workers/shared/router";
import {
  buildOperatorDelivery,
  encodedMessageUpperBound,
  outboundReplyPayload,
  parseRelayEmail,
  relayAddress,
  relayRecordIsActive,
  relayTokenFromRecipient,
} from "../../workers/shared/inbox-relay";

const policy = {
  default_reply_mode: "role_first",
  domains: {
    "example.com": {
      role_aliases: {
        security: {
          operators: ["operator-a@example.com", "operator-b@example.com"],
          reply_identity: "security@example.com",
          allowed_reply_identities: ["security@example.com"],
        },
      },
      personal_aliases: {},
    },
  },
};

test("inbox relay creates one bannered delivery per authorized operator and persists only a token hash", async () => {
  const db = new RelayD1();
  const deliveries: EmailMessageBuilder[] = [];
  const message = inboundMessage(
    "sender@example.net",
    "security@example.com",
    mime({ from: "Alice Example <sender@example.net>", messageId: "<original@example.net>" }),
  );

  await mailRouterWorker.email(message, relayEnv(db, deliveries), {} as ExecutionContext);

  expect(message.rejected).toBeUndefined();
  expect(deliveries).toHaveLength(2);
  expect(deliveries.map((delivery) => delivery.to)).toEqual([
    "operator-a@example.com",
    "operator-b@example.com",
  ]);
  for (const delivery of deliveries) {
    expect(delivery.from).toEqual({
      name: "Alice Example via security@example.com",
      email: "security@example.com",
    });
    expect(delivery.replyTo).toMatch(/^r\+[a-f0-9]{64}@reply\.maildesk\.example\.com$/);
    expect(delivery.text).toContain("Received at: security@example.com");
    expect(delivery.text).toContain("Policy result: Delivered to 2 authorized operators");
    expect(delivery.text).toContain("Your personal operator address will not be sent");
    expect(delivery.html).toContain("Maildesk route");
  }
  const relayInsert = db.calls.find((call) => call.sql.includes("INSERT INTO reply_relays"));
  expect(relayInsert).toBeDefined();
  expect(relayInsert?.bindings[1]).toMatch(/^[a-f0-9]{64}$/);
  expect(relayInsert?.bindings.join(" ")).not.toContain("r+");
  expect(db.calls.some((call) => call.sql.includes("INSERT INTO messages"))).toBe(false);
  const threadInsert = db.calls.find((call) => call.sql.includes("INSERT INTO threads"));
  expect(threadInsert?.sql).toContain("subject, status) SELECT ?1, ?2, ?3, ?4, NULL");
  expect(threadInsert?.sql).toContain("rs.active_policy_sha256 = ar.policy_sha256");
  expect(db.calls.some((call) => call.sql.includes("INSERT INTO alias_routes"))).toBe(false);
  expect(db.calls.some((call) => call.sql.includes("INSERT INTO alias_route_operators"))).toBe(false);
  const recipientAudits = db.calls.filter(
    (call) => call.sql.includes("INSERT INTO audit_events") &&
      String(call.bindings[4]).startsWith("operator_delivery_recipient_"),
  );
  expect(recipientAudits).toHaveLength(2);
  expect(recipientAudits.every((call) => !String(call.bindings[5]).includes("operator-a@example.com"))).toBe(true);
  expect(recipientAudits.every((call) => !String(call.bindings[5]).includes("operator-b@example.com"))).toBe(true);
  expect(db.calls.some((call) => call.sql.includes("INSERT INTO route_health"))).toBe(false);
  const healthResult = db.calls.find((call) => call.sql.includes("UPDATE route_health SET inbound_status"));
  expect(healthResult?.sql).toContain("inbound_status = 'inbox_verified'");
});

test("inbox relay binds the external destination to the visible sender, not an untrusted Reply-To", async () => {
  const db = new RelayD1();
  const message = inboundMessage(
    "sender@example.net",
    "security@example.com",
    mime({
      from: "Alice Example <sender@example.net>",
      replyTo: "redirect-target@example.org",
      messageId: "<redirect-attempt@example.net>",
    }),
  );

  await mailRouterWorker.email(message, relayEnv(db, []), {} as ExecutionContext);

  expect(message.rejected).toBeUndefined();
  const relayInsert = db.calls.find((call) => call.sql.includes("INSERT INTO reply_relays"));
  expect(relayInsert?.bindings[4]).toBe("sender@example.net");
  expect(relayInsert?.bindings).not.toContain("redirect-target@example.org");
});

test("a pre-send spool failure rejects before any operator delivery", async () => {
  const db = new RelayD1();
  const message = inboundMessage(
    "sender@example.net",
    "security@example.com",
    mime({ from: "sender@example.net", messageId: "<spool-failure@example.net>" }),
  );
  const env = relayEnv(db, []);
  let providerCalls = 0;
  env.EMAIL = { send: async () => { providerCalls += 1; return { messageId: "must-not-send" }; } } as SendEmail;
  env.RELAY_SPOOL = {
    put: async () => { throw new Error("spool unavailable"); },
  } as unknown as R2Bucket;

  await mailRouterWorker.email(message, env, {} as ExecutionContext);

  expect(message.rejected).toContain("could not create a durable operator-delivery spool");
  expect(providerCalls).toBe(0);
  expect(db.calls.some((call) => call.sql.includes("UPDATE route_health SET inbound_status"))).toBe(false);
});

test("route identifiers preserve distinct valid alias characters", async () => {
  const db = new RelayD1();
  const message = inboundMessage(
    "sender@example.net",
    "team+ops@example.com",
    mime({ from: "sender@example.net", messageId: "<plus-route@example.net>" }),
  );
  const env = relayEnv(db, [], {
      default_reply_mode: "role_first",
      domains: {
        "example.com": {
          role_aliases: {
            "team+ops": {
              operators: ["operator-a@example.com"],
              reply_identity: "team+ops@example.com",
              allowed_reply_identities: ["team+ops@example.com"],
            },
          },
          personal_aliases: {},
        },
      },
    });

  await mailRouterWorker.email(
    message,
    env as unknown as Parameters<typeof mailRouterWorker.email>[1],
    {} as ExecutionContext,
  );

  expect(message.rejected).toBeUndefined();
  const threadInsert = db.calls.find((call) => call.sql.includes("INSERT INTO threads"));
  expect(threadInsert?.bindings[2]).toBe("route:example.com:team%2Bops");
});

test("catch-all delivery advances the declared wildcard route while showing the actual recipient", async () => {
  const db = new RelayD1();
  const deliveries: EmailMessageBuilder[] = [];
  const message = inboundMessage(
    "sender@example.net",
    "unlisted@example.com",
    mime({ from: "sender@example.net", messageId: "<catch-all@example.net>" }),
  );
  const env = relayEnv(db, deliveries, {
      default_reply_mode: "role_first",
      domains: {
        "example.com": {
          role_aliases: {},
          personal_aliases: {},
          catch_all: {
            operators: ["operator-a@example.com"],
            reply_identity: "info@example.com",
            allowed_reply_identities: ["info@example.com"],
          },
        },
      },
    });

  await mailRouterWorker.email(
    message,
    env as unknown as Parameters<typeof mailRouterWorker.email>[1],
    {} as ExecutionContext,
  );

  expect(message.rejected).toBeUndefined();
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]?.from).toEqual({
    name: "sender@example.net via unlisted@example.com",
    email: "info@example.com",
  });
  expect(deliveries[0]?.text).toContain("Received at: unlisted@example.com");
  const threadInsert = db.calls.find((call) => call.sql.includes("INSERT INTO threads"));
  expect(threadInsert?.bindings.slice(1, 3)).toEqual([
    "domain:example.com",
    "route:example.com:*",
  ]);
  const healthAdvance = db.calls.find((call) => call.sql.includes("UPDATE route_health SET last_inbound_at"));
  expect(healthAdvance?.bindings[1]).toBe("route:example.com:*");
});

test("accepted inbound deliveries retain a spool and enqueue body-free recovery when D1 projection fails", async () => {
  const db = new RelayD1("UPDATE route_health SET inbound_status");
  const deliveries: EmailMessageBuilder[] = [];
  const queued: unknown[] = [];
  const puts: string[] = [];
  const deletes: string[] = [];
  const message = inboundMessage(
    "sender@example.net",
    "security@example.com",
    mime({ from: "sender@example.net", messageId: "<audit-recovery@example.net>" }),
  );
  const env = relayEnv(db, deliveries);
  env.MAIL_JOBS = { send: async (job: unknown) => { queued.push(job); } } as unknown as Queue;
  env.RELAY_SPOOL = {
    put: async (key: string) => { puts.push(key); },
    delete: async (key: string) => { deletes.push(key); },
  } as unknown as R2Bucket;

  await mailRouterWorker.email(message, env, {} as ExecutionContext);

  expect(message.rejected).toBeUndefined();
  expect(deliveries).toHaveLength(2);
  expect(puts).toHaveLength(1);
  expect(deletes).toHaveLength(0);
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({
    kind: "inbound_delivery_result",
    status: "provider_accepted",
    results: [
      { ok: true, providerMessageId: "provider-1" },
      { ok: true, providerMessageId: "provider-2" },
    ],
  });
  expect(JSON.stringify(queued[0])).not.toContain("operator-a@example.com");
  expect(JSON.stringify(queued[0])).not.toContain("operator-b@example.com");
});

test("a policy revision change during persistence rejects without rewriting route authority", async () => {
  const db = new RelayD1(undefined, true);
  const deliveries: EmailMessageBuilder[] = [];
  const message = inboundMessage(
    "sender@example.net",
    "security@example.com",
    mime({ from: "sender@example.net", messageId: "<revision-race@example.net>" }),
  );

  await mailRouterWorker.email(message, relayEnv(db, deliveries), {} as ExecutionContext);

  expect(message.rejected).toContain("could not create a durable route");
  expect(deliveries).toHaveLength(0);
  expect(db.calls.some((call) => call.sql.includes("INSERT INTO alias_routes"))).toBe(false);
  expect(db.calls.some((call) => call.sql.includes("INSERT INTO alias_route_operators"))).toBe(false);
});

test("inbox relay rejects malformed and oversized messages without direct-forward fallback", async () => {
  const malformed = inboundMessage("sender@example.net", "security@example.com", "not mime");
  malformed.rawSize = 10;
  await mailRouterWorker.email(malformed, relayEnv(new RelayD1(), []), {} as ExecutionContext);
  expect(malformed.rejected).toBeDefined();
  expect(malformed.forwarded).toHaveLength(0);

  const oversized = inboundMessage(
    "sender@example.net",
    "security@example.com",
    mime({ from: "sender@example.net", messageId: "<large@example.net>" }),
  );
  oversized.rawSize = 5_242_881;
  await mailRouterWorker.email(oversized, relayEnv(new RelayD1(), []), {} as ExecutionContext);
  expect(oversized.rejected).toContain("5 MiB");
  expect(oversized.forwarded).toHaveLength(0);
});

test("inbox relay is fail-closed until relay processing is explicitly enabled", async () => {
  const db = new RelayD1();
  const deliveries: EmailMessageBuilder[] = [];
  const message = inboundMessage(
    "sender@example.net",
    "security@example.com",
    mime({ from: "sender@example.net", messageId: "<dark@example.net>" }),
  );
  const env = relayEnv(db, deliveries);
  delete env.MAILDESK_RELAY_PROCESSING_MODE;
  delete env.MAILDESK_INBOUND_RELAY_MODE;
  delete env.MAILDESK_REPLY_RELAY_MODE;

  await mailRouterWorker.email(
    message,
    env as unknown as Parameters<typeof mailRouterWorker.email>[1],
    {} as ExecutionContext,
  );

  expect(message.rejected).toContain("inbound relay is disabled");
  expect(deliveries).toHaveLength(0);
  expect(db.calls).toHaveLength(0);
  expect(message.forwarded).toHaveLength(0);
});

test("opaque reply relay is side-effect free while relay processing is disabled", async () => {
  const db = new RelayD1();
  const deliveries: EmailMessageBuilder[] = [];
  const effects = { r2: 0, queue: 0 };
  const message = inboundMessage(
    "operator-a@example.com",
    relayAddress("c".repeat(64), "reply.maildesk.example.com"),
    mime({ from: "operator-a@example.com", messageId: "<dark-reply@example.com>" }),
  );
  const env = {
    ...relayEnv(db, deliveries),
    MAILDESK_REPLY_RELAY_MODE: "disabled" as const,
    RAW_MAIL: {
      put: async () => { effects.r2 += 1; },
      get: async () => { effects.r2 += 1; return null; },
      delete: async () => { effects.r2 += 1; },
    } as unknown as R2Bucket,
    MAIL_JOBS: {
      send: async () => { effects.queue += 1; },
    } as unknown as Queue,
  };

  await mailRouterWorker.email(
    message,
    env as unknown as Parameters<typeof mailRouterWorker.email>[1],
    {} as ExecutionContext,
  );

  expect(message.rejected).toContain("reply relay is disabled");
  expect(db.calls).toHaveLength(0);
  expect(effects).toEqual({ r2: 0, queue: 0 });
  expect(deliveries).toHaveLength(0);
  expect(message.forwarded).toHaveLength(0);
});

test("inbox relay rejects an invalid relay processing mode", async () => {
  const message = inboundMessage(
    "sender@example.net",
    "security@example.com",
    mime({ from: "sender@example.net", messageId: "<invalid-processing@example.net>" }),
  );
  const env = {
    ...relayEnv(new RelayD1(), []),
    MAILDESK_RELAY_PROCESSING_MODE: "enabledd",
  };

  await mailRouterWorker.email(
    message,
    env as unknown as Parameters<typeof mailRouterWorker.email>[1],
    {} as ExecutionContext,
  );

  expect(message.rejected).toContain("processing mode is invalid");
  expect(message.forwarded).toHaveLength(0);
});

test("invalid delivery configuration and relay timestamps fail closed", async () => {
  const message = inboundMessage(
    "sender@example.net",
    "security@example.com",
    mime({ from: "sender@example.net", messageId: "<invalid-mode@example.net>" }),
  );
  const env = {
    ...relayEnv(new RelayD1(), []),
    MAILDESK_OPERATOR_DELIVERY_MODE: "inbox-relayy",
  };

  await mailRouterWorker.email(
    message,
    env as unknown as Parameters<typeof mailRouterWorker.email>[1],
    {} as ExecutionContext,
  );

  expect(message.rejected).toContain("delivery mode is invalid");
  expect(message.forwarded).toHaveLength(0);
  expect(relayRecordIsActive("not-a-timestamp", null, 0)).toBe(false);
  expect(relayRecordIsActive("2026-08-12T00:00:00.000Z", null, Date.parse("2026-08-12T00:00:00.000Z"))).toBe(false);
  expect(relayRecordIsActive("2099-01-01T00:00:00.000Z", "2026-08-12T00:00:00.000Z", 0)).toBe(false);
  expect(relayRecordIsActive("2099-01-01T00:00:00.000Z", null, 0)).toBe(true);
});

test("reply relay requires cryptographic aligned DKIM before token lookup", async () => {
  const token = "a".repeat(64);
  const message = inboundMessage(
    "operator-a@example.com",
    relayAddress(token, "reply.maildesk.example.com"),
    mime({ from: "operator-a@example.com", messageId: "<reply@example.com>" }),
  );
  message.headers.set("Authentication-Results", "mx.invalid; spf=pass smtp.mailfrom=operator-a@example.com");
  const db = new RelayD1();

  await mailRouterWorker.email(message, relayEnv(db, []), {} as ExecutionContext);

  expect(message.rejected).toContain("aligned email authentication");
  expect(db.calls.some((call) => call.sql.includes("token_sha256"))).toBe(false);
});

test("relay helpers preserve content and bind lowercase opaque addresses", async () => {
  const parsed = await parseRelayEmail(new TextEncoder().encode(mime({
    from: "Alice Example <sender@example.net>",
    messageId: "<one@example.net>",
  })).buffer);
  const delivery = buildOperatorDelivery(parsed, {
    operator: "operator-a@example.com",
    receivedAddress: "unlisted@example.com",
    replyIdentity: "info@example.com",
    routeKind: "role_alias",
    operatorCount: 2,
    relayAddress: relayAddress("b".repeat(64), "reply.maildesk.example.com"),
    deliveryMessageId: "<delivery@reply.maildesk.example.com>",
  });
  expect(relayTokenFromRecipient(String(delivery.replyTo), "reply.maildesk.example.com")).toBe("b".repeat(64));
  expect(delivery.from).toEqual({
    name: "Alice Example via unlisted@example.com",
    email: "info@example.com",
  });
  expect(delivery.text).toContain("Received at: unlisted@example.com");
  expect(delivery.text).toContain("send the response to the correspondent from info@example.com");
  expect(delivery.headers["X-Maildesk-Original-To"]).toBe("unlisted@example.com");
  expect(delivery.headers["X-Maildesk-Reply-Identity"]).toBe("info@example.com");
  expect(encodedMessageUpperBound(delivery)).toBeGreaterThan(delivery.text.length);
});

test("encoded-size ceiling covers transfer encoding and base64 line wrapping", () => {
  const unicodeText = "é=".repeat(1_000);
  const attachment = new Uint8Array(7_600).buffer;
  const rawTextBytes = new TextEncoder().encode(unicodeText).byteLength;
  const base64Bytes = Math.ceil(attachment.byteLength / 3) * 4;
  const base64LineBreaks = Math.ceil(base64Bytes / 76) * 2;
  const bound = encodedMessageUpperBound({
    subject: unicodeText,
    text: unicodeText,
    attachments: [{
      disposition: "inline",
      filename: "résumé=.txt",
      type: "text/plain",
      contentId: "operator-image@example.invalid",
      content: attachment,
    }],
  });

  expect(bound).toBeGreaterThanOrEqual(16 * 1024 + rawTextBytes * 8 + base64Bytes + base64LineBreaks);
});

test("operator reply HTML is regenerated only from verified plaintext", () => {
  const payload = outboundReplyPayload({
    from: { address: "operator@example.com" },
    subject: "Reply",
    text: "Safe <reply>\u2060 body",
    html: '<p>oper<span style="display:none">X</span>ator@example.com</p>',
    references: [],
    attachments: [],
  });
  expect(payload.text).toBe("Safe <reply>\u2060 body");
  expect(payload.html).toBe('<pre style="white-space:pre-wrap">Safe &lt;reply&gt;\u2060 body</pre>');
  expect(payload.html).not.toContain("display:none");
  expect(() => outboundReplyPayload({
    from: { address: "operator@example.com" },
    subject: "HTML only",
    text: "",
    html: "<p>HTML only</p>",
    references: [],
    attachments: [],
  })).toThrow("plaintext MIME alternative");
});

function relayEnv(db: RelayD1, deliveries: EmailMessageBuilder[], policyValue: RouterPolicy = policy) {
  const policyJson = JSON.stringify(policyValue);
  const policySha256 = createHash("sha256").update(policyJson).digest("hex");
  db.activePolicy = { sha256: policySha256, json: policyJson };
  const relaySpool = {
    put: async () => undefined,
    get: async () => null,
    delete: async () => undefined,
  } as unknown as R2Bucket;
  return {
    DB: db as unknown as D1Database,
    RAW_MAIL: relaySpool,
    RELAY_SPOOL: relaySpool,
    POLICY_STORE: {
      get: async (key: string) => key === `config/policy/${policySha256}.json`
        ? { arrayBuffer: async () => new TextEncoder().encode(policyJson).buffer }
        : null,
    } as unknown as R2Bucket,
    MAIL_JOBS: { send: async () => undefined } as unknown as Queue,
    EMAIL: {
      send: async (delivery: EmailMessageBuilder) => {
        deliveries.push(delivery);
        return { messageId: `provider-${deliveries.length}` };
      },
    } as SendEmail,
    MAILDESK_OPERATOR_DELIVERY_MODE: "inbox_relay",
    MAILDESK_INBOUND_RELAY_MODE: "enabled" as const,
    MAILDESK_REPLY_RELAY_MODE: "enabled" as const,
    MAILDESK_REPLY_DOMAIN: "reply.maildesk.example.com",
    MAILDESK_REPLY_TOKEN_TTL_DAYS: "90",
    MAILDESK_SPOOL_RETENTION_DAYS: "7",
    MAILDESK_MAX_ENCODED_MESSAGE_BYTES: "5242880",
  };
}

function inboundMessage(from: string, to: string, raw: string) {
  const bytes = new TextEncoder().encode(raw);
  const forwarded: string[] = [];
  const message = {
    from,
    to,
    raw: new Blob([bytes]).stream(),
    rawSize: bytes.byteLength,
    headers: new Headers(),
    rejected: undefined as string | undefined,
    forwarded,
    setReject(reason: string) { this.rejected = reason; },
    async forward(recipient: string) { forwarded.push(recipient); return { messageId: "forwarded" }; },
    async reply() { return { messageId: "reply" }; },
  };
  return message;
}

function mime(input: { from: string; replyTo?: string; messageId: string }): string {
  return [
    `From: ${input.from}`,
    ...(input.replyTo ? [`Reply-To: ${input.replyTo}`] : []),
    "To: security@example.com",
    "Subject: Security question",
    `Message-ID: ${input.messageId}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Please review the attached question.",
  ].join("\r\n");
}

class RelayD1 {
  calls: Array<{ sql: string; bindings: unknown[] }> = [];
  activePolicy?: { sha256: string; json: string };
  private failedOnce = false;

  constructor(
    private readonly failOnceSql?: string,
    private readonly rejectPolicyBoundPersistence = false,
  ) {}

  prepare(sql: string): D1PreparedStatement {
    const call = { sql, bindings: [] as unknown[] };
    this.calls.push(call);
    const statement = {
      bind: (...bindings: unknown[]) => { call.bindings = bindings; return statement; },
      run: async () => {
        if (!this.failedOnce && this.failOnceSql && sql.includes(this.failOnceSql)) {
          this.failedOnce = true;
          throw new Error(`forced D1 failure for ${this.failOnceSql}`);
        }
        return { success: true, meta: { changes: 1 } };
      },
      first: async () => sql.includes("SELECT rs.active_policy_sha256") && this.activePolicy
        ? {
            active_policy_sha256: this.activePolicy.sha256,
            active_policy_r2_key: `config/policy/${this.activePolicy.sha256}.json`,
            revision_sha256: this.activePolicy.sha256,
            revision_r2_key: `config/policy/${this.activePolicy.sha256}.json`,
            expected_domain_count: 1,
            expected_route_count: 1,
            projected_route_count: 1,
            projected_domain_count: 1,
          }
        : null,
      all: async () => ({ success: true, results: [], meta: {} }),
      raw: async () => [],
    };
    return statement as unknown as D1PreparedStatement;
  }

  async batch(statements: D1PreparedStatement[]) {
    return statements.map((_, index) => ({
      success: true,
      meta: { changes: this.rejectPolicyBoundPersistence && index < 2 ? 0 : 1 },
      results: [],
    }));
  }
}
