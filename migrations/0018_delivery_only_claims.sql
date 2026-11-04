-- Delivery-only ingress retains the same no-replay boundary as operator mail,
-- but never creates or references a reply relay. Payloads remain in the bounded
-- relay spool until their corresponding provider outcome is durably recorded.
CREATE TABLE delivery_only_deliveries (
  id TEXT PRIMARY KEY,
  fingerprint_sha256 TEXT NOT NULL UNIQUE CHECK (length(fingerprint_sha256) = 64),
  route_id TEXT NOT NULL REFERENCES alias_routes(id) ON DELETE RESTRICT,
  policy_sha256 TEXT NOT NULL CHECK (length(policy_sha256) = 64),
  raw_r2_key TEXT,
  recipient_count INTEGER NOT NULL CHECK (recipient_count > 0),
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'provider_accepted', 'partial_delivery', 'recovery_required', 'failed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX delivery_only_deliveries_status_idx
ON delivery_only_deliveries(status, updated_at);

CREATE TABLE delivery_only_recipient_deliveries (
  delivery_id TEXT NOT NULL REFERENCES delivery_only_deliveries(id) ON DELETE CASCADE,
  recipient_ref TEXT NOT NULL CHECK (length(recipient_ref) = 64),
  delivery_message_id TEXT NOT NULL,
  delivery_payload_r2_key TEXT NOT NULL,
  delivery_payload_sha256 TEXT NOT NULL CHECK (length(delivery_payload_sha256) = 64),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'provider_accepted', 'recovery_required', 'failed')),
  provider_message_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (delivery_id, recipient_ref)
);

CREATE INDEX delivery_only_recipient_deliveries_status_idx
ON delivery_only_recipient_deliveries(status, updated_at);

