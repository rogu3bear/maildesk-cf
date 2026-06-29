-- Idempotent audit events: dedupe at-least-once queue redeliveries.
--
-- recordAuditEvent() writes a dedupe_key derived from the job's stable id
-- (inbound deliveryId / outbound messageId) plus the action, and uses
-- INSERT OR IGNORE. A redelivered job re-inserts the same dedupe_key and is
-- dropped. The unique index is PARTIAL (only non-null keys) so pre-existing
-- rows and any ad-hoc events with a null dedupe_key remain unconstrained.
ALTER TABLE audit_events ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX idx_audit_events_dedupe ON audit_events(dedupe_key) WHERE dedupe_key IS NOT NULL;
