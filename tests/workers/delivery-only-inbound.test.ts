import { expect, test } from "bun:test";
import { relayRuntime } from "../helpers/relay-runtime";
import { acceptDeliveryOnly } from "../../workers/mail-router/src/delivery-only-inbound";

const raw = new TextEncoder().encode("From: sender@example.net\r\nTo: support@example.com\r\nSubject: report\r\nContent-Type: text/plain\r\n\r\nreport body\r\n").buffer;

async function fixture(deliveryOnlyPolicy = false, rawMessage: ArrayBuffer = raw) {
  const f = await relayRuntime();
  let policySha = f.policySha;
  if (deliveryOnlyPolicy) {
    const { projectRoutes, projectionSql } = await import("../../scripts/sync-route-policy");
    const { sha256Hex } = await import("../../workers/shared/inbox-relay");
    const policy = { policy_version: 3 as const, default_reply_mode: "personal_first" as const, domains: { "example.com": {
      role_aliases: { support: { operators: ["operator@example.com", "second@example.com"], reply_identity: "support@example.com", delivery_only: true } }, personal_aliases: {},
    } } };
    const bytes = new TextEncoder().encode(JSON.stringify(policy));
    policySha = await sha256Hex(bytes);
    const desired = { storage: { d1_database: "fixture" }, domains: [{ name: "example.com", inbound_mx_provider: "cloudflare_email_routing" as const, role_aliases: ["support"], personal_aliases: [] }] };
    f.db.exec(projectionSql(projectRoutes(policy, desired), policySha, `config/policy/${policySha}.json`, "b".repeat(64)).sql);
    f.env.POLICY_STORE = { get: async () => ({ arrayBuffer: async () => bytes.buffer }) } as unknown as R2Bucket;
  }
  (f.d1 as unknown as { withSession: (mode: string) => unknown }).withSession = (mode) => { expect(mode).toBe("first-primary"); return f.d1; };
  const objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  let writes = 0;
  f.env.RELAY_SPOOL = {
    async put(key: string, value: ArrayBuffer | string, options: R2PutOptions) {
    if (options.onlyIf) expect((options.onlyIf as Headers).get("If-None-Match")).toBe("*");
    if (objects.has(key)) return null;
    writes++;
    objects.set(key, { bytes: typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value), metadata: options.customMetadata ?? {} });
    return {};
    },
    async get(key: string) { const obj = objects.get(key); return obj && { size: obj.bytes.byteLength, customMetadata: obj.metadata, text: async () => new TextDecoder().decode(obj.bytes), arrayBuffer: async () => obj.bytes.slice().buffer }; },
    async head(key: string) { const obj = objects.get(key); return obj ? { customMetadata: obj.metadata } : null; },
    async delete(key: string) { objects.delete(key); },
  } as unknown as R2Bucket;
  const bound = { policySha256: policySha, route: { domain: "example.com", localPart: "support", routeKind: "role_alias" as const,
    operators: ["operator@example.com", "second@example.com"], deliveryOnly: true, defaultReplyIdentity: "support@example.com", allowedReplyIdentities: [] } };
  async function admit() {
    let rejected: string | undefined;
    const message = { from: "sender@example.net", to: "support@example.com", rawSize: rawMessage.byteLength,
    raw: new Response(rawMessage.slice(0)).body!, headers: new Headers(), setReject(reason: string) { rejected = reason; } } as ForwardableEmailMessage;
    await acceptDeliveryOnly(message, bound, f.env);
    return rejected;
  }
  return { ...f, policySha, objects, writes: () => writes, admit };
}

