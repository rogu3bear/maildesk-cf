export interface CanonicalDesiredTopology {
  workers: {
    relay_router: DesiredWorker;
    relay_outbound: DesiredWorker;
    routing_health: DesiredWorker;
  };
  storage: {
    d1_database: string;
    d1_preview_database?: string;
    r2_policy_bucket: string;
    r2_spool_bucket: string;
    queue: string;
    dead_letter_queue: string;
  };
}

interface DesiredWorker {
  script_name: string;
  config: string;
}

export function requireCanonicalDesiredTopology(value: unknown): asserts value is CanonicalDesiredTopology {
  const root = object(value, "desired state");
  const workers = object(root.workers, "workers");
  requireExactKeys(workers, ["relay_outbound", "relay_router", "routing_health"], "workers");
  for (const role of ["relay_router", "relay_outbound", "routing_health"] as const) {
    const worker = object(workers[role], `workers.${role}`);
    requireExactKeys(worker, ["config", "script_name"], `workers.${role}`);
    string(worker.script_name, `workers.${role}.script_name`);
    string(worker.config, `workers.${role}.config`);
  }

  const storage = object(root.storage, "storage");
  requireExactKeys(
    storage,
    [
      "d1_database",
      "d1_preview_database",
      "dead_letter_queue",
      "queue",
      "r2_policy_bucket",
      "r2_spool_bucket",
    ],
    "storage",
    ["d1_preview_database"],
  );
  for (const key of [
    "d1_database",
    "r2_policy_bucket",
    "r2_spool_bucket",
    "queue",
    "dead_letter_queue",
  ] as const) {
    string(storage[key], `storage.${key}`);
  }
  if (storage.d1_preview_database !== undefined) {
    string(storage.d1_preview_database, "storage.d1_preview_database");
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
  optional: string[] = [],
): void {
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  const extra = Object.keys(value).filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !optionalSet.has(key) && !(key in value));
  if (extra.length > 0 || missing.length > 0) {
    throw new Error(`${label} must use only the canonical topology keys`);
  }
}
