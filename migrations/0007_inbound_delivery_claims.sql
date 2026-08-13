CREATE TABLE inbound_deliveries (
  id TEXT PRIMARY KEY,
  fingerprint_sha256 TEXT NOT NULL UNIQUE CHECK (length(fingerprint_sha256) = 64),
  relay_id TEXT NOT NULL UNIQUE REFERENCES reply_relays(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL REFERENCES alias_routes(id) ON DELETE CASCADE,
  policy_sha256 TEXT NOT NULL CHECK (length(policy_sha256) = 64),
  raw_r2_key TEXT,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'provider_accepted', 'partial_delivery', 'recovery_required', 'failed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX inbound_deliveries_status_idx
ON inbound_deliveries(status, updated_at);

CREATE TABLE inbound_recipient_deliveries (
  delivery_id TEXT NOT NULL REFERENCES inbound_deliveries(id) ON DELETE CASCADE,
  operator_ref TEXT NOT NULL CHECK (length(operator_ref) = 64),
  delivery_message_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'provider_accepted', 'recovery_required', 'failed')),
  provider_message_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (delivery_id, operator_ref)
);

CREATE INDEX inbound_recipient_deliveries_status_idx
ON inbound_recipient_deliveries(status, updated_at);
