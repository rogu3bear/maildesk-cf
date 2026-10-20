import { closedObject, digestCanonical } from "./operation-context";
import { preparePluginInventory } from "./plugin-inventory-contract";

// Metadata only: no table contents, authority values or caller-supplied SQL.
export const SCHEMA_OBJECTS_SQL = `SELECT type, name, tbl_name, sql FROM sqlite_master
  WHERE type IN ('table', 'view', 'index', 'trigger') AND name NOT GLOB 'sqlite_*'
  ORDER BY type, name LIMIT 501`;
const roles = ["relay_router", "relay_outbound", "routing_health"] as const;

/** Dependent read preparation after deployment IDs have actually been observed.
 * Version content must be obtained losslessly in the private executor, never
 * inferred from an ETag, annotation, reconstructed text or truncated tool output.
 */
export function preparePluginRuntimeInventory(input: unknown, now = Date.now()) {
  const row = closedObject(input, ["inventory", "versions", "deployment_receipt_sha256"], "runtime inventory");
  const base = preparePluginInventory(row.inventory, now, ["schema_columns"]);
  const versions = closedObject(row.versions, roles, "observed Worker versions");
  const inventory = row.inventory as { workers: Record<string, string> };
  const requests = roles.flatMap((role) => {
    const version = versions[role];
    if (typeof version !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(version)) throw new Error("invalid observed version selector");
    const script = inventory.workers[role];
    const prefix = `/accounts/${base.context.account_id}/workers/scripts/${script}`;
    return [
      { kind: "worker_version_detail", role, script_name: script, version_id: version,
        method: "GET", path: `${prefix}/versions/${version}`, max_response_bytes: 262144,
        output: "filtered_runtime_bindings_and_handler_metadata" },
      { kind: "worker_version_content", role, script_name: script, version_id: version,
        method: "GET", path: `${prefix}/content/v2`, query: { version },
        max_response_bytes: 16777216, max_modules: 128,
        output: "lossless_private_binary_and_module_sha256_only" },
    ];
  });
  const proposal = { schema_version: 1, kind: "maildesk_plugin_runtime_inventory",
    performed: false, execution_supported: false, informational_only: true,
    qualifies_release: false, qualifies_mail: false, context: base.context,
    deployment_receipt_sha256: requireDigest(row.deployment_receipt_sha256),
    requests, private_capture: { directory_mode: "0700", file_mode: "0600",
      print_raw_content: false, print_binding_values: false, include_source_maps: false,
      on_lossy_or_unsupported_binary: "stop_without_content_identity_claim" } };
  return { ...proposal, proposal_sha256: digestCanonical(proposal) };
}

/** Independently scoped schema reconciliation. SQL is kept only in private
 * captures because even schema defaults may contain deployment-specific text.
 */
export function preparePluginSchemaInventory(input: unknown, now = Date.now()) {
  const base = preparePluginInventory(input, now, ["schema_columns"]);
  const proposal = { schema_version: 1, kind: "maildesk_plugin_schema_inventory",
    performed: false, execution_supported: false, informational_only: true,
    qualifies_release: false, qualifies_mail: false, context: base.context,
    requests: [{ kind: "schema_objects", database_id: base.context.database_id,
      sql: SCHEMA_OBJECTS_SQL, params: [], max_rows: 500, max_response_bytes: 524288 }],
    private_capture: { directory_mode: "0700", file_mode: "0600", print_raw_sql: false } };
  return { ...proposal, proposal_sha256: digestCanonical(proposal) };
}

/** Distinct JSON-module digest method, after the exact portable projection has
 * passed synthetic checks in the actual plugin runtime. No raw content output.
 */
export function preparePluginModuleInventory(input: unknown, now = Date.now()) {
  const row = closedObject(input, ["runtime", "runtime_qualification_sha256", "projection_source_sha256"], "module inventory");
  const base = preparePluginRuntimeInventory(row.runtime, now);
  const requests = base.requests.filter((request) => request.kind === "worker_version_detail").map((request) => ({
    kind: "worker_version_module_digests", role: request.role, script_name: request.script_name,
    version_id: request.version_id, method: "GET",
    path: `/accounts/${base.context.account_id}/workers/workers/${request.script_name}/versions/${request.version_id}`,
    query: { include: "modules" }, max_modules: 128, max_decoded_bytes: 16777216,
    max_normalized_response_bytes: 33554432, bound_kind: "post_normalization_validation",
    output: "complete_decoded_module_digest_manifest_only" }));
  const proposal = { schema_version: 1, kind: "maildesk_plugin_module_digest_inventory",
    performed: false, execution_supported: false, informational_only: true,
    qualifies_release: false, qualifies_mail: false, context: base.context,
    deployment_receipt_sha256: base.deployment_receipt_sha256,
    runtime_qualification_sha256: requireDigest(row.runtime_qualification_sha256),
    projection_source_sha256: requireDigest(row.projection_source_sha256), requests };
  return { ...proposal, proposal_sha256: digestCanonical(proposal) };
}

function requireDigest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error("deployment receipt digest missing");
  return value;
}
