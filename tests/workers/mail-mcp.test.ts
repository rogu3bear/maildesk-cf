import { expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createMaildeskMcp, type MaildeskMcpEnv } from "../../workers/mail-mcp/src/index";
import { MCP_GENERATION_SQL, MCP_STATUS_SQL } from "../../workers/mail-mcp/src/read-model";
import { refreshRouteStatuses } from "../../workers/shared/status-store";
import { relayRuntime, testPolicy } from "../helpers/relay-runtime";

const resource = "https://maildesk.example.org/mcp", issuer = "https://login.example.org";
const keys = await generateKeyPair("RS256", { modulusLength: 2048 });
const jwk = { ...await exportJWK(keys.publicKey), kid: "fixture", alg: "RS256", use: "sig" };
const resolveKey = createLocalJWKSet({ keys: [jwk] });
const scopes = "maildesk.routes.read maildesk.status.read";
async function token(overrides: Record<string, unknown> = {}, typ = "at+jwt") {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: "operator-one", client_id: "fixture-client", scope: scopes, iat: now, exp: now + 3600,
    iss: issuer, aud: resource, ...overrides }).setProtectedHeader({ alg: "RS256", typ, kid: "fixture" }).sign(keys.privateKey);
}
function policy(extra = 0) {
  const p = structuredClone(testPolicy), roles = p.domains["example.com"]!.role_aliases;
  roles.restricted = { operators: ["unrelated@example.net"], reply_identity: "support@example.com" };
  for (let i = 0; i < extra; i++) roles[`role${String(i).padStart(3, "0")}`] = structuredClone(roles.support!);
  return p;
}
async function fixture(extra = 0, now?: () => number) {
  const f = await relayRuntime(99, policy(extra));
  const env: MaildeskMcpEnv = { DB: f.env.DB, POLICY_STORE: f.env.POLICY_STORE,
    MAILDESK_OPERATOR_DELIVERY_MODE: "inbox_relay", MAILDESK_MCP_MODE: "read_only", MAILDESK_MCP_RESOURCE: resource,
    MAILDESK_MCP_ISSUER: issuer, MAILDESK_MCP_JWKS_URL: issuer + "/jwks",
    MAILDESK_MCP_BINDINGS_JSON: JSON.stringify([{ subject: "operator-one", client_id: "fixture-client", operator: "operator@example.com" }]) };
  const worker = createMaildeskMcp({ resolveKey, now });
  const clients: Client[] = [];
  const requests: string[] = [];
  async function connect(access?: string, modern = false) {
    access ??= await token();
    const client = new Client({ name: "maildesk-local-test", version: "1.0.0" }, modern ? { versionNegotiation: { mode: "auto" } } : undefined);
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { authorization: `Bearer ${access}` } },
      fetch: async (url, init) => {
        const request = new Request(url, init); requests.push(request.method + " " + new URL(request.url).pathname);
        return worker.fetch(request, env);
      } });
    await client.connect(transport); return client;
  }
  return { ...f, env, worker, connect, requests, async close() { for (const c of clients) await c.close(); f.db.close(); } };
}
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

for (const modern of [false, true]) {
  const era = modern ? "auto negotiation" : "2025 client";
  test(`a stalled data read stays inside the HTTP deadline (${era})`, async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let pending: Promise<unknown> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await refreshRouteStatuses(f.env as never);
      const client = await f.connect(await token(), modern), before = f.db.serialize();
      const prepare = f.d1.prepare.bind(f.d1);
      f.d1.prepare = sql => {
        const statement = prepare(sql);
        if (sql === MCP_STATUS_SQL) {
          const first = statement.first.bind(statement);
          statement.first = (async () => { await gate; return first(); }) as D1PreparedStatement["first"];
        }
        return statement;
      };
      pending = call(client, "get_delivery_status", { route_id: "route:example.com:support" })
        .then(value => ({ value }), error => ({ error: String(error), status: error.data?.status }));
      const outcome = await Promise.race([pending, new Promise(resolve => {
        watchdog = setTimeout(() => resolve({ timed_out: true }), 7_000);
      })]);
      expect(outcome).toMatchObject({ status: 503, error: expect.stringContaining("mcp_deadline_exceeded") });
      expect(f.db.serialize()).toEqual(before); expect(f.sends).toHaveLength(0); expect(f.jobs).toHaveLength(0);
    } finally {
      clearTimeout(watchdog); release(); await pending; await f.close();
    }
  }, 15_000);

  test(`token expiry during a tool read withholds the streamed result (${era})`, async () => {
    // Keep the controlled server clock behind wall time so default token iat
    // would fail deterministically instead of racing a real second boundary.
    let now = Date.now() - 1000;
    const expires = (Math.floor(now / 1000) + 60) * 1000;
    const f = await fixture(0, () => now);
    try {
      await refreshRouteStatuses(f.env as never, now);
      const client = await f.connect(await token({ iat: Math.floor(now / 1000), exp: expires / 1000 }), modern);
      f.d1.before = sql => { if (sql === MCP_GENERATION_SQL) now = expires; };
      await expect(call(client, "get_delivery_status", { route_id: "route:example.com:support" })).rejects.toThrow("invalid_token");
    } finally { await f.close(); }
  });
}

