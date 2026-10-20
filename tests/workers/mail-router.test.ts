import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import mailRouterWorker from "../../workers/mail-router/src/index";

const routingPolicyV2 = readFileSync(
  resolve(import.meta.dir, "../fixtures/routing-policy-v2.json"),
  "utf8",
);

test("routing policy v2 delivers same-local-part mailbox routes without STAR", async () => {
  const effects: string[] = [];
  const db = new D1Recorder(undefined, effects);
  const rawMail = new R2Recorder(effects);
  const mailJobs = new QueueRecorder(effects);
  const message = new TestEmailMessage({
    from: "sender@example.org",
    to: "security@example.com",
    headers: { "message-id": "<mailbox-v2@example.org>" },
    raw: "From: sender@example.org\r\nTo: security@example.com\r\n\r\nmailbox",
    effects,
  });

  await mailRouterWorker.email(message as unknown as ForwardableEmailMessage, {
    DB: db,
    RAW_MAIL: rawMail,
    MAIL_JOBS: mailJobs,
    MAILDESK_OPERATOR_DELIVERY_MODE: "web_desk",
    MAILDESK_POLICY_JSON: routingPolicyV2,
  } as unknown as Env, new TestExecutionContext() as unknown as ExecutionContext);

  expect(message.rejectedWith).toBeNull();
  expect(message.forwardedTo).toEqual(["operator@example.org"]);
  expect(effects[0]).toBe("mailbox:operator@example.org");
  expect(db.auditDetail("route_disposition_selected")).toEqual({
    routeRef: "route:example.com:security",
    destinationRef: "mailbox:security",
    accountableRef: "team:security",
    targetKind: "mailbox",
    fallbackUsed: false,
  });
});

test("internal MAIL_JOBS does not qualify a work destination; the declared mailbox fallback wins", async () => {
  const effects: string[] = [];
  const db = new D1Recorder(undefined, effects);
  const rawMail = new R2Recorder(effects);
  const mailJobs = new QueueRecorder(effects);
  const message = new TestEmailMessage({
    from: "sender@example.org",
    to: "security@example.net",
    headers: { "message-id": "<queue-v2@example.org>" },
    raw: "From: sender@example.org\r\nTo: security@example.net\r\n\r\nprivate-work-item-body",
    effects,
  });

  await mailRouterWorker.email(message as unknown as ForwardableEmailMessage, {
    DB: db,
    RAW_MAIL: rawMail,
    MAIL_JOBS: mailJobs,
    MAILDESK_OPERATOR_DELIVERY_MODE: "web_desk",
    MAILDESK_POLICY_JSON: routingPolicyV2,
  } as unknown as Env, new TestExecutionContext() as unknown as ExecutionContext);

  expect(message.rejectedWith).toBeNull();
  expect(message.forwardedTo).toEqual(["operator@example.org"]);
  expect(effects[0]).toBe("mailbox:operator@example.org");
  expect(mailJobs.jobs).toHaveLength(1);
  expect(mailJobs.jobs[0]).toMatchObject({ kind: "inbound_email_received" });
  expect(db.auditDetail("route_disposition_selected")).toMatchObject({
    destinationRef: "mailbox:support", fallbackUsed: true, targetKind: "mailbox",
  });
  expect(JSON.stringify(db.auditDetail("route_disposition_selected"))).not.toContain("private-work-item-body");
});

test("routing policy v2 chooses mailbox fallback before any side effect", async () => {
  const effects: string[] = [];
  const db = new D1Recorder(undefined, effects);
  const rawMail = new R2Recorder(effects);
  const message = new TestEmailMessage({
    from: "sender@example.org",
    to: "security@example.net",
    headers: { "message-id": "<fallback-v2@example.org>" },
    raw: "From: sender@example.org\r\nTo: security@example.net\r\n\r\nfallback",
    effects,
  });

  await mailRouterWorker.email(message as unknown as ForwardableEmailMessage, {
    DB: db,
    RAW_MAIL: rawMail,
    MAIL_JOBS: undefined,
    MAILDESK_OPERATOR_DELIVERY_MODE: "web_desk",
    MAILDESK_POLICY_JSON: routingPolicyV2,
  } as unknown as Env, new TestExecutionContext() as unknown as ExecutionContext);

  expect(message.rejectedWith).toBeNull();
  expect(message.forwardedTo).toEqual(["operator@example.org"]);
  expect(effects[0]).toBe("mailbox:operator@example.org");
  expect(db.auditDetail("route_disposition_selected")).toMatchObject({
    destinationRef: "mailbox:support",
    accountableRef: "team:support",
    targetKind: "mailbox",
    fallbackUsed: true,
  });
});

