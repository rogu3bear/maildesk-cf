import { expect, test } from "bun:test";
import { activateFixture, relayRuntime, testPolicy } from "../helpers/relay-runtime";
import { authorizeReplyWithPolicy, routeInbound, type RouterPolicy } from "../../workers/shared/router";
import { publicIdentityProfileSha256, sha256Hex } from "../../workers/shared/inbox-relay";
import { completeActivationCoverage } from "../../workers/shared/status-store";
import { CLAIM_ACTIVE_INBOUND_RECIPIENT_SQL } from "../../workers/mail-router/src/inbound-repository";

function policy(): RouterPolicy {
  const result = structuredClone(testPolicy);
  result.default_reply_mode = "personal_first";
  const domain = result.domains["example.com"]!;
  domain.role_aliases.support!.operators = ["operator-a@example.net", "operator-b@example.net"];
  for (const prefix of ["operator-a", "operator-b"]) {
    domain.personal_aliases[prefix] = { operator: `${prefix}@example.net`, reply_identity: `${prefix}@example.com` };
    result.identity_profiles![`${prefix}@example.com`] = {
      display_name: `Example ${prefix}`, signature_profile_ref: `signature:${prefix}`,
      signature_text: `Example ${prefix}\nexample.com`, sender_adapter: "cloudflare_email_service",
    };
  }
  return result;
}

for (const mode of ["role_first", "personal_first"] as const) {
  test(`${mode} exact inbound redelivery recovers only unsent recipients with their original public identities`, async () => {
    const current = policy();
    current.default_reply_mode = mode;
    const f = await relayRuntime(99, current, "operator-a@example.net");
    try {
      const raw = new TextEncoder().encode("From: sender@example.net\r\nTo: support@example.com\r\nMessage-ID: <recover-identities@example.net>\r\nSubject: Recovery\r\nContent-Type: text/plain\r\n\r\nHello\r\n").buffer;
      f.d1.before = (sql) => { if (sql === CLAIM_ACTIVE_INBOUND_RECIPIENT_SQL) throw new Error("claim unavailable before send"); };
      await f.ingress(raw, "support@example.com", "sender@example.net");
      expect(f.sends).toHaveLength(0);
      expect(f.db.query("SELECT status FROM inbound_recipient_deliveries").all()).toEqual([{ status: "pending" }, { status: "pending" }]);
      f.d1.before = undefined;
      await f.ingress(raw, "support@example.com", "sender@example.net");
      expect(f.sends).toHaveLength(2);
      for (const prefix of ["operator-a", "operator-b"]) {
        const delivery = f.sends.find((entry) => entry.to === `${prefix}@example.net`)!;
        const identity = mode === "personal_first" ? `${prefix}@example.com` : "support@example.com";
        expect(delivery.from).toMatchObject({ email: identity });
        expect(delivery.headers?.["X-Maildesk-Reply-Identity"]).toBe(identity);
      }
      expect(f.db.query("SELECT status FROM inbound_recipient_deliveries").all()).toEqual([{ status: "provider_accepted" }, { status: "provider_accepted" }]);
      expect(f.db.query("SELECT DISTINCT reply_identity FROM reply_relays").all()).toEqual([{ reply_identity: "support@example.com" }]);
      await f.ingress(raw, "support@example.com", "sender@example.net");
      expect(f.sends).toHaveLength(2);
    } finally { f.db.close(); }
  });
}

test("personal-first recovery rejects a substituted identity in the immutable spool", async () => {
  const f = await relayRuntime(99, policy(), "operator-a@example.net");
  try {
    const raw = new TextEncoder().encode("From: sender@example.net\r\nTo: support@example.com\r\nMessage-ID: <tampered-identities@example.net>\r\nContent-Type: text/plain\r\n\r\nHello\r\n").buffer;
    f.d1.before = (sql) => { if (sql === CLAIM_ACTIVE_INBOUND_RECIPIENT_SQL) throw new Error("claim unavailable before send"); };
    await f.ingress(raw, "support@example.com", "sender@example.net");
    f.d1.before = undefined;
    const rows = f.db.query("SELECT delivery_payload_r2_key FROM inbound_recipient_deliveries").all() as Array<{ delivery_payload_r2_key: string }>;
    for (const row of rows) {
      const delivery = JSON.parse(new TextDecoder().decode(f.spools.get(row.delivery_payload_r2_key)!));
      delivery.from.email = "substituted@example.com";
      delivery.headers["X-Maildesk-Reply-Identity"] = "substituted@example.com";
      f.spools.set(row.delivery_payload_r2_key, new TextEncoder().encode(JSON.stringify(delivery)).buffer);
    }
    await f.ingress(raw, "support@example.com", "sender@example.net");
    expect(f.sends).toHaveLength(0);
    expect(f.db.query("SELECT status FROM inbound_recipient_deliveries").all()).toEqual([{ status: "pending" }, { status: "pending" }]);
  } finally { f.db.close(); }
});

test("shared inbound delivery gives each primary inbox its own public reply identity", async () => {
  const f = await relayRuntime(99, policy(), "operator-a@example.net");
  try {
    const raw = new TextEncoder().encode("From: sender@example.net\r\nTo: support@example.com\r\nMessage-ID: <shared-inbound@example.net>\r\nSubject: Shared question\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello\r\n").buffer;
    expect(await f.ingress(raw, "support@example.com", "sender@example.net")).toBeUndefined();
    expect(f.sends).toHaveLength(2);
    for (const prefix of ["operator-a", "operator-b"]) {
      const delivered = f.sends.find((message) => message.to === `${prefix}@example.net`)!;
      expect(delivered.from).toMatchObject({ email: `${prefix}@example.com` });
      expect(delivered.headers?.["X-Maildesk-Reply-Identity"]).toBe(`${prefix}@example.com`);
      expect(delivered.text).toContain("Received at: support@example.com");
      expect(delivered.text).toContain(`<${prefix}@example.com>`);
      expect(delivered.text).not.toContain("operator-a@example.net");
      expect(delivered.text).not.toContain("operator-b@example.net");
    }
  } finally { f.db.close(); }
});