for (const modern of [false, true]) test(`real MCP client discovers and invokes only read-only tools (${modern ? "auto negotiation" : "2025 client"})`, async () => {
  const f = await fixture();
  try {
    await refreshRouteStatuses(f.env as never);
    const before = f.db.serialize(); const sql: string[] = [];
    f.d1.before = query => { sql.push(query); if (!/^SELECT\b/.test(query)) throw new Error("MCP attempted a write"); };
    const client = await f.connect(await token(), modern), tools = await client.listTools();
    expect(tools.tools.map(t => t.name).sort()).toEqual(["get_delivery_status", "list_authorized_routes"]);
    expect(tools.tools.every(t => t.annotations?.readOnlyHint && t.annotations?.destructiveHint === false)).toBe(true);
    const routes = await call(client, "list_authorized_routes");
    expect(routes.isError).not.toBe(true);
    expect(routes.structuredContent?.routes).toEqual([{ route_id: "route:example.com:support", address: "support@example.com", kind: "role_alias" }]);
    const result = await call(client, "get_delivery_status", { route_id: "route:example.com:support" });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ projection_state: "current", operational_ready: false,
      status: { inbound_outcome: "provider_accepted", inbox_proof: "missing", reply_proof: "missing" } });
    const outward = JSON.stringify([routes, result]);
    for (const forbidden of ["operator@example.com", "second@example.com", "unrelated@example.net", "relay-spool", "activation_id", "signature_text", "token_sha256"]) expect(outward).not.toContain(forbidden);
    expect(sql.length).toBeGreaterThan(0); expect(f.db.serialize()).toEqual(before); expect(f.sends).toHaveLength(0); expect(f.jobs).toHaveLength(0);
  } finally { await f.close(); }
});

test("route authority cannot be supplied in tool arguments or token email claims", async () => {
  const f = await fixture();
  try {
    const client = await f.connect(await token({ email: "unrelated@example.net" }));
    const denied = await call(client, "get_delivery_status", { route_id: "route:example.com:restricted" });
    const absent = await call(client, "get_delivery_status", { route_id: "route:example.com:absent" });
    expect(denied).toMatchObject({ isError: true, content: [{ type: "text", text: "route_not_found_or_not_authorized" }] });
    expect(absent).toEqual(denied);
    expect((await call(client, "list_authorized_routes", { operator: "unrelated@example.net" })).isError).toBe(true);
    expect((await call(client, "get_delivery_status", { route_id: "route:example.com:support", sql: "DELETE FROM messages" })).isError).toBe(true);
    await expect(call(client, "send_mail", { to: "outside@example.net" })).rejects.toThrow("not found");
    expect(f.sends).toHaveLength(0); expect(f.jobs).toHaveLength(0);
  } finally { await f.close(); }
});

test("scopes limit discovery and cannot be escalated by tool invocation", async () => {
  const f = await fixture();
  try {
    const client = await f.connect(await token({ scope: "maildesk.routes.read" }));
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(["list_authorized_routes"]);
    await expect(call(client, "get_delivery_status", { route_id: "route:example.com:support" })).rejects.toThrow("not found");
    f.env.MAILDESK_MCP_BINDINGS_JSON = "[]";
    await expect(client.listTools()).rejects.toThrow();
  } finally { await f.close(); }
});

test("JWT resource, signature, issuer, client, expiry and token type fail closed before storage", async () => {
  const f = await fixture();
  try {
    let reads = 0; f.d1.before = () => { reads++; };
    const signed = (await token()).split("."); signed[2] = (signed[2]!.startsWith("a") ? "b" : "a") + signed[2]!.slice(1);
    const samples = [signed.join("."), await token({ aud: [resource, "https://other.example.org/mcp"] }),
      await token({ aud: "https://other.example.org/mcp" }), await token({ iss: "https://other.example.org" }),
      await token({ client_id: "other-client" }), await token({ sub: "other-user" }), await token({ scope: "mail.send" }),
      await token({ exp: Math.floor(Date.now() / 1000) }), await token({ iat: Math.floor(Date.now() / 1000) + 300 }),
      await token({}, "JWT"), (await token()).replace(/.$/, "!")];
    for (const access of samples) {
      const result = await f.worker.fetch(new Request(resource, { method: "POST", headers: { authorization: `Bearer ${access}` } }), f.env);
      expect([401, 403]).toContain(result.status);
    }
    expect(reads).toBe(0);
  } finally { await f.close(); }
});

