import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { projectRoutes, projectionSql } from "../../scripts/sync-route-policy";
import { publicIdentityProfileSha256, sha256Hex } from "../../workers/shared/inbox-relay";
import { authorizeReplyWithPolicy, routeInbound, type RouterPolicy } from "../../workers/shared/router";
import type { MaildeskEnv, MailJob } from "../../workers/shared/contracts";
import mailRouter from "../../workers/mail-router/src/index";
import { processQueueBatch } from "../../workers/shared/outbound/queue";
import { signingFixture } from "./signed-message";
import type { RouteReplyAuthorization } from "../../workers/shared/ordinary-reply";

const root = resolve(import.meta.dir, "../..");
const signerPromise = signingFixture();
export const testPolicy: RouterPolicy = {
  default_reply_mode: "role_first",
  identity_profiles: { "support@example.com": {
    display_name: "Example Support", signature_profile_ref: "signature:support:v1",
    signature_text: "Example Support\nexample.com", sender_adapter: "cloudflare_email_service",
  } },
  domains: { "example.com": { role_aliases: { support: {
    operators: ["operator@example.com", "second@example.com"], reply_identity: "support@example.com",
  } }, personal_aliases: {} } },
};

export class LocalD1 {
  before?: (sql: string, values: SQLQueryBindings[]) => void;
  after?: (sql: string, values: SQLQueryBindings[]) => void;
  constructor(readonly db: Database) {}
  prepare(sql: string): D1PreparedStatement {
    let values: SQLQueryBindings[] = [];
    const run = () => {
      this.before?.(sql, values);
      // D1 reports sqlite3_total_changes(), including trigger side effects.
      const result = this.db.query(sql).run(...values);
      this.after?.(sql, values);
      return { success: true, meta: { changes: result.changes }, results: [] };
    };
    const statement = {
      bind(...input: SQLQueryBindings[]) { values = input; return statement; },
      run: async () => run(),
      first: async () => { this.before?.(sql, values); return this.db.query(sql).get(...values); },
      all: async () => { this.before?.(sql, values); return { success: true, results: this.db.query(sql).all(...values) }; },
      raw: async () => this.db.query(sql).values(...values),
      execute: run,
    };
    return statement as unknown as D1PreparedStatement;
  }
  async batch(statements: D1PreparedStatement[]) {
    return this.db.transaction(() => statements.map((statement) =>
      (statement as unknown as { execute(): { success: true; meta: { changes: number } } }).execute()))();
  }
}

