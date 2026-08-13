ALTER TABLE relay_attempts
ADD COLUMN raw_sha256 TEXT
CHECK (raw_sha256 IS NULL OR length(raw_sha256) = 64);
