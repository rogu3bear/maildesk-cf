-- Ordinary authority is explicit and route-scoped. No enabled flag or old proof
-- timestamp is backfilled into this table. Only governed activation inserts it.
CREATE TABLE route_reply_authorizations (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  route_id TEXT NOT NULL REFERENCES alias_routes(id) ON DELETE RESTRICT,
  policy_sha256 TEXT NOT NULL REFERENCES policy_revisions(policy_sha256) ON DELETE RESTRICT,
  desired_state_sha256 TEXT NOT NULL CHECK ((length(desired_state_sha256) = 64 AND desired_state_sha256 NOT GLOB '*[^0-9a-f]*')),
  public_identity TEXT NOT NULL CHECK (lower(public_identity) = public_identity),
  identity_profile_ref TEXT NOT NULL,
  identity_profile_sha256 TEXT NOT NULL CHECK ((length(identity_profile_sha256) = 64 AND identity_profile_sha256 NOT GLOB '*[^0-9a-f]*')),
  operator_set_sha256 TEXT NOT NULL CHECK ((length(operator_set_sha256) = 64 AND operator_set_sha256 NOT GLOB '*[^0-9a-f]*')),
  operator_set_json TEXT NOT NULL CHECK (json_valid(operator_set_json) AND json_type(operator_set_json) = 'array' AND json_array_length(operator_set_json) > 0),
  sender_adapter TEXT NOT NULL CHECK (sender_adapter IN ('cloudflare_email_service', 'resend')),
  sender_domain TEXT NOT NULL CHECK (lower(sender_domain) = sender_domain),
  runtime_artifacts_sha256 TEXT NOT NULL CHECK ((length(runtime_artifacts_sha256) = 64 AND runtime_artifacts_sha256 NOT GLOB '*[^0-9a-f]*')),
  topology_sha256 TEXT NOT NULL CHECK ((length(topology_sha256) = 64 AND topology_sha256 NOT GLOB '*[^0-9a-f]*')),
  qualification_kind TEXT NOT NULL CHECK (qualification_kind = 'golden_thread'),
  canary_admission_id TEXT NOT NULL REFERENCES reply_admissions(id) ON DELETE RESTRICT,
  inbox_proof_id TEXT NOT NULL REFERENCES route_proofs(id) ON DELETE RESTRICT,
  reply_proof_id TEXT NOT NULL REFERENCES route_proofs(id) ON DELETE RESTRICT,
  qualification_receipt_sha256 TEXT NOT NULL CHECK ((length(qualification_receipt_sha256) = 64 AND qualification_receipt_sha256 NOT GLOB '*[^0-9a-f]*')),
  qualification_valid_until TEXT NOT NULL CHECK (julianday(qualification_valid_until) IS NOT NULL),
  activation_receipt_sha256 TEXT NOT NULL CHECK ((length(activation_receipt_sha256) = 64 AND activation_receipt_sha256 NOT GLOB '*[^0-9a-f]*')),
  owner_authorization_sha256 TEXT NOT NULL CHECK ((length(owner_authorization_sha256) = 64 AND owner_authorization_sha256 NOT GLOB '*[^0-9a-f]*')),
  activated_by_ref TEXT NOT NULL CHECK ((length(activated_by_ref) = 64 AND activated_by_ref NOT GLOB '*[^0-9a-f]*')),
  activated_at TEXT NOT NULL CHECK (julianday(activated_at) IS NOT NULL),
  expires_at TEXT CHECK (expires_at IS NULL OR (julianday(expires_at) IS NOT NULL AND julianday(expires_at) > julianday(activated_at))),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  revoked_at TEXT,
  revocation_receipt_sha256 TEXT CHECK (revocation_receipt_sha256 IS NULL OR (length(revocation_receipt_sha256) = 64 AND revocation_receipt_sha256 NOT GLOB '*[^0-9a-f]*')),
  CHECK (public_identity LIKE '%@' || sender_domain),
  CHECK (julianday(activated_at) <= julianday(qualification_valid_until)),
  CHECK ((status = 'active' AND revoked_at IS NULL AND revocation_receipt_sha256 IS NULL)
    OR (status = 'revoked' AND julianday(revoked_at) IS NOT NULL AND revocation_receipt_sha256 IS NOT NULL))
);
CREATE UNIQUE INDEX route_reply_authorizations_one_active_idx ON route_reply_authorizations(route_id) WHERE status = 'active';