test("routing policy v2 rejects fallback cycles before every Worker side effect", async () => {
  const effects: string[] = [];
  const policy = JSON.parse(routingPolicyV2) as {
    destinations: Record<string, { fallback_destination_ref?: string }>;
  };
  policy.destinations["mailbox:support"]!.fallback_destination_ref = "queue:support";
  const message = new TestEmailMessage({
    from: "sender@example.org",
    to: "security@example.net",
    headers: { "message-id": "<cycle-v2@example.org>" },
    raw: "From: sender@example.org\r\nTo: security@example.net\r\n\r\ncycle",
    effects,
  });

  await mailRouterWorker.email(message as unknown as ForwardableEmailMessage, {
    DB: new D1Recorder(undefined, effects),
    RAW_MAIL: new R2Recorder(effects),
    MAIL_JOBS: new QueueRecorder(effects),
    MAILDESK_OPERATOR_DELIVERY_MODE: "web_desk",
    MAILDESK_POLICY_JSON: JSON.stringify(policy),
  } as unknown as Env, new TestExecutionContext() as unknown as ExecutionContext);

  // Whole-policy validation rejects before any route is exposed.
  expect(message.rejectedWith).toBe("maildesk policy unavailable");
  expect(message.forwardedTo).toEqual([]);
  expect(effects).toEqual([]);
});

test("routing policy v2 rejects invalid closed shapes before every Worker side effect", async () => {
  const mutations: Array<[string, (policy: any) => void]> = [
    ["unsupported version", (policy) => { policy.policy_version = 3; }],
    ["unknown accountable", (policy) => {
      policy.destinations["mailbox:security"].accountable_ref = "team:missing";
    }],
    ["unknown destination", (policy) => {
      policy.domains["example.com"].role_aliases.security.destination_ref = "mailbox:missing";
    }],
    ["unknown fallback", (policy) => {
      policy.destinations["queue:support"].fallback_destination_ref = "mailbox:missing";
    }],
    ["empty mailbox", (policy) => {
      policy.destinations["mailbox:security"].target.recipients = [];
    }],
    ["invalid mailbox", (policy) => {
      policy.destinations["mailbox:security"].target.recipients = ["operator a@example.com"];
    }],
    ["blank queue", (policy) => {
      policy.destinations["queue:support"].target.queue_ref = "  ";
    }],
  ];

  for (const [caseName, mutate] of mutations) {
    const effects: string[] = [];
    const policy = JSON.parse(routingPolicyV2);
    mutate(policy);
    const message = new TestEmailMessage({
      from: "sender@example.org",
      to: "security@example.com",
      headers: { "message-id": `<invalid-${caseName.replaceAll(" ", "-")}@example.org>` },
      raw: "From: sender@example.org\r\nTo: security@example.com\r\n\r\ninvalid",
      effects,
    });

    await mailRouterWorker.email(message as unknown as ForwardableEmailMessage, {
      DB: new D1Recorder(undefined, effects),
      RAW_MAIL: new R2Recorder(effects),
      MAIL_JOBS: new QueueRecorder(effects),
      MAILDESK_OPERATOR_DELIVERY_MODE: "web_desk",
      MAILDESK_POLICY_JSON: JSON.stringify(policy),
    } as unknown as Env, new TestExecutionContext() as unknown as ExecutionContext);

    expect(message.rejectedWith, caseName).toBeTruthy();
    expect(message.forwardedTo, caseName).toEqual([]);
    expect(effects, caseName).toEqual([]);
  }
});

