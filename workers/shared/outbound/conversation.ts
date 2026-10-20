import type { OutboundReplyRequestedJob } from "../contracts";

export function canonicalConversationHeaders(job: OutboundReplyRequestedJob): Record<string, string> {
  const headers: Record<string, string> = {};
  const inReplyTo = messageHeader(job.headers, "in-reply-to");
  if (validMessageId(inReplyTo)) headers["In-Reply-To"] = inReplyTo;

  const references = validMessageIdList(messageHeader(job.headers, "references"));
  if (references.length > 0) headers.References = references.join(" ");
  return headers;
}

export function messageHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1];
}

export function validMessageId(value: string | null | undefined): value is string {
  return Boolean(value && value.length <= 998 && /^<[^<>\s]+>$/.test(value));
}

export function validMessageIdList(value: string | null | undefined): string[] {
  if (!value || value.length > 8_000) return [];
  return [...new Set(value.match(/<[^<>\s]+>/g) ?? [])].slice(-50);
}

export function storedReferences(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((entry): entry is string => typeof entry === "string" && validMessageId(entry)))].slice(-50);
  } catch {
    return [];
  }
}