-- Quarantine does not need an arbitrary relay or canary admission. Both ledgers
-- remain append-only. A release names exactly the quarantine it releases.
CREATE TABLE route_reply_containment_events (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  route_id TEXT NOT NULL REFERENCES alias_routes(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('quarantine', 'release')),
  reason TEXT NOT NULL CHECK (reason IN ('wrong_identity', 'private_identity_exposure', 'duplicate_send',
    'ambiguous_provider_result', 'unauthorized_operator', 'policy_changed', 'controller_recovery')),
  receipt_sha256 TEXT NOT NULL CHECK ((length(receipt_sha256) = 64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*')),
  owner_authorization_sha256 TEXT NOT NULL CHECK ((length(owner_authorization_sha256) = 64 AND owner_authorization_sha256 NOT GLOB '*[^0-9a-f]*')),
  release_of TEXT REFERENCES route_reply_containment_events(id) ON DELETE RESTRICT,
  recorded_at TEXT NOT NULL CHECK (julianday(recorded_at) IS NOT NULL),
  cannot_unsend INTEGER NOT NULL CHECK (cannot_unsend = 1),
  CHECK ((action = 'quarantine' AND release_of IS NULL) OR (action = 'release' AND release_of IS NOT NULL))
);
CREATE UNIQUE INDEX route_reply_containment_one_release_idx ON route_reply_containment_events(release_of) WHERE action = 'release';
CREATE TRIGGER route_reply_containment_release_lineage BEFORE INSERT ON route_reply_containment_events
WHEN NEW.action = 'release' AND NOT EXISTS (SELECT 1 FROM route_reply_containment_events q
  WHERE q.id = NEW.release_of AND q.action = 'quarantine' AND q.route_id = NEW.route_id
    AND q.receipt_sha256 != NEW.receipt_sha256 AND julianday(q.recorded_at) <= julianday(NEW.recorded_at))
BEGIN SELECT RAISE(ABORT, 'route quarantine release lineage mismatch'); END;
CREATE TRIGGER route_reply_containment_no_update BEFORE UPDATE ON route_reply_containment_events
BEGIN SELECT RAISE(ABORT, 'route containment is append-only'); END;
CREATE TRIGGER route_reply_containment_no_delete BEFORE DELETE ON route_reply_containment_events
BEGIN SELECT RAISE(ABORT, 'route containment is append-only'); END;

CREATE VIEW active_route_reply_quarantines AS
SELECT q.id, q.route_id FROM route_outbound_quarantines q
WHERE q.action = 'quarantine' AND NOT EXISTS (SELECT 1 FROM route_outbound_quarantines r
  WHERE r.action = 'release' AND r.release_of_quarantine_id = q.id)
UNION ALL
SELECT q.id, q.route_id FROM route_reply_containment_events q
WHERE q.action = 'quarantine' AND NOT EXISTS (SELECT 1 FROM route_reply_containment_events r
  WHERE r.action = 'release' AND r.release_of = q.id);

CREATE VIEW current_route_reply_authorizations AS
SELECT a.* FROM route_reply_authorizations a
JOIN runtime_state rs ON rs.singleton = 1 AND rs.active_policy_sha256 = a.policy_sha256
JOIN policy_projection_state ds ON ds.key = 'active_desired_state_sha256' AND ds.value = a.desired_state_sha256
JOIN policy_projection_state art ON art.key = 'active_runtime_artifacts_sha256' AND art.value = a.runtime_artifacts_sha256
JOIN policy_projection_state top ON top.key = 'active_topology_sha256' AND top.value = a.topology_sha256
JOIN alias_routes ar ON ar.id = a.route_id AND ar.enabled = 1 AND ar.policy_sha256 = a.policy_sha256 AND ar.decision_kind != 'sink'
JOIN identities i ON i.id = ar.default_reply_identity_id AND i.address = a.public_identity
WHERE a.operator_set_json = (SELECT json_group_array(email) FROM (SELECT o.email FROM alias_route_operators aro JOIN operators o ON o.id = aro.operator_id WHERE aro.route_id = a.route_id ORDER BY o.email))
  AND a.status = 'active' AND julianday(a.activated_at) <= julianday('now')
  AND (a.expires_at IS NULL OR julianday(a.expires_at) > julianday('now'))
  AND NOT EXISTS (SELECT 1 FROM active_route_reply_quarantines q WHERE q.route_id = a.route_id);

CREATE TRIGGER route_reply_authorization_qualification BEFORE INSERT ON route_reply_authorizations
BEGIN
  SELECT CASE WHEN NEW.status != 'active' OR julianday(NEW.qualification_valid_until) <= julianday('now')
    OR julianday(NEW.activated_at) > julianday('now', '+1 minute')
    OR NOT EXISTS (SELECT 1 FROM reply_admissions ra
      JOIN route_proofs ip ON ip.id = NEW.inbox_proof_id AND ip.route_id = ra.route_id
        AND ip.policy_sha256 = ra.policy_sha256 AND ip.proof_kind = 'inbox_verified'
      JOIN route_proofs rp ON rp.id = NEW.reply_proof_id AND rp.route_id = ra.route_id
        AND rp.policy_sha256 = ra.policy_sha256 AND rp.proof_kind = 'reply_verified'
      WHERE ra.id = NEW.canary_admission_id AND ra.status = 'provider_accepted'
        AND ra.route_id = NEW.route_id AND ra.policy_sha256 = NEW.policy_sha256
        AND ra.desired_state_sha256 = NEW.desired_state_sha256
        AND ra.public_identity = NEW.public_identity AND ra.identity_profile_ref = NEW.identity_profile_ref
        AND ra.identity_profile_sha256 = NEW.identity_profile_sha256 AND ra.operator_set_sha256 = NEW.operator_set_sha256
        AND ra.sender_adapter = NEW.sender_adapter AND ra.sender_domain = NEW.sender_domain
        AND julianday(ip.verified_at) <= julianday(NEW.activated_at)
        AND julianday(rp.verified_at) <= julianday(NEW.activated_at)
        AND julianday(rp.verified_at) >= julianday(ra.provider_boundary_at)
        AND julianday(ip.verified_at) >= julianday('now', '-1 day')
        AND julianday(rp.verified_at) >= julianday('now', '-1 day'))
  THEN RAISE(ABORT, 'route activation requires current exact golden-thread qualification') END;
END;
CREATE TRIGGER route_reply_authorization_current AFTER INSERT ON route_reply_authorizations
WHEN NOT EXISTS (SELECT 1 FROM current_route_reply_authorizations WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'route activation binding is not current'); END;

CREATE TRIGGER route_reply_authorization_identity_immutable BEFORE UPDATE OF
  id, schema_version, route_id, policy_sha256, desired_state_sha256, public_identity, identity_profile_ref,
  identity_profile_sha256, operator_set_sha256, operator_set_json, sender_adapter, sender_domain, runtime_artifacts_sha256,
  topology_sha256, qualification_kind, canary_admission_id, inbox_proof_id, reply_proof_id,
  qualification_receipt_sha256, qualification_valid_until, activation_receipt_sha256,
  owner_authorization_sha256, activated_by_ref, activated_at, expires_at ON route_reply_authorizations
BEGIN SELECT RAISE(ABORT, 'route authorization identity is immutable'); END;
CREATE TRIGGER route_reply_authorization_terminal BEFORE UPDATE ON route_reply_authorizations
WHEN OLD.status = 'revoked'
BEGIN SELECT RAISE(ABORT, 'revoked route authorization is terminal'); END;
CREATE TRIGGER route_reply_authorization_no_delete BEFORE DELETE ON route_reply_authorizations
BEGIN SELECT RAISE(ABORT, 'route authorization history is retained'); END;

CREATE TABLE ordinary_reply_admissions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 2),
  admission_kind TEXT NOT NULL CHECK (admission_kind = 'ordinary'),
  activation_id TEXT NOT NULL REFERENCES route_reply_authorizations(id) ON DELETE RESTRICT,
  transaction_sha256 TEXT NOT NULL UNIQUE CHECK ((length(transaction_sha256) = 64 AND transaction_sha256 NOT GLOB '*[^0-9a-f]*')),
  relay_id TEXT NOT NULL REFERENCES reply_relays(id) ON DELETE RESTRICT,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
  route_id TEXT NOT NULL REFERENCES alias_routes(id) ON DELETE RESTRICT,
  policy_sha256 TEXT NOT NULL REFERENCES policy_revisions(policy_sha256) ON DELETE RESTRICT,
  desired_state_sha256 TEXT NOT NULL CHECK ((length(desired_state_sha256) = 64 AND desired_state_sha256 NOT GLOB '*[^0-9a-f]*')),
  operator_set_sha256 TEXT NOT NULL CHECK ((length(operator_set_sha256) = 64 AND operator_set_sha256 NOT GLOB '*[^0-9a-f]*')),
  admitted_operator_ref TEXT NOT NULL CHECK ((length(admitted_operator_ref) = 64 AND admitted_operator_ref NOT GLOB '*[^0-9a-f]*')),
  operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  public_identity TEXT NOT NULL CHECK (lower(public_identity) = public_identity),
  sender_domain TEXT NOT NULL CHECK (lower(sender_domain) = sender_domain),
  identity_profile_ref TEXT NOT NULL,
  identity_profile_sha256 TEXT NOT NULL CHECK ((length(identity_profile_sha256) = 64 AND identity_profile_sha256 NOT GLOB '*[^0-9a-f]*')),
  display_name TEXT NOT NULL,
  signature_profile_ref TEXT NOT NULL,
  signature_sha256 TEXT NOT NULL CHECK ((length(signature_sha256) = 64 AND signature_sha256 NOT GLOB '*[^0-9a-f]*')),
  sender_adapter TEXT NOT NULL CHECK (sender_adapter IN ('cloudflare_email_service', 'resend')),
  authenticated_raw_sha256 TEXT NOT NULL CHECK ((length(authenticated_raw_sha256) = 64 AND authenticated_raw_sha256 NOT GLOB '*[^0-9a-f]*')),
  authenticated_message_id_sha256 TEXT NOT NULL CHECK ((length(authenticated_message_id_sha256) = 64 AND authenticated_message_id_sha256 NOT GLOB '*[^0-9a-f]*')),
  signed_recipient_sha256 TEXT NOT NULL CHECK ((length(signed_recipient_sha256) = 64 AND signed_recipient_sha256 NOT GLOB '*[^0-9a-f]*')),
  operator_message_id TEXT NOT NULL,
  raw_r2_key TEXT NOT NULL,
  external_recipient TEXT NOT NULL,
  admitted_at TEXT NOT NULL CHECK (julianday(admitted_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK (julianday(expires_at) IS NOT NULL AND julianday(expires_at) > julianday(admitted_at)),
  status TEXT NOT NULL CHECK (status IN ('claimed', 'sending', 'provider_accepted', 'failed', 'recovery_required', 'revoked', 'expired', 'superseded')),
  claimed_attempt_id TEXT NOT NULL UNIQUE,
  claimed_attempt_sha256 TEXT NOT NULL CHECK ((length(claimed_attempt_sha256) = 64 AND claimed_attempt_sha256 NOT GLOB '*[^0-9a-f]*')),
  claimed_payload_sha256 TEXT NOT NULL CHECK ((length(claimed_payload_sha256) = 64 AND claimed_payload_sha256 NOT GLOB '*[^0-9a-f]*')),
  claimed_at TEXT NOT NULL CHECK (julianday(claimed_at) IS NOT NULL),
  provider_boundary_at TEXT CHECK (provider_boundary_at IS NULL OR julianday(provider_boundary_at) IS NOT NULL),
  terminal_at TEXT CHECK (terminal_at IS NULL OR julianday(terminal_at) IS NOT NULL),
  revoked_at TEXT CHECK (revoked_at IS NULL OR julianday(revoked_at) IS NOT NULL),
  error_code TEXT,
  CHECK (public_identity LIKE '%@' || sender_domain),
  CHECK ((status = 'claimed' AND provider_boundary_at IS NULL) OR status != 'claimed'),
  CHECK (status != 'sending' OR provider_boundary_at IS NOT NULL),
  CHECK (status NOT IN ('provider_accepted', 'failed', 'recovery_required') OR terminal_at IS NOT NULL),
  CHECK (status != 'revoked' OR revoked_at IS NOT NULL)
);
CREATE INDEX ordinary_reply_admissions_status_idx ON ordinary_reply_admissions(status, expires_at);

CREATE TRIGGER ordinary_reply_admission_require_current BEFORE INSERT ON ordinary_reply_admissions
BEGIN
  SELECT CASE WHEN NEW.status != 'claimed' OR NEW.provider_boundary_at IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM current_route_reply_authorizations a
      JOIN reply_relays rr ON rr.id = NEW.relay_id AND rr.route_id = a.route_id
      JOIN threads t ON t.id = rr.thread_id AND t.route_id = rr.route_id
      JOIN alias_route_operators aro ON aro.route_id = a.route_id AND aro.operator_id = NEW.operator_id
      WHERE a.id = NEW.activation_id AND a.policy_sha256 = NEW.policy_sha256
        AND a.desired_state_sha256 = NEW.desired_state_sha256 AND a.route_id = NEW.route_id
        AND a.public_identity = NEW.public_identity AND a.public_identity = rr.reply_identity
        AND a.identity_profile_ref = NEW.identity_profile_ref AND a.identity_profile_sha256 = NEW.identity_profile_sha256
        AND a.operator_set_sha256 = NEW.operator_set_sha256 AND a.sender_adapter = NEW.sender_adapter
        AND a.sender_domain = NEW.sender_domain AND rr.thread_id = NEW.thread_id
        AND rr.external_recipient = NEW.external_recipient AND lower(t.external_sender) = NEW.external_recipient
        AND rr.revoked_at IS NULL AND rr.superseded_by_relay_id IS NULL
        AND julianday(NEW.expires_at) <= julianday(rr.expires_at)
        AND (a.expires_at IS NULL OR julianday(NEW.expires_at) <= julianday(a.expires_at))
        AND julianday(NEW.admitted_at) <= julianday('now', '+1 minute') AND julianday(NEW.expires_at) > julianday('now'))
  THEN RAISE(ABORT, 'ordinary reply authority is unavailable or mismatched') END;
END;

-- The authorization and dispatch intent become durable together.
CREATE TRIGGER ordinary_reply_admission_dispatch AFTER INSERT ON ordinary_reply_admissions
BEGIN
  INSERT INTO relay_attempts (id, relay_id, operator, operator_message_id, raw_r2_key, raw_sha256,
    status, identity_version, payload_version, admission_kind, admission_id, transaction_sha256, attempt_sha256,
    claimed_payload_sha256, desired_state_sha256, identity_profile_sha256, policy_sha256,
    operator_ref, operator_set_sha256, dispatch_received_at)
  SELECT NEW.claimed_attempt_id, NEW.relay_id, o.email, NEW.operator_message_id,
    NEW.raw_r2_key, NEW.authenticated_raw_sha256, 'receiving', 2, 2, 'ordinary', NEW.id,
    NEW.transaction_sha256, NEW.claimed_attempt_sha256, NEW.claimed_payload_sha256,
    NEW.desired_state_sha256, NEW.identity_profile_sha256, NEW.policy_sha256,
    NEW.admitted_operator_ref, NEW.operator_set_sha256, NEW.admitted_at
  FROM operators o WHERE o.id = NEW.operator_id;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'ordinary dispatch claim lost') END;
