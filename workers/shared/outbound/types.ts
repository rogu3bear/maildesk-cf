
export interface ReplyRelayJobRow {
  id: string;
  thread_id: string;
  route_id: string;
  external_recipient: string;
  thread_external_sender: string;
  reply_identity: string;
  original_message_id: string | null;
  references_json: string;
  expires_at: string;
  revoked_at: string | null;
  route_address: string;
}

export interface OutboundSendResult {
  /** Internal ownership fact, never accepted from Queue input or audit replay. */
  providerBoundaryClaimed?: boolean;
  ok: boolean;
  provider: string;
  providerMessageId?: string;
  error?: string;
  status?: number;
  retryable?: boolean;
  ambiguous?: boolean;
  response?: unknown;
  notClaimed?: boolean;
}

export type TerminalSendAction =
  | "outbound_reply_delivered"
  | "outbound_reply_failed"
  | "outbound_reply_recovery_required";

export type QueueDisposition = { kind: "ack" } | { kind: "retry"; delaySeconds: number };

export type OutboundMode = "disabled" | "cloudflare_email_service" | "resend" | "invalid";