test("accepted inbound role alias persists D1 metadata", async () => {
  const db = new D1Recorder();
  const rawMail = new R2Recorder();
  const mailJobs = new QueueRecorder();
  const message = new TestEmailMessage({
    from: "sender@example.net",
    to: "founders@example.com",
    headers: {
      "message-id": "<message-1@example.net>",
      subject: "Launch question",
    },
    raw: "From: sender@example.net\r\nTo: founders@example.com\r\n\r\nhello",
  });

  await mailRouterWorker.email(
    message as unknown as ForwardableEmailMessage,
    {
      DB: db,
      RAW_MAIL: rawMail,
      MAIL_JOBS: mailJobs,
      MAILDESK_OPERATOR_DELIVERY_MODE: "web_desk",
      MAILDESK_POLICY_JSON: JSON.stringify({
        default_reply_mode: "role_first",
        domains: {
          "example.com": {
            role_aliases: {
              founders: {
                operators: ["operator-a@example.com"],
                reply_identity: "founders@example.com",
                allowed_reply_identities: ["operator-a@example.com"],
              },
            },
            personal_aliases: {},
          },
        },
      }),
    } as unknown as Env,
    new TestExecutionContext() as unknown as ExecutionContext,
  );

  expect(message.rejectedWith).toBeNull();
  expect(message.forwardedTo).toEqual(["operator-a@example.com"]);
  expect(rawMail.puts).toHaveLength(1);
  expect(mailJobs.jobs).toHaveLength(1);

  expect(db.sqlFor("INSERT OR IGNORE INTO domains")).toBeTruthy();
  expect(db.sqlFor("INSERT OR IGNORE INTO identities")).toBeTruthy();
  expect(db.sqlFor("INSERT OR IGNORE INTO alias_routes")).toBeTruthy();
  expect(db.sqlFor("INSERT INTO threads")).toBeTruthy();
  expect(db.sqlFor("INSERT INTO messages")).toBeTruthy();
  expect(db.sqlFor("INSERT INTO audit_events")).toBeTruthy();

  const allBinds = db.statements.flatMap((statement) => statement.binds);
  expect(allBinds).toContain("example.com");
  expect(allBinds).toContain("founders@example.com");
  expect(allBinds).toContain("sender@example.net");
  expect(allBinds).toContain("<message-1@example.net>");
  expect(allBinds).toContain("Launch question");
});

test("D1 metadata failure stops follow-up queue work after forwarding", async () => {
  const db = new D1Recorder("INSERT OR IGNORE INTO domains");
  const rawMail = new R2Recorder();
  const mailJobs = new QueueRecorder();
  const message = new TestEmailMessage({
    from: "sender@example.net",
    to: "founders@example.com",
    headers: {
      "message-id": "<message-2@example.net>",
      subject: "Needs recovery",
    },
    raw: "From: sender@example.net\r\nTo: founders@example.com\r\n\r\nhello",
  });

  const consoleErrors = await captureConsoleError(() =>
    mailRouterWorker.email(
      message as unknown as ForwardableEmailMessage,
      {
        DB: db,
        RAW_MAIL: rawMail,
        MAIL_JOBS: mailJobs,
        MAILDESK_OPERATOR_DELIVERY_MODE: "web_desk",
        MAILDESK_POLICY_JSON: JSON.stringify({
          default_reply_mode: "role_first",
          domains: {
            "example.com": {
              role_aliases: {
                founders: {
                  operators: ["operator-a@example.com"],
                  reply_identity: "founders@example.com",
                  allowed_reply_identities: ["operator-a@example.com"],
                },
              },
              personal_aliases: {},
            },
          },
        }),
      } as unknown as Env,
      new TestExecutionContext() as unknown as ExecutionContext,
    ),
  );

  expect(message.rejectedWith).toBeNull();
  expect(message.forwardedTo).toEqual(["operator-a@example.com"]);
  expect(rawMail.puts).toHaveLength(1);
  expect(mailJobs.jobs).toHaveLength(0);
  expect(String(consoleErrors[0]?.[0])).toContain("maildesk metadata persist failed");
});

test("distinct attacker-controlled Message-IDs cannot collapse to one thread id", async () => {
  const db = new D1Recorder();
  const env = {
    DB: db,
    RAW_MAIL: new R2Recorder(),
    MAIL_JOBS: new QueueRecorder(),
    MAILDESK_OPERATOR_DELIVERY_MODE: "web_desk",
    MAILDESK_POLICY_JSON: JSON.stringify({
      default_reply_mode: "role_first",
      domains: {
        "example.com": {
          role_aliases: {
            founders: {
              operators: ["operator-a@example.com"],
              reply_identity: "founders@example.com",
              allowed_reply_identities: [],
            },
          },
          personal_aliases: {},
        },
      },
    }),
  } as unknown as Env;

  for (const messageId of [
    "<collision+a@example.net>",
    "<collision a@example.net>",
    "<CaseSensitive@example.net>",
    "<casesensitive@example.net>",
  ]) {
    await mailRouterWorker.email(
      new TestEmailMessage({
        from: "sender@example.net",
        to: "founders@example.com",
        headers: { "message-id": messageId },
        raw: `Message-ID: ${messageId}\r\n\r\nhello`,
      }) as unknown as ForwardableEmailMessage,
      env,
      new TestExecutionContext() as unknown as ExecutionContext,
    );
  }

  const threadIds = db.bindsFor("INSERT INTO threads").map((values) => values[0]);
  expect(threadIds).toHaveLength(4);
  expect(new Set(threadIds).size).toBe(4);
});