END;

CREATE TRIGGER ordinary_reply_identity_immutable BEFORE UPDATE OF
  id, schema_version, admission_kind, activation_id, transaction_sha256, relay_id, thread_id,
  route_id, policy_sha256, desired_state_sha256, operator_set_sha256, admitted_operator_ref,
  operator_id, public_identity, sender_domain, identity_profile_ref, identity_profile_sha256,
  display_name, signature_profile_ref, signature_sha256, sender_adapter, authenticated_raw_sha256,
  authenticated_message_id_sha256, signed_recipient_sha256, operator_message_id, raw_r2_key,
  external_recipient, admitted_at, expires_at, claimed_attempt_id, claimed_attempt_sha256,
  claimed_payload_sha256, claimed_at ON ordinary_reply_admissions
BEGIN SELECT RAISE(ABORT, 'ordinary reply identity is immutable'); END;
CREATE TRIGGER ordinary_reply_terminal BEFORE UPDATE OF status ON ordinary_reply_admissions
WHEN OLD.status IN ('provider_accepted', 'failed', 'recovery_required', 'revoked', 'expired', 'superseded') AND NEW.status != OLD.status
BEGIN SELECT RAISE(ABORT, 'ordinary reply terminal state cannot reopen'); END;
CREATE TRIGGER ordinary_reply_no_delete BEFORE DELETE ON ordinary_reply_admissions
BEGIN SELECT RAISE(ABORT, 'ordinary reply history is retained'); END;

