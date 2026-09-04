/** Decode only the compiler-owned body-free projection; no receipt proof is inferred. */
const digest = (value: unknown): string | null => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value) ? value.slice(7) : null;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const key = (value: unknown): value is string => typeof value === "string" && /^config\/policy\/[a-f0-9]{64}\.json$/.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export const APPROVED_RELAY_TABLES = ["alias_routes", "audit_events", "domains", "inbound_deliveries", "inbound_recipient_deliveries", "policy_projection_state", "policy_revisions", "relay_attempts", "route_health", "runtime_state"] as const;

export const APPROVED_AUDIT_EVENTS = ["inbound_email_accepted", "operator_delivery_provider_accepted", "inbox_reply_authorized", "outbound_reply_delivered", "outbound_reply_retry_scheduled", "outbound_reply_recovery_required", "outbound_reply_failed"] as const;

export function decodeD1Evidence(value: unknown, databaseId: string) {
  if (!record(value) || value.adapter !== "workspace_d1_evidence_v1" || value.success !== true ||
      value.database_id !== databaseId || value.body_returned !== false || value.provider_output_retained !== false || !record(value.evidence)) return null;
  const e = value.evidence;
  if (e.schema_version !== 1 || e.body_returned !== false || !key(e.immutable_policy_object_key) || !key(e.revision_r2_key) ||
      !record(e.approved_table_presence) || !record(e.audit_event_counts) || typeof e.approved_schema_present !== "boolean") return null;
  const tablePresence = e.approved_table_presence, auditCounts = e.audit_event_counts;
  const active = digest(e.active_policy_digest), projected = digest(e.projection_policy_sha256), desired = digest(e.desired_state_digest), semantic = digest(e.semantic_projection_digest);
  if (!active || !projected || !desired || !semantic) return null;
  for (const name of ["expected_domain_count", "projected_domain_count", "expected_route_count", "projected_route_count"]) if (!count(e[name])) return null;
  if (Object.keys(tablePresence).length !== APPROVED_RELAY_TABLES.length || APPROVED_RELAY_TABLES.some(name => typeof tablePresence[name] !== "boolean")) return null;
  if (e.approved_schema_present !== APPROVED_RELAY_TABLES.every(name => tablePresence[name] === true)) return null;
  if (Object.keys(auditCounts).length !== APPROVED_AUDIT_EVENTS.length || APPROVED_AUDIT_EVENTS.some(name => !count(auditCounts[name]))) return null;
  return {
    active_policy: {
      active_policy_sha256: active, active_policy_r2_key: e.immutable_policy_object_key, revision_r2_key: e.revision_r2_key,
      projection_policy_sha256: projected, active_desired_state_sha256: desired, active_projection_sha256: semantic,
      expected_domain_count: e.expected_domain_count as number, projected_domain_count: e.projected_domain_count as number,
      expected_route_count: e.expected_route_count as number, projected_route_count: e.projected_route_count as number,
    },
    d1: { tables: APPROVED_RELAY_TABLES.filter(name => tablePresence[name]), audit_event_counts: auditCounts as Record<string, number> },
  };
}

export function decodePolicyObjectDigest(value: unknown, account: string, bucket: string, objectKey: string): string | null {
  if (!record(value) || value.success !== true || !record(value.result)) return null;
  const e = value.result;
  if (e.schema_version !== 1 || e.account_id !== account || e.bucket_name !== bucket || e.object_key !== objectKey ||
      e.body_returned !== false || !count(e.byte_count) || typeof e.etag !== "string" || !e.etag) return null;
  return digest(e.sha256);
}
