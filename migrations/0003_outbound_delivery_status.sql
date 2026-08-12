ALTER TABLE messages
ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'received'
CHECK (delivery_status IN ('received', 'queued', 'delivered', 'failed', 'recovery_required'));

CREATE INDEX IF NOT EXISTS messages_thread_delivery_status_idx
ON messages(thread_id, delivery_status, created_at);

CREATE INDEX IF NOT EXISTS messages_header_message_id_idx
ON messages(header_message_id)
WHERE header_message_id IS NOT NULL;
