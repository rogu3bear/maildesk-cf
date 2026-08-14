import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isSenderMode, senderModeOrDefault, type SenderMode } from "./sender-mode";
import {
  isRepositoryRelativePath,
  canonicalWorkerConfigFailure,
  type WranglerConfigFormat,
  type WranglerWorkerRole,
  wranglerArtifactContainmentFailure,
  wranglerBuildCommandFailure,
} from "./wrangler-config";

type InboundMxProvider = "cloudflare_email_routing" | "google_workspace" | "external" | "excluded";

interface DesiredState {
  project: {
    name: string;
    account_id?: string;
    account_id_env?: string;
  };
  domains: DesiredDomain[];
  workers: {
    relay_router: DesiredWorker;
    relay_outbound: DesiredWorker;
    routing_health: DesiredWorker;
  };
  storage: {
    d1_database: string;
    d1_preview_database: string;
    r2_policy_bucket: string;
    r2_spool_bucket: string;
    queue: string;
    dead_letter_queue: string;
  };
  operator_delivery: OperatorDeliveryConfig;
  sender: {
    mode: SenderMode;
    candidate_domains: string[];
  };
  verification: {
    allow_broad_live_sends: boolean;
    targeted_send_required: boolean;
  };
}

interface DesiredDomain {
  name: string;
  inbound_mx_provider: InboundMxProvider;
  role_aliases: string[];
  personal_aliases: string[];
  catch_all?: boolean;
}

interface OperatorDeliveryConfig {
  mode: "inbox_relay" | "web_desk";
  processing_mode?: "disabled" | "enabled";
  inbound_processing_mode?: "disabled" | "enabled";
  reply_processing_mode?: "disabled" | "enabled";
  reply_domain: string;
  reply_token_ttl_days: number;
  spool_retention_days: number;
  max_encoded_message_bytes: number;
  banner_mode: "inline";
}

interface DesiredWorker {
  script_name: string;
  config: string;
}

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const schemaPath = "ops/cfctl/maildesk-cf.desired-state.schema.json";
const desiredStatePath = resolve(root, argValue("--desired-state") ?? defaultDesiredStatePath());
const desiredStateDisplayPath = relativePath(desiredStatePath);
const failures: string[] = [];

checkFile(schemaPath);
const desiredState = readDesiredState(desiredStatePath);
if (desiredState) {
  validateDesiredState(desiredState);
}

if (failures.length > 0 || !desiredState) {
  for (const failure of failures) {
    console.error(`fail: ${failure}`);
  }
  process.exit(1);
}

const receipt = {
  generated_at: new Date().toISOString(),
  schema_path: schemaPath,
  desired_state_path: desiredStateDisplayPath,
  status: {
    provisioning_contract_ready: true,
    live_mutation_ready: false,
  },
  cfctl_commands: lifecycleCommands(desiredStateDisplayPath),
  resources: resourceSummary(desiredState),
  protected_actions: [
    "cfctl maildesk-cf provision --ack-plan <operation-id>",
    "targeted inbound or outbound live mail probes",
  ],
  outside_checkout_blockers: outsideCheckoutBlockers(),
};

if (jsonOutput) {
  console.log(JSON.stringify(receipt, null, 2));
} else {
  console.log("cfctl maildesk-cf provisioning contract ready");
  console.log(`schema ${receipt.schema_path}`);
  console.log(`desired_state ${receipt.desired_state_path}`);
  console.log("");
  for (const command of receipt.cfctl_commands) {
    console.log(command);
  }
  console.log("");
  console.log("outside_checkout_blockers");
  for (const blocker of receipt.outside_checkout_blockers) {
    console.log(`- ${blocker}`);
  }
}

function defaultDesiredStatePath(): string {
  return existsSync(resolve(root, "config/desired-state.local.json"))
    ? "config/desired-state.local.json"
    : "config/desired-state.example.json";
}

function argValue(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function checkFile(path: string) {
  if (!existsSync(resolve(root, path))) {
    failures.push(`missing required file: ${path}`);
  }
}

function readDesiredState(path: string): DesiredState | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DesiredState;
  } catch (error) {
    failures.push(`invalid JSON in ${relativePath(path)}: ${errorDetail(error)}`);
    return null;
  }
}

