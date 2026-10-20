import type { OutboundSendResult } from "./types";

export const CLOUDFLARE_EMAIL_SERVICE_DEFINITIVE_REJECTIONS = new Set([
  "E_VALIDATION_ERROR",
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_SENDER_NOT_VERIFIED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_CONTENT_TOO_LARGE",
  "E_DELIVERY_FAILED",
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY",
]);

export function terminalProviderErrorCode(
  result: OutboundSendResult,
  status: "provider_accepted" | "failed" | "recovery_required",
): string | null {
  if (!result.error) return null;
  const match = /^cloudflare_email_service:(E_[A-Z0-9_]{1,80})(?::outcome_unknown)?$/.exec(result.error);
  return match?.[1] ?? status;
}

export function cloudflareEmailServiceFailure(error: unknown): OutboundSendResult {
  const code = providerErrorCode(error);
  if (code && CLOUDFLARE_EMAIL_SERVICE_DEFINITIVE_REJECTIONS.has(code)) {
    return {
      ok: false,
      provider: "cloudflare_email_service",
      error: `cloudflare_email_service:${code}`,
    };
  }
  return {
    ok: false,
    provider: "cloudflare_email_service",
    ambiguous: true,
    error: code
      ? `cloudflare_email_service:${code}:outcome_unknown`
      : "Cloudflare Email Service send outcome is unknown",
  };
}

export function providerErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^E_[A-Z0-9_]{1,80}$/.test(code) ? code : null;
}
