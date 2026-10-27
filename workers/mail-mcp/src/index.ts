import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { JWTVerifyGetKey } from "jose";
import { authenticateMcp, mcpConfiguration, McpAccessError, MCP_SCOPES, type McpAuthEnv } from "./auth";
import { getDeliveryStatus, listAuthorizedRoutes, McpReadError, type McpDataEnv } from "./read-model";
import { RequestDeadlineError, withRequestDeadline } from "../../shared/request-deadline";
import { boundedMcpRequest, MCP_MAX_REQUEST_BYTES, McpRequestError } from "./request";

export type MaildeskMcpEnv = McpAuthEnv & McpDataEnv;
const descriptor = z.object({ route_id: z.string(), address: z.string(), kind: z.enum(["role_alias", "personal_alias", "catch_all", "sink"]) });
const status = z.object({ classification: z.string(), observed_at: z.string(), valid_until: z.string(),
  inbound_outcome: z.string(), reply_outcome: z.string(), inbox_proof: z.string(), reply_proof: z.string(),
  pending_dispatch: z.number().int().nonnegative(), pending_queue: z.number().int().nonnegative(), unknown_provider_attempts: z.number().int().nonnegative(),
  reason_codes: z.array(z.string()), next_action: z.string() });
const base = { schema_version: z.literal(1), read_at: z.string(), policy_sha256: z.string() };
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const json = (value: unknown, code = 200, headers?: HeadersInit) => Response.json(value, { status: code, headers: { "cache-control": "no-store", ...headers } });

/** A resource server only. Its configured OAuth issuer owns login, consent and revocation. */
export function createMaildeskMcp(dependencies: { resolveKey?: JWTVerifyGetKey; now?: () => number } = {}) {
  return {
    async fetch(request: Request, env: MaildeskMcpEnv): Promise<Response> {
      if (env.MAILDESK_MCP_MODE !== "read_only") return json({ error: "not_found" }, 404);
      const config = mcpConfiguration(env);
      if (!config) return json({ error: "mcp_configuration_unavailable" }, 503);
      const url = new URL(request.url), resource = new URL(config.resource);
      if (url.origin !== resource.origin || (request.headers.has("host") && request.headers.get("host") !== resource.host) ||
          (request.headers.has("origin") && request.headers.get("origin") !== resource.origin)) return json({ error: "origin_not_allowed" }, 403);
      const metadataPath = "/.well-known/oauth-protected-resource/mcp";
      if (url.pathname === metadataPath && request.method === "GET") return json({ resource: config.resource,
        authorization_servers: [config.issuer], scopes_supported: [...MCP_SCOPES], bearer_methods_supported: ["header"] });
      if (url.pathname !== resource.pathname || url.search) return json({ error: "not_found" }, 404);
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
      let handler: ReturnType<typeof createMcpHandler> | undefined;
      try { return await withRequestDeadline(5_000, async signal => {
        const now = dependencies.now?.() ?? Date.now();
        let principal;
        try { principal = await authenticateMcp(request, config, now, dependencies.resolveKey); }
        catch (error) {
          const denied = error instanceof McpAccessError ? error : new McpAccessError(503, "authorization_unavailable");
          return json({ error: denied.code }, denied.status, { "www-authenticate":
            `Bearer resource_metadata="${resource.origin}${metadataPath}", scope="${MCP_SCOPES.join(" ")}"` });
        }
        signal.throwIfAborted();
        const bounded = await boundedMcpRequest(request, AbortSignal.any([signal, request.signal]));
        handler = createMcpHandler(() => {
          const server = new McpServer({ name: "maildesk-status", version: "0.1.0" }, { instructions:
            "Read-only Maildesk routing/status evidence. Use your existing mailbox connector for content. Provider acceptance is not inbox receipt. These tools do not authorize sends, replay, activation, deployment or email-trigger routines." });
          const result = async (operation: () => Promise<Record<string, unknown>>) => {
            try { signal.throwIfAborted(); const value = await operation(); signal.throwIfAborted(); return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value }; }
            catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof McpReadError ? error.message : "maildesk_read_unavailable" }] }; }
          };
          if (principal.scopes.includes("maildesk.routes.read")) server.registerTool("list_authorized_routes", {
            title: "List authorized Maildesk routes", description: "List only routes assigned by current Rust policy to your bound operator. Public addresses and kinds only; no mailbox content or other operators. A cursor is policy/principal bound and expires after ten minutes.",
            annotations, inputSchema: z.object({ cursor: z.string().max(2048).optional() }).strict(),
            outputSchema: z.object({ ...base, routes: z.array(descriptor).max(32), next_cursor: z.string().nullable() }),
          }, ({ cursor }) => result(() => listAuthorizedRoutes(env, principal, cursor, dependencies.now ?? Date.now, signal)));
          if (principal.scopes.includes("maildesk.status.read")) server.registerTool("get_delivery_status", {
            title: "Read Maildesk delivery status", description: "Read one authorized route's existing generation-fenced body-free status. Stale/missing evidence stays stale/unknown; no status refresh, recovery or provider effect occurs. Acceptance and recipient observation remain distinct.",
            annotations, inputSchema: z.object({ route_id: z.string().min(1).max(1024) }).strict(),
            outputSchema: z.object({ ...base, route: descriptor, projection_state: z.enum(["current", "stale", "unknown"]),
              operational_ready: z.boolean(), reason: z.string().nullable(), status: status.nullable() }),
          }, ({ route_id }) => result(() => getDeliveryStatus(env, principal, route_id, dependencies.now ?? Date.now, signal)));
          return server;
        }, { responseMode: "auto", maxRequestBodySize: MCP_MAX_REQUEST_BYTES });
        const response = await handler.fetch(bounded);
        // Legacy SSE headers precede the tool result. Complete the finite body
        // inside the deadline and token lifetime before releasing any result.
        const body = response.body === null ? null : await response.arrayBuffer();
        signal.throwIfAborted();
        if ((dependencies.now?.() ?? Date.now()) >= principal.expiresAt) throw new McpAccessError(401, "invalid_token");
        response.headers.set("cache-control", "no-store");
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      }); } catch (error) {
        if (error instanceof McpAccessError) return json({ error: error.code }, error.status);
        if (error instanceof McpRequestError) return json({ error: error.message }, error.status);
        return json({ error: error instanceof RequestDeadlineError ? "mcp_deadline_exceeded" : "mcp_request_unavailable" }, 503);
      } finally { await handler?.close(); }
    },
  };
}

export default createMaildeskMcp();