function validateDesiredState(value: DesiredState) {
  const rootObject = asObject(value, "desired state");
  if (!rootObject) return;

  const project = requireObject(rootObject, "project");
  if (project) {
    requireString(project, "project.name");
    const hasAccountId = optionalString(project, "project.account_id");
    const hasAccountIdEnv = optionalString(project, "project.account_id_env");
    if (!hasAccountId && !hasAccountIdEnv) {
      failures.push("project.account_id or project.account_id_env is required");
    }
  }

  const domains = requireObjectArray(rootObject, "domains");
  const domainNames = domains
    .map((domain) => optionalString(domain, "domains[].name"))
    .filter((domain): domain is string => Boolean(domain));
  if (domains.length === 0) {
    failures.push("domains must contain at least one domain");
  }
  checkDuplicates(domainNames, "domains[].name");
  for (const domain of domainNames) {
    if (!validDomain(domain)) failures.push(`domains[].name is not a valid domain: ${domain}`);
  }
  for (const [index, domain] of domains.entries()) {
    const prefix = `domains[${index}]`;
    requireString(domain, `${prefix}.name`);
    requireEnum(domain, `${prefix}.inbound_mx_provider`, [
      "cloudflare_email_routing",
      "google_workspace",
      "external",
      "excluded",
    ]);
    requireStringArray(domain, `${prefix}.role_aliases`);
    requireStringArray(domain, `${prefix}.personal_aliases`);
    checkDuplicates(stringArrayValue(domain["role_aliases"]), `${prefix}.role_aliases`);
    checkDuplicates(stringArrayValue(domain["personal_aliases"]), `${prefix}.personal_aliases`);
    optionalBoolean(domain, `${prefix}.catch_all`);
  }

  const workers = requireObject(rootObject, "workers");
  if (workers) {
    validateWorker(requireObject(workers, "workers.relay_router"), "workers.relay_router", "mail-router");
    validateWorker(requireObject(workers, "workers.relay_outbound"), "workers.relay_outbound", "mail-outbound");
    validateWorker(requireObject(workers, "workers.routing_health"), "workers.routing_health", "routing-health");
  }

  const storage = requireObject(rootObject, "storage");
  if (storage) {
    requireString(storage, "storage.d1_database");
    requireString(storage, "storage.d1_preview_database");
    requireString(storage, "storage.r2_policy_bucket");
    requireString(storage, "storage.r2_spool_bucket");
    requireString(storage, "storage.queue");
    requireString(storage, "storage.dead_letter_queue");
  }

  const operatorDelivery = requireObject(rootObject, "operator_delivery");
  if (operatorDelivery) {
    const mode = requireEnum(operatorDelivery, "operator_delivery.mode", ["inbox_relay", "web_desk"]);
    validateProcessingModes(operatorDelivery);
    const replyDomain = requireString(operatorDelivery, "operator_delivery.reply_domain");
    if (replyDomain && !validDomain(replyDomain)) {
      failures.push("operator_delivery.reply_domain must be a valid domain");
    }
    requireIntegerRange(operatorDelivery, "operator_delivery.reply_token_ttl_days", 1, 365);
    requireIntegerRange(operatorDelivery, "operator_delivery.spool_retention_days", 1, 30);
    requireIntegerRange(operatorDelivery, "operator_delivery.max_encoded_message_bytes", 65_536, 5_242_880);
    requireEnum(operatorDelivery, "operator_delivery.banner_mode", ["inline"]);
    if (mode === "inbox_relay" && operatorDelivery["max_encoded_message_bytes"] !== 5_242_880) {
      failures.push("operator_delivery.max_encoded_message_bytes must be 5242880 for inbox_relay");
    }
  }

  const sender = requireObject(rootObject, "sender");
  if (sender) {
    const mode = requireEnum(sender, "sender.mode", [
      "disabled",
      "cloudflare_email_service",
      "resend",
    ]);
    const candidateDomains = requireStringArray(sender, "sender.candidate_domains");
    if (mode === "disabled" && candidateDomains.length > 0) {
      failures.push("sender.candidate_domains must be empty when sender.mode is disabled");
    }
    if (mode && mode !== "disabled" && candidateDomains.length === 0) {
      failures.push("sender.candidate_domains is required when sender.mode sends mail");
    }
    for (const domain of candidateDomains) {
      if (!validDomain(domain)) {
        failures.push("sender.candidate_domains entries must be valid domains");
      }
      if (!domainNames.includes(domain)) {
        failures.push("sender.candidate_domains entries must also appear in domains[].name");
      }
    }
  }

  const verification = requireObject(rootObject, "verification");
  if (verification) {
    requireBoolean(verification, "verification.allow_broad_live_sends");
    requireBoolean(verification, "verification.targeted_send_required");
    if (verification["allow_broad_live_sends"] === true) {
      failures.push("verification.allow_broad_live_sends must remain false in template-safe desired state");
    }
  }
}