test("projection expiry is evaluated after the data read, including equality", async () => {
  const f = await fixture();
  try {
    const observed = Date.now(); await refreshRouteStatuses(f.env as never, observed);
    const expires = new Date(observed + 100).toISOString();
    f.db.run("UPDATE route_status_projection SET valid_until=?,projection_json=json_set(projection_json,'$.valid_until',?) WHERE route_id='route:example.com:support'", [expires, expires]);
    const stored = f.db.query("SELECT valid_until FROM route_status_projection WHERE route_id='route:example.com:support'").get() as { valid_until: string };
    let now = observed;
    const worker = createMaildeskMcp({ resolveKey, now: () => now });
    f.d1.before = sql => { if (sql === MCP_GENERATION_SQL) now = Date.parse(stored.valid_until); };
    // The token remains valid past projection expiry so only projection freshness changes.
    const access = await token({ iat: Math.floor(observed / 1000), exp: Math.floor(observed / 1000) + 10_000 });
    const response = await worker.fetch(new Request(resource, { method: "POST", headers: { authorization: `Bearer ${access}`,
      "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_delivery_status", arguments: { route_id: "route:example.com:support" } } }) }), f.env);
    const body = await response.text();
    expect(response.status).toBe(200); expect(body).toContain('"projection_state":"stale"'); expect(body).toContain('"operational_ready":false');
  } finally { await f.close(); }
});

