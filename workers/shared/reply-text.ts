export interface ReplyTextParts {
  authored: string;
  quoteRemoved: boolean;
  signatureRemoved: boolean;
}

const MAILDESK_CONTEXT = /(?:^|\n)[ \t]*(?:>+[ \t]*)?(?:Maildesk route|Reply behavior:|--- Original message ---)[ \t]*(?:\n|$)/i;
const APPLE_ATTRIBUTION = /^[ \t]*(?:>+[ \t]*)?On [^\n]{1,500} wrote:[ \t]*$/;

/** Only explicit boundaries remove text. Blank paragraphs never imply a signature.
 * Normalization changes CRLF/CR to LF and trims boundary blank lines only.
 */
export function parseReplyText(value: string): ReplyTextParts {
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.split("\n");
  let quoteAt = -1;
  for (let index = 0; index < lines.length; index++) {
    if (!APPLE_ATTRIBUTION.test(lines[index]!)) continue;
    const suffix = lines.slice(index + 1).filter((line) => line.trim());
    if (suffix.length && suffix.every((line) => /^[ \t]*>/.test(line))) {
      quoteAt = index;
      break;
    }
  }
  const unquoted = (quoteAt < 0 ? lines : lines.slice(0, quoteAt)).join("\n");
  // Even a signature delimiter does not license removing an unrecognized banner.
  if (MAILDESK_CONTEXT.test(unquoted)) {
    throw new Error("operator reply retains unrecognized Maildesk routing context");
  }
  const signature = /(?:^|\n)-- \n/.exec(unquoted);
  const authored = (signature ? unquoted.slice(0, signature.index) : unquoted)
    .replace(/^\n+|\n+$/g, "");
  if (!authored.trim()) throw new Error("operator reply has no public message after identity normalization");
  return { authored, quoteRemoved: quoteAt >= 0, signatureRemoved: Boolean(signature) };
}

export function renderPublicReplyText(operatorText: string, publicSignature: string): string {
  const parsed = parseReplyText(operatorText);
  const signature = publicSignature.trim();
  if (!signature) throw new Error("identity profile signature is empty");
  const rendered = `${parsed.authored}\n\n-- \n${signature}`;
  if (MAILDESK_CONTEXT.test(rendered)) throw new Error("operator reply retains Maildesk routing context");
  return rendered;
}
