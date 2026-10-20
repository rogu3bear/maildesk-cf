-- A reviewed policy change must still have its reviewed base when its import
-- transaction starts. The review and projection must use one atomic import.
CREATE TABLE policy_change_reviews (
  review_sha256 TEXT PRIMARY KEY CHECK (length(review_sha256) = 64),
  base_policy_sha256 TEXT NOT NULL CHECK (length(base_policy_sha256) = 64),
  base_desired_state_sha256 TEXT NOT NULL CHECK (length(base_desired_state_sha256) = 64),
  candidate_policy_sha256 TEXT NOT NULL CHECK (length(candidate_policy_sha256) = 64),
  candidate_desired_state_sha256 TEXT NOT NULL CHECK (length(candidate_desired_state_sha256) = 64),
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER policy_change_base_guard BEFORE INSERT ON policy_change_reviews
WHEN NOT EXISTS (
  SELECT 1 FROM runtime_state rs JOIN policy_projection_state ds
    ON ds.key = 'active_desired_state_sha256'
  WHERE rs.singleton = 1 AND rs.active_policy_sha256 = NEW.base_policy_sha256
    AND rs.active_policy_r2_key = 'config/policy/' || NEW.base_policy_sha256 || '.json'
    AND ds.value = NEW.base_desired_state_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'policy change base changed; review current state');
END;

CREATE TRIGGER policy_change_review_immutable BEFORE UPDATE ON policy_change_reviews
BEGIN
  SELECT RAISE(ABORT, 'policy change review is immutable');
END;

CREATE TRIGGER policy_change_review_retained BEFORE DELETE ON policy_change_reviews
BEGIN
  SELECT RAISE(ABORT, 'policy change review history must be retained');
END;