test("disabled, missing configuration, host/origin mismatch and missing auth cannot read storage", async () => {
  const f = await fixture();
  try {
    let reads = 0; f.d1.before = () => { reads++; };
    expect((await f.worker.fetch(new Request(resource, { method: "POST" }), { ...f.env, MAILDESK_MCP_MODE: "disabled" })).status).toBe(404);
    expect((await f.worker.fetch(new Request(resource, { method: "POST" }), { ...f.env, MAILDESK_MCP_ISSUER: undefined })).status).toBe(503);
    expect((await f.worker.fetch(new Request(resource, { method: "POST", headers: { origin: "https://untrusted.example.net" } }), f.env)).status).toBe(403);
    expect((await f.worker.fetch(new Request(resource, { method: "POST", headers: { host: "untrusted.example.net" } }), f.env)).status).toBe(403);
    const missing = await f.worker.fetch(new Request(resource, { method: "POST" }), f.env);
    expect(missing.status).toBe(401); expect(missing.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
    const metadata = await f.worker.fetch(new Request("https://maildesk.example.org/.well-known/oauth-protected-resource/mcp"), f.env);
    expect(await metadata.json()).toMatchObject({ resource, authorization_servers: [issuer], bearer_methods_supported: ["header"] });
    expect(reads).toBe(0);
  } finally { await f.close(); }
});

test("missing and expired projections stay unknown/stale without refresh", async () => {
  const f = await fixture();
  try {
    const client = await f.connect();
    expect((await call(client, "get_delivery_status", { route_id: "route:example.com:support" })).structuredContent)
      .toMatchObject({ projection_state: "unknown", operational_ready: false, status: null });
    await refreshRouteStatuses(f.env as never, Date.now() - 7_200_001);
    const before = f.db.serialize();
    const stale = await call(client, "get_delivery_status", { route_id: "route:example.com:support" });
    expect(stale.structuredContent).toMatchObject({ projection_state: "stale", operational_ready: false, reason: "operational_projection_stale" });
    expect(f.db.serialize()).toEqual(before);
    f.db.run("UPDATE alias_routes SET status_generation=status_generation+1 WHERE id='route:example.com:support'");
    expect((await call(client, "get_delivery_status", { route_id: "route:example.com:support" })).structuredContent)
      .toMatchObject({ projection_state: "unknown", operational_ready: false, status: null });
  } finally { await f.close(); }
});

test("unknown provider outcomes remain visible reconciliation work and never trigger a send", async () => {
  const f = await fixture();
  try {
    f.db.run("INSERT INTO inbound_recipient_deliveries (delivery_id,operator_ref,delivery_message_id,delivery_payload_r2_key,delivery_payload_sha256,status) VALUES ('inbound:one',?,'fixture-id','relay-spool/fixture',?,'recovery_required')", ["a".repeat(64), "b".repeat(64)]);
    await refreshRouteStatuses(f.env as never);
    const before = f.db.serialize(), client = await f.connect();
    const result = await call(client, "get_delivery_status", { route_id: "route:example.com:support" });
    expect(result.structuredContent).toMatchObject({ operational_ready: false, status: { inbound_outcome: "unknown", unknown_provider_attempts: 1, next_action: "reconcile_provider_outcome" } });
    expect(f.db.serialize()).toEqual(before); expect(f.sends).toHaveLength(0); expect(f.jobs).toHaveLength(0);
  } finally { await f.close(); }
});

test("whole-policy inventory drift and read errors fail instead of returning empty success", async () => {
  const f = await fixture();
  try {
    const client = await f.connect();
    f.db.run("UPDATE alias_routes SET local_part='substituted' WHERE id='route:example.com:support'");
    expect(await call(client, "list_authorized_routes")).toMatchObject({ isError: true, content: [{ type: "text", text: "policy_unavailable" }] });
    f.d1.before = () => { throw new Error("private DB details must not escape"); };
    const failed = await call(client, "get_delivery_status", { route_id: "route:example.com:support" });
    expect(failed.isError).toBe(true); expect(JSON.stringify(failed)).not.toContain("private DB details");
  } finally { await f.close(); }
});

test("policy membership drift during a status read withholds the result", async () => {
  const f = await fixture();
  try {
    await refreshRouteStatuses(f.env as never);
    const client = await f.connect();
    f.d1.before = sql => { if (sql !== MCP_STATUS_SQL) return; f.d1.before = undefined;
      f.db.run("UPDATE operators SET email='substituted@example.net' WHERE email='operator@example.com'"); };
    expect((await call(client, "get_delivery_status", { route_id: "route:example.com:support" })).isError).toBe(true);
  } finally { await f.close(); }
});

test("status-generation drift between reads cannot return an older ready projection", async () => {
  const f = await fixture();
  try {
    await refreshRouteStatuses(f.env as never); const client = await f.connect();
    f.d1.before = sql => { if (sql !== MCP_GENERATION_SQL) return; f.d1.before = undefined;
      f.db.run("UPDATE alias_routes SET status_generation=status_generation+1 WHERE id='route:example.com:support'"); };
    expect(await call(client, "get_delivery_status", { route_id: "route:example.com:support" }))
      .toMatchObject({ isError: true, content: [{ type: "text", text: "status_changed_during_read" }] });
  } finally { await f.close(); }
});

test("route pages are bounded, do not disclose other routes and bind cursors to principal and policy", async () => {
  const f = await fixture(65);
  try {
    const client = await f.connect(); const seen: string[] = []; let cursor: string | undefined;
    do {
      const page = await call(client, "list_authorized_routes", cursor ? { cursor } : {});
      expect(page.isError).not.toBe(true);
      const output = page.structuredContent as { routes: Array<{ route_id: string }>; next_cursor: string | null };
      expect(output.routes.length).toBeLessThanOrEqual(32); seen.push(...output.routes.map(r => r.route_id)); cursor = output.next_cursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(66); expect(new Set(seen).size).toBe(66); expect(seen).not.toContain("route:example.com:restricted");
    const first = await call(client, "list_authorized_routes"), next = first.structuredContent!.next_cursor as string;
    const other = JSON.parse(atob(next.replace(/-/g, "+").replace(/_/g, "/"))); other.principal = "f".repeat(64);
    const changed = btoa(JSON.stringify(other)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect((await call(client, "list_authorized_routes", { cursor: changed })).isError).toBe(true);
    other.principal = JSON.parse(atob(next.replace(/-/g, "+").replace(/_/g, "/"))).principal; other.policy = "e".repeat(64);
    expect((await call(client, "list_authorized_routes", { cursor: btoa(JSON.stringify(other)).replace(/=+$/, "") })).isError).toBe(true);
  } finally { await f.close(); }
});

test("oversized MCP input is rejected before a data read", async () => {
  const f = await fixture();
  try {
    let reads = 0; f.d1.before = () => { reads++; };
    const result = await f.worker.fetch(new Request(resource, { method: "POST", headers: {
      authorization: `Bearer ${await token()}`, "content-type": "application/json", accept: "application/json, text/event-stream",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_authorized_routes", arguments: { cursor: "x".repeat(70_000) } } }) }), f.env);
    expect(result.status).toBe(413); expect(reads).toBe(0);
  } finally { await f.close(); }
});

test("a stalled request body reaches the deadline without storage effects", async () => {
  const f = await fixture(); let cancelled = false;
  try {
    let reads = 0; f.d1.before = () => { reads++; };
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const response = await f.worker.fetch(new Request(resource, { method: "POST", headers: {
      authorization: `Bearer ${await token()}`, "content-type": "application/json", accept: "application/json, text/event-stream",
    }, body }), f.env);
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "mcp_deadline_exceeded" });
    expect(reads).toBe(0); expect(f.sends).toHaveLength(0);
  } finally { await f.close(); }
  expect(cancelled).toBe(true);
}, 15_000);
