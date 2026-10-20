import { admitGitCandidateBinding } from "./git-candidate";
import { closedObject, digest, digestCanonical, instant, reference } from "./operation-context";

const metadataTables = ["d1_migrations", "runtime_state", "policy_revisions", "policy_projection_state",
  "alias_routes", "route_health", "reply_relays", "inbound_deliveries", "reply_admissions",
  "relay_attempts", "ordinary_reply_admissions", "route_reply_authorizations",
  "route_reply_containment_events", "route_status_projection", "policy_change_reviews"];
// These selectors inspect schema metadata, never mail rows or authority values.
export const SCHEMA_COLUMNS_SQL = `SELECT m.name AS table_name, p.name AS column_name,
  p.type AS column_type, p.[notnull] AS not_null, p.pk AS primary_key
  FROM sqlite_master m JOIN pragma_table_info(m.name) p
  WHERE m.type = 'table' AND m.name IN ('d1_migrations', 'runtime_state',
    'policy_revisions', 'policy_projection_state', 'alias_routes', 'route_health',
    'reply_relays', 'inbound_deliveries', 'reply_admissions', 'relay_attempts',
    'ordinary_reply_admissions', 'route_reply_authorizations',
    'route_reply_containment_events', 'route_status_projection', 'policy_change_reviews')
  ORDER BY m.name, p.cid LIMIT 1001`;
export const MIGRATION_NAMES_SQL = "SELECT name FROM d1_migrations ORDER BY id LIMIT 101";
const roles = ["relay_router", "relay_outbound", "routing_health"] as const;
type InventoryKind = "schema_columns" | "migration_names" | "worker_deployments";
const metadataTypes = ["TEXT", "INTEGER", "REAL", "BLOB", "NUMERIC", "TIMESTAMP", ""];

/** A non-advancing informational lane. Dirty source is explicit and allowed;
 * it can never be used as protected-operation or mail admission evidence.
 */
export function preparePluginInventory(input: unknown, now = Date.now(), selectedKinds: InventoryKind[] = ["schema_columns", "migration_names", "worker_deployments"]) {
  const row = closedObject(input, ["schema_version", "candidate", "candidate_sha256", "source_snapshot_sha256",
    "target_manifest_sha256", "connector_subject", "account_id", "database_id", "workers"], "plugin inventory input");
  if (row.schema_version !== 1 || typeof row.account_id !== "string" || !/^[a-f0-9]{32}$/.test(row.account_id) ||
      typeof row.database_id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.database_id) ||
      typeof row.connector_subject !== "string" || !/^(user|account):[a-f0-9]{32}$/.test(row.connector_subject) || !Number.isFinite(now)) {
    throw new Error("plugin inventory identity is invalid");
  }
  const candidate = admitGitCandidateBinding(row.candidate, row.candidate_sha256);
  const workers = closedObject(row.workers, roles, "inventory Workers");
  const names = roles.map((role) => {
    const name = reference(workers[role], "Worker name");
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error("invalid Worker selector");
    return name;
  });
  if (new Set(names).size !== roles.length) throw new Error("duplicate Worker selectors");
  if (selectedKinds.length === 0 || new Set(selectedKinds).size !== selectedKinds.length ||
      selectedKinds.some((kind) => !["schema_columns", "migration_names", "worker_deployments"].includes(kind))) throw new Error("invalid informational read selection");
  const context = { ...candidate,
    source_snapshot_sha256: digest(row.source_snapshot_sha256, "source snapshot"),
    target_manifest_sha256: digest(row.target_manifest_sha256, "target manifest"),
    transport: "cloudflare_mcp_v1" as const, connector_subject: row.connector_subject,
    account_id: row.account_id, database_id: row.database_id,
    prepared_at: new Date(now).toISOString(), expires_at: new Date(now + 600_000).toISOString() };
  const requests = [
    { kind: "schema_columns", database_id: row.database_id, sql: SCHEMA_COLUMNS_SQL, params: [],
      max_rows: 1000, max_response_bytes: 262144 },
    { kind: "migration_names", database_id: row.database_id, sql: MIGRATION_NAMES_SQL, params: [],
      max_rows: 100, max_response_bytes: 32768 },
    ...roles.map((role, i) => ({ kind: "worker_deployments", role, script_name: names[i],
      max_response_bytes: 131072, max_deployments: 10 })),
  ];
  const proposal = { schema_version: 1, kind: "maildesk_plugin_informational_inventory",
    performed: false, execution_supported: false, informational_only: true,
    qualifies_release: false, qualifies_mail: false, context,
    requests: requests.filter((request) => selectedKinds.includes(request.kind as InventoryKind)) };
  return { ...proposal, proposal_sha256: digestCanonical(proposal) };
}