test("an authenticated reply reference keeps a sender on the existing route thread", async () => {
  const db = new D1Recorder(undefined, new Map([
    ["<outbound-1@example.com>|route:example.com:founders|sender@example.net", "thread:existing"],
  ]));
  const env = {
    DB: db,
    RAW_MAIL: new R2Recorder(),
    MAIL_JOBS: new QueueRecorder(),
    MAILDESK_OPERATOR_DELIVERY_MODE: "web_desk",
    MAILDESK_POLICY_JSON: JSON.stringify({
      default_reply_mode: "role_first",
      domains: {
        "example.com": {
          role_aliases: {
            founders: {
              operators: ["operator-a@example.com"],
              reply_identity: "founders@example.com",
              allowed_reply_identities: [],
            },
          },
          personal_aliases: {},
        },
      },
    }),
  } as unknown as Env;

  await mailRouterWorker.email(
    new TestEmailMessage({
      from: "sender@example.net",
      to: "founders@example.com",
      headers: {
        "message-id": "<follow-up@example.net>",
        "in-reply-to": "<outbound-1@example.com>",
        references: "<original@example.net> <outbound-1@example.com>",
      },
      raw: "Message-ID: <follow-up@example.net>\r\nIn-Reply-To: <outbound-1@example.com>\r\n\r\nhello",
    }) as unknown as ForwardableEmailMessage,
    env,
    new TestExecutionContext() as unknown as ExecutionContext,
  );

  expect(db.bindsFor("SELECT m.thread_id")[0]).toEqual([
    "<outbound-1@example.com>",
    "route:example.com:founders",
    "sender@example.net",
  ]);
  expect(db.bindsFor("INSERT INTO threads")[0]?.[0]).toBe("thread:existing");
  expect(db.bindsFor("INSERT INTO messages")[0]?.[1]).toBe("thread:existing");
});

test("a reply reference cannot cross sender or route authority", async () => {
  const db = new D1Recorder(undefined, new Map([
    ["<known-outbound@example.com>|route:example.com:founders|sender@example.net", "thread:existing"],
  ]));
  const message = new TestEmailMessage({
    from: "attacker@example.net",
    to: "founders@example.com",
    headers: {
      "message-id": "<attacker-follow-up@example.net>",
      "in-reply-to": "<known-outbound@example.com>",
    },
    raw: "Message-ID: <attacker-follow-up@example.net>\r\n\r\nhello",
  });

  await mailRouterWorker.email(
    message as unknown as ForwardableEmailMessage,
    {
      DB: db,
      RAW_MAIL: new R2Recorder(),
      MAIL_JOBS: new QueueRecorder(),
      MAILDESK_OPERATOR_DELIVERY_MODE: "web_desk",
      MAILDESK_POLICY_JSON: JSON.stringify({
        default_reply_mode: "role_first",
        domains: {
          "example.com": {
            role_aliases: {
              founders: {
                operators: ["operator-a@example.com"],
                reply_identity: "founders@example.com",
                allowed_reply_identities: [],
              },
            },
            personal_aliases: {},
          },
        },
      }),
    } as unknown as Env,
    new TestExecutionContext() as unknown as ExecutionContext,
  );

  expect(db.bindsFor("INSERT INTO threads")[0]?.[0]).not.toBe("thread:existing");
  expect(db.bindsFor("SELECT m.thread_id")[0]?.slice(1)).toEqual([
    "route:example.com:founders",
    "attacker@example.net",
  ]);
});

test("inbound routing rejects mailbox whitespace through the Rust policy boundary", async () => {
  const message = new TestEmailMessage({
    from: "sender@example.net",
    to: "bad alias@example.com",
    headers: {
      "message-id": "<message-invalid@example.net>",
      subject: "Invalid recipient",
    },
    raw: "From: sender@example.net\r\nTo: bad alias@example.com\r\n\r\nhello",
  });

  await mailRouterWorker.email(
    message as unknown as ForwardableEmailMessage,
    {
      DB: new D1Recorder(),
      RAW_MAIL: new R2Recorder(),
      MAIL_JOBS: new QueueRecorder(),
      MAILDESK_OPERATOR_DELIVERY_MODE: "web_desk",
      MAILDESK_POLICY_JSON: JSON.stringify({
        default_reply_mode: "role_first",
        domains: {
          "example.com": {
            role_aliases: {},
            personal_aliases: {},
            catch_all: {
              operators: ["operator-a@example.com"],
              reply_identity: "info@example.com",
              allowed_reply_identities: [],
            },
          },
        },
      }),
    } as unknown as Env,
    new TestExecutionContext() as unknown as ExecutionContext,
  );

  expect(message.rejectedWith).toBe("recipient is not a valid mailbox address");
  expect(message.forwardedTo).toEqual([]);
});

