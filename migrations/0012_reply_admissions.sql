-- One body-free, controller-compiled authorization for one canary inbox reply.
-- Identity/evidence columns are immutable application inputs; only lifecycle
-- columns are updated after activation. Historical rows are retained so a
-- consumed, failed, or ambiguous transaction can never be silently replayed.
CREATE TABLE reply_admissions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  transaction_sha256 TEXT NOT NULL UNIQUE CHECK (length(transaction_sha256) = 64),
  correlation_sha256 TEXT NOT NULL CHECK (length(correlation_sha256) = 64),
  candidate_sha256 TEXT NOT NULL CHECK (length(candidate_sha256) = 64),
  scope_manifest_sha256 TEXT NOT NULL CHECK (length(scope_manifest_sha256) = 64),
  inbound_delivery_id TEXT NOT NULL REFERENCES inbound_deliveries(id) ON DELETE RESTRICT,
  relay_id TEXT NOT NULL REFERENCES reply_relays(id) ON DELETE RESTRICT,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
  route_id TEXT NOT NULL REFERENCES alias_routes(id) ON DELETE RESTRICT,
  policy_sha256 TEXT NOT NULL REFERENCES policy_revisions(policy_sha256) ON DELETE RESTRICT,
  desired_state_sha256 TEXT NOT NULL CHECK (length(desired_state_sha256) = 64),
  operator_set_sha256 TEXT NOT NULL CHECK (length(operator_set_sha256) = 64),
  admitted_operator_ref TEXT NOT NULL CHECK (length(admitted_operator_ref) = 64),
  public_identity TEXT NOT NULL,
  sender_domain TEXT NOT NULL,
  identity_profile_ref TEXT NOT NULL,
  identity_profile_sha256 TEXT NOT NULL CHECK (length(identity_profile_sha256) = 64),
  display_name TEXT NOT NULL,
  signature_profile_ref TEXT NOT NULL,
  signature_sha256 TEXT NOT NULL CHECK (length(signature_sha256) = 64),
  sender_adapter TEXT NOT NULL
    CHECK (sender_adapter IN ('cloudflare_email_service', 'resend')),
  configured_policy_receipt_sha256 TEXT NOT NULL
    CHECK (length(configured_policy_receipt_sha256) = 64),
  edge_activation_receipt_sha256 TEXT NOT NULL
    CHECK (length(edge_activation_receipt_sha256) = 64),
  sender_domain_receipt_sha256 TEXT NOT NULL
    CHECK (length(sender_domain_receipt_sha256) = 64),
  inbound_acceptance_receipt_sha256 TEXT NOT NULL
    CHECK (length(inbound_acceptance_receipt_sha256) = 64),
  apple_mail_inbox_receipt_sha256 TEXT NOT NULL
    CHECK (length(apple_mail_inbox_receipt_sha256) = 64),
  operator_authorization_receipt_sha256 TEXT NOT NULL
    CHECK (length(operator_authorization_receipt_sha256) = 64),
  opaque_relay_receipt_sha256 TEXT NOT NULL
    CHECK (length(opaque_relay_receipt_sha256) = 64),
  evidence_bundle_sha256 TEXT NOT NULL CHECK (length(evidence_bundle_sha256) = 64),
  evidence_observed_at TEXT NOT NULL,
  admitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'admitted'
    CHECK (status IN (
      'admitted',
      'claimed',
      'sending',
      'provider_accepted',
      'failed',
      'recovery_required',
      'revoked',
      'expired',
      'superseded'
    )),
  claimed_attempt_id TEXT UNIQUE,
  claimed_attempt_sha256 TEXT
    CHECK (claimed_attempt_sha256 IS NULL OR length(claimed_attempt_sha256) = 64),
  claimed_payload_sha256 TEXT
    CHECK (claimed_payload_sha256 IS NULL OR length(claimed_payload_sha256) = 64),
  claimed_at TEXT,
  provider_boundary_at TEXT,
  terminal_at TEXT,
  revoked_at TEXT,
  error_code TEXT,
  CHECK (lower(public_identity) = public_identity),
  CHECK (lower(sender_domain) = sender_domain),
  CHECK (public_identity LIKE '%@' || sender_domain),
  CHECK (julianday(expires_at) > julianday(admitted_at)),
  CHECK (
    (status = 'admitted' AND claimed_attempt_id IS NULL AND claimed_attempt_sha256 IS NULL AND claimed_payload_sha256 IS NULL AND claimed_at IS NULL)
    OR
    (status <> 'admitted' AND claimed_attempt_id IS NOT NULL AND claimed_attempt_sha256 IS NOT NULL AND claimed_payload_sha256 IS NOT NULL AND claimed_at IS NOT NULL)
    OR
    (status IN ('revoked', 'expired', 'superseded') AND claimed_attempt_id IS NULL)
  )
);