/** Project only the expected metadata cells. Missing, denied, oversized and
 * malformed responses throw; no empty-success fallback or raw output escape.
 */
export function projectPluginMetadata(kind: "schema_columns" | "migration_names", input: unknown) {
  const limit = kind === "schema_columns" ? 1000 : 100;
  if (!Array.isArray(input) || input.length > limit) rejectMetadata(kind, "response_shape_or_limit", input, null);
  const rows = input.map((value, index) => {
    if (kind === "migration_names") {
      let row: Record<string, unknown>;
      try { row = closedObject(value, ["name"], "migration metadata"); }
      catch { return rejectMetadata(kind, "unexpected_fields", value, index); }
      if (typeof row.name !== "string" || !/^[a-zA-Z0-9_.-]{1,160}$/.test(row.name)) return rejectMetadata(kind, "migration_name", value, index);
      return { name: row.name };
    }
    let row: Record<string, unknown>;
    try { row = closedObject(value, ["table_name", "column_name", "column_type", "not_null", "primary_key"], "column metadata"); }
    catch { return rejectMetadata(kind, "unexpected_fields", value, index); }
    if (!metadataTables.includes(String(row.table_name))) return rejectMetadata(kind, "unexpected_table", value, index);
    for (const field of ["table_name", "column_name"] as const) {
      if (typeof row[field] !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]{0,79}$/.test(row[field])) return rejectMetadata(kind, "column_identity", value, index);
    }
    if (typeof row.column_type !== "string" || !metadataTypes.includes(row.column_type.toUpperCase())) return rejectMetadata(kind, "column_type", value, index);
    if (typeof row.not_null !== "number" || ![0, 1].includes(row.not_null)) return rejectMetadata(kind, "not_null", value, index);
    if (!Number.isSafeInteger(row.primary_key) || Number(row.primary_key) < 0 || Number(row.primary_key) > 16) return rejectMetadata(kind, "primary_key", value, index);
    return { table_name: row.table_name, column_name: row.column_name, column_type: row.column_type,
      not_null: row.not_null, primary_key: row.primary_key };
  });
  const keys = rows.map((row) => "name" in row ? row.name : `${row.table_name}\0${row.column_name}`);
  if (new Set(keys).size !== keys.length) rejectMetadata(kind, "duplicate_rows", null, null);
  const projected = { kind, rows, informational_only: true, qualifies_release: false, qualifies_mail: false };
  return { ...projected, projection_sha256: digestCanonical(projected) };
}

export class PluginMetadataError extends Error {
  constructor(readonly diagnostic: ReturnType<typeof rejectionDiagnostic>) {
    super(`plugin metadata rejected: ${JSON.stringify(diagnostic)}`);
    this.name = "PluginMetadataError";
  }
}

function rejectionDiagnostic(kind: string, reason: string, value: unknown, index: number | null) {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const fieldCategory = (item: unknown) => item === null ? "null" : Array.isArray(item) ? "array" : typeof item;
  return { kind, reason, row_index: index,
    table_name: metadataTables.includes(String(row.table_name)) ? row.table_name as string : null,
    column_name: typeof row.column_name === "string" && /^[a-zA-Z_][a-zA-Z0-9_]{0,79}$/.test(row.column_name) ? row.column_name : null,
    column_type: typeof row.column_type === "string" && metadataTypes.includes(row.column_type.toUpperCase()) ? row.column_type.toUpperCase() : "other",
    value_categories: Object.fromEntries(["table_name", "column_name", "column_type", "not_null", "primary_key", "name"].map((key) => [key, fieldCategory(row[key])])) };
}

function rejectMetadata(kind: string, reason: string, value: unknown, index: number | null): never {
  throw new PluginMetadataError(rejectionDiagnostic(kind, reason, value, index));
}

export function assertInventoryFreshness(packet: ReturnType<typeof preparePluginInventory>, observedAt: string, now = Date.now()) {
  const observed = instant(observedAt, "metadata observation");
  if (observed < instant(packet.context.prepared_at, "inventory preparation") || observed > now ||
      now >= instant(packet.context.expires_at, "inventory expiry")) throw new Error("plugin informational inventory expired or out of order");
}