async function captureConsoleError(action: () => Promise<void>): Promise<unknown[][]> {
  const original = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    await action();
  } finally {
    console.error = original;
  }
  return calls;
}

class TestEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  readonly forwardedTo: string[] = [];
  rejectedWith: string | null = null;
  private readonly effects?: string[];

  constructor(input: {
    from: string;
    to: string;
    headers: Record<string, string>;
    raw: string;
    effects?: string[];
  }) {
    this.from = input.from;
    this.to = input.to;
    this.headers = new Headers(input.headers);
    const encoded = new TextEncoder().encode(input.raw);
    this.raw = new Blob([encoded], { type: "message/rfc822" }).stream();
    this.rawSize = encoded.byteLength;
    this.effects = input.effects;
  }

  async forward(recipient: string): Promise<void> {
    this.effects?.push(`mailbox:${recipient}`);
    this.forwardedTo.push(recipient);
  }

  setReject(reason: string): void {
    this.rejectedWith = reason;
  }
}

class TestExecutionContext {
  waitUntil(_promise: Promise<unknown>): void {}
  passThroughOnException(): void {}
}

class R2Recorder {
  readonly puts: Array<{ key: string; value: unknown; options: unknown }> = [];

  constructor(private readonly effects?: string[]) {}

  async put(key: string, value: unknown, options: unknown): Promise<void> {
    this.effects?.push("r2:put");
    this.puts.push({ key, value, options });
  }

  async get(_key: string): Promise<null> {
    return null;
  }
}

class QueueRecorder {
  readonly jobs: unknown[] = [];

  constructor(private readonly effects?: string[]) {}

  async send(job: unknown): Promise<void> {
    this.effects?.push("queue:send");
    this.jobs.push(job);
  }
}

interface RecordedStatement {
  sql: string;
  binds: unknown[];
}

class D1Recorder {
  readonly statements: RecordedStatement[] = [];
  private readonly threadsByHeader: Map<string, string>;
  private readonly effects?: string[];

  constructor(
    private readonly failOnSql?: string,
    threadsOrEffects: Map<string, string> | string[] = new Map<string, string>(),
    effects?: string[],
  ) {
    this.threadsByHeader = threadsOrEffects instanceof Map
      ? threadsOrEffects
      : new Map<string, string>();
    this.effects = Array.isArray(threadsOrEffects) ? threadsOrEffects : effects;
  }

  prepare(sql: string): D1PreparedStatement {
    const statements = this.statements;
    const failOnSql = this.failOnSql;
    const threadsByHeader = this.threadsByHeader;
    const effects = this.effects;
    const record: RecordedStatement = { sql, binds: [] };
    const prepared = {
      bind(...values: unknown[]) {
        record.binds = values;
        return prepared;
      },
      async run() {
        if (failOnSql && sql.includes(failOnSql)) {
          throw new Error(`forced D1 failure for ${failOnSql}`);
        }
        statements.push(record);
        effects?.push("d1:run");
        return { success: true };
      },
      async first() {
        statements.push(record);
        if (sql.includes("SELECT m.thread_id")) {
          const threadId = threadsByHeader.get(record.binds.map(String).join("|"));
          return threadId ? { thread_id: threadId } : null;
        }
        return { ok: 1 };
      },
    };
    return prepared as unknown as D1PreparedStatement;
  }

  sqlFor(needle: string): string | undefined {
    return this.statements.find((statement) => statement.sql.includes(needle))?.sql;
  }

  bindsFor(needle: string): unknown[][] {
    return this.statements
      .filter((statement) => statement.sql.includes(needle))
      .map((statement) => statement.binds);
  }

  auditDetail(action: string): unknown {
    const statement = this.statements.find(
      (entry) => entry.sql.includes("INSERT INTO audit_events") && entry.binds[4] === action,
    );
    return statement ? JSON.parse(String(statement.binds[5])) : undefined;
  }
}

type Env = Parameters<typeof mailRouterWorker.email>[1];
