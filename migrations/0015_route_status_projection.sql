-- Derived, body-free read model; this is not historical proof or activation.
ALTER TABLE alias_routes ADD COLUMN status_generation INTEGER NOT NULL DEFAULT 0 CHECK (status_generation >= 0);
CREATE TABLE route_status_projection (
  route_id TEXT PRIMARY KEY REFERENCES alias_routes(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  projection_revision TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
  policy_sha256 TEXT NOT NULL REFERENCES policy_revisions(policy_sha256) ON DELETE RESTRICT,
  observed_at TEXT NOT NULL CHECK (julianday(observed_at) IS NOT NULL),
  valid_until TEXT NOT NULL CHECK (julianday(valid_until) IS NOT NULL AND julianday(valid_until) > julianday(observed_at)),
  projection_json TEXT NOT NULL CHECK (json_valid(projection_json) AND json_type(projection_json) = 'object'),
  CHECK (json_extract(projection_json, '$.schema_version') IS schema_version),
  CHECK (json_extract(projection_json, '$.source_generation') IS source_generation),
  CHECK (json_extract(projection_json, '$.projection_revision') IS projection_revision),
  CHECK (json_extract(projection_json, '$.policy_sha256') IS policy_sha256),
  CHECK (json_extract(projection_json, '$.observed_at') IS observed_at),
  CHECK (json_extract(projection_json, '$.valid_until') IS valid_until)
);

CREATE TRIGGER route_status_health_changed AFTER UPDATE ON route_health BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = NEW.route_id;
  DELETE FROM route_status_projection WHERE route_id = NEW.route_id;
END;
CREATE TRIGGER route_status_route_changed AFTER UPDATE OF domain_id, local_part, kind, enabled, policy_sha256, default_reply_identity_id, decision_kind ON alias_routes BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = NEW.id;
  DELETE FROM route_status_projection WHERE route_id = NEW.id;
END;
CREATE TRIGGER route_status_operator_added AFTER INSERT ON alias_route_operators BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = NEW.route_id;
  DELETE FROM route_status_projection WHERE route_id = NEW.route_id;
END;
CREATE TRIGGER route_status_operator_removed AFTER DELETE ON alias_route_operators BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = OLD.route_id;
  DELETE FROM route_status_projection WHERE route_id = OLD.route_id;
END;
CREATE TRIGGER route_status_operator_changed AFTER UPDATE OF email ON operators BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id IN (SELECT route_id FROM alias_route_operators WHERE operator_id = NEW.id);
  DELETE FROM route_status_projection WHERE route_id IN (SELECT route_id FROM alias_route_operators WHERE operator_id = NEW.id);
END;
CREATE TRIGGER route_status_runtime_changed AFTER UPDATE ON runtime_state BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1;
  DELETE FROM route_status_projection;
END;
CREATE TRIGGER route_status_binding_changed AFTER UPDATE ON policy_projection_state BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1;
  DELETE FROM route_status_projection;
END;
CREATE TRIGGER route_status_authority_added AFTER INSERT ON route_reply_authorizations BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = NEW.route_id;
  DELETE FROM route_status_projection WHERE route_id = NEW.route_id;
END;
CREATE TRIGGER route_status_authority_changed AFTER UPDATE ON route_reply_authorizations BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = NEW.route_id;
  DELETE FROM route_status_projection WHERE route_id = NEW.route_id;
END;
CREATE TRIGGER route_status_containment_changed AFTER INSERT ON route_reply_containment_events BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = NEW.route_id;
  DELETE FROM route_status_projection WHERE route_id = NEW.route_id;
END;
CREATE TRIGGER route_status_legacy_containment_changed AFTER INSERT ON route_outbound_quarantines BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = NEW.route_id;
  DELETE FROM route_status_projection WHERE route_id = NEW.route_id;
END;
CREATE TRIGGER route_status_dispatch_added AFTER INSERT ON relay_attempts BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = (SELECT route_id FROM reply_relays WHERE id = NEW.relay_id);
  DELETE FROM route_status_projection WHERE route_id = (SELECT route_id FROM reply_relays WHERE id = NEW.relay_id);
END;
CREATE TRIGGER route_status_dispatch_changed AFTER UPDATE ON relay_attempts BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = (SELECT route_id FROM reply_relays WHERE id = NEW.relay_id);
  DELETE FROM route_status_projection WHERE route_id = (SELECT route_id FROM reply_relays WHERE id = NEW.relay_id);
END;

CREATE TRIGGER route_status_route_proofs_insert AFTER INSERT ON route_proofs BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = NEW.route_id;
  DELETE FROM route_status_projection WHERE route_id = NEW.route_id;
END;

CREATE TRIGGER route_status_route_proofs_update AFTER UPDATE ON route_proofs BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = NEW.route_id;
  DELETE FROM route_status_projection WHERE route_id = NEW.route_id;
END;

CREATE TRIGGER route_status_route_proofs_delete AFTER DELETE ON route_proofs BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = OLD.route_id;
  DELETE FROM route_status_projection WHERE route_id = OLD.route_id;
END;

CREATE TRIGGER route_status_route_health_insert AFTER INSERT ON route_health BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = NEW.route_id;
  DELETE FROM route_status_projection WHERE route_id = NEW.route_id;
END;

CREATE TRIGGER route_status_route_health_delete AFTER DELETE ON route_health BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = OLD.route_id;
  DELETE FROM route_status_projection WHERE route_id = OLD.route_id;
END;

CREATE TRIGGER route_status_reply_admissions_update AFTER UPDATE ON reply_admissions BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = NEW.route_id;
  DELETE FROM route_status_projection WHERE route_id = NEW.route_id;
END;

CREATE TRIGGER route_status_ordinary_reply_admissions_update AFTER UPDATE ON ordinary_reply_admissions BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = NEW.route_id;
  DELETE FROM route_status_projection WHERE route_id = NEW.route_id;
END;

CREATE TRIGGER route_status_binding_insert AFTER INSERT ON policy_projection_state BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1;
  DELETE FROM route_status_projection;
END;

CREATE TRIGGER route_status_binding_delete AFTER DELETE ON policy_projection_state BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1;
  DELETE FROM route_status_projection;
END;

CREATE TRIGGER route_status_relay_changed AFTER UPDATE OF revoked_at, superseded_by_relay_id, expires_at ON reply_relays BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id = NEW.route_id;
  DELETE FROM route_status_projection WHERE route_id = NEW.route_id;
END;

CREATE TRIGGER route_status_runtime_inserted AFTER INSERT ON runtime_state BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1;
  DELETE FROM route_status_projection;
END;
CREATE TRIGGER route_status_runtime_deleted AFTER DELETE ON runtime_state BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1;
  DELETE FROM route_status_projection;
END;

-- Every stored route/profile row participating in Rust inventory parity changes
-- the generation. A cache cannot outlive an equal-count substitution.
CREATE TRIGGER route_status_identity_changed AFTER UPDATE OF address, kind ON identities BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE default_reply_identity_id = NEW.id;
  DELETE FROM route_status_projection WHERE route_id IN (SELECT id FROM alias_routes WHERE default_reply_identity_id = NEW.id);
END;
CREATE TRIGGER route_status_domain_changed AFTER UPDATE OF domain ON domains BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE domain_id = NEW.id;
  DELETE FROM route_status_projection WHERE route_id IN (SELECT id FROM alias_routes WHERE domain_id = NEW.id);
END;
CREATE TRIGGER route_status_operator_membership_changed AFTER UPDATE OF route_id, operator_id ON alias_route_operators BEGIN
  UPDATE alias_routes SET status_generation = status_generation + 1 WHERE id IN (OLD.route_id, NEW.route_id);
  DELETE FROM route_status_projection WHERE route_id IN (OLD.route_id, NEW.route_id);
END;
