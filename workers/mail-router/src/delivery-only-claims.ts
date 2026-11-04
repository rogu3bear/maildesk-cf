/**
 * Claim one exact delivery-only recipient before crossing the provider boundary.
 * A changed policy, route, payload digest, or spool generation refuses the claim.
 * A `sending` claim is an unknown provider outcome and is never auto-reopened.
 */
export const CLAIM_ACTIVE_DELIVERY_ONLY_RECIPIENT_SQL =
  "UPDATE delivery_only_recipient_deliveries SET status = 'sending', updated_at = CURRENT_TIMESTAMP WHERE delivery_id = ?1 AND recipient_ref = ?2 AND status = 'pending' AND delivery_payload_sha256 = ?5 AND EXISTS (SELECT 1 FROM delivery_only_deliveries d JOIN runtime_state rs ON rs.singleton = 1 AND rs.active_policy_sha256 = d.policy_sha256 JOIN alias_routes ar ON ar.id = d.route_id AND ar.enabled = 1 AND ar.policy_sha256 = d.policy_sha256 WHERE d.id = delivery_only_recipient_deliveries.delivery_id AND d.policy_sha256 = ?3 AND d.raw_r2_key = ?4 AND d.recipient_count = (SELECT COUNT(*) FROM delivery_only_recipient_deliveries all_recipients WHERE all_recipients.delivery_id = d.id))";

export const INSERT_ACTIVE_DELIVERY_ONLY_SQL =
  "INSERT INTO delivery_only_deliveries (id, fingerprint_sha256, route_id, policy_sha256, raw_r2_key, received_at, recipient_count, status) SELECT ?1, ?2, (SELECT ar.id FROM alias_routes ar JOIN runtime_state rs ON rs.singleton = 1 AND rs.active_policy_sha256 = ar.policy_sha256 WHERE ar.id = ?3 AND ar.enabled = 1 AND ar.policy_sha256 = ?4 AND ar.decision_kind = 'role_alias'), ?4, ?5, ?6, ?7, 'pending'";

export const INSERT_DELIVERY_ONLY_RECIPIENT_SQL =
  "INSERT INTO delivery_only_recipient_deliveries (delivery_id, recipient_ref, delivery_message_id, delivery_payload_r2_key, delivery_payload_sha256, status) SELECT (SELECT d.id FROM delivery_only_deliveries d JOIN runtime_state rs ON rs.singleton = 1 AND rs.active_policy_sha256 = d.policy_sha256 JOIN alias_routes ar ON ar.id = d.route_id AND ar.enabled = 1 AND ar.policy_sha256 = d.policy_sha256 WHERE d.id = ?1 AND d.policy_sha256 = ?6 AND d.raw_r2_key = ?7), ?2, ?3, ?4, ?5, 'pending'";

export interface DeliveryOnlyClaimInput {
  deliveryId: string;
  fingerprintSha256: string;
  routeId: string;
  policySha256: string;
  rawSpoolKey: string;
  receivedAt: string;
  recipients: Array<{ ref: string; messageId: string; payloadKey: string; payloadSha256: string }>;
}

/**
 * Stage a new claim and all recipient bindings in one D1 batch. Missing
 * policy or route bindings violate NOT NULL constraints, so they abort the
 * batch rather than silently committing a partial claim. A rejected or
 * uncertain batch is reconciled by fingerprint; callers must not blindly retry
 * or delete staged spools on an ambiguous outcome.
 */
export async function persistDeliveryOnlyClaim(db: D1Database, input: DeliveryOnlyClaimInput): Promise<void> {
  const refs = input.recipients.map((recipient) => recipient.ref);
  if (refs.length === 0 || new Set(refs).size !== refs.length) {
    throw new Error("delivery-only recipients must be nonempty and unique");
  }
  const statements = [
    db.prepare(INSERT_ACTIVE_DELIVERY_ONLY_SQL).bind(input.deliveryId, input.fingerprintSha256, input.routeId, input.policySha256, input.rawSpoolKey, input.receivedAt, input.recipients.length),
    ...input.recipients.map((recipient) => db.prepare(INSERT_DELIVERY_ONLY_RECIPIENT_SQL).bind(input.deliveryId, recipient.ref, recipient.messageId, recipient.payloadKey, recipient.payloadSha256, input.policySha256, input.rawSpoolKey)),
  ];
  const results = await db.batch(statements);
  if (results.length !== statements.length || results.some((result) => !result.success || Number(result.meta?.changes ?? 0) < 1)) {
    throw new Error("delivery-only claim was not established under the active policy");
  }
}

export const READ_DELIVERY_ONLY_CLAIM_SQL =
  "SELECT d.id, d.fingerprint_sha256, d.route_id, d.policy_sha256, d.raw_r2_key, d.received_at, d.recipient_count, d.status AS delivery_status, r.recipient_ref, r.delivery_message_id, r.delivery_payload_r2_key, r.delivery_payload_sha256, r.status AS recipient_status FROM delivery_only_deliveries d LEFT JOIN delivery_only_recipient_deliveries r ON r.delivery_id = d.id WHERE d.fingerprint_sha256 = ?1 ORDER BY r.recipient_ref";

