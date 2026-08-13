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
  requireWorkersDevOff(config, path);
  requireBinding(config, path, "d1_databases", "DB");
  requireBinding(config, path, "r2_buckets", "POLICY_STORE");
  requireBinding(config, path, "r2_buckets", "RELAY_SPOOL");
  requireBinding(config, path, "queues.producers", "MAIL_JOBS");
  requireBinding(config, path, "send_email", "EMAIL");
  requireValue(config, path, "database_name", desired.storage.d1_database);
  requireValue(config, path, "bucket_name", desired.storage.r2_policy_bucket);
  requireValue(config, path, "bucket_name", desired.storage.r2_spool_bucket);
  requireValue(config, path, "queue", desired.storage.queue);
  forbid(config, path, /\[\[queues\.consumers\]\]/, "Queue consumer");
  forbid(config, path, /^routes\s*=/m, "public HTTP route");
  forbid(config, path, /^MAILDESK_RELAY_PROCESSING_MODE\s*=/m, "legacy relay processing switch");
  requireAssignment(config, path, "MAILDESK_INBOUND_RELAY_MODE", desired.operator_delivery.inbound_processing_mode);
  requireAssignment(config, path, "MAILDESK_REPLY_RELAY_MODE", desired.operator_delivery.reply_processing_mode);
}

function checkOutbound(desired: DesiredState): void {
  const path = desired.workers.relay_outbound.config;
  const config = readConfig(path);
  if (!config) return;
  requireAssignment(config, path, "name", desired.workers.relay_outbound.script_name);
  requireWorkersDevOff(config, path);
  requireBinding(config, path, "d1_databases", "DB");
  requireBinding(config, path, "r2_buckets", "POLICY_STORE");
  requireBinding(config, path, "r2_buckets", "RELAY_SPOOL");
  requireBinding(config, path, "send_email", "EMAIL");
  requireValue(config, path, "database_name", desired.storage.d1_database);
  requireValue(config, path, "bucket_name", desired.storage.r2_policy_bucket);
  requireValue(config, path, "bucket_name", desired.storage.r2_spool_bucket);
  requireValue(config, path, "queue", desired.storage.queue);
  requireValue(config, path, "dead_letter_queue", desired.storage.dead_letter_queue);
  requireNumericValue(config, path, "max_batch_size", 1);
  requireNumericValue(config, path, "max_concurrency", 1);
  requireNumericValue(config, path, "max_retries", 5);
  forbid(config, path, /\[\[queues\.producers\]\]/, "Queue producer");
  forbid(config, path, /^routes\s*=/m, "public HTTP route");
}

function checkRoutingHealth(desired: DesiredState): void {
  const path = desired.workers.routing_health.config;
  const config = readConfig(path);
  if (!config) return;
  requireAssignment(config, path, "name", desired.workers.routing_health.script_name);
  requireWorkersDevOff(config, path);
  requireBinding(config, path, "d1_databases", "DB");
  requireValue(config, path, "database_name", desired.storage.d1_database);
  if (!/^\[assets\]$/m.test(config)) failures.push(`${path} must bind static assets`);
  forbid(config, path, /\[\[r2_buckets\]\]/, "R2 binding");
  forbid(config, path, /\[\[queues\./, "Queue binding");
  forbid(config, path, /^send_email\s*=/m, "Email binding");
  requireAssignment(config, path, "MAILDESK_UI_AUTH_MODE", "access");
  requireAssignment(config, path, "MAILDESK_UI_ACCESS_SCOPE", "all_routes");
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
