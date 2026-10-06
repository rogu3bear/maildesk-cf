-- One stamp per completed coverage run. The external heartbeat reads this
-- instead of per-route ledger rows, which now change only with their proofs.
ALTER TABLE mail_canary_state ADD COLUMN last_coverage_at_ms INTEGER NOT NULL DEFAULT 0;
