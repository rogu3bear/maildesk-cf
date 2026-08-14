import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface DesiredState {
  workers: {
    relay_router: { script_name: string; config: string };
    relay_outbound: { script_name: string; config: string };
    routing_health: { script_name: string; config: string };
  };
  storage: {
    d1_database: string;
    r2_policy_bucket: string;
    r2_spool_bucket: string;
    queue: string;
    dead_letter_queue: string;
  };
  operator_delivery: {
    inbound_processing_mode: string;
    reply_processing_mode: string;
  };
}

const root = resolve(import.meta.dir, "..");
const desiredPath = process.argv[2] ?? "config/desired-state.example.json";
const failures: string[] = [];

const desired = readJson<DesiredState>(desiredPath);
if (desired) {
  checkRouter(desired);
  checkOutbound(desired);
  checkRoutingHealth(desired);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`fail: ${failure}`);
  process.exit(1);
}

console.log("relay topology ok");

function checkRouter(desired: DesiredState): void {
  const path = desired.workers.relay_router.config;
  const config = readConfig(path);
  if (!config) return;
  requireAssignment(config, path, "name", desired.workers.relay_router.script_name);
  requireAssignment(config, path, "main", "workers/mail-router/src/index.ts");
  requireWorkersDevOff(config, path);
  requireBindingTarget(config, path, "d1_databases", "DB", "database_name", desired.storage.d1_database);
  requireBindingTarget(config, path, "r2_buckets", "POLICY_STORE", "bucket_name", desired.storage.r2_policy_bucket);
  requireBindingTarget(config, path, "r2_buckets", "RELAY_SPOOL", "bucket_name", desired.storage.r2_spool_bucket);
  requireBindingTarget(config, path, "queues.producers", "MAIL_JOBS", "queue", desired.storage.queue);
  requireSectionCount(config, path, "d1_databases", 1);
  requireSectionCount(config, path, "r2_buckets", 2);
  requireSectionCount(config, path, "queues.producers", 1);
  requireBinding(config, path, "send_email", "EMAIL");
  requireExactEmailBinding(config, path);
  requireExactTopLevelKeys(config, path, [
    "name", "main", "compatibility_date", "workers_dev", "send_email", "build", "vars",
    "d1_databases", "r2_buckets", "queues",
  ]);
  forbid(config, path, /\[\[queues\.consumers\]\]/, "Queue consumer");
  forbid(config, path, /^routes\s*=/m, "public HTTP route");
  forbid(config, path, /^preview_database_id\s*=/m, "preview D1 binding");
  forbid(config, path, /^MAILDESK_RELAY_PROCESSING_MODE\s*=/m, "legacy relay processing switch");
  requireAssignment(config, path, "MAILDESK_INBOUND_RELAY_MODE", desired.operator_delivery.inbound_processing_mode);
  requireAssignment(config, path, "MAILDESK_REPLY_RELAY_MODE", desired.operator_delivery.reply_processing_mode);
}

function checkOutbound(desired: DesiredState): void {
  const path = desired.workers.relay_outbound.config;
  const config = readConfig(path);
  if (!config) return;
  requireAssignment(config, path, "name", desired.workers.relay_outbound.script_name);
  requireAssignment(config, path, "main", "workers/mail-outbound/src/index.ts");
  requireWorkersDevOff(config, path);
  requireBindingTarget(config, path, "d1_databases", "DB", "database_name", desired.storage.d1_database);
  requireBindingTarget(config, path, "r2_buckets", "POLICY_STORE", "bucket_name", desired.storage.r2_policy_bucket);
  requireBindingTarget(config, path, "r2_buckets", "RELAY_SPOOL", "bucket_name", desired.storage.r2_spool_bucket);
  requireSectionCount(config, path, "d1_databases", 1);
  requireSectionCount(config, path, "r2_buckets", 2);
  requireSectionCount(config, path, "queues.consumers", 1);
  requireBinding(config, path, "send_email", "EMAIL");
  requireExactEmailBinding(config, path);
  requireExactTopLevelKeys(config, path, [
    "name", "main", "compatibility_date", "workers_dev", "upload_source_maps", "send_email",
    "build", "vars", "d1_databases", "r2_buckets", "queues",
  ]);
  requireValue(config, path, "queue", desired.storage.queue);
  requireValue(config, path, "dead_letter_queue", desired.storage.dead_letter_queue);
  requireNumericValue(config, path, "max_batch_size", 1);
  requireNumericValue(config, path, "max_concurrency", 1);
  requireNumericValue(config, path, "max_retries", 5);
  forbid(config, path, /\[\[queues\.producers\]\]/, "Queue producer");
  forbid(config, path, /^routes\s*=/m, "public HTTP route");
  forbid(config, path, /^preview_database_id\s*=/m, "preview D1 binding");
}

function checkRoutingHealth(desired: DesiredState): void {
  const path = desired.workers.routing_health.config;
  const config = readConfig(path);
  if (!config) return;
  requireAssignment(config, path, "name", desired.workers.routing_health.script_name);
  requireAssignment(config, path, "main", "build/_worker.js");
  requireWorkersDevOff(config, path);
  requireBinding(config, path, "d1_databases", "DB");
  requireValue(config, path, "database_name", desired.storage.d1_database);
  if (!/^\[assets\]$/m.test(config)) failures.push(`${path} must bind static assets`);
  requireSectionBoolean(config, path, "assets", "run_worker_first", true);
  forbid(config, path, /\[\[r2_buckets\]\]/, "R2 binding");
  forbid(config, path, /\[\[queues\./, "Queue binding");
  forbid(config, path, /^send_email\s*=/m, "Email binding");
  forbid(config, path, /^preview_database_id\s*=/m, "preview D1 binding");
  requireAssignment(config, path, "MAILDESK_UI_AUTH_MODE", "access");
  requireAssignment(config, path, "MAILDESK_UI_ACCESS_SCOPE", "all_routes");
  requireExactTopLevelKeys(config, path, [
    "name", "main", "compatibility_date", "workers_dev", "upload_source_maps", "build", "assets", "vars", "d1_databases",
  ]);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(resolve(root, path), "utf8")) as T;
  } catch (error) {
    failures.push(`${path} is unreadable or invalid JSON: ${detail(error)}`);
    return null;
  }
}