CREATE UNIQUE INDEX reply_admissions_one_live_relay_idx
ON reply_admissions(relay_id)
WHERE status IN ('admitted', 'claimed', 'sending');

CREATE INDEX reply_admissions_status_expiry_idx
ON reply_admissions(status, expires_at);

CREATE INDEX reply_admissions_transaction_state_idx
ON reply_admissions(transaction_sha256, status);

CREATE TRIGGER reply_admissions_require_relational_ownership
BEFORE INSERT ON reply_admissions
WHEN NOT EXISTS (
  SELECT 1 FROM reply_relays rr
  WHERE rr.id = NEW.relay_id
    AND rr.thread_id = NEW.thread_id
    AND rr.route_id = NEW.route_id
)
BEGIN
  SELECT RAISE(ABORT, 'reply admission route relay ownership mismatch');
END;

-- Relay termination is irreversible. Recovery creates a new relay and records
-- one controller-bound supersession; it never extends or reactivates the old
-- opaque address.
ALTER TABLE reply_relays ADD COLUMN revocation_reason TEXT
  CHECK (revocation_reason IS NULL OR revocation_reason IN (
    'wrong_identity',
    'private_identity_exposure',
    'duplicate_send',
    'ambiguous_provider_result',
    'unauthorized_operator',
    'policy_changed',
    'controller_recovery'
  ));
ALTER TABLE reply_relays ADD COLUMN superseded_by_relay_id TEXT
  REFERENCES reply_relays(id) ON DELETE RESTRICT;
ALTER TABLE reply_relays ADD COLUMN supersession_controller_transaction_sha256 TEXT
  CHECK (
    supersession_controller_transaction_sha256 IS NULL
    OR length(supersession_controller_transaction_sha256) = 64
  );

CREATE TRIGGER reply_relays_require_revocation_reason
BEFORE UPDATE OF revoked_at ON reply_relays
WHEN NEW.revoked_at IS NOT NULL AND NEW.revocation_reason IS NULL
BEGIN
  SELECT RAISE(ABORT, 'revocation reason required');
END;

CREATE TRIGGER reply_relays_no_reactivation
BEFORE UPDATE OF revoked_at ON reply_relays
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
  SELECT RAISE(ABORT, 'revoked relay is terminal');
END;

CREATE TRIGGER reply_relays_no_revoked_expiry_extension
BEFORE UPDATE OF expires_at ON reply_relays
WHEN OLD.revoked_at IS NOT NULL AND julianday(NEW.expires_at) > julianday(OLD.expires_at)
BEGIN
  SELECT RAISE(ABORT, 'revoked relay expiry is immutable');
END;

CREATE TRIGGER reply_relays_one_supersession
BEFORE UPDATE OF superseded_by_relay_id ON reply_relays
WHEN OLD.superseded_by_relay_id IS NOT NULL
  AND NEW.superseded_by_relay_id IS NOT OLD.superseded_by_relay_id
BEGIN
  SELECT RAISE(ABORT, 'relay supersession is immutable');
END;

-- Quarantine is an event ledger. A release is a new, explicitly governed row
-- linked to exactly one quarantine; historical safety evidence is never
-- overwritten or deleted.
CREATE TABLE route_outbound_quarantines (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES alias_routes(id) ON DELETE RESTRICT,
  relay_id TEXT NOT NULL REFERENCES reply_relays(id) ON DELETE RESTRICT,
  reply_admission_id TEXT NOT NULL REFERENCES reply_admissions(id) ON DELETE RESTRICT,
  controller_transaction_sha256 TEXT NOT NULL
    CHECK (length(controller_transaction_sha256) = 64),
  action TEXT NOT NULL CHECK (action IN ('quarantine', 'release')),
  reason TEXT NOT NULL CHECK (reason IN (
    'wrong_identity',
    'private_identity_exposure',
    'duplicate_send',
    'ambiguous_provider_result',
    'unauthorized_operator',
    'controller_recovery'
  )),
  containment_plan_sha256 TEXT NOT NULL CHECK (length(containment_plan_sha256) = 64),
  source_containment_plan_sha256 TEXT CHECK (
    source_containment_plan_sha256 IS NULL OR length(source_containment_plan_sha256) = 64
  ),
  release_of_quarantine_id TEXT REFERENCES route_outbound_quarantines(id) ON DELETE RESTRICT,
  quarantined_at TEXT NOT NULL,
  CHECK (
    (action = 'quarantine'
      AND release_of_quarantine_id IS NULL
      AND source_containment_plan_sha256 IS NULL)
    OR
    (action = 'release'
      AND release_of_quarantine_id IS NOT NULL
      AND source_containment_plan_sha256 IS NOT NULL)
  )
);

