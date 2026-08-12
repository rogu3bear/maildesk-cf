ALTER TABLE route_health
ADD COLUMN last_inbound_provider_accepted_at TEXT;

ALTER TABLE route_health
ADD COLUMN last_inbox_verified_at TEXT;

ALTER TABLE route_health
ADD COLUMN last_reply_provider_accepted_at TEXT;

ALTER TABLE route_health
ADD COLUMN last_reply_verified_at TEXT;