-- Route containment also applies to canaries compiled before this migration.
CREATE TRIGGER relay_attempts_route_quarantine BEFORE INSERT ON relay_attempts
WHEN EXISTS (SELECT 1 FROM reply_relays rr JOIN active_route_reply_quarantines q ON q.route_id = rr.route_id
  WHERE rr.id = NEW.relay_id)
BEGIN SELECT RAISE(ABORT, 'reply route is quarantined'); END;

DROP VIEW reply_admissions_all;
CREATE VIEW reply_admissions_all AS SELECT
  'canary' AS admission_kind, NULL AS activation_id, id, schema_version,
  transaction_sha256, relay_id, thread_id, route_id, policy_sha256,
  desired_state_sha256, operator_set_sha256, admitted_operator_ref,
  public_identity, sender_domain, identity_profile_ref, identity_profile_sha256,
  display_name, signature_profile_ref, signature_sha256, sender_adapter,
  admitted_at, expires_at, status, claimed_attempt_id, claimed_attempt_sha256,
  claimed_payload_sha256, claimed_at, provider_boundary_at, terminal_at, revoked_at, error_code
FROM reply_admissions
UNION ALL SELECT admission_kind, activation_id, id, schema_version,
  transaction_sha256, relay_id, thread_id, route_id, policy_sha256,
  desired_state_sha256, operator_set_sha256, admitted_operator_ref,
  public_identity, sender_domain, identity_profile_ref, identity_profile_sha256,
  display_name, signature_profile_ref, signature_sha256, sender_adapter,
  admitted_at, expires_at, status, claimed_attempt_id, claimed_attempt_sha256,
  claimed_payload_sha256, claimed_at, provider_boundary_at, terminal_at, revoked_at, error_code
FROM ordinary_reply_admissions;
