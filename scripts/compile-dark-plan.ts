import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isRepositoryRelativePath } from "./wrangler-config";

interface DesiredState {
  project: { name: string };
  workers: Record<string, { script_name: string; config: string }>;
  storage: {
    d1_database: string;
    r2_policy_bucket: string;
    r2_spool_bucket: string;
    queue: string;
    dead_letter_queue: string;
  };
  operator_delivery: {
    processing_mode?: string;
    inbound_processing_mode?: string;
    reply_processing_mode?: string;
    reply_domain: string;
  };
  sender?: { mode?: string };
}

const root = resolve(import.meta.dir, "..");
const desiredPath = assertDesiredStatePath(arg("--desired-state") ?? "config/desired-state.example.json");
const outputPath = arg("--out");
const desired = json<DesiredState>(desiredPath);
assertDarkActivation(desired.operator_delivery);
assertDarkWorkerConfigs(desired);
const head = git("rev-parse", "HEAD");
const tree = git("rev-parse", "HEAD^{tree}");
const dirty = git("status", "--porcelain").length > 0;

const sourceFiles = [
  desiredPath,
  ".cfctl/operations/d1-migrations.toml",
  ".cfctl/operations/d1-policy-projections.toml",
  "ops/cfctl/relay-spool-lifecycle.example.json",
  ...Object.values(desired.workers).map((worker) => worker.config),
];

const plan = {
  schema_version: 1,
  kind: "maildesk_dark_plan_blueprint",
  performed: false,
  plan_ready: !dirty,
  operation_ids_created: false,
  repository: {
    head,
    tree,
    dirty,
    source_files: Object.fromEntries(sourceFiles.sort().map((path) => [path, shaFile(path)])),
  },
  activation: {
    inbound_processing_mode: desired.operator_delivery.inbound_processing_mode,
    reply_processing_mode: desired.operator_delivery.reply_processing_mode,
    required_dark_state: "disabled/disabled",
  },
  plan_sets: [
    {
      name: "bootstrap-resources",
      purpose: "Create isolated resources whose returned identifiers are required by later exact Worker configs.",
      children: [
        step("d1", "d1-create-database", desired.storage.d1_database, "delete only the newly created database in a separate plan"),
        step("policy-r2", "r2-create-bucket", desired.storage.r2_policy_bucket, "delete only the empty newly created bucket in a separate plan"),
        step("spool-r2", "r2-create-bucket", desired.storage.r2_spool_bucket, "delete only the empty newly created bucket in a separate plan"),
        step("queue", "queues-create", desired.storage.queue, "delete only the newly created queue in a separate plan"),
        step("dlq", "queues-create", desired.storage.dead_letter_queue, "delete only the newly created dead-letter queue in a separate plan"),
      ],
    },
    {
      name: "dark-deployment",
      purpose: "Compile only after bootstrap identifiers and fresh provider snapshots are verified.",
      children: [
        step("spool-lifecycle", "r2-put-bucket-lifecycle-configuration", desired.storage.r2_spool_bucket, "restore the complete prior lifecycle snapshot; expired objects are unrecoverable"),
        step("d1-migrations", "maildesk-cf.d1-migrations-apply", desired.storage.d1_database, "restore the exact fresh pre-migration bookmark in a separate plan"),
        step("policy-upload", "r2-put-object", `${desired.storage.r2_policy_bucket}/config/policy/<sha256>.json`, "delete only the newly created immutable object in a separate plan"),
        step("policy-projection", "maildesk-cf.d1-policy-project", desired.storage.d1_database, "restore the exact fresh pre-projection bookmark in a separate plan"),
        ...Object.values(desired.workers).map((worker) =>
          step(`deploy-${worker.script_name}`, "wrangler.deploy", worker.config, "redeploy the exact prior Worker version in a separate plan"),
        ),
        step("queue-consumer", "queues-create-consumer", `${desired.storage.queue} -> ${desired.workers.relay_outbound.script_name}`, "delete the exact new consumer in a separate plan"),
        readStep("ui-access-application", "access-applications-get-an-access-application", "existing whole-host Access application"),
        readStep("ui-access-policies", "access-policies-list-access-app-policies", "existing approved operator policies"),
        step("ui-custom-domain", "workers.domains.update", "entire routing-health hostname", "restore the exact prior Worker custom-domain attachment in a separate plan"),
        step("reply-routing", "email-routing-settings-enable-email-routing-dns", desired.operator_delivery.reply_domain, "remove only the reply-subdomain routing and restore its prior DNS snapshot"),
        step("reply-catch-all", "email-routing-routing-rules-update-catch-all-rule", desired.workers.relay_router.script_name, "restore the exact prior subdomain catch-all rule in a separate plan"),
      ],
    },
  ],
  required_fresh_reads: [
    "Workers, versions, bindings, routes, custom domains",
    "D1 databases, bookmarks, migration ledger, schema",
    "R2 buckets, lifecycle, immutable policy object metadata",
    "Queue consumers, backlog, and DLQ",
    "Access application, audience, group, policy, and full-host coverage",
    "Email Routing settings and rules for the canary and reply subdomain",
    "Email Sending entitlement, domains, preview preference, and DNS status",
    "DNS and legacy rollback route for every in-scope zone",
  ],
  explicit_exclusions: [
    "approval or execution of any child operation",
    "credential minting or import",
    "sender-domain onboarding",
    "website alias or MX changes",
    "live inbound or outbound email probes",
    "domains retained on an external mail authority",
    "separately reviewed future domain migrations",
  ],
  stop_conditions: [
    "dirty or drifting source checkout",
    "missing fresh provider snapshot or recovery target",
    "placeholder bootstrap identifier in a downstream Worker config",
    "credential, profile, catalog, policy, source, config, or provider drift",
    "either relay activation switch is enabled",
  ],
};

