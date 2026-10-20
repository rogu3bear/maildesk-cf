import { sha256Hex } from "./inbox-relay";

/** Message-ID is an opaque, case-sensitive identifier, never a mailbox. */
export function messageIdentity(value: string | undefined): string | null {
  return value && value.length <= 998 && /^<[\x21-\x3b\x3d\x3f-\x7e]+>$/.test(value)
    ? value : null;
}

export async function replyAttemptIdentities(relayId: string, messageId: string): Promise<{
  current: string; legacy: string;
}> {
  const identity = messageIdentity(messageId);
  if (!identity) throw new Error("invalid opaque message identity");
  return {
    current: `relay-attempt:${await sha256Hex(`maildesk-reply-identity-v2\0${relayId}\0${identity}`)}`,
    legacy: `relay-attempt:${await sha256Hex(`${relayId}\0${identity.toLowerCase()}`)}`,
  };
}