function validateProcessingModes(operatorDelivery: Record<string, unknown>): void {
  const legacy = operatorDelivery["processing_mode"];
  const inbound = operatorDelivery["inbound_processing_mode"];
  const reply = operatorDelivery["reply_processing_mode"];
  const hasSplit = inbound !== undefined || reply !== undefined;
  if (legacy !== undefined && hasSplit) {
    failures.push("operator_delivery must not combine processing_mode with split processing modes");
    return;
  }
  if (legacy !== undefined) {
    requireEnum(operatorDelivery, "operator_delivery.processing_mode", ["disabled", "enabled"]);
    return;
  }
  requireEnum(operatorDelivery, "operator_delivery.inbound_processing_mode", ["disabled", "enabled"]);
  requireEnum(operatorDelivery, "operator_delivery.reply_processing_mode", ["disabled", "enabled"]);
}

function validateWorker(
  worker: Record<string, unknown> | null,
  prefix: string,
  role: WranglerWorkerRole,
) {
  if (!worker) return;
  requireString(worker, `${prefix}.script_name`);
  const config = requireString(worker, `${prefix}.config`);
  if (!config) return;
  if (!isRepositoryRelativePath(config)) {
    failures.push(`${prefix}.config must be a normalized repository-relative path`);
    return;
  }
  checkFile(config);
  const canonicalFailure = canonicalWorkerConfigFailure(config, role);
  if (canonicalFailure) {
    failures.push(`${prefix}.config ${canonicalFailure}`);
    return;
  }
  const format: WranglerConfigFormat = "toml";
  validateWranglerBuildCommand(config, prefix, format);
}

function validateWranglerBuildCommand(
  path: string,
  prefix: string,
  format: WranglerConfigFormat,
) {
  let contents: string;
  try {
    contents = readFileSync(resolve(root, path), "utf8");
  } catch {
    return;
  }
  const failure = wranglerBuildCommandFailure(contents, format);
  if (failure) failures.push(`${prefix}.config ${failure}`);
  const containmentFailure = wranglerArtifactContainmentFailure(contents, path, root, format);
  if (containmentFailure) failures.push(`${prefix}.config ${containmentFailure}`);
}

function lifecycleCommands(desiredStatePath: string): string[] {
  return [
    "cfctl doctor",
    `cfctl maildesk-cf diff --file ${desiredStatePath}`,
    `cfctl maildesk-cf provision --file ${desiredStatePath} --plan`,
    `cfctl maildesk-cf provision --file ${desiredStatePath} --ack-plan <operation-id>`,
    `cfctl maildesk-cf verify --file ${desiredStatePath}`,
  ];
}

function resourceSummary(desired: DesiredState) {
  return {
    domains: desired.domains.map((domain) => domain.name).sort(),
    workers: [
      desired.workers.relay_router.script_name,
      desired.workers.relay_outbound.script_name,
      desired.workers.routing_health.script_name,
    ].sort(),
    worker_configs: [
      desired.workers.relay_router.config,
      desired.workers.relay_outbound.config,
      desired.workers.routing_health.config,
    ].sort(),
    storage: [
      `d1:${desired.storage.d1_database}`,
      `d1-preview:${desired.storage.d1_preview_database}`,
      `r2-policy:${desired.storage.r2_policy_bucket}`,
      `r2-spool:${desired.storage.r2_spool_bucket}`,
      `queue:${desired.storage.queue}`,
      `queue-dlq:${desired.storage.dead_letter_queue}`,
    ],
    operator_delivery: desired.operator_delivery,
    email_routing_aliases: emailRoutingAliases(desired),
    sender: {
      mode: senderModeOrDefault(desired.sender.mode),
      candidate_domains: [...desired.sender.candidate_domains].sort(),
    },
    verification: {
      allow_broad_live_sends: desired.verification.allow_broad_live_sends,
      targeted_send_required: desired.verification.targeted_send_required,
    },
  };
}