export function migrate(db: Database, after = 0, through = 99): void {
  for (const file of readdirSync(resolve(root, "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    const version = Number(file.slice(0, 4));
    if (version > after && version <= through) db.exec(readFileSync(resolve(root, "migrations", file), "utf8"));
  }
}

export async function relayRuntime(through = 99, policy = testPolicy, actor = "operator@example.com") {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, 0, through);
  const d1 = new LocalD1(db);
  const policyJson = JSON.stringify(policy);
  const policySha = await sha256Hex(policyJson);
  const desiredSha = "b".repeat(64);
  const routes = projectRoutes(policy, { storage: { d1_database: "fixture" }, domains: [{
    name: "example.com", inbound_mx_provider: "cloudflare_email_routing", role_aliases: Object.keys(policy.domains["example.com"]!.role_aliases),
    personal_aliases: Object.keys(policy.domains["example.com"]!.personal_aliases),
  }] });
  const projection = projectionSql(routes, policySha, `config/policy/${policySha}.json`, desiredSha).sql;
  // Populated pre-0013 fixtures must use the historical role-first projection
  // shape. Do not create the new table early: the upgrade must backfill it.
  const initialProjection = through < 13
    ? projection.split("\n").filter((line) => !line.startsWith("INSERT INTO alias_route_reply_identities ")).join("\n")
    : projection;
  db.exec(initialProjection);
  db.run("INSERT INTO threads (id, domain_id, route_id, external_sender) VALUES ('thread:one', 'domain:example.com', 'route:example.com:support', 'sender@example.net')");
  const token = "a".repeat(62);
  const tokenHash = await sha256Hex(token);
  const relayRecipient = `r+${token}@reply.example.net`;
  db.run(`INSERT INTO reply_relays (id, token_sha256, thread_id, route_id, external_recipient,
    reply_identity, original_message_id, expires_at) VALUES
    ('relay:one', ?, 'thread:one', 'route:example.com:support', 'sender@example.net',
    'support@example.com', '<original@example.net>', '2099-01-01T00:00:00Z')`, [tokenHash]);
  db.run(`INSERT INTO inbound_deliveries (id, fingerprint_sha256, relay_id, thread_id, route_id,
    policy_sha256, received_at, status) VALUES ('inbound:one', ?, 'relay:one', 'thread:one',
    'route:example.com:support', ?, ?, 'provider_accepted')`, ["c".repeat(64), policySha, new Date().toISOString()]);
  const profile = authorizeReplyWithPolicy(policy, { envelopeTo: "support@example.com", operator: actor });
  if (!profile.ok || !profile.value.identityProfile) throw new Error("fixture profile missing");
  const profileSha = await publicIdentityProfileSha256(profile.value.identityProfile);
  const routed = routeInbound(policy, { envelopeTo: "support@example.com", headerFrom: "sender@example.net" });
  if (!routed.ok) throw new Error("fixture route missing");
  const operatorSetSha = await sha256Hex(JSON.stringify(routed.value.operators));
  const spools = new Map<string, ArrayBuffer>();
  const jobs: MailJob[] = [];
  const sends: EmailMessageBuilder[] = [];
  const faults = { spoolWrite: false, queueBefore: false, queueAfter: false, cleanup: false, providerAfter: false };
  const env: MaildeskEnv = {
    DB: d1 as unknown as D1Database,
    POLICY_STORE: { get: async (key: string) => key === `config/policy/${policySha}.json`
      ? { arrayBuffer: async () => new TextEncoder().encode(policyJson).buffer } : null } as unknown as R2Bucket,
    RELAY_SPOOL: {
      async put(key: string, value: ArrayBuffer) {
        if (faults.spoolWrite) throw new Error("spool write unavailable");
        spools.set(key, value.slice(0));
      },
      async get(key: string) {
        const value = spools.get(key);
        return value ? { size: value.byteLength, arrayBuffer: async () => value.slice(0) } : null;
      },
      async delete(key: string) { if (faults.cleanup) throw new Error("cleanup unavailable"); spools.delete(key); },
    } as unknown as R2Bucket,
    MAIL_JOBS: { async send(job: MailJob) {
      if (faults.queueBefore) throw new Error("queue unavailable");
      jobs.push(job);
      if (faults.queueAfter) throw new Error("queue acknowledgement lost");
    } } as unknown as Queue<MailJob>,
    EMAIL: { async send(message: EmailMessageBuilder) {
      sends.push(message);
      if (faults.providerAfter) throw new Error("provider acknowledgement lost");
      return { messageId: `provider:${sends.length}` };
    } } as SendEmail,
    MAILDESK_OPERATOR_DELIVERY_MODE: "inbox_relay", MAILDESK_INBOUND_RELAY_MODE: "enabled",
    MAILDESK_REPLY_RELAY_MODE: "enabled", MAILDESK_REPLY_DOMAIN: "reply.example.net",
    MAILDESK_OUTBOUND_MODE: "cloudflare_email_service", MAILDESK_VERIFIED_SENDER_DOMAINS: "example.com",
  };
  return {
    db, d1, env, spools, jobs, sends, faults, policySha, desiredSha, profileSha, operatorSetSha, relayRecipient,
    publicIdentity: profile.value.fromIdentity, profile: profile.value.identityProfile!, operators: routed.value.operators,
    async admitCanary(id = "admission:one") {
      const digest = "d".repeat(64);
      const values: Record<string, SQLQueryBindings> = {
        id, schema_version: 1, transaction_sha256: await sha256Hex(id), correlation_sha256: digest,
        candidate_sha256: digest, scope_manifest_sha256: digest, inbound_delivery_id: "inbound:one",
        relay_id: "relay:one", thread_id: "thread:one", route_id: "route:example.com:support",
        policy_sha256: policySha, desired_state_sha256: desiredSha, operator_set_sha256: operatorSetSha,
        admitted_operator_ref: await sha256Hex(actor), public_identity: profile.value.fromIdentity,
        sender_domain: "example.com", identity_profile_ref: profile.value.identityProfile!.profileRef, identity_profile_sha256: profileSha,
        display_name: profile.value.identityProfile!.displayName, signature_profile_ref: profile.value.identityProfile!.signatureProfileRef,
        signature_sha256: await sha256Hex(profile.value.identityProfile!.signatureText), sender_adapter: "cloudflare_email_service",
        configured_policy_receipt_sha256: digest, edge_activation_receipt_sha256: digest,
        sender_domain_receipt_sha256: digest, inbound_acceptance_receipt_sha256: digest,
        apple_mail_inbox_receipt_sha256: digest, operator_authorization_receipt_sha256: digest,
        opaque_relay_receipt_sha256: digest, evidence_bundle_sha256: digest,
        evidence_observed_at: new Date().toISOString(), admitted_at: new Date(Date.now() - 1000).toISOString(),
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      };
      db.run(`INSERT INTO reply_admissions (${Object.keys(values).join(",")}) VALUES (${Object.keys(values).map(() => "?").join(",")})`, Object.values(values));
    },
    async signedReply(messageId = "<reply-1@example.com>", body = "A plain reply.\r\n", operator = actor) {
      const signer = await signerPromise;
      return signer.sign({ headers: [
        `From: ${operator}`, `To: ${relayRecipient}`, `Message-ID: ${messageId}`,
        "Subject: Re: report", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: 8bit",
      ], body, domain: operator.split("@")[1] });
    },
    async ingress(raw: ArrayBuffer, to = relayRecipient, from = actor) {
      let rejected: string | undefined;
      const message = { from, to, rawSize: raw.byteLength, raw: new Response(raw.slice(0)).body!,
        headers: new Headers(), setReject(reason: string) { rejected = reason; } };
      const prior = globalThis.fetch;
      globalThis.fetch = (await signerPromise).fetcher;
      try { await mailRouter.email(message as ForwardableEmailMessage, env); }
      finally { globalThis.fetch = prior; }
      return rejected;
    },
    async consume(job = jobs[0]!) {
      let acked = 0; let retries = 0;
      await processQueueBatch({ messages: [{ body: job, attempts: 1, ack() { acked++; }, retry() { retries++; } }] } as unknown as MessageBatch<MailJob>, env);
      return { acked, retries };
    },
  };
}

/** Qualification and owner authorization below are explicit offline fixtures.
 * The canary itself traverses the real ingress/Queue implementation first.
 */
export async function activateFixture(f: Awaited<ReturnType<typeof relayRuntime>>, qualificationAlreadyAccepted = false, activationLifetimeMs?: number) {
  if (!qualificationAlreadyAccepted) {
    await f.admitCanary();
    const error = await f.ingress(await f.signedReply("<canary@example.com>"));
    if (error) throw new Error(error);
    await f.consume();
  }
  const now = new Date().toISOString();
  f.env.MAILDESK_ORDINARY_REPLY_MODE = "enabled";
  f.env.MAILDESK_RUNTIME_ARTIFACTS_SHA256 = "1".repeat(64);
  f.env.MAILDESK_TOPOLOGY_SHA256 = "2".repeat(64);
  f.db.run("INSERT INTO policy_projection_state (key, value) VALUES ('active_runtime_artifacts_sha256', ?), ('active_topology_sha256', ?)",
    [f.env.MAILDESK_RUNTIME_ARTIFACTS_SHA256, f.env.MAILDESK_TOPOLOGY_SHA256]);
  for (const kind of ["inbox_verified", "reply_verified"]) {
    f.db.run("INSERT INTO route_proofs (id, route_id, policy_sha256, proof_kind, evidence_sha256, verified_at) VALUES (?, 'route:example.com:support', ?, ?, ?, ?)",
      [`proof:${kind}`, f.policySha, kind, "3".repeat(64), now]);
  }
  const record: Record<string, SQLQueryBindings> = {
    id: "activation:fixture", schema_version: 1, route_id: "route:example.com:support",
    policy_sha256: f.policySha, desired_state_sha256: f.desiredSha,
    public_identity: f.publicIdentity, identity_profile_ref: f.profile.profileRef,
    identity_profile_sha256: f.profileSha, operator_set_sha256: f.operatorSetSha,
    operator_set_json: JSON.stringify(f.operators),
    sender_adapter: "cloudflare_email_service", sender_domain: "example.com",
    runtime_artifacts_sha256: f.env.MAILDESK_RUNTIME_ARTIFACTS_SHA256, topology_sha256: f.env.MAILDESK_TOPOLOGY_SHA256,
    qualification_kind: "golden_thread", canary_admission_id: "admission:one",
    inbox_proof_id: "proof:inbox_verified", reply_proof_id: "proof:reply_verified",
    qualification_receipt_sha256: "4".repeat(64), qualification_valid_until: new Date(Date.now() + 900_000).toISOString(),
    activation_receipt_sha256: "5".repeat(64), owner_authorization_sha256: "6".repeat(64),
    activated_by_ref: "7".repeat(64), activated_at: now,
    expires_at: activationLifetimeMs === undefined ? null : new Date(Date.parse(now) + activationLifetimeMs).toISOString(), status: "active",
  };
  f.db.run(`INSERT INTO route_reply_authorizations (${Object.keys(record).join(",")}) VALUES (${Object.keys(record).map(() => "?").join(",")})`, Object.values(record));
  return f.db.query("SELECT * FROM route_reply_authorizations").get() as RouteReplyAuthorization;
}
