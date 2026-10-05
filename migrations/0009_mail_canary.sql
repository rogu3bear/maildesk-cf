CREATE TABLE mail_canary_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_report_sha256 TEXT,
  last_notified_at_ms INTEGER NOT NULL DEFAULT 0,
  attempt_id TEXT,
  attempt_state TEXT NOT NULL DEFAULT 'idle'
    CHECK (attempt_state IN ('idle', 'sending', 'uncertain'))
);

INSERT INTO mail_canary_state (singleton) VALUES (1);