const encoded = `${JSON.stringify(plan, null, 2)}\n`;
if (outputPath) {
  const absolute = resolve(outputPath);
  writeFileSync(absolute, encoded, { mode: 0o600, flag: "wx" });
  chmodSync(absolute, 0o600);
} else {
  process.stdout.write(encoded);
}

function step(id: string, capability: string, target: string, rollback: string) {
  return { id, capability, target, effect: "mutation", operation_id: null, plan_hash: null, rollback };
}

function readStep(id: string, capability: string, target: string) {
  return { id, capability, target, effect: "read_only", operation_id: null, plan_hash: null, rollback: "not applicable" };
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function json<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(root, path), "utf8")) as T;
}

function assertDarkActivation(operatorDelivery: DesiredState["operator_delivery"] | undefined): void {
  if (operatorDelivery && "processing_mode" in operatorDelivery) {
    throw new Error(
      "dark deployment desired state must not combine the legacy operator_delivery.processing_mode field with split activation fields",
    );
  }
  if (
    operatorDelivery?.inbound_processing_mode !== "disabled" ||
    operatorDelivery.reply_processing_mode !== "disabled"
  ) {
    throw new Error(
      "dark deployment requires operator_delivery.inbound_processing_mode and operator_delivery.reply_processing_mode to both equal disabled",
    );
  }
}

