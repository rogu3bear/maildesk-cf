import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface AccessEnvironment {
  MAILDESK_ACCESS_AUD?: string;
  MAILDESK_ACCESS_TEAM_DOMAIN?: string;
  MAILDESK_UI_ACCESS_SCOPE?: "desk_only" | "all_routes";
}

export interface AccessConfiguration {
  audience: string;
  teamDomain: string;
}

type AccessClaimsVerifier = (
  token: string,
  configuration: AccessConfiguration,
) => Promise<JWTPayload>;

const accessJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const ACCESS_JWKS_TIMEOUT_MS = 5_000;
const ACCESS_JWKS_COOLDOWN_MS = 30_000;
const ACCESS_JWKS_CACHE_MAX_AGE_MS = 10 * 60_000;

export function isDeskPath(pathname: string): boolean {
  return pathname === "/desk" || pathname.startsWith("/desk/");
}

export function isAccessProtectedPath(
  pathname: string,
  scope: AccessEnvironment["MAILDESK_UI_ACCESS_SCOPE"] = "desk_only",
): boolean {
  if (scope === "all_routes") return pathname.startsWith("/");
  if (scope === "desk_only") return isDeskPath(pathname);
  return true;
}

export function accessConfiguration(env: AccessEnvironment): AccessConfiguration | null {
  const audience = env.MAILDESK_ACCESS_AUD?.trim();
  const configuredDomain = env.MAILDESK_ACCESS_TEAM_DOMAIN?.trim();
  if (!audience || !configuredDomain) return null;

  try {
    const teamDomain = new URL(configuredDomain);
    if (
      teamDomain.protocol !== "https:" ||
      !teamDomain.hostname.endsWith(".cloudflareaccess.com") ||
      teamDomain.pathname !== "/" ||
      teamDomain.search ||
      teamDomain.hash
    ) {
      return null;
    }
    return { audience, teamDomain: teamDomain.origin };
  } catch {
    return null;
  }
}

function accessRejection(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

async function verifyAccessClaims(
  token: string,
  configuration: AccessConfiguration,
): Promise<JWTPayload> {
  let jwks = accessJwks.get(configuration.teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`${configuration.teamDomain}/cdn-cgi/access/certs`),
      {
        timeoutDuration: ACCESS_JWKS_TIMEOUT_MS,
        cooldownDuration: ACCESS_JWKS_COOLDOWN_MS,
        cacheMaxAge: ACCESS_JWKS_CACHE_MAX_AGE_MS,
      },
    );
    accessJwks.set(configuration.teamDomain, jwks);
  }

  const { payload } = await jwtVerify(token, jwks, {
    issuer: configuration.teamDomain,
    audience: configuration.audience,
    algorithms: ["RS256"],
  });
  return payload;
}

export async function verifiedAccessRequest(
  request: Request,
  env: AccessEnvironment,
  verifyClaims: AccessClaimsVerifier = verifyAccessClaims,
): Promise<Request | Response> {
  const configuration = accessConfiguration(env);
  if (!configuration) {
    return accessRejection(503, "Cloudflare Access validation is not configured.");
  }

  const token = request.headers.get("cf-access-jwt-assertion")?.trim();
  if (!token) {
    return accessRejection(401, "Cloudflare Access authentication is required.");
  }

  try {
    const payload = await verifyClaims(token, configuration);
    if (typeof payload.email !== "string" || !payload.email.trim()) {
      return accessRejection(403, "The Access identity does not include an operator email.");
    }

    const headers = new Headers(request.headers);
    headers.delete("x-maildesk-access-validated");
    headers.set("cf-access-authenticated-user-email", payload.email.trim().toLowerCase());
    headers.set("x-maildesk-access-validated", "1");
    return new Request(request, { headers });
  } catch {
    return accessRejection(403, "Cloudflare Access authentication could not be verified.");
  }
}