function readConfig(path: string): string | null {
  try {
    return readFileSync(resolve(root, path), "utf8");
  } catch (error) {
    failures.push(`${path} is unreadable: ${detail(error)}`);
    return null;
  }
}

function requireWorkersDevOff(config: string, path: string): void {
  if (!/^workers_dev\s*=\s*false\s*$/m.test(config)) {
    failures.push(`${path} must set workers_dev = false`);
  }
}

function requireSectionBoolean(
  config: string,
  path: string,
  section: string,
  key: string,
  value: boolean,
): void {
  const block = new RegExp(`^\\[${escapeRegex(section)}\\]$[\\s\\S]*?(?=^\\[|(?![\\s\\S]))`, "m").exec(config)?.[0] ?? "";
  const pattern = new RegExp(`^${escapeRegex(key)}\\s*=\\s*${value}\\s*$`, "m");
  if (!pattern.test(block)) failures.push(`${path} [${section}] must set ${key} = ${value}`);
}

function requireAssignment(config: string, path: string, key: string, value: string): void {
  const pattern = new RegExp(`^${escapeRegex(key)}\\s*=\\s*"${escapeRegex(value)}"\\s*$`, "m");
  if (!pattern.test(config)) failures.push(`${path} must set ${key} = ${value}`);
}

function requireBinding(config: string, path: string, section: string, binding: string): void {
  const sectionPattern = section === "send_email"
    ? /^send_email\s*=\s*\[[\s\S]*?\]\s*$/gm
    : new RegExp(`\\[\\[${escapeRegex(section)}\\]\\][\\s\\S]*?(?=\\n\\[|$)`, "g");
  const block = [...config.matchAll(sectionPattern)].map((match) => match[0]).join("\n");
  const bindingPattern = new RegExp(`\\b(?:binding|name)\\s*=\\s*"${escapeRegex(binding)}"`);
  if (!bindingPattern.test(block)) failures.push(`${path} must bind ${binding} in ${section}`);
}

function requireBindingTarget(
  config: string,
  path: string,
  section: string,
  binding: string,
  targetKey: string,
  target: string,
): void {
  const sectionPattern = new RegExp(`\\[\\[${escapeRegex(section)}\\]\\][\\s\\S]*?(?=\\n\\[|$)`, "g");
  const blocks = [...config.matchAll(sectionPattern)].map((match) => match[0]);
  const bindingPattern = new RegExp(`^binding\\s*=\\s*"${escapeRegex(binding)}"\\s*$`, "m");
  const targetPattern = new RegExp(`^${escapeRegex(targetKey)}\\s*=\\s*"${escapeRegex(target)}"\\s*$`, "m");
  if (!blocks.some((block) => bindingPattern.test(block) && targetPattern.test(block))) {
    failures.push(`${path} must bind ${binding} to ${targetKey} = ${target} in ${section}`);
  }
}

function requireSectionCount(config: string, path: string, section: string, expected: number): void {
  const pattern = new RegExp(`^\\[\\[${escapeRegex(section)}\\]\\]$`, "gm");
  const observed = [...config.matchAll(pattern)].length;
  if (observed !== expected) failures.push(`${path} must contain exactly ${expected} ${section} entries`);
}

function requireExactEmailBinding(config: string, path: string): void {
  try {
    const parsed = Bun.TOML.parse(config) as Record<string, unknown>;
    const bindings = parsed.send_email;
    if (!Array.isArray(bindings) || bindings.length !== 1 ||
        bindings[0] === null || typeof bindings[0] !== "object" || Array.isArray(bindings[0]) ||
        (bindings[0] as Record<string, unknown>).name !== "EMAIL" ||
        Object.keys(bindings[0] as Record<string, unknown>).length !== 1) {
      failures.push(`${path} send_email must contain exactly the EMAIL binding`);
    }
  } catch (error) {
    failures.push(`${path} must be valid TOML: ${detail(error)}`);
  }
}

function requireExactTopLevelKeys(config: string, path: string, allowed: string[]): void {
  try {
    const parsed = Bun.TOML.parse(config) as Record<string, unknown>;
    const unexpected = Object.keys(parsed).filter((key) => !allowed.includes(key)).sort();
    if (unexpected.length > 0) {
      failures.push(`${path} contains unexpected top-level authority: ${unexpected.join(", ")}`);
    }
  } catch (error) {
    failures.push(`${path} must be valid TOML: ${detail(error)}`);
  }
}

function requireValue(config: string, path: string, key: string, value: string): void {
  const pattern = new RegExp(`^${escapeRegex(key)}\\s*=\\s*"${escapeRegex(value)}"\\s*$`, "m");
  if (!pattern.test(config)) failures.push(`${path} must target ${key} = ${value}`);
}

function requireNumericValue(config: string, path: string, key: string, value: number): void {
  const pattern = new RegExp(`^${escapeRegex(key)}\\s*=\\s*${value}\\s*$`, "m");
  if (!pattern.test(config)) failures.push(`${path} must set ${key} = ${value}`);
}

function forbid(config: string, path: string, pattern: RegExp, label: string): void {
  if (pattern.test(config)) failures.push(`${path} must not contain a ${label}`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