test("signed operator replies traverse real D1 claims and queues with their own prefix at the receiving domain", async () => {
  for (const prefix of ["operator-a", "operator-b"]) {
    const actor = `${prefix}@example.net`, publicIdentity = `${prefix}@example.com`;
    const f = await relayRuntime(99, policy(), actor);
    try {
      await f.admitCanary();
      expect(await f.ingress(await f.signedReply())).toBeUndefined();
      expect(f.jobs).toHaveLength(1);
      expect(await f.consume()).toEqual({ acked: 1, retries: 0 });
      expect(f.sends).toHaveLength(1);
      expect(f.sends[0]!.from).toMatchObject({ email: publicIdentity });
      expect(JSON.stringify(f.sends[0])).not.toContain(actor);
      expect(f.db.query("SELECT public_identity, status FROM reply_admissions").get()).toEqual({ public_identity: publicIdentity, status: "provider_accepted" });
      expect(f.db.query("SELECT reply_identity FROM reply_relays WHERE id = 'relay:one'").get()).toEqual({ reply_identity: "support@example.com" });
      expect(f.db.query("SELECT json_extract(detail_json, '$.fromIdentity') AS identity FROM audit_events WHERE action = 'inbox_reply_authorized'").get()).toEqual({ identity: publicIdentity });
      await f.consume();
      expect(f.sends).toHaveLength(1);
    } finally { f.db.close(); }
  }
});

test("one operator activation cannot claim full group coverage or hide an identity mismatch", async () => {
  const current = policy(), f = await relayRuntime(99, current, "operator-a@example.net");
  try {
    f.env.MAILDESK_RUNTIME_ARTIFACTS_SHA256 = "1".repeat(64);
    f.env.MAILDESK_TOPOLOGY_SHA256 = "2".repeat(64);
    const routed = routeInbound(current, { envelopeTo: "support@example.com", headerFrom: "sender@example.net" });
    if (!routed.ok) throw Error(routed.error.kind);
    const now = Date.now(), rows = [];
    for (const [index, actor] of routed.value.operators.entries()) {
      const auth = authorizeReplyWithPolicy(current, { envelopeTo: "support@example.com", operator: actor });
      if (!auth.ok || !auth.value.identityProfile) throw Error("missing fixture profile");
      rows.push({ id: `activation:${index}`, public_identity: auth.value.fromIdentity,
        identity_profile_sha256: await publicIdentityProfileSha256(auth.value.identityProfile),
        operator_set_sha256: await sha256Hex(JSON.stringify(routed.value.operators)),
        runtime_artifacts_sha256: f.env.MAILDESK_RUNTIME_ARTIFACTS_SHA256, topology_sha256: f.env.MAILDESK_TOPOLOGY_SHA256,
        sender_adapter: "cloudflare_email_service", expires_at: null,
        inbox_at: new Date(now - 1000 - index * 1000).toISOString(), reply_at: new Date(now - 500 - index * 1000).toISOString() });
    }
    expect(await completeActivationCoverage(routed.value, JSON.stringify(rows.slice(0, 1)), f.env, now)).toBeNull();
    expect(await completeActivationCoverage(routed.value, JSON.stringify(rows), f.env, now)).toMatchObject({ representativeId: "activation:0", inboxAt: new Date(now - 2000).toISOString(), replyAt: new Date(now - 1500).toISOString() });
    const changed = structuredClone(rows); changed[1]!.identity_profile_sha256 = "9".repeat(64);
    expect(await completeActivationCoverage(routed.value, JSON.stringify(changed), f.env, now)).toBeNull();
    const missingProof = structuredClone(rows); missingProof[1]!.reply_at = "invalid";
    expect(await completeActivationCoverage(routed.value, JSON.stringify(missingProof), f.env, now)).toMatchObject({ replyAt: null });
  } finally { f.db.close(); }
});

test("ordinary activation admits its own operator prefix and cannot authorize another group member's identity", async () => {
  for (const prefix of ["operator-a", "operator-b"]) {
    const actor = `${prefix}@example.net`, publicIdentity = `${prefix}@example.com`;
    const other = prefix === "operator-a" ? "operator-b@example.net" : "operator-a@example.net";
    const f = await relayRuntime(99, policy(), actor);
    try {
      await activateFixture(f);
      expect(f.sends).toHaveLength(1);
      expect(await f.ingress(await f.signedReply("<ordinary@example.net>"))).toBeUndefined();
      await f.consume(f.jobs.at(-1)!);
      expect(f.sends).toHaveLength(2);
      expect(f.sends[1]!.from).toMatchObject({ email: publicIdentity });
      expect(f.db.query("SELECT public_identity, status FROM ordinary_reply_admissions").get()).toEqual({ public_identity: publicIdentity, status: "provider_accepted" });
      expect(await f.ingress(await f.signedReply("<other@example.net>", "Reply\r\n", other), f.relayRecipient, other)).toContain("explicit ordinary route authorization");
      expect(f.sends).toHaveLength(2);
      expect(f.db.query("SELECT count(*) AS n FROM ordinary_reply_admissions").get()).toEqual({ n: 1 });
    } finally { f.db.close(); }
  }
});
