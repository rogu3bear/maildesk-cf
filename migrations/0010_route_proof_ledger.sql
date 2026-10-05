CREATE TABLE route_proof_ledger (
  route_id TEXT NOT NULL REFERENCES alias_routes(id) ON DELETE CASCADE,
  plane TEXT NOT NULL CHECK (plane IN ('configuration', 'inbox', 'reply', 'edge')),
  policy_sha256 TEXT NOT NULL REFERENCES policy_revisions(policy_sha256),
  verified_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (route_id, plane)
);

CREATE INDEX route_proof_ledger_configuration_idx
ON route_proof_ledger(plane, updated_at_ms);

CREATE TABLE mail_canary_probe_rotation (
  route_id TEXT PRIMARY KEY REFERENCES alias_routes(id) ON DELETE CASCADE,
  selected_at_ms INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('never_proven', 'oldest_proof'))
);