function assertDarkWorkerConfigs(desired: DesiredState): void {
  const expectedRoles = ["relay_outbound", "relay_router", "routing_health"];
  const observedRoles = Object.keys(desired.workers).sort();
  if (observedRoles.length !== expectedRoles.length ||
      expectedRoles.some((role, index) => observedRoles[index] !== role)) {
    throw new Error(`workers must contain exactly the canonical roles: ${expectedRoles.join(", ")}`);
  }
  const routerPath = assertWorkerConfigPath("relay_router", desired.workers.relay_router.config, "mail-router");
  const healthPath = assertWorkerConfigPath("routing_health", desired.workers.routing_health.config, "routing-health");
  assertWorkerConfigPath("relay_outbound", desired.workers.relay_outbound.config, "mail-outbound");

  const router = wranglerConfig(routerPath);
  assertExactTopLevelKeys(router, routerPath, [
    "name", "main", "compatibility_date", "workers_dev", "send_email", "build", "vars",
    "d1_databases", "r2_buckets", "queues",
  ]);
  requireWorkersDevOff(router, routerPath);
  requireExactEmailBinding(router, routerPath);
  assertConfigName(router, routerPath, desired.workers.relay_router.script_name);
  requireConfigValue(router, routerPath, "main", "../../workers/mail-router/src/index.ts");
  const routerVars = record(router.vars, `${routerPath} [vars]`);
  if ("MAILDESK_RELAY_PROCESSING_MODE" in routerVars) {
    throw new Error(`${routerPath} must not combine the legacy relay processing switch with split activation switches`);
  }
  for (const [key, desiredValue] of [
    ["MAILDESK_INBOUND_RELAY_MODE", desired.operator_delivery.inbound_processing_mode],
    ["MAILDESK_REPLY_RELAY_MODE", desired.operator_delivery.reply_processing_mode],
  ] as const) {
    if (routerVars[key] !== "disabled" || routerVars[key] !== desiredValue) {
      throw new Error(`${routerPath} ${key} must exist, equal disabled, and match desired state`);
    }
  }
  requireConfigValue(routerVars, routerPath, "MAILDESK_REPLY_DOMAIN", desired.operator_delivery.reply_domain);
  assertStorageBindings(router, routerPath, desired);
  requireArrayValue(router, routerPath, "queues.producers", "queue", desired.storage.queue);
  requireExactArrayLength(router, routerPath, "queues.producers", 1);

  const outboundPath = desired.workers.relay_outbound.config;
  const outbound = wranglerConfig(outboundPath);
  assertExactTopLevelKeys(outbound, outboundPath, [
    "name", "main", "compatibility_date", "workers_dev", "upload_source_maps", "send_email",
    "build", "vars", "d1_databases", "r2_buckets", "queues",
  ]);
  requireWorkersDevOff(outbound, outboundPath);
  requireExactEmailBinding(outbound, outboundPath);
  assertConfigName(outbound, outboundPath, desired.workers.relay_outbound.script_name);
  requireConfigValue(outbound, outboundPath, "main", "../../workers/mail-outbound/src/index.ts");
  assertStorageBindings(outbound, outboundPath, desired);
  requireArrayValue(outbound, outboundPath, "queues.consumers", "queue", desired.storage.queue);
  requireArrayValue(outbound, outboundPath, "queues.consumers", "dead_letter_queue", desired.storage.dead_letter_queue);
  requireExactArrayLength(outbound, outboundPath, "queues.consumers", 1);
  if (desired.sender?.mode !== undefined) {
    requireConfigValue(record(outbound.vars, `${outboundPath} [vars]`), outboundPath, "MAILDESK_OUTBOUND_MODE", desired.sender.mode);
  }

  const health = wranglerConfig(healthPath);
  assertExactTopLevelKeys(health, healthPath, [
    "name", "main", "compatibility_date", "workers_dev", "upload_source_maps", "build", "assets", "vars", "d1_databases",
  ]);
  requireWorkersDevOff(health, healthPath);
  assertConfigName(health, healthPath, desired.workers.routing_health.script_name);
  requireConfigValue(health, healthPath, "main", "../../build/_worker.js");
  requireArrayValue(health, healthPath, "d1_databases", "database_name", desired.storage.d1_database);
  requireExactArrayLength(health, healthPath, "d1_databases", 1);
  const healthVars = record(health.vars, `${healthPath} [vars]`);
  if (healthVars.MAILDESK_UI_AUTH_MODE !== "access" || healthVars.MAILDESK_UI_ACCESS_SCOPE !== "all_routes") {
    throw new Error(`${healthPath} must require Cloudflare Access for all_routes`);
  }
}

function assertExactTopLevelKeys(config: Record<string, unknown>, path: string, allowed: string[]): void {
  const unexpected = Object.keys(config).filter((key) => !allowed.includes(key)).sort();
  if (unexpected.length > 0) {
    throw new Error(`${path} contains unexpected top-level authority: ${unexpected.join(", ")}`);
  }
}