CREATE INDEX route_outbound_quarantines_active_idx
ON route_outbound_quarantines(route_id, relay_id, quarantined_at)
WHERE action = 'quarantine';

CREATE UNIQUE INDEX route_outbound_quarantines_one_release_idx
ON route_outbound_quarantines(release_of_quarantine_id)
WHERE action = 'release';

CREATE TRIGGER route_outbound_quarantines_no_update
BEFORE UPDATE ON route_outbound_quarantines
BEGIN
  SELECT RAISE(ABORT, 'quarantine ledger is append-only');
END;

CREATE TRIGGER route_outbound_quarantines_require_relational_ownership
BEFORE INSERT ON route_outbound_quarantines
WHEN NOT EXISTS (
  SELECT 1 FROM reply_admissions ra
  WHERE ra.id = NEW.reply_admission_id
    AND ra.relay_id = NEW.relay_id
    AND ra.route_id = NEW.route_id
)
BEGIN
  SELECT RAISE(ABORT, 'quarantine route relay admission ownership mismatch');
END;

CREATE TRIGGER route_outbound_quarantines_require_release_lineage
BEFORE INSERT ON route_outbound_quarantines
WHEN NEW.action = 'release' AND NOT EXISTS (
  SELECT 1 FROM route_outbound_quarantines source
  WHERE source.id = NEW.release_of_quarantine_id
    AND source.action = 'quarantine'
    AND source.route_id = NEW.route_id
    AND source.relay_id = NEW.relay_id
    AND source.reply_admission_id = NEW.reply_admission_id
    AND source.containment_plan_sha256 = NEW.source_containment_plan_sha256
    AND source.controller_transaction_sha256 != NEW.controller_transaction_sha256
    AND source.containment_plan_sha256 != NEW.containment_plan_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'quarantine release lineage mismatch');
END;

CREATE TRIGGER route_outbound_quarantines_no_delete
BEFORE DELETE ON route_outbound_quarantines
BEGIN
  SELECT RAISE(ABORT, 'quarantine ledger is append-only');
END;

-- The governed PlanV2 lifecycle records all outcomes, including an ambiguous
-- provider result. A later reconciliation appends a new row and never rewrites
-- the original operation evidence.
CREATE TABLE reply_containment_plan_records (
  id TEXT PRIMARY KEY,
  controller_transaction_sha256 TEXT NOT NULL
    CHECK (length(controller_transaction_sha256) = 64),
  containment_transaction_sha256 TEXT NOT NULL
    CHECK (length(containment_transaction_sha256) = 64),
  route_id TEXT NOT NULL REFERENCES alias_routes(id) ON DELETE RESTRICT,
  relay_id TEXT NOT NULL REFERENCES reply_relays(id) ON DELETE RESTRICT,
  reply_admission_id TEXT NOT NULL REFERENCES reply_admissions(id) ON DELETE RESTRICT,
  plan_sha256 TEXT NOT NULL CHECK (length(plan_sha256) = 64),
  pre_read_receipt_sha256 TEXT NOT NULL CHECK (length(pre_read_receipt_sha256) = 64),
  authority_sha256 TEXT NOT NULL CHECK (length(authority_sha256) = 64),
  operation_id_sha256 TEXT CHECK (
    operation_id_sha256 IS NULL OR length(operation_id_sha256) = 64
  ),
  operation_kind TEXT NOT NULL CHECK (operation_kind IN (
    'pre_send_rollback',
    'replacement',
    'post_boundary_containment'
  )),
  cannot_unsend INTEGER NOT NULL DEFAULT 0 CHECK (cannot_unsend IN (0, 1)),
  terminal_provider_evidence_sha256 TEXT CHECK (
    terminal_provider_evidence_sha256 IS NULL
    OR length(terminal_provider_evidence_sha256) = 64
  ),
  outcome TEXT NOT NULL CHECK (outcome IN ('planned', 'performed', 'ambiguous')),
  match_count INTEGER CHECK (match_count IS NULL OR match_count >= 0),
  prior_record_id TEXT REFERENCES reply_containment_plan_records(id) ON DELETE RESTRICT,
  observed_at TEXT NOT NULL,
  CHECK (
    (outcome = 'planned' AND operation_id_sha256 IS NULL AND match_count IS NULL)
    OR
    (outcome = 'performed' AND operation_id_sha256 IS NOT NULL AND match_count = 1)
    OR
    (outcome = 'ambiguous' AND operation_id_sha256 IS NOT NULL AND match_count != 1)
  ),
  CHECK (
    (operation_kind = 'post_boundary_containment'
      AND cannot_unsend = 1
      AND terminal_provider_evidence_sha256 IS NOT NULL)
    OR
    (operation_kind != 'post_boundary_containment'
      AND cannot_unsend = 0
      AND terminal_provider_evidence_sha256 IS NULL)
  )
);

