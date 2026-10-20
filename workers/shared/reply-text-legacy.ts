import type { ResolvedIdentityProfile } from "./router";

// Frozen v1 renderer for pre-cutover immutable canary claims only. It cannot
// authorize a new message. Its output must match the original claimed digest.
// Fresh messages use reply-text.ts; its blank-line rules must never return there.
export function renderLegacyClaimedReplyText(
  operatorText: string,
  identityProfile: ResolvedIdentityProfile,
  authenticatedSenderName?: string,
): string {
  const normalized = operatorText.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const quotedReply = /^[ \t]*(?:>+[ \t]*)?On [^\n]{1,500} wrote:[ \t]*$/im.exec(normalized);
  const maildeskContext = /(?:^|\n)[ \t]*>?[ \t]*(?:Maildesk route|Reply behavior:|--- Original message ---)[ \t]*(?:\n|$)/i;
  if (!quotedReply && maildeskContext.test(normalized)) {
    throw new Error("operator reply retains unrecognized Maildesk routing context");
  }
  const unquoted = quotedReply ? normalized.slice(0, quotedReply.index) : normalized;
  const privateSignature = /(?:^|\n)-- ?\n/.exec(unquoted);
  let signatureBoundary = privateSignature?.index;
  if (signatureBoundary === undefined && quotedReply) {
    const delimiterlessCandidates = [...unquoted.matchAll(/\n(?:[ \t]*\n){2,}(?=[^\n \t])/g)];
    const candidate = delimiterlessCandidates.at(-1);
    if (candidate?.index !== undefined) {
      const suffix = unquoted.slice(candidate.index + candidate[0].length).trim();
      const suffixLines = suffix.split("\n").filter((line) => line.trim());
      const boundedAppleSignature = suffix.length > 0 &&
        suffix.length <= 1_000 &&
        suffixLines.length <= 8 &&
        suffixLines.every((line) => line.length <= 200);
      if (boundedAppleSignature) signatureBoundary = candidate.index;
    }
  }
  if (signatureBoundary === undefined && quotedReply && authenticatedSenderName?.trim()) {
    const senderName = authenticatedSenderName.trim().replace(/\s+/g, " ").toLowerCase();
    const delimiterlessCandidates = [...unquoted.matchAll(/\n[ \t]*\n(?=[^\n \t])/g)];
    for (const candidate of delimiterlessCandidates.reverse()) {
      if (candidate.index === undefined) continue;
      const suffix = unquoted.slice(candidate.index + candidate[0].length).trim();
      const suffixLines = suffix.split("\n").map((line) => line.trim()).filter(Boolean);
      const boundedAppleSignature = suffix.length > 0 &&
        suffix.length <= 1_000 &&
        suffixLines.length <= 8 &&
        suffixLines.every((line) => line.length <= 200);
      const signatureName = suffixLines[0]?.replace(/\s+/g, " ").toLowerCase();
      if (boundedAppleSignature && signatureName === senderName) {
        signatureBoundary = candidate.index;
        break;
      }
    }
  }
  if (signatureBoundary === undefined) {
    throw new Error("operator reply private signature boundary is ambiguous");
  }
  const authored = unquoted.slice(0, signatureBoundary).trim();
  if (!authored) {
    throw new Error("operator reply has no public message after identity normalization");
  }
  const signature = identityProfile.signatureText.trim();
  if (!signature) {
    throw new Error("identity profile signature is empty");
  }
  const rendered = `${authored}\n\n-- \n${signature}`;
  if (maildeskContext.test(rendered)) {
    throw new Error("operator reply retains Maildesk routing context");
  }
  return rendered;
}
