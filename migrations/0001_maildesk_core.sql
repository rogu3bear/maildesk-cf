CREATE TABLE domains (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  address TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('role', 'personal')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE operators (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE alias_routes (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  local_part TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('role', 'personal')),
  default_reply_identity_id TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(domain_id, local_part)
);

CREATE TABLE alias_route_operators (
  route_id TEXT NOT NULL REFERENCES alias_routes(id) ON DELETE CASCADE,
  operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  PRIMARY KEY(route_id, operator_id)
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id),
  route_id TEXT NOT NULL REFERENCES alias_routes(id),
  external_sender TEXT NOT NULL,
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  envelope_from TEXT,
  envelope_to TEXT NOT NULL,
  header_message_id TEXT,
  in_reply_to TEXT,
  raw_r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_threads_domain_status ON threads(domain_id, status);
CREATE INDEX idx_messages_thread_created ON messages(thread_id, created_at);
