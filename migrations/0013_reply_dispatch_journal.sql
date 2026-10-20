-- Add a body-free authorization/dispatch journal without changing historical IDs.
-- Existing unbound attempts remain reconciliation records, never fresh authority.
ALTER TABLE relay_attempts ADD COLUMN payload_version INTEGER NOT NULL DEFAULT 1 CHECK (payload_version IN (1, 2));
ALTER TABLE relay_attempts ADD COLUMN identity_version INTEGER NOT NULL DEFAULT 1 CHECK (identity_version IN (1, 2));
ALTER TABLE relay_attempts ADD COLUMN admission_kind TEXT CHECK (admission_kind IN ('canary', 'ordinary'));
ALTER TABLE relay_attempts ADD COLUMN admission_id TEXT;
ALTER TABLE relay_attempts ADD COLUMN transaction_sha256 TEXT CHECK (transaction_sha256 IS NULL OR (length(transaction_sha256) = 64 AND transaction_sha256 NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE relay_attempts ADD COLUMN attempt_sha256 TEXT CHECK (attempt_sha256 IS NULL OR (length(attempt_sha256) = 64 AND attempt_sha256 NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE relay_attempts ADD COLUMN claimed_payload_sha256 TEXT CHECK (claimed_payload_sha256 IS NULL OR (length(claimed_payload_sha256) = 64 AND claimed_payload_sha256 NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE relay_attempts ADD COLUMN desired_state_sha256 TEXT CHECK (desired_state_sha256 IS NULL OR (length(desired_state_sha256) = 64 AND desired_state_sha256 NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE relay_attempts ADD COLUMN identity_profile_sha256 TEXT CHECK (identity_profile_sha256 IS NULL OR (length(identity_profile_sha256) = 64 AND identity_profile_sha256 NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE relay_attempts ADD COLUMN policy_sha256 TEXT REFERENCES policy_revisions(policy_sha256) ON DELETE RESTRICT;
ALTER TABLE relay_attempts ADD COLUMN operator_ref TEXT CHECK (operator_ref IS NULL OR (length(operator_ref) = 64 AND operator_ref NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE relay_attempts ADD COLUMN operator_set_sha256 TEXT CHECK (operator_set_sha256 IS NULL OR (length(operator_set_sha256) = 64 AND operator_set_sha256 NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE relay_attempts ADD COLUMN dispatch_received_at TEXT;

UPDATE relay_attempts SET
  admission_kind = 'canary',
  admission_id = (SELECT id FROM reply_admissions WHERE claimed_attempt_id = relay_attempts.id),
  transaction_sha256 = (SELECT transaction_sha256 FROM reply_admissions WHERE claimed_attempt_id = relay_attempts.id),
  attempt_sha256 = (SELECT claimed_attempt_sha256 FROM reply_admissions WHERE claimed_attempt_id = relay_attempts.id),
  claimed_payload_sha256 = (SELECT claimed_payload_sha256 FROM reply_admissions WHERE claimed_attempt_id = relay_attempts.id),
  desired_state_sha256 = (SELECT desired_state_sha256 FROM reply_admissions WHERE claimed_attempt_id = relay_attempts.id),
  identity_profile_sha256 = (SELECT identity_profile_sha256 FROM reply_admissions WHERE claimed_attempt_id = relay_attempts.id),
  policy_sha256 = (SELECT policy_sha256 FROM reply_admissions WHERE claimed_attempt_id = relay_attempts.id),
  operator_ref = (SELECT admitted_operator_ref FROM reply_admissions WHERE claimed_attempt_id = relay_attempts.id),
  operator_set_sha256 = (SELECT operator_set_sha256 FROM reply_admissions WHERE claimed_attempt_id = relay_attempts.id),
  dispatch_received_at = created_at
WHERE EXISTS (SELECT 1 FROM reply_admissions WHERE claimed_attempt_id = relay_attempts.id);

CREATE UNIQUE INDEX relay_attempts_authorization_idx ON relay_attempts(admission_kind, admission_id)
WHERE admission_id IS NOT NULL;

CREATE TRIGGER relay_attempts_require_bound_dispatch
BEFORE INSERT ON relay_attempts WHEN NEW.identity_version = 2
BEGIN
  SELECT CASE WHEN NEW.admission_kind IS NULL OR NEW.admission_id IS NULL
    OR NEW.transaction_sha256 IS NULL OR NEW.attempt_sha256 IS NULL
    OR NEW.claimed_payload_sha256 IS NULL OR NEW.desired_state_sha256 IS NULL
    OR NEW.identity_profile_sha256 IS NULL OR NEW.policy_sha256 IS NULL
    OR NEW.operator_ref IS NULL OR NEW.operator_set_sha256 IS NULL
    OR NEW.raw_r2_key IS NULL OR NEW.raw_sha256 IS NULL
    OR NEW.dispatch_received_at IS NULL OR julianday(NEW.dispatch_received_at) IS NULL
    OR NEW.payload_version != 2 OR NEW.status != 'receiving'
  THEN RAISE(ABORT, 'reply dispatch requires immutable authorization') END;
END;

-- One INSERT owns both the attempt and canary admission claim. RAISE rolls back
-- the entire statement; a successful D1 batch with zero rows is not relied on.
CREATE TRIGGER relay_attempts_claim_canary
AFTER INSERT ON relay_attempts WHEN NEW.admission_kind = 'canary' AND NEW.identity_version = 2
BEGIN
  UPDATE reply_admissions SET status = 'claimed', claimed_attempt_id = NEW.id,
    claimed_attempt_sha256 = NEW.attempt_sha256,
    claimed_payload_sha256 = NEW.claimed_payload_sha256, claimed_at = CURRENT_TIMESTAMP
  WHERE id = NEW.admission_id AND transaction_sha256 = NEW.transaction_sha256
    AND status = 'admitted' AND relay_id = NEW.relay_id
    AND policy_sha256 = NEW.policy_sha256 AND desired_state_sha256 = NEW.desired_state_sha256
    AND identity_profile_sha256 = NEW.identity_profile_sha256
    AND admitted_operator_ref = NEW.operator_ref AND operator_set_sha256 = NEW.operator_set_sha256
    AND julianday(admitted_at) <= julianday('now') AND julianday(expires_at) > julianday('now')
    AND EXISTS (SELECT 1 FROM runtime_state WHERE singleton = 1 AND active_policy_sha256 = NEW.policy_sha256)
    AND EXISTS (SELECT 1 FROM policy_projection_state WHERE key = 'active_desired_state_sha256' AND value = NEW.desired_state_sha256)
    AND EXISTS (SELECT 1 FROM reply_relays rr JOIN alias_routes ar ON ar.id = rr.route_id
      JOIN alias_route_operators aro ON aro.route_id = ar.id JOIN operators o ON o.id = aro.operator_id
      WHERE rr.id = NEW.relay_id AND rr.route_id = reply_admissions.route_id
        AND rr.thread_id = reply_admissions.thread_id AND rr.reply_identity = reply_admissions.public_identity
        AND o.email = NEW.operator AND ar.enabled = 1 AND ar.policy_sha256 = NEW.policy_sha256
        AND rr.revoked_at IS NULL AND rr.superseded_by_relay_id IS NULL
        AND julianday(rr.expires_at) > julianday('now'))
    AND NOT EXISTS (SELECT 1 FROM route_outbound_quarantines q
      WHERE q.route_id = reply_admissions.route_id AND q.action = 'quarantine'
        AND NOT EXISTS (SELECT 1 FROM route_outbound_quarantines qr WHERE qr.action = 'release' AND qr.release_of_quarantine_id = q.id));
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'canary admission claim lost') END;
END;

CREATE TRIGGER relay_attempts_identity_immutable
BEFORE UPDATE OF id, relay_id, operator, operator_message_id, raw_sha256, identity_version,
  payload_version, admission_kind, admission_id, transaction_sha256, attempt_sha256, claimed_payload_sha256,
  desired_state_sha256, identity_profile_sha256, policy_sha256, operator_ref, operator_set_sha256,
  dispatch_received_at ON relay_attempts
BEGIN
  SELECT RAISE(ABORT, 'reply claim identity is immutable');
END;

CREATE TRIGGER relay_attempts_terminal_no_reopen
BEFORE UPDATE OF status ON relay_attempts
WHEN OLD.status IN ('provider_accepted', 'failed', 'recovery_required') AND NEW.status != OLD.status
BEGIN
  SELECT RAISE(ABORT, 'terminal reply attempt cannot reopen');
END;

CREATE TRIGGER relay_attempts_spool_generation_immutable
BEFORE UPDATE OF raw_r2_key ON relay_attempts
WHEN NEW.raw_r2_key IS NOT OLD.raw_r2_key
  AND NOT (NEW.raw_r2_key IS NULL AND NEW.status = 'provider_accepted')
BEGIN
  SELECT RAISE(ABORT, 'reply spool generation is immutable');
END;

-- Closed union gains the ordinary variant in 0014. No canary evidence is
-- synthesized, renamed, or backfilled into ordinary authorization.
CREATE VIEW reply_admissions_all AS SELECT
  'canary' AS admission_kind, NULL AS activation_id, id, schema_version,
  transaction_sha256, relay_id, thread_id, route_id, policy_sha256,
  desired_state_sha256, operator_set_sha256, admitted_operator_ref,
  public_identity, sender_domain, identity_profile_ref, identity_profile_sha256,
  display_name, signature_profile_ref, signature_sha256, sender_adapter,
  admitted_at, expires_at, status, claimed_attempt_id, claimed_attempt_sha256,
  claimed_payload_sha256, claimed_at, provider_boundary_at, terminal_at, revoked_at, error_code
FROM reply_admissions;

-- Identity inputs and consumed claims cannot be rewritten into fresh authority.
CREATE TRIGGER reply_admissions_identity_immutable BEFORE UPDATE OF
  id, schema_version, transaction_sha256, correlation_sha256, candidate_sha256, scope_manifest_sha256,
  inbound_delivery_id, relay_id, thread_id, route_id, policy_sha256, desired_state_sha256,
  operator_set_sha256, admitted_operator_ref, public_identity, sender_domain, identity_profile_ref,
  identity_profile_sha256, display_name, signature_profile_ref, signature_sha256, sender_adapter,
  configured_policy_receipt_sha256, edge_activation_receipt_sha256, sender_domain_receipt_sha256,
  inbound_acceptance_receipt_sha256, apple_mail_inbox_receipt_sha256, operator_authorization_receipt_sha256,
  opaque_relay_receipt_sha256, evidence_bundle_sha256, evidence_observed_at, admitted_at, expires_at
  ON reply_admissions
BEGIN SELECT RAISE(ABORT, 'canary admission identity is immutable'); END;
CREATE TRIGGER reply_admissions_claim_immutable BEFORE UPDATE OF
  claimed_attempt_id, claimed_attempt_sha256, claimed_payload_sha256, claimed_at ON reply_admissions
WHEN OLD.claimed_attempt_id IS NOT NULL AND
  (NEW.claimed_attempt_id IS NOT OLD.claimed_attempt_id OR NEW.claimed_attempt_sha256 IS NOT OLD.claimed_attempt_sha256
    OR NEW.claimed_payload_sha256 IS NOT OLD.claimed_payload_sha256 OR NEW.claimed_at IS NOT OLD.claimed_at)
BEGIN SELECT RAISE(ABORT, 'canary claim identity is immutable'); END;
CREATE TRIGGER reply_admissions_terminal_no_reopen BEFORE UPDATE OF status ON reply_admissions
WHEN OLD.status IN ('provider_accepted', 'failed', 'recovery_required', 'revoked', 'expired', 'superseded') AND NEW.status != OLD.status
BEGIN SELECT RAISE(ABORT, 'canary terminal state cannot reopen'); END;
CREATE TRIGGER reply_admissions_no_delete BEFORE DELETE ON reply_admissions
BEGIN SELECT RAISE(ABORT, 'canary admission history is retained'); END;
