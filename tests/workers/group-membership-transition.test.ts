import { expect, test } from "bun:test";
import { relayRuntime, testPolicy } from "../helpers/relay-runtime";
import { projectRoutes, projectionSql } from "../../scripts/sync-route-policy";
import { sha256Hex } from "../../workers/shared/inbox-relay";
import { loadActivePolicy } from "../../workers/shared/policy-store";
import { authorizeReplyWithPolicy } from "../../workers/shared/router";

// Offline client/provider fixtures only; these are not Apple Mail or live mail proof.
for (const state of ["queued", "accepted", "uncertain"] as const) {
  test(`membership revision preserves the original ${state} claim and never repeats its send`, async () => {
    const f = await relayRuntime();
    try {
      await f.admitCanary();
      const raw = await f.signedReply();
      expect(await f.ingress(raw)).toBeUndefined();
      if (state !== "queued") {
        f.faults.providerAfter = state === "uncertain";
        await f.consume();
      }
      const attempts = f.db.query("SELECT * FROM relay_attempts ORDER BY id").all();
      const providerCalls = f.sends.length;
      const next = structuredClone(testPolicy);
      next.domains["example.com"]!.role_aliases.support!.operators = ["second@example.com", "replacement@example.net"];
      const json = JSON.stringify(next); const sha = await sha256Hex(json);
      const desired = { storage: { d1_database: "fixture" }, domains: [{ name: "example.com",
        inbound_mx_provider: "cloudflare_email_routing" as const, role_aliases: ["support"], personal_aliases: [] }] };
      const sql = projectionSql(projectRoutes(next, desired), sha, `config/policy/${sha}.json`, f.desiredSha).sql;
      f.db.transaction(() => { for (const statement of sql.trim().split("\n")) f.db.query(statement).run(); })();
      f.env.POLICY_STORE = { get: async (key: string) => key === `config/policy/${sha}.json`
        ? { arrayBuffer: async () => new TextEncoder().encode(json).buffer } : null } as unknown as R2Bucket;
      const active = await loadActivePolicy(f.env);
      expect(active?.sha256).toBe(sha);
      expect(f.db.query("SELECT * FROM relay_attempts ORDER BY id").all()).toEqual(attempts);
      expect(authorizeReplyWithPolicy(active!.policy, { envelopeTo: "support@example.com", operator: "operator@example.com" }).ok).toBe(false);
      expect(authorizeReplyWithPolicy(active!.policy, { envelopeTo: "support@example.com", operator: "replacement@example.net" }).ok).toBe(true);
      await f.ingress(raw); // Exact occurrence resolves its old claim; no new authority.
      await f.consume();
      expect(f.sends).toHaveLength(providerCalls);
      expect(f.db.query("SELECT count(*) AS n FROM relay_attempts").get()).toEqual({ n: attempts.length });
      expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { f.db.close(); }
  });
}
