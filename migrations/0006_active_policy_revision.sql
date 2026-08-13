CREATE TABLE policy_revisions (
  policy_sha256 TEXT PRIMARY KEY CHECK (length(policy_sha256) = 64),
  r2_object_key TEXT NOT NULL UNIQUE,
  expected_domain_count INTEGER NOT NULL CHECK (expected_domain_count >= 0),
  expected_route_count INTEGER NOT NULL CHECK (expected_route_count >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activated_at TEXT,
  superseded_at TEXT
);

CREATE TABLE runtime_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_policy_sha256 TEXT NOT NULL REFERENCES policy_revisions(policy_sha256),
  active_policy_r2_key TEXT NOT NULL,
  activated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE alias_routes
ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1));

ALTER TABLE alias_routes
ADD COLUMN policy_sha256 TEXT REFERENCES policy_revisions(policy_sha256);

ALTER TABLE route_health
ADD COLUMN policy_sha256 TEXT REFERENCES policy_revisions(policy_sha256);

ALTER TABLE route_health
ADD COLUMN last_inbound_provider_message_ids_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE route_health
ADD COLUMN last_reply_provider_message_id TEXT;

CREATE TABLE route_proofs (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES alias_routes(id) ON DELETE CASCADE,
  policy_sha256 TEXT NOT NULL REFERENCES policy_revisions(policy_sha256),
  proof_kind TEXT NOT NULL CHECK (
    proof_kind IN (
      'edge_verified',
      'provider_accepted',
      'inbox_verified',
      'reply_verified',
      'intentionally_excluded'
    )
  ),
  provider_message_id TEXT,
  worker_version TEXT,
  evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256) = 64),
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(route_id, proof_kind, evidence_sha256)
);

CREATE TABLE route_proof_coverage (
  route_id TEXT PRIMARY KEY REFERENCES alias_routes(id) ON DELETE CASCADE,
  representative_route_id TEXT NOT NULL REFERENCES alias_routes(id) ON DELETE CASCADE,
  representative_proof_id TEXT NOT NULL REFERENCES route_proofs(id) ON DELETE CASCADE,
  policy_sha256 TEXT NOT NULL REFERENCES policy_revisions(policy_sha256),
  topology_sha256 TEXT NOT NULL CHECK (length(topology_sha256) = 64),
  approved_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (route_id <> representative_route_id)
);

CREATE INDEX alias_routes_active_policy_idx
ON alias_routes(enabled, policy_sha256, domain_id, local_part);

CREATE INDEX route_proofs_route_kind_idx
ON route_proofs(route_id, proof_kind, verified_at);

CREATE INDEX route_proof_coverage_representative_idx
ON route_proof_coverage(representative_route_id, representative_proof_id);