function requireExactEmailBinding(config: Record<string, unknown>, path: string): void {
  const bindings = config.send_email;
  if (!Array.isArray(bindings) || bindings.length !== 1 ||
      bindings[0] === null || typeof bindings[0] !== "object" || Array.isArray(bindings[0]) ||
      (bindings[0] as Record<string, unknown>).name !== "EMAIL" ||
      Object.keys(bindings[0] as Record<string, unknown>).length !== 1) {
    throw new Error(`${path} send_email must contain exactly the EMAIL binding`);
  }
}

function assertDesiredStatePath(path: string): string {
  const absolute = resolve(root, path);
  const repositoryPath = relative(root, absolute);
  if (!isRepositoryRelativePath(repositoryPath) || !repositoryPath.startsWith("config/") || !repositoryPath.endsWith(".json")) {
    throw new Error("desired state must be a repository-relative config/*.json path contained in the source checkout");
  }
  return repositoryPath;
}

function assertConfigName(config: Record<string, unknown>, path: string, expected: string): void {
  requireConfigValue(config, path, "name", expected);
}

function requireWorkersDevOff(config: Record<string, unknown>, path: string): void {
  if (config.workers_dev !== false) throw new Error(`${path} must set workers_dev = false`);
}

function assertStorageBindings(config: Record<string, unknown>, path: string, desired: DesiredState): void {
  requireArrayBindingValue(config, path, "d1_databases", "binding", "DB", "database_name", desired.storage.d1_database);
  requireArrayBindingValue(config, path, "r2_buckets", "binding", "POLICY_STORE", "bucket_name", desired.storage.r2_policy_bucket);
  requireArrayBindingValue(config, path, "r2_buckets", "binding", "RELAY_SPOOL", "bucket_name", desired.storage.r2_spool_bucket);
  requireExactArrayLength(config, path, "d1_databases", 1);
  requireExactArrayLength(config, path, "r2_buckets", 2);
}

function requireExactArrayLength(
  config: Record<string, unknown>,
  path: string,
  section: string,
  expected: number,
): void {
  const value = section.split(".").reduce<unknown>((current, part) =>
    current !== null && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)[part]
      : undefined, config);
  if (!Array.isArray(value) || value.length !== expected) {
    throw new Error(`${path} ${section} must contain exactly ${expected} entries`);
  }
}

function requireArrayBindingValue(
  config: Record<string, unknown>,
  path: string,
  section: string,
  bindingKey: string,
  binding: string,
  valueKey: string,
  expected: string,
): void {
  const value = section.split(".").reduce<unknown>((current, part) =>
    current !== null && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)[part]
      : undefined, config);
  if (!Array.isArray(value) || !value.some((entry) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry) &&
    (entry as Record<string, unknown>)[bindingKey] === binding &&
    (entry as Record<string, unknown>)[valueKey] === expected)) {
    throw new Error(`${path} ${section} must bind ${binding} to desired ${valueKey} ${expected}`);
  }
}

function requireConfigValue(config: Record<string, unknown>, path: string, key: string, expected: string): void {
  if (config[key] !== expected) throw new Error(`${path} ${key} must equal desired value ${expected}`);
}

function requireArrayValue(
  config: Record<string, unknown>,
  path: string,
  section: string,
  key: string,
  expected: string,
): void {
  const value = section.split(".").reduce<unknown>((current, part) =>
    current !== null && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)[part]
      : undefined, config);
  if (!Array.isArray(value) || !value.some((entry) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry) &&
    (entry as Record<string, unknown>)[key] === expected)) {
    throw new Error(`${path} ${section}.${key} must include desired value ${expected}`);
  }
}

function assertWorkerConfigPath(role: string, path: string, directory: string): string {
  const pattern = new RegExp(`^deploy/${directory}/wrangler(?:\\.[a-z0-9-]+)?\\.toml$`);
  if (!isRepositoryRelativePath(path) || !pattern.test(path)) {
    throw new Error(`${role} config must be a repository-relative canonical deploy/${directory}/wrangler*.toml path`);
  }
  return path;
}

function wranglerConfig(path: string): Record<string, unknown> {
  try {
    return record(Bun.TOML.parse(readFileSync(resolve(root, path), "utf8")), path);
  } catch (error) {
    throw new Error(`${path} must be readable valid TOML: ${detail(error)}`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function shaFile(path: string): string {
  return createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex");
}

function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