test("delivery-only admission stages, persists, dispatches and deduplicates", async () => {
  const f = await fixture();
  try {
    expect(await f.admit()).toBeUndefined();
    expect(f.sends).toHaveLength(2);
    expect(f.sends.every((message) => !("replyTo" in message))).toBe(true);
    expect(f.db.query("SELECT status,recipient_count FROM delivery_only_deliveries").get()).toEqual({ status: "provider_accepted", recipient_count: 2 });
    expect(await f.admit()).toBeUndefined();
    expect(f.sends).toHaveLength(2);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { f.db.close(); }
});

test("lost commit acknowledgement reconciles the exact claim without duplicate sends", async () => {
  const f = await fixture();
  try {
    const batch = f.d1.batch.bind(f.d1);
    let lost = false;
    f.d1.batch = async (statements) => {
      const result = await batch(statements);
      if (!lost) { lost = true; throw new Error("acknowledgement lost"); }
      return result;
    };
    expect(await f.admit()).toBeUndefined();
    expect(f.sends).toHaveLength(2);
    expect(await f.admit()).toBeUndefined();
    expect(f.sends).toHaveLength(2);
    expect(f.objects.size).toBe(3);
  } finally { f.db.close(); }
});

test("unavailable readback after commit holds, then redelivery resumes without duplicates", async () => {
  const f = await fixture();
  try {
    const batch = f.d1.batch.bind(f.d1);
    let lost = false;
    f.d1.batch = async (statements) => { const result = await batch(statements); lost = true; throw new Error("acknowledgement lost"); };
    f.d1.before = (sql) => { if (lost && sql.includes("WHERE d.fingerprint_sha256")) throw new Error("readback unavailable"); };
    expect(await f.admit()).toContain("reconciliation");
    expect(f.sends).toHaveLength(0); expect(f.objects.size).toBe(3);
    f.d1.before = undefined;
    expect(await f.admit()).toBeUndefined();
    expect(f.sends).toHaveLength(2);
    expect(await f.admit()).toBeUndefined(); expect(f.sends).toHaveLength(2);
  } finally { f.db.close(); }
});

test("unknown provider acknowledgement never causes a resend", async () => {
  const f = await fixture();
  try {
    f.faults.providerAfter = true;
    expect(await f.admit()).toBeUndefined();
    expect(f.sends).toHaveLength(2);
    expect(f.db.query("SELECT status FROM delivery_only_recipient_deliveries ORDER BY recipient_ref").all()).toEqual([{ status: "recovery_required" }, { status: "recovery_required" }]);
    f.faults.providerAfter = false;
    expect(await f.admit()).toBeUndefined(); expect(f.sends).toHaveLength(2);
    expect(f.objects.size).toBe(3);
  } finally { f.db.close(); }
});

test("uncertain spool write retains staged objects and sends nothing", async () => {
  const f = await fixture();
  try {
    const bucket = f.env.RELAY_SPOOL!;
    const put = bucket.put.bind(bucket);
    let writes = 0;
    bucket.put = (async (...args: Parameters<R2Bucket["put"]>) => {
      const result = await put(...args); writes++;
      if (writes === 2) throw new Error("spool acknowledgement lost");
      return result;
    }) as R2Bucket["put"];
    expect(await f.admit()).toContain("stage");
    expect(f.sends).toHaveLength(0); expect(f.objects.size).toBe(2);
    expect(f.db.query("SELECT COUNT(*) AS n FROM delivery_only_deliveries").get()).toEqual({ n: 0 });
  } finally { f.db.close(); }
});

test("lost outcome projection leaves sending claims held and prevents replay", async () => {
  const f = await fixture();
  try {
    f.d1.before = (sql) => { if (sql.startsWith("UPDATE delivery_only_recipient_deliveries SET status = ?1")) throw new Error("projection unavailable"); };
    expect(await f.admit()).toBeUndefined();
    expect(f.sends).toHaveLength(2);
    expect(f.db.query("SELECT status FROM delivery_only_recipient_deliveries ORDER BY recipient_ref").all()).toEqual([{ status: "sending" }, { status: "sending" }]);
    f.d1.before = undefined;
    expect(await f.admit()).toBeUndefined(); expect(f.sends).toHaveLength(2);
    expect(f.objects.size).toBe(3);
  } finally { f.db.close(); }
});

test("concurrent identical ingress claims dispatch each recipient at most once", async () => {
  const f = await fixture();
  try {
    expect(await Promise.all([f.admit(), f.admit()])).toEqual([undefined, undefined]);
    expect(f.sends).toHaveLength(2);
    expect(f.db.query("SELECT COUNT(*) AS n FROM delivery_only_deliveries").get()).toEqual({ n: 1 });
    expect(f.db.query("SELECT status FROM delivery_only_recipient_deliveries ORDER BY recipient_ref").all()).toEqual([{ status: "provider_accepted" }, { status: "provider_accepted" }]);
  } finally { f.db.close(); }
});

test("delivery-only claim changes invalidate and appear in status inputs", async () => {
  const { ROUTE_STATUS_INPUT_SQL } = await import("../../workers/shared/status-store");
  const f = await fixture();
  try {
    const generation = () => (f.db.query("SELECT status_generation FROM alias_routes WHERE id='route:example.com:support'").get() as { status_generation: number }).status_generation;
    const before = generation();
    f.faults.providerAfter = true;
    expect(await f.admit()).toBeUndefined();
    expect(generation()).toBeGreaterThan(before);
    const row = f.db.query(ROUTE_STATUS_INPUT_SQL).get(f.policySha, "", null) as { delivery_only_status: string; delivery_only_unknown: number };
    expect(row.delivery_only_status).toBe("recovery_required");
    expect(row.delivery_only_unknown).toBe(2);
  } finally { f.db.close(); }
});

test("ordinary ingress recognizes an existing delivery-only fingerprint", async () => {
  const { acceptInboxRelay } = await import("../../workers/mail-router/src/inbound");
  const f = await fixture();
  try {
    expect(await f.admit()).toBeUndefined();
    let rejected: string | undefined;
    const message = { from: "sender@example.net", to: "support@example.com", rawSize: raw.byteLength,
      raw: new Response(raw.slice(0)).body!, headers: new Headers(), setReject(reason: string) { rejected = reason; } } as ForwardableEmailMessage;
    await acceptInboxRelay(message, { policySha256: f.policySha, route: { domain: "example.com", localPart: "support", routeKind: "role_alias",
      operators: ["operator@example.com", "second@example.com"], defaultReplyIdentity: "support@example.com", allowedReplyIdentities: ["support@example.com"] } }, f.env);
    expect(rejected).toBeUndefined(); expect(f.sends).toHaveLength(2);
    expect(f.db.query("SELECT COUNT(*) AS n FROM inbound_deliveries WHERE id != 'inbound:one'").get()).toEqual({ n: 0 });
  } finally { f.db.close(); }
});

test("delivery-only ingress recognizes an existing ordinary fingerprint", async () => {
  const f = await fixture();
  try {
    expect(await f.ingress(raw, "support@example.com", "sender@example.net")).toBeUndefined();
    expect(f.sends).toHaveLength(2);
    expect(await f.admit()).toBeUndefined();
    expect(f.sends).toHaveLength(2);
    expect(f.db.query("SELECT COUNT(*) AS n FROM delivery_only_deliveries").get()).toEqual({ n: 0 });
  } finally { f.db.close(); }
});

test("web-desk ingress does not forward a delivery-only message again after a mode change", async () => {
  const { acceptWebDesk } = await import("../../workers/mail-router/src/inbound");
  const f = await fixture();
  try {
    expect(await f.admit()).toBeUndefined();
    let forwards = 0;
    f.env.RAW_MAIL = { put: async () => ({}) } as unknown as R2Bucket;
    const message = { from: "sender@example.net", to: "support@example.com", rawSize: raw.byteLength,
      raw: new Response(raw.slice(0)).body!, headers: new Headers(), setReject() {},
      async forward() { forwards++; } } as unknown as ForwardableEmailMessage;
    await acceptWebDesk(message, { domain: "example.com", localPart: "support", routeKind: "role_alias",
      operators: ["operator@example.com", "second@example.com"], defaultReplyIdentity: "support@example.com",
      allowedReplyIdentities: ["support@example.com"] }, f.env);
    expect(forwards).toBe(0);
  } finally { f.db.close(); }
});

test("web-desk ingress does not forward when delivery-only history cannot be checked", async () => {
  const { acceptWebDesk } = await import("../../workers/mail-router/src/inbound");
  const f = await fixture();
  try {
    let forwards = 0, rejected = "";
    f.env.RAW_MAIL = { put: async () => ({}) } as unknown as R2Bucket;
    f.d1.before = (sql) => { if (sql.includes("SELECT id FROM delivery_only_deliveries")) throw new Error("unavailable"); };
    const message = { from: "sender@example.net", to: "support@example.com", rawSize: raw.byteLength,
      raw: new Response(raw.slice(0)).body!, headers: new Headers(), setReject(reason: string) { rejected = reason; },
      async forward() { forwards++; } } as unknown as ForwardableEmailMessage;
    await acceptWebDesk(message, { domain: "example.com", localPart: "support", routeKind: "role_alias",
      operators: ["operator@example.com"], defaultReplyIdentity: "support@example.com", allowedReplyIdentities: ["support@example.com"] }, f.env);
    expect(forwards).toBe(0);
    expect(rejected).toContain("idempotency");
  } finally { f.db.close(); }
});

test("accepted deliveries retain spools while conditional cleanup is unavailable", async () => {
  const f = await fixture();
  try {
    let deletes = 0, heads = 0;
    const originalHead = f.env.RELAY_SPOOL!.head.bind(f.env.RELAY_SPOOL!);
    f.env.RELAY_SPOOL!.head = (async (...args: Parameters<R2Bucket["head"]>) => { heads++; return originalHead(...args); }) as R2Bucket["head"];
    f.env.RELAY_SPOOL!.delete = (async () => { deletes++; }) as R2Bucket["delete"];
    expect(await f.admit()).toBeUndefined();
    expect(f.sends).toHaveLength(2);
    expect(f.objects.size).toBe(3);
    expect(deletes).toBe(0);
    expect(heads).toBe(0);
    expect((f.db.query("SELECT raw_r2_key FROM delivery_only_deliveries").get() as { raw_r2_key: string | null }).raw_r2_key).not.toBeNull();
    expect(await f.admit()).toBeUndefined();
    expect(f.sends).toHaveLength(2);
    expect(f.objects.size).toBe(3);
    expect(deletes).toBe(0);
  } finally { f.db.close(); }
});

test("Worker routes v3 delivery-only mail through the complete guarded pipeline", async () => {
  const { projectRoutes, projectionSql } = await import("../../scripts/sync-route-policy");
  const { sha256Hex } = await import("../../workers/shared/inbox-relay");
  const f = await fixture();
  try {
    const policy = { policy_version: 3 as const, default_reply_mode: "personal_first" as const, domains: { "example.com": {
      role_aliases: { support: { operators: ["operator@example.com", "second@example.com"], reply_identity: "support@example.com", delivery_only: true } }, personal_aliases: {},
    } } };
    const json = JSON.stringify(policy), bytes = new TextEncoder().encode(json), sha = await sha256Hex(bytes);
    const desired = { storage: { d1_database: "fixture" }, domains: [{ name: "example.com", inbound_mx_provider: "cloudflare_email_routing" as const, role_aliases: ["support"], personal_aliases: [] }] };
    f.db.exec(projectionSql(projectRoutes(policy, desired), sha, `config/policy/${sha}.json`, "b".repeat(64)).sql);
    f.env.POLICY_STORE = { get: async () => ({ arrayBuffer: async () => bytes.buffer }) } as unknown as R2Bucket;
    expect(await f.ingress(raw, "support@example.com", "sender@example.net")).toBeUndefined();
    expect(f.sends).toHaveLength(2);
    expect(f.sends.every((message) => !("replyTo" in message))).toBe(true);
    const accepted = f.db.query("SELECT status,raw_r2_key FROM delivery_only_deliveries").get() as { status: string; raw_r2_key: string | null };
    expect(accepted.status).toBe("provider_accepted");
    expect(accepted.raw_r2_key).not.toBeNull();
    expect(await f.ingress(raw, "support@example.com", "sender@example.net")).toBeUndefined();
    expect(f.sends).toHaveLength(2);
    expect(f.db.query("SELECT count(*) AS n FROM reply_relays").get()).toEqual({ n: 1 });
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { f.db.close(); }
});

test("scheduled sweep resumes pending deliveries after transient spool failure", async () => {
  const { default: router } = await import("../../workers/mail-router/src/index");
  const f = await fixture();
  try {
    const bucket = f.env.RELAY_SPOOL!;
    const get = bucket.get.bind(bucket);
    let unavailable = true;
    bucket.get = (async (...args: Parameters<R2Bucket["get"]>) => unavailable ? null : get(...args)) as R2Bucket["get"];
    expect(await f.admit()).toBeUndefined();
    expect(f.sends).toHaveLength(0);
    expect(f.db.query("SELECT status,error_code FROM delivery_only_recipient_deliveries").all()).toEqual([{ status: "pending", error_code: "delivery_payload_missing_observed" }, { status: "pending", error_code: "delivery_payload_missing_observed" }]);
    unavailable = false;
    await router.scheduled({} as ScheduledController, f.env);
    expect(f.sends).toHaveLength(2);
    expect(f.db.query("SELECT error_code FROM delivery_only_recipient_deliveries").all()).toEqual([{ error_code: null }, { error_code: null }]);
    const projection = f.db.query("SELECT sp.source_generation,ar.status_generation FROM route_status_projection sp JOIN alias_routes ar ON ar.id=sp.route_id WHERE ar.id='route:example.com:support'").get() as { source_generation: number; status_generation: number };
    expect(projection.source_generation).toBe(projection.status_generation);
    await router.scheduled({} as ScheduledController, f.env);
    expect(f.sends).toHaveLength(2);
  } finally { f.db.close(); }
});


test("scheduled sweep leaves unknown provider outcomes untouched", async () => {
  const { sweepDeliveryOnly } = await import("../../workers/mail-router/src/delivery-only-sweep");
  const f = await fixture();
  try {
    f.faults.providerAfter = true;
    expect(await f.admit()).toBeUndefined();
    expect(f.sends).toHaveLength(2);
    f.faults.providerAfter = false;
    await sweepDeliveryOnly(f.env);
    expect(f.sends).toHaveLength(2);
    expect(f.db.query("SELECT status FROM delivery_only_recipient_deliveries").all()).toEqual([{ status: "recovery_required" }, { status: "recovery_required" }]);
  } finally { f.db.close(); }
});

test("scheduled sweep respects disabled inbound mode", async () => {
  const { sweepDeliveryOnly } = await import("../../workers/mail-router/src/delivery-only-sweep");
  const f = await fixture();
  try {
    const bucket = f.env.RELAY_SPOOL!;
    const get = bucket.get.bind(bucket);
    bucket.get = (async () => null) as R2Bucket["get"];
    expect(await f.admit()).toBeUndefined();
    bucket.get = get;
    f.env.MAILDESK_INBOUND_RELAY_MODE = "disabled";
    await sweepDeliveryOnly(f.env);
    expect(f.sends).toHaveLength(0);
    expect(f.db.query("SELECT status FROM delivery_only_recipient_deliveries").all()).toEqual([{ status: "pending" }, { status: "pending" }]);
  } finally { f.db.close(); }
});

test("bounded sweep advances past held rows and wraps without starvation", async () => {
  const { sweepDeliveryOnly } = await import("../../workers/mail-router/src/delivery-only-sweep");
  const f = await fixture();
  try {
    for (let i = 1; i <= 21; i++) {
      const fp = i.toString(16).padStart(64, "0"), id = `held:${i}`;
      f.db.run("INSERT INTO delivery_only_deliveries(id,fingerprint_sha256,route_id,policy_sha256,raw_r2_key,recipient_count,received_at) VALUES (?1,?2,'route:example.com:support',?3,'missing',1,'2026-01-01')", [id, fp, f.policySha]);
      f.db.run("INSERT INTO delivery_only_recipient_deliveries(delivery_id,recipient_ref,delivery_message_id,delivery_payload_r2_key,delivery_payload_sha256) VALUES (?1,?2,'id','missing',?2)", [id, "a".repeat(64)]);
    }
    await Promise.all([sweepDeliveryOnly(f.env), sweepDeliveryOnly(f.env)]);
    expect(f.db.query("SELECT after_fingerprint FROM delivery_only_recovery_cursor").get()).toEqual({ after_fingerprint: (20).toString(16).padStart(64, "0") });
    await sweepDeliveryOnly(f.env);
    expect(f.db.query("SELECT after_fingerprint FROM delivery_only_recovery_cursor").get()).toEqual({ after_fingerprint: (21).toString(16).padStart(64, "0") });
    await sweepDeliveryOnly(f.env);
    expect(f.db.query("SELECT after_fingerprint FROM delivery_only_recovery_cursor").get()).toEqual({ after_fingerprint: "" });
    expect(f.sends).toHaveLength(0);
  } finally { f.db.close(); }
});

test("lost cursor acknowledgement eventually revisits pending delivery", async () => {
  const { sweepDeliveryOnly } = await import("../../workers/mail-router/src/delivery-only-sweep");
  const f = await fixture();
  try {
    const bucket = f.env.RELAY_SPOOL!;
    const get = bucket.get.bind(bucket);
    bucket.get = (async () => null) as R2Bucket["get"];
    expect(await f.admit()).toBeUndefined();
    bucket.get = get;
    let lost = false;
    f.d1.after = (sql) => {
      if (!lost && sql.includes("UPDATE delivery_only_recovery_cursor SET after_fingerprint = ?1")) {
        lost = true; throw new Error("cursor acknowledgement lost");
      }
    };
    await expect(sweepDeliveryOnly(f.env)).rejects.toThrow("cursor acknowledgement lost");
    f.d1.after = undefined;
    expect(f.sends).toHaveLength(0);
    await sweepDeliveryOnly(f.env); // wraps the cursor
    await sweepDeliveryOnly(f.env); // revisits the unattempted delivery
    expect(f.sends).toHaveLength(2);
    await sweepDeliveryOnly(f.env);
    expect(f.sends).toHaveLength(2);
  } finally { f.db.close(); }
});

test("scheduled recovery holds pending recipients when active policy changes", async () => {
  const { sweepDeliveryOnly } = await import("../../workers/mail-router/src/delivery-only-sweep");
  const f = await fixture();
  try {
    const bucket = f.env.RELAY_SPOOL!;
    const get = bucket.get.bind(bucket);
    bucket.get = (async () => null) as R2Bucket["get"];
    expect(await f.admit()).toBeUndefined();
    bucket.get = get;
    const other = "d".repeat(64);
    f.db.run("INSERT INTO policy_revisions(policy_sha256,r2_object_key,expected_domain_count,expected_route_count) VALUES (?1,'policy/other',1,1)", [other]);
    f.db.run("UPDATE runtime_state SET active_policy_sha256=?1,active_policy_r2_key='policy/other' WHERE singleton=1", [other]);
    f.db.run("UPDATE alias_routes SET policy_sha256=?1 WHERE id='route:example.com:support'", [other]);
    await sweepDeliveryOnly(f.env);
    expect(f.sends).toHaveLength(0);
    expect(f.db.query("SELECT status FROM delivery_only_recipient_deliveries").all()).toEqual([{ status: "pending" }, { status: "pending" }]);
    const { ROUTE_STATUS_INPUT_SQL } = await import("../../workers/shared/status-store");
    const { ROUTES_SQL } = await import("../../workers/mail-canary/src/index");
    expect((f.db.query(ROUTE_STATUS_INPUT_SQL).get(other, "", null) as { delivery_only_status: string }).delivery_only_status).toBe("recovery_required");
    expect((f.db.query(ROUTES_SQL).get(other) as { delivery_only_status: string }).delivery_only_status).toBe("recovery_required");
    f.db.run("UPDATE alias_routes SET policy_sha256=?1 WHERE id='route:example.com:support'", [f.policySha]);
    f.db.run("UPDATE runtime_state SET active_policy_sha256=?1,active_policy_r2_key=?2 WHERE singleton=1", [f.policySha, `config/policy/${f.policySha}.json`]);
    await sweepDeliveryOnly(f.env);
    await sweepDeliveryOnly(f.env);
    expect(f.sends).toHaveLength(2);
  } finally { f.db.close(); }
});

test("missing recovery payload remains held and never sends", async () => {
  const { sweepDeliveryOnly } = await import("../../workers/mail-router/src/delivery-only-sweep");
  const f = await fixture();
  try {
    const bucket = f.env.RELAY_SPOOL!;
    const get = bucket.get.bind(bucket);
    bucket.get = (async () => null) as R2Bucket["get"];
    expect(await f.admit()).toBeUndefined();
    bucket.get = get;
    f.objects.clear(); // Model a missing payload; this does not establish why it is missing.
    await sweepDeliveryOnly(f.env);
    await sweepDeliveryOnly(f.env);
    await sweepDeliveryOnly(f.env);
    expect(f.sends).toHaveLength(0);
    expect(f.db.query("SELECT status FROM delivery_only_deliveries").get()).toEqual({ status: "recovery_required" });
    expect(f.db.query("SELECT status,error_code FROM delivery_only_recipient_deliveries").all()).toEqual([{ status: "pending", error_code: "delivery_payload_missing_observed" }, { status: "pending", error_code: "delivery_payload_missing_observed" }]);
    const { ROUTE_STATUS_INPUT_SQL } = await import("../../workers/shared/status-store");
    const { ROUTES_SQL } = await import("../../workers/mail-canary/src/index");
    const status = f.db.query(ROUTE_STATUS_INPUT_SQL).get(f.policySha, "", null) as { delivery_only_status: string; delivery_only_unknown: number };
    const canary = f.db.query(ROUTES_SQL).get(f.policySha) as { delivery_only_status: string };
    expect(status.delivery_only_status).toBe("recovery_required");
    expect(status.delivery_only_unknown).toBe(0); // no provider attempt was made
    expect(canary.delivery_only_status).toBe("recovery_required");
    // The fixture's current projected route is ordinary; legacy delivery-only
    // work must still block its readiness after a mode transition.
    const saved = f.db.query("SELECT projection_json FROM route_status_projection WHERE route_id='route:example.com:support'").get() as { projection_json: string };
    expect(JSON.parse(saved.projection_json)).toMatchObject({ classification: "needs_attention", reason_codes: ["delivery_payload_missing_observed"], next_action: "inspect_delivery_recovery", unknown_provider_attempts: 0 });
    f.db.run("INSERT INTO delivery_only_deliveries(id,fingerprint_sha256,route_id,policy_sha256,raw_r2_key,recipient_count,received_at) VALUES ('newer',?1,'route:example.com:support',?2,'newer',1,'2099-01-01')", ["e".repeat(64), f.policySha]);
    f.db.run("INSERT INTO delivery_only_recipient_deliveries(delivery_id,recipient_ref,delivery_message_id,delivery_payload_r2_key,delivery_payload_sha256) VALUES ('newer',?1,'id','newer',?1)", ["f".repeat(64)]);
    expect((f.db.query(ROUTE_STATUS_INPUT_SQL).get(f.policySha, "", null) as { delivery_only_status: string }).delivery_only_status).toBe("recovery_required");
    expect((f.db.query(ROUTES_SQL).get(f.policySha) as { delivery_only_status: string }).delivery_only_status).toBe("recovery_required");
  } finally { f.db.close(); }
});

test("scheduled status refresh failure cannot reopen an accepted delivery", async () => {
  const { sweepDeliveryOnly } = await import("../../workers/mail-router/src/delivery-only-sweep");
  const f = await fixture();
  try {
    const bucket = f.env.RELAY_SPOOL!;
    const get = bucket.get.bind(bucket);
    bucket.get = (async () => null) as R2Bucket["get"];
    expect(await f.admit()).toBeUndefined();
    bucket.get = get;
    f.d1.before = (sql) => { if (sql.includes("INSERT INTO route_status_projection")) throw new Error("projection unavailable"); };
    await sweepDeliveryOnly(f.env);
    expect(f.sends).toHaveLength(2);
    expect(f.db.query("SELECT status FROM delivery_only_deliveries").get()).toEqual({ status: "provider_accepted" });
    f.d1.before = undefined;
    await sweepDeliveryOnly(f.env);
    await sweepDeliveryOnly(f.env);
    expect(f.sends).toHaveLength(2);
  } finally { f.db.close(); }
});

test("an unavailable spool read is not recorded as a missing payload", async () => {
  const f = await fixture();
  try {
    f.env.RELAY_SPOOL!.get = (async () => { throw new Error("storage unavailable"); }) as R2Bucket["get"];
    expect(await f.admit()).toBeUndefined();
    expect(f.sends).toHaveLength(0);
    expect(f.db.query("SELECT status,error_code FROM delivery_only_recipient_deliveries").all()).toEqual([{ status: "pending", error_code: null }, { status: "pending", error_code: null }]);
  } finally { f.db.close(); }
});

test("an unbound spool object is not recorded as a missing payload", async () => {
  const f = await fixture();
  try {
    f.env.RELAY_SPOOL!.get = (async () => ({ size: 1, customMetadata: {} })) as unknown as R2Bucket["get"];
    expect(await f.admit()).toBeUndefined();
    expect(f.sends).toHaveLength(0);
    expect(f.db.query("SELECT status,error_code FROM delivery_only_recipient_deliveries").all()).toEqual([{ status: "pending", error_code: null }, { status: "pending", error_code: null }]);
  } finally { f.db.close(); }
});

test("retained raw fixture can reproduce its exact bound recipient payloads", async () => {
  const { buildDeliveryOnlyMessage, parseRelayEmail, sha256Hex } = await import("../../workers/shared/inbox-relay");
  const { serializeDeliveryOnlyMessage } = await import("../../workers/mail-router/src/delivery-only-spool");
  const f = await fixture();
  try {
    f.env.RELAY_SPOOL!.get = (async () => null) as R2Bucket["get"];
    expect(await f.admit()).toBeUndefined();
    expect(f.sends).toHaveLength(0);
    const parent = f.db.query("SELECT raw_r2_key FROM delivery_only_deliveries").get() as { raw_r2_key: string };
    const rawObject = f.objects.get(parent.raw_r2_key);
    expect(rawObject).toBeDefined();
    const parsed = await parseRelayEmail(rawObject!.bytes.slice().buffer);
    const recipients = ["operator@example.com", "second@example.com"];
    const claims = f.db.query("SELECT recipient_ref,delivery_message_id,delivery_payload_sha256 FROM delivery_only_recipient_deliveries").all() as Array<{ recipient_ref: string; delivery_message_id: string; delivery_payload_sha256: string }>;
    for (const claim of claims) {
      const matches = [];
      for (const recipient of recipients) if (await sha256Hex(recipient) === claim.recipient_ref) matches.push(recipient);
      expect(matches).toHaveLength(1);
      const rebuilt = buildDeliveryOnlyMessage(parsed, { recipient: matches[0]!, receivedAddress: "support@example.com", deliveryMessageId: claim.delivery_message_id });
      expect(await sha256Hex(serializeDeliveryOnlyMessage(rebuilt))).toBe(claim.delivery_payload_sha256);
      const tampered = buildDeliveryOnlyMessage({ ...parsed, text: parsed.text + " changed" }, { recipient: matches[0]!, receivedAddress: "support@example.com", deliveryMessageId: claim.delivery_message_id });
      expect(await sha256Hex(serializeDeliveryOnlyMessage(tampered))).not.toBe(claim.delivery_payload_sha256);
    }
    expect(f.sends).toHaveLength(0);
  } finally { f.db.close(); }
});

test("missing recipient payload can recover in memory from exact raw and active policy", async () => {
  const { sweepDeliveryOnly } = await import("../../workers/mail-router/src/delivery-only-sweep");
  const f = await fixture(true);
  try {
    const bucket = f.env.RELAY_SPOOL!;
    const get = bucket.get.bind(bucket);
    let paused = true;
    bucket.get = (async (...args: Parameters<R2Bucket["get"]>) => paused ? null : get(...args)) as R2Bucket["get"];
    expect(await f.admit()).toBeUndefined();
    expect(f.sends).toHaveLength(0);
    const payloadKeys = [...f.objects.keys()].filter((key) => key.includes(".delivery-only-"));
    expect(payloadKeys).toHaveLength(2);
    for (const key of payloadKeys) f.objects.delete(key);
    paused = false;
    const writesBeforeRecovery = f.writes();
    await sweepDeliveryOnly(f.env);
    expect(f.writes()).toBe(writesBeforeRecovery);
    expect(f.sends).toHaveLength(2);
    expect(f.db.query("SELECT status FROM delivery_only_deliveries").get()).toEqual({ status: "provider_accepted" });
    await sweepDeliveryOnly(f.env);
    expect(f.sends).toHaveLength(2);
  } finally { f.db.close(); }
});

test("reconstruction refuses tampered raw and never crosses the provider boundary", async () => {
  const { sweepDeliveryOnly } = await import("../../workers/mail-router/src/delivery-only-sweep");
  const f = await fixture(true);
  try {
    const bucket = f.env.RELAY_SPOOL!, get = bucket.get.bind(bucket);
    let paused = true;
    bucket.get = (async (...args: Parameters<R2Bucket["get"]>) => paused ? null : get(...args)) as R2Bucket["get"];
    expect(await f.admit()).toBeUndefined();
    for (const key of [...f.objects.keys()].filter((key) => key.includes(".delivery-only-"))) f.objects.delete(key);
    const rawKey = (f.db.query("SELECT raw_r2_key FROM delivery_only_deliveries").get() as { raw_r2_key: string }).raw_r2_key;
    const object = f.objects.get(rawKey)!;
    object.bytes = new TextEncoder().encode(new TextDecoder().decode(object.bytes).replace("report body", "altered body"));
    paused = false;
    await sweepDeliveryOnly(f.env);
    expect(f.sends).toHaveLength(0);
    expect(f.db.query("SELECT status FROM delivery_only_recipient_deliveries").all()).toEqual([{ status: "pending" }, { status: "pending" }]);
  } finally { f.db.close(); }
});

test("reconstructed payloads retain the no-replay boundary on provider uncertainty", async () => {
  const { sweepDeliveryOnly } = await import("../../workers/mail-router/src/delivery-only-sweep");
  const f = await fixture(true);
  try {
    const bucket = f.env.RELAY_SPOOL!, get = bucket.get.bind(bucket);
    let paused = true;
    bucket.get = (async (...args: Parameters<R2Bucket["get"]>) => paused ? null : get(...args)) as R2Bucket["get"];
    expect(await f.admit()).toBeUndefined();
    for (const key of [...f.objects.keys()].filter((key) => key.includes(".delivery-only-"))) f.objects.delete(key);
    paused = false; f.faults.providerAfter = true;
    await Promise.all([sweepDeliveryOnly(f.env), sweepDeliveryOnly(f.env)]);
    expect(f.sends).toHaveLength(2);
    expect(f.db.query("SELECT status FROM delivery_only_recipient_deliveries").all()).toEqual([{ status: "recovery_required" }, { status: "recovery_required" }]);
    f.faults.providerAfter = false;
    await sweepDeliveryOnly(f.env); await sweepDeliveryOnly(f.env);
    expect(f.sends).toHaveLength(2);
  } finally { f.db.close(); }
});

test("reconstruction holds when the active policy changes", async () => {
  const { sweepDeliveryOnly } = await import("../../workers/mail-router/src/delivery-only-sweep");
  const f = await fixture(true);
  try {
    const bucket = f.env.RELAY_SPOOL!, get = bucket.get.bind(bucket);
    let paused = true;
    bucket.get = (async (...args: Parameters<R2Bucket["get"]>) => paused ? null : get(...args)) as R2Bucket["get"];
    expect(await f.admit()).toBeUndefined();
    for (const key of [...f.objects.keys()].filter((key) => key.includes(".delivery-only-"))) f.objects.delete(key);
    const other = "d".repeat(64);
    f.db.run("INSERT INTO policy_revisions(policy_sha256,r2_object_key,expected_domain_count,expected_route_count) VALUES (?1,'policy/other',1,1)", [other]);
    f.db.run("UPDATE runtime_state SET active_policy_sha256=?1,active_policy_r2_key='policy/other' WHERE singleton=1", [other]);
    paused = false;
    await sweepDeliveryOnly(f.env);
    expect(f.sends).toHaveLength(0);
    expect(f.db.query("SELECT status FROM delivery_only_recipient_deliveries").all()).toEqual([{ status: "pending" }, { status: "pending" }]);
  } finally { f.db.close(); }
});

test("reconstruction preserves multipart text and attachment bytes", async () => {
  const { sweepDeliveryOnly } = await import("../../workers/mail-router/src/delivery-only-sweep");
  const mime = new TextEncoder().encode("From: sender@example.net\r\nTo: support@example.com\r\nSubject: report\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=example\r\n\r\n--example\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nreport body\r\n--example\r\nContent-Type: application/xml; name=report.xml\r\nContent-Disposition: attachment; filename=report.xml\r\nContent-Transfer-Encoding: base64\r\n\r\nPHJlcG9ydC8+\r\n--example--\r\n").buffer;
  const f = await fixture(true, mime);
  try {
    const bucket = f.env.RELAY_SPOOL!, get = bucket.get.bind(bucket);
    let paused = true;
    bucket.get = (async (...args: Parameters<R2Bucket["get"]>) => paused ? null : get(...args)) as R2Bucket["get"];
    expect(await f.admit()).toBeUndefined();
    for (const key of [...f.objects.keys()].filter((key) => key.includes(".delivery-only-"))) f.objects.delete(key);
    paused = false;
    await sweepDeliveryOnly(f.env);
    expect(f.sends).toHaveLength(2);
    for (const message of f.sends) {
      expect(message.text).toContain("report body");
      expect(message.attachments?.[0]?.filename).toBe("report.xml");
      expect(new TextDecoder().decode(message.attachments![0]!.content as ArrayBuffer)).toBe("<report/>");
    }
  } finally { f.db.close(); }
});

test("reconstruction rejects raw objects with mismatched metadata", async () => {
  const { sweepDeliveryOnly } = await import("../../workers/mail-router/src/delivery-only-sweep");
  const f = await fixture(true);
  try {
    const bucket = f.env.RELAY_SPOOL!, get = bucket.get.bind(bucket);
    let paused = true;
    bucket.get = (async (...args: Parameters<R2Bucket["get"]>) => paused ? null : get(...args)) as R2Bucket["get"];
    expect(await f.admit()).toBeUndefined();
    for (const key of [...f.objects.keys()].filter((key) => key.includes(".delivery-only-"))) f.objects.delete(key);
    const rawKey = (f.db.query("SELECT raw_r2_key FROM delivery_only_deliveries").get() as { raw_r2_key: string }).raw_r2_key;
    f.objects.get(rawKey)!.metadata.deliveryId = "unrelated";
    paused = false;
    await sweepDeliveryOnly(f.env);
    expect(f.sends).toHaveLength(0);
    expect(f.db.query("SELECT status FROM delivery_only_recipient_deliveries").all()).toEqual([{ status: "pending" }, { status: "pending" }]);
  } finally { f.db.close(); }
});

test("policy change after reconstruction is fenced at the provider claim", async () => {
  const { sweepDeliveryOnly } = await import("../../workers/mail-router/src/delivery-only-sweep");
  const f = await fixture(true);
  try {
    const bucket = f.env.RELAY_SPOOL!, get = bucket.get.bind(bucket);
    let paused = true;
    bucket.get = (async (...args: Parameters<R2Bucket["get"]>) => paused ? null : get(...args)) as R2Bucket["get"];
    expect(await f.admit()).toBeUndefined();
    for (const key of [...f.objects.keys()].filter((key) => key.includes(".delivery-only-"))) f.objects.delete(key);
    const other = "d".repeat(64);
    f.db.run("INSERT INTO policy_revisions(policy_sha256,r2_object_key,expected_domain_count,expected_route_count) VALUES (?1,'policy/other',1,1)", [other]);
    let switched = false;
    f.d1.before = (sql) => {
      if (!switched && sql.includes("UPDATE delivery_only_recipient_deliveries SET status = 'sending'")) {
        switched = true;
        f.db.run("UPDATE runtime_state SET active_policy_sha256=?1,active_policy_r2_key='policy/other' WHERE singleton=1", [other]);
      }
    };
    paused = false;
    await sweepDeliveryOnly(f.env);
    expect(switched).toBe(true);
    expect(f.sends).toHaveLength(0);
    expect(f.db.query("SELECT status FROM delivery_only_recipient_deliveries").all()).toEqual([{ status: "pending" }, { status: "pending" }]);
  } finally { f.db.close(); }
});

test("lost missing-observation clear acknowledgement does not send twice", async () => {
  const { sweepDeliveryOnly } = await import("../../workers/mail-router/src/delivery-only-sweep");
  const f = await fixture(true);
  try {
    const bucket = f.env.RELAY_SPOOL!, get = bucket.get.bind(bucket);
    let paused = true;
    bucket.get = (async (...args: Parameters<R2Bucket["get"]>) => paused ? null : get(...args)) as R2Bucket["get"];
    expect(await f.admit()).toBeUndefined();
    expect(f.sends).toHaveLength(0);
    let lost = false;
    f.d1.after = (sql, values) => {
      if (!lost && sql.includes("SET error_code = ?1") && values[0] === null) {
        lost = true; throw new Error("observation acknowledgement lost");
      }
    };
    paused = false;
    await sweepDeliveryOnly(f.env);
    expect(lost).toBe(true);
    expect(f.sends).toHaveLength(1);
    f.d1.after = undefined;
    await sweepDeliveryOnly(f.env);
    await sweepDeliveryOnly(f.env);
    expect(f.sends).toHaveLength(2);
    await sweepDeliveryOnly(f.env);
    expect(f.sends).toHaveLength(2);
    expect(f.db.query("SELECT status FROM delivery_only_recipient_deliveries ORDER BY recipient_ref").all()).toEqual([{ status: "provider_accepted" }, { status: "provider_accepted" }]);
  } finally { f.db.close(); }
});
