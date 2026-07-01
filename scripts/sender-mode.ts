export const senderModes = ["disabled", "cloudflare_email_service", "resend"] as const;

export type SenderMode = (typeof senderModes)[number];

export function isSenderMode(value: unknown): value is SenderMode {
  return typeof value === "string" && (senderModes as readonly string[]).includes(value);
}

export function senderModeOrDefault(value: unknown): SenderMode {
  return isSenderMode(value) ? value : "disabled";
}

export function senderModeList(): string {
  return senderModes.join(", ");
}

export function senderModeNeedsProviderReadback(mode: SenderMode): boolean {
  return mode !== "disabled";
}