function emailRoutingAliases(desired: DesiredState): string[] {
  return desired.domains
    .filter((domain) => domain.inbound_mx_provider === "cloudflare_email_routing")
    .flatMap((domain) =>
      [...domain.role_aliases, ...domain.personal_aliases].map((alias) => `${alias}@${domain.name}`),
    )
    .sort();
}

function outsideCheckoutBlockers(): string[] {
  return [
    "install or update cfctl with the maildesk-cf lifecycle surface",
    "copy config/desired-state.example.json to config/desired-state.local.json and replace reserved examples with a real Cloudflare account and domain",
    "run cfctl doctor with a healthy credential lane before planning",
    "review the cfctl provision preview and provide its operation id before --ack-plan",
    "run targeted cfctl maildesk-cf verify and mail proof readbacks after mutation",
  ];
}

function asObject(value: unknown, path: string): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  failures.push(`${path} must be an object`);
  return null;
}

function requireObject(
  parent: Record<string, unknown>,
  path: string,
): Record<string, unknown> | null {
  const key = lastPathSegment(path);
  const value = parent[key];
  if (value === undefined) {
    failures.push(`${path} is required`);
    return null;
  }
  return asObject(value, path);
}

function requireObjectArray(parent: Record<string, unknown>, path: string): Array<Record<string, unknown>> {
  const value = parent[path];
  if (value === undefined) {
    failures.push(`${path} is required`);
    return [];
  }
  if (!Array.isArray(value)) {
    failures.push(`${path} must be an array`);
    return [];
  }
  const objects: Array<Record<string, unknown>> = [];
  for (const [index, item] of value.entries()) {
    const object = asObject(item, `${path}[${index}]`);
    if (object) objects.push(object);
  }
  return objects;
}

function requireString(parent: Record<string, unknown>, path: string): string | null {
  const key = lastPathSegment(path);
  const value = parent[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    failures.push(`${path} is required`);
    return null;
  }
  return value;
}

function optionalString(parent: Record<string, unknown>, path: string): string | null {
  const key = lastPathSegment(path);
  const value = parent[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function requireStringArray(parent: Record<string, unknown>, path: string): string[] {
  const key = lastPathSegment(path);
  const value = parent[key];
  if (value === undefined) {
    failures.push(`${path} is required`);
    return [];
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    failures.push(`${path} must be an array of strings`);
    return [];
  }
  return [...value];
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function requireEnum(
  parent: Record<string, unknown>,
  path: string,
  allowed: string[],
): string | null {
  const key = lastPathSegment(path);
  const value = parent[key];
  if (typeof value !== "string" || !allowed.includes(value)) {
    failures.push(`${path} must be one of ${allowed.join(", ")}`);
    return null;
  }
  if (path === "sender.mode" && !isSenderMode(value)) {
    failures.push(`sender.mode must be one of ${allowed.join(", ")}`);
    return null;
  }
  return value;
}

function requireBoolean(parent: Record<string, unknown>, path: string) {
  const key = lastPathSegment(path);
  if (typeof parent[key] !== "boolean") {
    failures.push(`${path} is required`);
  }
}

function optionalBoolean(parent: Record<string, unknown>, path: string): boolean | null {
  const key = lastPathSegment(path);
  const value = parent[key];
  if (value === undefined) return null;
  if (typeof value !== "boolean") {
    failures.push(`${path} must be a boolean`);
    return null;
  }
  return value;
}

function requireIntegerRange(
  parent: Record<string, unknown>,
  path: string,
  minimum: number,
  maximum: number,
): number | null {
  const key = lastPathSegment(path);
  const value = parent[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    failures.push(`${path} must be an integer from ${minimum} through ${maximum}`);
    return null;
  }
  return value;
}

function checkDuplicates(values: string[], path: string) {
  if (values.length === new Set(values).size) return;
  failures.push(`${path} must not contain duplicates`);
}

function validDomain(value: string): boolean {
  const domain = value.trim().toLowerCase();
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(domain);
}

function lastPathSegment(path: string): string {
  const bracketMatch = path.match(/\.?([a-zA-Z0-9_]+)$/);
  return bracketMatch?.[1] ?? path;
}

function relativePath(path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
