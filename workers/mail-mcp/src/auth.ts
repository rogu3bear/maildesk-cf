import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export const MCP_SCOPES = ["maildesk.routes.read", "maildesk.status.read"] as const;
export interface McpAuthEnv {
  MAILDESK_MCP_MODE?: string;
  MAILDESK_MCP_RESOURCE?: string;
  MAILDESK_MCP_ISSUER?: string;
  MAILDESK_MCP_JWKS_URL?: string;
  MAILDESK_MCP_BINDINGS_JSON?: string;
}
export interface McpConfiguration {
  resource: string;
  issuer: string;
  jwks: string;
  bindings: Array<{ subject: string; client_id: string; operator: string }>;
}
export interface McpPrincipal {
  subject: string;
  clientId: string;
  operator: string;
  scopes: string[];
  binding: string;
  expiresAt: number;
}
export class McpAccessError extends Error {
  constructor(readonly status: 401 | 403 | 503, readonly code: string) { super(code); }
}
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Operator-owned subject/client bindings, never a caller-supplied mailbox. */
export function mcpConfiguration(env: McpAuthEnv): McpConfiguration | null {
  try {
    const resource = new URL(env.MAILDESK_MCP_RESOURCE ?? "");
    const issuer = new URL(env.MAILDESK_MCP_ISSUER ?? "");
    const jwks = new URL(env.MAILDESK_MCP_JWKS_URL ?? "");
    if ([resource, issuer, jwks].some(url => url.protocol !== "https:" || url.username || url.password || url.search || url.hash) ||
        resource.pathname !== "/mcp" || jwks.origin !== issuer.origin ||
        (env.MAILDESK_MCP_BINDINGS_JSON?.length ?? Infinity) > 65_536) return null;
    const bindings: unknown = JSON.parse(env.MAILDESK_MCP_BINDINGS_JSON!);
    if (!Array.isArray(bindings) || !bindings.length || bindings.length > 100) return null;
    const seen = new Set<string>();
    for (const binding of bindings) {
      if (!binding || typeof binding !== "object" || Object.keys(binding).sort().join(",") !== "client_id,operator,subject" ||
          ![binding.subject, binding.client_id].every(value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value)) ||
          typeof binding.operator !== "string" || binding.operator.length > 254 ||
          binding.operator !== binding.operator.trim().toLowerCase() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(binding.operator)) return null;
      const key = JSON.stringify([binding.subject, binding.client_id]);
      if (seen.has(key)) return null;
      seen.add(key);
    }
    return { resource: resource.href, issuer: env.MAILDESK_MCP_ISSUER!, jwks: jwks.href, bindings };
  } catch { return null; }
}

export async function authenticateMcp(
  request: Request, config: McpConfiguration, now = Date.now(), resolveKey?: JWTVerifyGetKey,
): Promise<McpPrincipal> {
  const authorization = request.headers.get("authorization") ?? "";
  if (authorization.length > 16_384 || !/^Bearer [A-Za-z0-9._~-]+$/i.test(authorization)) throw new McpAccessError(401, "invalid_token");
  try {
    let key = resolveKey;
    if (!key) {
      let remote = keySets.get(config.jwks);
      if (!remote) {
        remote = createRemoteJWKSet(new URL(config.jwks), { timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 600_000 });
        keySets.set(config.jwks, remote);
      }
      key = remote;
    }
    const { payload } = await jwtVerify(authorization.slice(7), key, {
      algorithms: ["RS256"], typ: "at+jwt", issuer: config.issuer, audience: config.resource,
      requiredClaims: ["sub", "iat", "exp", "client_id", "scope"], maxTokenAge: "1h", currentDate: new Date(now),
    });
    if (payload.aud !== config.resource || typeof payload.sub !== "string" || typeof payload.client_id !== "string" ||
        typeof payload.scope !== "string" || payload.scope.length > 1024) throw new McpAccessError(401, "invalid_token");
    const binding = config.bindings.find(row => row.subject === payload.sub && row.client_id === payload.client_id);
    if (!binding) throw new McpAccessError(403, "principal_not_bound");
    const scopes = [...new Set(payload.scope.split(/\s+/).filter(scope => (MCP_SCOPES as readonly string[]).includes(scope)))].sort();
    if (!scopes.length) throw new McpAccessError(403, "insufficient_scope");
    const bytes = new TextEncoder().encode(JSON.stringify([config.issuer, binding.subject, binding.client_id, binding.operator, scopes]));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return { subject: binding.subject, clientId: binding.client_id, operator: binding.operator, scopes,
      expiresAt: Math.min(payload.exp! * 1000, (payload.iat! + 3600) * 1000),
      binding: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") };
  } catch (error) {
    if (error instanceof McpAccessError) throw error;
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ERR_JWKS_TIMEOUT" || (error instanceof TypeError && code === null)) throw new McpAccessError(503, "authorization_unavailable");
    throw new McpAccessError(401, "invalid_token");
  }
}