-- A boundary attempt can be reconciled, but cannot become an automatic resend.
CREATE TRIGGER delivery_only_recipient_no_reopen
BEFORE UPDATE OF status ON delivery_only_recipient_deliveries
WHEN NEW.status != OLD.status AND NOT (
  (OLD.status = 'pending' AND NEW.status = 'sending') OR
  (OLD.status = 'sending' AND NEW.status IN ('provider_accepted', 'recovery_required', 'failed')) OR
  (OLD.status = 'recovery_required' AND NEW.status IN ('provider_accepted', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'delivery-only provider outcome cannot be reopened');
END;

CREATE TRIGGER delivery_only_recipient_no_delete_after_attempt
BEFORE DELETE ON delivery_only_recipient_deliveries
WHEN OLD.status != 'pending' OR EXISTS (
  SELECT 1 FROM delivery_only_recipient_deliveries sibling
  WHERE sibling.delivery_id = OLD.delivery_id AND sibling.status != 'pending'
)
BEGIN
  SELECT RAISE(ABORT, 'delivery-only provider attempt must be retained');
END;

CREATE TRIGGER delivery_only_delivery_identity_immutable
BEFORE UPDATE OF id, fingerprint_sha256, route_id, policy_sha256, recipient_count ON delivery_only_deliveries
BEGIN
  SELECT RAISE(ABORT, 'delivery-only delivery identity is immutable');
END;

CREATE TRIGGER delivery_only_recipient_identity_immutable
BEFORE UPDATE OF delivery_id, recipient_ref, delivery_message_id, delivery_payload_r2_key, delivery_payload_sha256
ON delivery_only_recipient_deliveries
BEGIN
  SELECT RAISE(ABORT, 'delivery-only recipient identity is immutable');
END;

-- Both ingress modes share the same fingerprint namespace. This also makes
-- an older Worker fail closed after migration if a delivery-only claim exists.
CREATE TRIGGER delivery_only_fingerprint_excludes_inbound
BEFORE INSERT ON delivery_only_deliveries
WHEN EXISTS (SELECT 1 FROM inbound_deliveries WHERE fingerprint_sha256 = NEW.fingerprint_sha256)
BEGIN
  SELECT RAISE(ABORT, 'fingerprint already belongs to inbound delivery');
END;

CREATE TRIGGER inbound_fingerprint_excludes_delivery_only
BEFORE INSERT ON inbound_deliveries
WHEN EXISTS (SELECT 1 FROM delivery_only_deliveries WHERE fingerprint_sha256 = NEW.fingerprint_sha256)
BEGIN
  SELECT RAISE(ABORT, 'fingerprint already belongs to delivery-only delivery');
END;

CREATE TRIGGER inbound_fingerprint_update_excludes_delivery_only
BEFORE UPDATE OF fingerprint_sha256 ON inbound_deliveries
WHEN EXISTS (SELECT 1 FROM delivery_only_deliveries WHERE fingerprint_sha256 = NEW.fingerprint_sha256)
BEGIN
  SELECT RAISE(ABORT, 'fingerprint already belongs to delivery-only delivery');
END;

-- Freeze the complete recipient set before any provider boundary is crossed.
CREATE TRIGGER delivery_only_recipient_set_bounded
BEFORE INSERT ON delivery_only_recipient_deliveries
WHEN (SELECT COUNT(*) FROM delivery_only_recipient_deliveries WHERE delivery_id = NEW.delivery_id) >=
     (SELECT recipient_count FROM delivery_only_deliveries WHERE id = NEW.delivery_id)
  OR EXISTS (SELECT 1 FROM delivery_only_recipient_deliveries WHERE delivery_id = NEW.delivery_id AND status != 'pending')
BEGIN
  SELECT RAISE(ABORT, 'delivery-only recipient set is complete or attempted');
END;

-- Invalidate cached status whenever delivery-only evidence changes.
CREATE TRIGGER delivery_only_status_after_insert AFTER INSERT ON delivery_only_deliveries
BEGIN UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = NEW.route_id; END;
CREATE TRIGGER delivery_only_status_after_update AFTER UPDATE ON delivery_only_deliveries
BEGIN UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = NEW.route_id; END;
CREATE TRIGGER delivery_only_status_after_delete AFTER DELETE ON delivery_only_deliveries
BEGIN UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = OLD.route_id; END;
CREATE TRIGGER delivery_only_recipient_status_after_insert AFTER INSERT ON delivery_only_recipient_deliveries
BEGIN UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = (SELECT route_id FROM delivery_only_deliveries WHERE id = NEW.delivery_id); END;
CREATE TRIGGER delivery_only_recipient_status_after_update AFTER UPDATE ON delivery_only_recipient_deliveries
BEGIN UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = (SELECT route_id FROM delivery_only_deliveries WHERE id = NEW.delivery_id); END;
CREATE TRIGGER delivery_only_recipient_status_after_delete AFTER DELETE ON delivery_only_recipient_deliveries
BEGIN UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = (SELECT route_id FROM delivery_only_deliveries WHERE id = OLD.delivery_id); END;

-- A web-desk provider attempt is claimed under an exact active policy before
-- crossing the send boundary. The record is retained even for unknown outcomes.
CREATE TABLE webdesk_provider_claims (
  message_id TEXT PRIMARY KEY,
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  policy_sha256 TEXT NOT NULL CHECK (length(policy_sha256) = 64),
  provider TEXT NOT NULL CHECK (provider IN ('cloudflare_email_service', 'resend')),
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
  route_id TEXT NOT NULL REFERENCES alias_routes(id) ON DELETE RESTRICT,
  claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER webdesk_provider_claim_no_delete BEFORE DELETE ON webdesk_provider_claims
BEGIN SELECT RAISE(ABORT, 'web-desk provider claim must be retained'); END;
CREATE TRIGGER webdesk_provider_claim_identity_immutable
BEFORE UPDATE OF message_id, request_sha256, policy_sha256, provider, thread_id, route_id, claimed_at ON webdesk_provider_claims
BEGIN SELECT RAISE(ABORT, 'web-desk provider claim is immutable'); END;

CREATE TRIGGER delivery_only_raw_spool_update_guard
BEFORE UPDATE OF raw_r2_key ON delivery_only_deliveries
WHEN OLD.raw_r2_key IS NOT NEW.raw_r2_key AND NOT (
  OLD.raw_r2_key IS NOT NULL AND NEW.raw_r2_key IS NULL AND OLD.status = 'provider_accepted'
  AND (SELECT COUNT(*) FROM delivery_only_recipient_deliveries WHERE delivery_id = OLD.id) = OLD.recipient_count
  AND NOT EXISTS (SELECT 1 FROM delivery_only_recipient_deliveries WHERE delivery_id = OLD.id AND status != 'provider_accepted')
)
BEGIN SELECT RAISE(ABORT, 'delivery-only spool cleanup is not authorized'); END;

-- A durable cursor lets bounded recovery sweeps rotate past held deliveries.
CREATE TABLE delivery_only_recovery_cursor (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  after_fingerprint TEXT NOT NULL DEFAULT ''
);
INSERT INTO delivery_only_recovery_cursor(singleton, after_fingerprint) VALUES (1, '');