interface ClaimReadbackRow {
  id: string; fingerprint_sha256: string; route_id: string; policy_sha256: string;
  raw_r2_key: string; received_at: string; recipient_count: number; delivery_status: string;
  recipient_ref: string | null; delivery_message_id: string | null;
  delivery_payload_r2_key: string | null; delivery_payload_sha256: string | null;
  recipient_status: string | null;
}

/**
 * A positive match establishes only the durable bindings and their observed
 * statuses. It does not grant permission to send or prove an R2 object exists.
 * Absence or mismatch is a hold, never proof that an uncertain write failed.
 */
export async function readDeliveryOnlyClaim(
  db: D1Database, input: DeliveryOnlyClaimInput,
): Promise<{ kind: "matched"; deliveryStatus: string; recipients: Array<{ ref: string; status: string }> } | { kind: "unresolved" }> {
  const result = await db.withSession("first-primary").prepare(READ_DELIVERY_ONLY_CLAIM_SQL)
    .bind(input.fingerprintSha256).all<ClaimReadbackRow>();
  if (!result.success || !Array.isArray(result.results) || input.recipients.length === 0 ||
      new Set(input.recipients.map((recipient) => recipient.ref)).size !== input.recipients.length ||
      result.results.length !== input.recipients.length) return { kind: "unresolved" };
  const first = result.results[0];
  if (!first) return { kind: "unresolved" };
  const expected = new Map(input.recipients.map((recipient) => [recipient.ref, recipient]));
  const recipients: Array<{ ref: string; status: string }> = [];
  for (const row of result.results) {
    const recipient = row.recipient_ref === null ? undefined : expected.get(row.recipient_ref);
    if (!recipient || row.id !== input.deliveryId || row.fingerprint_sha256 !== input.fingerprintSha256 ||
        row.route_id !== input.routeId || row.policy_sha256 !== input.policySha256 ||
        row.raw_r2_key !== input.rawSpoolKey || row.received_at !== input.receivedAt || row.recipient_count !== input.recipients.length ||
        row.delivery_message_id !== recipient.messageId || row.delivery_payload_r2_key !== recipient.payloadKey ||
        row.delivery_payload_sha256 !== recipient.payloadSha256 || !row.recipient_status ||
        row.delivery_status !== first.delivery_status) return { kind: "unresolved" };
    expected.delete(recipient.ref);
    recipients.push({ ref: recipient.ref, status: row.recipient_status });
  }
  if (expected.size !== 0) return { kind: "unresolved" };
  return { kind: "matched", deliveryStatus: first.delivery_status, recipients };
}

export const PROJECT_DELIVERY_ONLY_OUTCOME_SQL =
  "UPDATE delivery_only_recipient_deliveries SET status = ?1, provider_message_id = ?2, error_code = ?3, updated_at = CURRENT_TIMESTAMP WHERE delivery_id = ?4 AND recipient_ref = ?5 AND delivery_payload_sha256 = ?6 AND status = 'sending'";

/** A rejected or uncertain claim is never permission to call the provider. */
export async function claimDeliveryOnlyRecipient(
  db: D1Database, binding: { deliveryId: string; recipientRef: string; policySha256: string; rawSpoolKey: string; payloadSha256: string },
): Promise<boolean> {
  const result = await db.prepare(CLAIM_ACTIVE_DELIVERY_ONLY_RECIPIENT_SQL)
    .bind(binding.deliveryId, binding.recipientRef, binding.policySha256, binding.rawSpoolKey, binding.payloadSha256).run();
  if (!result.success) throw new Error("delivery-only claim outcome is uncertain");
  return Number(result.meta?.changes ?? 0) > 0;
}

/**
 * Record a provider response only against its exact sending claim. A failed
 * provider call is ambiguous and requires recovery, never an automatic resend.
 * Projection failure leaves the sending claim in place for reconciliation.
 */
export async function projectDeliveryOnlyOutcome(
  db: D1Database,
  binding: { deliveryId: string; recipientRef: string; payloadSha256: string },
  outcome: { kind: "accepted"; providerMessageId?: string } | { kind: "unknown"; errorCode: string },
): Promise<void> {
  const result = await db.prepare(PROJECT_DELIVERY_ONLY_OUTCOME_SQL).bind(
    outcome.kind === "accepted" ? "provider_accepted" : "recovery_required",
    outcome.kind === "accepted" ? outcome.providerMessageId ?? null : null,
    outcome.kind === "unknown" ? outcome.errorCode : null,
    binding.deliveryId, binding.recipientRef, binding.payloadSha256,
  ).run();
  if (!result.success || Number(result.meta?.changes ?? 0) < 1) {
    throw new Error("delivery-only provider outcome was not durably projected");
  }
}
