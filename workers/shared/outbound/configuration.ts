import type { MaildeskEnv as Env } from "../contracts";
import type { OutboundMode } from "./types";

export function configuredOutboundMode(env: Env): OutboundMode {
  const mode = env.MAILDESK_OUTBOUND_MODE ?? "disabled";
  if (mode === "disabled" || mode === "cloudflare_email_service" || mode === "resend") {
    return mode;
  }
  return "invalid";
}

export function isVerifiedSenderDomain(domain: string, env: Env): boolean {
  const configured = env.MAILDESK_VERIFIED_SENDER_DOMAINS?.trim();
  if (!configured) return false;
  const domains = configured
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (domains.some((value) => value.includes("*"))) return false;
  return domains.includes(domain);
}

export function senderDomain(address: string): string {
  const parsed = parseMailbox(address);
  return parsed?.domain ?? "";
}

export function parseMailbox(address: string): ParsedMailbox | null {
  const normalized = normalizeMailbox(address);
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === normalized.length - 1) return null;

  return {
    localPart: normalized.slice(0, atIndex),
    domain: normalized.slice(atIndex + 1),
  };
}

export function normalizeMailbox(address: string): string {
  return address.trim().toLowerCase();
}

export interface ParsedMailbox {
  localPart: string;
  domain: string;
}
