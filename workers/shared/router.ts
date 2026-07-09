import {
  authorize_reply_json,
  route_message_json,
} from "../../generated/router-wasm/maildesk_router.js";

export interface RouterPolicy {
  default_reply_mode: "role_first" | "personal_first";
  domains: Record<string, DomainPolicy>;
}

export interface DomainPolicy {
  role_aliases: Record<string, RoleAliasPolicy>;
  personal_aliases: Record<string, PersonalAliasPolicy>;
  catch_all?: CatchAllPolicy;
}

export interface RoleAliasPolicy {
  operators: string[];
  reply_identity: string;
  allowed_reply_identities?: string[];
  sink?: boolean;
}

export interface PersonalAliasPolicy {
  operator: string;
  reply_identity: string;
}

export interface CatchAllPolicy {
  operators: string[];
  reply_identity: string;
  allowed_reply_identities?: string[];
  sink?: boolean;
}

export interface InboundMessage {
  envelopeTo: string;
  headerFrom: string;
  messageId?: string;
  subject?: string;
}

export interface RouteDecision {
  domain: string;
  localPart: string;
  routeKind: "role_alias" | "personal_alias" | "catch_all" | "sink";
  operators: string[];
  defaultReplyIdentity: string;
  allowedReplyIdentities: string[];
}

export interface ReplyAuthorization {
  fromIdentity: string;
  envelopeSender: string;
}

export interface RouterError {
  kind: string;
  message: string;
}

export type RouterResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RouterError };

export function routeInbound(
  policy: RouterPolicy,
  message: InboundMessage,
): RouterResult<RouteDecision> {
  const response = route_message_json(
    JSON.stringify({
      policy,
      message: {
        envelope_to: message.envelopeTo,
        header_from: message.headerFrom,
        message_id: message.messageId ?? null,
        subject: message.subject ?? null,
      },
    }),
  );

  return parseAdapterResponse(response, mapRouteDecision);
}

export function authorizeReplyWithPolicy(
  policy: RouterPolicy,
  input: {
    envelopeTo: string;
    operator: string;
    requestedIdentity?: string;
  },
): RouterResult<ReplyAuthorization> {
  const response = authorize_reply_json(
    JSON.stringify({
      policy,
      envelope_to: input.envelopeTo,
      operator: input.operator,
      requested_identity: input.requestedIdentity ?? null,
    }),
  );

  return parseAdapterResponse(response, (value) => ({
    fromIdentity: requireString(value, "from_identity"),
    envelopeSender: requireString(value, "envelope_sender"),
  }));
}

function parseAdapterResponse<T>(
  responseJson: string,
  mapValue: (value: Record<string, unknown>) => T,
): RouterResult<T> {
  try {
    const response = JSON.parse(responseJson) as {
      status?: unknown;
      value?: unknown;
      error?: unknown;
    };

    if (response.status === "ok" && isRecord(response.value)) {
      return { ok: true, value: mapValue(response.value) };
    }

    if (response.status === "error" && isRecord(response.error)) {
      return {
        ok: false,
        error: {
          kind: requireString(response.error, "kind"),
          message: requireString(response.error, "message"),
        },
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: "adapter_failure",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  return {
    ok: false,
    error: {
      kind: "adapter_failure",
      message: "Rust router returned an invalid adapter response",
    },
  };
}

function mapRouteDecision(value: Record<string, unknown>): RouteDecision {
  const routeKind = requireString(value, "route_kind");
  if (
    routeKind !== "role_alias" &&
    routeKind !== "personal_alias" &&
    routeKind !== "catch_all" &&
    routeKind !== "sink"
  ) {
    throw new Error(`invalid Rust route kind: ${routeKind}`);
  }

  return {
    domain: requireString(value, "domain"),
    localPart: requireString(value, "local_part"),
    routeKind,
    operators: requireStringArray(value, "operators"),
    defaultReplyIdentity: requireString(value, "default_reply_identity"),
    allowedReplyIdentities: requireStringArray(value, "allowed_reply_identities"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`Rust router field ${key} must be a string`);
  return field;
}

function requireStringArray(value: Record<string, unknown>, key: string): string[] {
  const field = value[key];
  if (!Array.isArray(field) || !field.every((entry) => typeof entry === "string")) {
    throw new Error(`Rust router field ${key} must be a string array`);
  }
  return field;
}