CREATE UNIQUE INDEX reply_containment_plan_records_outcome_idx
ON reply_containment_plan_records(containment_transaction_sha256, outcome);

CREATE TRIGGER reply_containment_plan_records_no_update
BEFORE UPDATE ON reply_containment_plan_records
BEGIN
  SELECT RAISE(ABORT, 'containment plan ledger is append-only');
END;

CREATE TRIGGER reply_containment_plan_records_require_relational_ownership
BEFORE INSERT ON reply_containment_plan_records
WHEN NOT EXISTS (
  SELECT 1 FROM reply_admissions ra
  WHERE ra.id = NEW.reply_admission_id
    AND ra.relay_id = NEW.relay_id
    AND ra.route_id = NEW.route_id
)
BEGIN
  SELECT RAISE(ABORT, 'containment plan route relay admission ownership mismatch');
END;

CREATE TRIGGER reply_containment_plan_records_no_delete
BEFORE DELETE ON reply_containment_plan_records
BEGIN
  SELECT RAISE(ABORT, 'containment plan ledger is append-only');
END;

CREATE TABLE reply_relay_replacements (
  id TEXT PRIMARY KEY,
  source_relay_id TEXT NOT NULL REFERENCES reply_relays(id) ON DELETE RESTRICT,
  replacement_relay_id TEXT NOT NULL REFERENCES reply_relays(id) ON DELETE RESTRICT,
  controller_transaction_sha256 TEXT NOT NULL
    CHECK (length(controller_transaction_sha256) = 64),
  source_containment_receipt_sha256 TEXT NOT NULL
    CHECK (length(source_containment_receipt_sha256) = 64),
  created_at TEXT NOT NULL,
  CHECK (source_relay_id != replacement_relay_id)
);

CREATE UNIQUE INDEX reply_relay_replacements_source_unique_idx
ON reply_relay_replacements(source_relay_id);

CREATE UNIQUE INDEX reply_relay_replacements_target_unique_idx
ON reply_relay_replacements(replacement_relay_id);

CREATE TRIGGER reply_relay_replacements_require_terminal_lineage
BEFORE INSERT ON reply_relay_replacements
WHEN NOT EXISTS (
  SELECT 1
  FROM reply_relays source
  JOIN reply_relays replacement ON replacement.id = NEW.replacement_relay_id
  WHERE source.id = NEW.source_relay_id
    AND (
      source.revoked_at IS NOT NULL
      OR source.superseded_by_relay_id IS NOT NULL
      OR julianday(source.expires_at) <= julianday(NEW.created_at)
    )
    AND source.supersession_controller_transaction_sha256 IS NOT NEW.controller_transaction_sha256
    AND replacement.revoked_at IS NULL
    AND replacement.superseded_by_relay_id IS NULL
    AND julianday(replacement.expires_at) > julianday(NEW.created_at)
)
BEGIN
  SELECT RAISE(ABORT, 'replacement requires terminal source and fresh target');
END;

CREATE TRIGGER reply_relay_replacements_no_update
BEFORE UPDATE ON reply_relay_replacements
BEGIN
  SELECT RAISE(ABORT, 'relay replacement lineage is append-only');
END;

CREATE TRIGGER reply_relay_replacements_no_delete
BEFORE DELETE ON reply_relay_replacements
BEGIN
  SELECT RAISE(ABORT, 'relay replacement lineage is append-only');
END;
