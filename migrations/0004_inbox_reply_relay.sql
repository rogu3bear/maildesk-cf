ALTER TABLE alias_routes
ADD COLUMN decision_kind TEXT NOT NULL DEFAULT 'role_alias'
CHECK (decision_kind IN ('role_alias', 'personal_alias', 'catch_all', 'sink'));

CREATE TABLE messages_relay_migration (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  envelope_from TEXT,
  envelope_to TEXT NOT NULL,
  header_message_id TEXT,
  in_reply_to TEXT,
  raw_r2_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivery_status TEXT NOT NULL DEFAULT 'received'
    CHECK (delivery_status IN ('received', 'queued', 'delivered', 'failed', 'recovery_required')),
  retention_class TEXT NOT NULL DEFAULT 'none'
    CHECK (retention_class IN ('none', 'relay_spool', 'archive'))
);

INSERT INTO messages_relay_migration (
  id,
  thread_id,
  direction,
  envelope_from,
  envelope_to,
  header_message_id,
  in_reply_to,
  raw_r2_key,
  created_at,
  delivery_status,
  retention_class
)
SELECT
  id,
  thread_id,
  direction,
  envelope_from,
  envelope_to,
  header_message_id,
  in_reply_to,
  raw_r2_key,
  created_at,
  delivery_status,
  CASE WHEN raw_r2_key IS NULL OR raw_r2_key = '' THEN 'none' ELSE 'archive' END
FROM messages;

DROP TABLE messages;
ALTER TABLE messages_relay_migration RENAME TO messages;

CREATE INDEX idx_messages_thread_created ON messages(thread_id, created_at);
CREATE INDEX messages_thread_delivery_status_idx
ON messages(thread_id, delivery_status, created_at);
CREATE INDEX messages_header_message_id_idx
ON messages(header_message_id)
WHERE header_message_id IS NOT NULL;

CREATE TABLE reply_relays (
  id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL REFERENCES alias_routes(id) ON DELETE CASCADE,
  external_recipient TEXT NOT NULL,
  reply_identity TEXT NOT NULL,
  original_message_id TEXT,
  references_json TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX reply_relays_route_expiry_idx
ON reply_relays(route_id, expires_at)
WHERE revoked_at IS NULL;

CREATE TABLE relay_attempts (
  id TEXT PRIMARY KEY,
  relay_id TEXT NOT NULL REFERENCES reply_relays(id) ON DELETE CASCADE,
  operator TEXT NOT NULL,
  operator_message_id TEXT NOT NULL,
  raw_r2_key TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('receiving', 'queued', 'authorized', 'provider_accepted', 'failed', 'recovery_required')),
  provider_message_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(relay_id, operator_message_id)
);

CREATE INDEX relay_attempts_status_idx
ON relay_attempts(status, updated_at);

CREATE TABLE route_health (
  route_id TEXT PRIMARY KEY REFERENCES alias_routes(id) ON DELETE CASCADE,
  route_address TEXT NOT NULL,
  decision_kind TEXT NOT NULL
    CHECK (decision_kind IN ('role_alias', 'personal_alias', 'catch_all', 'sink')),
  desired_provider TEXT NOT NULL
    CHECK (desired_provider IN ('cloudflare_email_routing', 'google_workspace', 'external', 'excluded')),
  observed_provider TEXT,
  operator_count INTEGER NOT NULL DEFAULT 0 CHECK (operator_count >= 0),
  reply_identity TEXT NOT NULL,
  inbound_status TEXT NOT NULL DEFAULT 'declared'
    CHECK (inbound_status IN ('declared', 'local_policy_valid', 'edge_verified', 'provider_accepted', 'inbox_verified', 'reply_verified', 'partial_delivery', 'recovery_required', 'failed', 'intentionally_excluded')),
  reply_status TEXT NOT NULL DEFAULT 'declared'
    CHECK (reply_status IN ('declared', 'local_policy_valid', 'edge_verified', 'provider_accepted', 'inbox_verified', 'reply_verified', 'partial_delivery', 'recovery_required', 'failed', 'intentionally_excluded')),
  last_inbound_at TEXT,
  last_reply_at TEXT,
  last_error_code TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX route_health_status_idx
ON route_health(inbound_status, reply_status, updated_at);
