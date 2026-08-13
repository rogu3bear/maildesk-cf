import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadEnvFile } from "./env-file";
import {
  isSenderMode,
  senderModeList,
  senderModeNeedsProviderReadback,
  senderModeOrDefault,
  type SenderMode,
} from "./sender-mode";

type Mode = "template" | "production";

interface DesiredState {
  project?: {
    name?: unknown;
    account_id?: unknown;
    account_id_env?: unknown;
  };
  sender?: {
    mode?: unknown;
    candidate_domains?: unknown;
  };
  operator_delivery?: {
    mode?: unknown;
    processing_mode?: unknown;
    inbound_processing_mode?: unknown;
    reply_processing_mode?: unknown;
    reply_domain?: unknown;
    reply_token_ttl_days?: unknown;
    spool_retention_days?: unknown;
    max_encoded_message_bytes?: unknown;
    banner_mode?: unknown;
  };
}

const root = resolve(import.meta.dir, "..");
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const failures: string[] = [];
const warnings: string[] = [];
const envFileLoad = loadEnvFile(root, argValue("--env-file"));
failures.push(...envFileLoad.failures);
const mode: Mode = args.has("--mode")
  ? parseMode(argValue("--mode"))
  : args.has("--production")
    ? "production"
    : "template";

checkCommand("bun", ["--version"], true);
checkCommand("cargo", ["--version"], true);
checkCommand("rustc", ["--version"], true);
checkCommand(process.env.CFCTL_BIN ?? "cfctl", ["--help"], mode === "production");

checkFile("Cargo.toml");
checkFile("wrangler.toml");
checkFile("deploy/mail-router/wrangler.toml");
checkFile("deploy/mail-outbound/wrangler.toml");
checkFile("deploy/routing-health/wrangler.toml");
checkFile("config/policy.example.json");
checkFile("config/desired-state.example.json");
checkFile("scripts/check-template.sh");

const desiredStatePath =
  process.env.MAILDESK_DESIRED_STATE_PATH ??
  (mode === "production" && existsSync(resolve(root, "config/desired-state.local.json"))
    ? "config/desired-state.local.json"
    : "config/desired-state.example.json");
const desiredState = checkJson<DesiredState>(desiredStatePath);
checkDesiredSenderMode(desiredState);
checkDesiredOperatorDelivery(desiredState);
checkRelayTopology(desiredStatePath);

const policyPath =
  process.env.MAILDESK_POLICY_PATH ??
  (mode === "production" && existsSync(resolve(root, "config/policy.local.json"))
    ? "config/policy.local.json"
    : "config/policy.example.json");

checkFile(policyPath);
checkPolicy(policyPath);

if (mode === "production") {
  const cfctlDoctor = readCfctlDoctor();
  checkCfctlDoctor(cfctlDoctor);
  checkCloudflareAccountTarget(desiredState);
  checkCloudflareAuthEnv();
  checkProjectName(desiredState);
  checkReplyApiEnv();
  checkAccessValidationEnv();
  checkOutboundEnv(desiredState);
  checkOperatorDeliveryEnv(desiredState);
  checkWranglerPlaceholders();
} else {
  checkTemplateExamples();
}

for (const warning of warnings) {
  console.warn(`warn: ${warning}`);
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`fail: ${failure}`);
  }
  process.exit(1);
}

console.log(`preflight ok: ${mode}`);

function parseMode(value: string | undefined): Mode {
  if (value === "template" || value === "production") return value;
  failures.push("mode must be template or production");
  return "template";
}

function argValue(name: string): string | undefined {
  const index = rawArgs.indexOf(name);
  if (index === -1) return undefined;
  return rawArgs[index + 1];
}

function checkFile(path: string) {
  if (!existsSync(resolve(root, path))) {
    failures.push(`missing required file: ${path}`);
  }
}

function checkCommand(command: string, args: string[], required: boolean) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", env: process.env });
  if (result.status === 0) return;

  const message = `command unavailable or failing: ${command}`;
  if (required) failures.push(message);
  else warnings.push(message);
}

function checkPolicy(path: string) {
  const result = spawnSync(
    "cargo",
    ["run", "--quiet", "--package", "maildesk-router", "--bin", "maildesk-policy-check", "--", path],
    { cwd: root, encoding: "utf8", env: process.env },
  );
  if (result.status === 0) return;

  failures.push(
    `policy validation failed for ${path}: ${result.stderr.trim() || result.stdout.trim()}`,
  );
}

function checkRelayTopology(desiredStatePath: string) {
  const result = spawnSync("bun", ["run", "scripts/check-relay-topology.ts", desiredStatePath], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status === 0) return;
  failures.push(`relay topology validation failed: ${result.stderr.trim() || result.stdout.trim()}`);
}

function checkJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(resolve(root, path), "utf8")) as T;
  } catch (error) {
    failures.push(`invalid JSON in ${path}: ${errorDetail(error)}`);
    return null;
  }
}

function checkRequiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value || value.startsWith("<") || value.includes("replace-me")) {
    failures.push(`missing or placeholder environment variable: ${name}`);
  }
}

function hasUsableEnv(name: string): boolean {
  const value = process.env[name]?.trim();
  return Boolean(value && !value.startsWith("<") && !value.includes("replace-me"));
}

function checkProjectName(desiredState: DesiredState | null) {
  if (hasUsableEnv("MAILDESK_PROJECT_NAME")) return;
  if (isUsableValue(desiredState?.project?.name)) return;

  failures.push(
    "missing project name: set MAILDESK_PROJECT_NAME or project.name in desired state",
  );
}

function checkCloudflareAccountTarget(
  desiredState: DesiredState | null,
) {
  if (hasUsableEnv("CLOUDFLARE_ACCOUNT_ID")) return;
  if (isUsableValue(desiredState?.project?.account_id)) return;

  const accountIdEnv = stringValue(desiredState?.project?.account_id_env);
  if (accountIdEnv && hasUsableEnv(accountIdEnv)) return;
  failures.push(
    "missing Cloudflare account target: set CLOUDFLARE_ACCOUNT_ID or desired-state project.account_id",
  );
}

function checkCloudflareAuthEnv() {
  if (hasUsableEnv("CLOUDFLARE_API_TOKEN")) return;

  failures.push(
    "missing Cloudflare deploy auth: set a purpose-scoped CLOUDFLARE_API_TOKEN",
  );
}

function checkCfctlDoctor(cfctlDoctor: CfctlDoctorSummary | null) {
  if (cfctlDoctor?.healthy) return;
  failures.push("cfctl doctor must report at least one healthy lane");
}

function checkDesiredSenderMode(desiredState: DesiredState | null) {
  const mode = desiredState?.sender?.mode;
  if (mode === undefined) return;
  if (!isSenderMode(mode)) {
    failures.push(`desired-state sender.mode must be ${senderModeList()}`);
  }
  const candidateDomains = desiredState?.sender?.candidate_domains;
  if (candidateDomains !== undefined && !isStringArray(candidateDomains)) {
    failures.push("desired-state sender.candidate_domains must be an array of domains");
  }
}

function desiredSenderMode(desiredState: DesiredState | null): SenderMode {
  return senderModeOrDefault(desiredState?.sender?.mode);
}

function checkDesiredOperatorDelivery(desiredState: DesiredState | null) {
  const delivery = desiredState?.operator_delivery;
  if (!delivery) {
    failures.push("desired-state operator_delivery is required");
    return;
  }
  if (delivery.mode !== "inbox_relay" && delivery.mode !== "web_desk") {
    failures.push("desired-state operator_delivery.mode must be inbox_relay or web_desk");
  }
  const legacy = delivery.processing_mode;
  const hasSplit = delivery.inbound_processing_mode !== undefined || delivery.reply_processing_mode !== undefined;
  if (legacy !== undefined && hasSplit) {
    failures.push("desired-state operator_delivery must not combine processing_mode with split processing modes");
  } else if (legacy !== undefined) {
    if (legacy !== "disabled" && legacy !== "enabled") {
      failures.push("desired-state operator_delivery.processing_mode must be disabled or enabled");
    }
  } else {
    for (const [name, value] of [
      ["inbound_processing_mode", delivery.inbound_processing_mode],
      ["reply_processing_mode", delivery.reply_processing_mode],
    ] as const) {
      if (value !== "disabled" && value !== "enabled") {
        failures.push(`desired-state operator_delivery.${name} must be disabled or enabled`);
      }
    }
  }
  if (!isUsableValue(delivery.reply_domain)) {
    failures.push("desired-state operator_delivery.reply_domain is required");
  }
  checkDesiredInteger("operator_delivery.reply_token_ttl_days", delivery.reply_token_ttl_days, 1, 365);
  checkDesiredInteger("operator_delivery.spool_retention_days", delivery.spool_retention_days, 1, 30);
  checkDesiredInteger("operator_delivery.max_encoded_message_bytes", delivery.max_encoded_message_bytes, 65_536, 5_242_880);
  if (delivery.banner_mode !== "inline") {
    failures.push("desired-state operator_delivery.banner_mode must be inline");
  }
}

function checkDesiredInteger(name: string, value: unknown, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    failures.push(`desired-state ${name} must be an integer from ${minimum} through ${maximum}`);
  }
}

function checkOperatorDeliveryEnv(desiredState: DesiredState | null) {
  const delivery = desiredState?.operator_delivery;
  if (!delivery || (delivery.mode !== "inbox_relay" && delivery.mode !== "web_desk")) return;
  const runtimeMode = process.env.MAILDESK_OPERATOR_DELIVERY_MODE?.trim() || "web_desk";
  if (runtimeMode !== delivery.mode) {
    failures.push(
      `MAILDESK_OPERATOR_DELIVERY_MODE (${runtimeMode}) must match desired-state operator_delivery.mode (${delivery.mode})`,
    );
  }
  if (delivery.mode !== "inbox_relay") return;

  checkRelayActivationEnv(delivery);

  const replyDomain = process.env.MAILDESK_REPLY_DOMAIN?.trim();
  if (replyDomain !== delivery.reply_domain) {
    failures.push("MAILDESK_REPLY_DOMAIN must match desired-state operator_delivery.reply_domain");
  }
  checkRuntimeInteger("MAILDESK_REPLY_TOKEN_TTL_DAYS", delivery.reply_token_ttl_days);
  checkRuntimeInteger("MAILDESK_SPOOL_RETENTION_DAYS", delivery.spool_retention_days);
  checkRuntimeInteger("MAILDESK_MAX_ENCODED_MESSAGE_BYTES", delivery.max_encoded_message_bytes);
  checkSendEmailBinding("deploy/mail-router/wrangler.toml");
  checkSendEmailBinding("deploy/mail-outbound/wrangler.toml");
}

function checkRuntimeInteger(name: string, desired: unknown) {
  const runtime = process.env[name]?.trim();
  if (typeof desired !== "number" || runtime !== String(desired)) {
    failures.push(`${name} must match desired-state operator delivery configuration`);
  }
}

function checkRelayActivationEnv(delivery: NonNullable<DesiredState["operator_delivery"]>) {
  const legacyRuntime = process.env.MAILDESK_RELAY_PROCESSING_MODE?.trim();
  const inboundRuntime = process.env.MAILDESK_INBOUND_RELAY_MODE?.trim();
  const replyRuntime = process.env.MAILDESK_REPLY_RELAY_MODE?.trim();
  const hasSplitRuntime = inboundRuntime !== undefined || replyRuntime !== undefined;
  if (legacyRuntime !== undefined && hasSplitRuntime) {
    failures.push("runtime must not combine MAILDESK_RELAY_PROCESSING_MODE with split relay modes");
    return;
  }
  const desiredLegacy = delivery.processing_mode;
  const desiredInbound = delivery.inbound_processing_mode ?? desiredLegacy;
  const desiredReply = delivery.reply_processing_mode ?? desiredLegacy;
  const actualInbound = inboundRuntime ?? legacyRuntime ?? "disabled";
  const actualReply = replyRuntime ?? legacyRuntime ?? "disabled";
  for (const [name, actual, desired] of [
    ["MAILDESK_INBOUND_RELAY_MODE", actualInbound, desiredInbound],
    ["MAILDESK_REPLY_RELAY_MODE", actualReply, desiredReply],
  ] as const) {
    if (actual !== "disabled" && actual !== "enabled") {
      failures.push(`${name} must be disabled or enabled`);
    } else if (actual !== desired) {
      failures.push(`${name} (${actual}) must match desired-state split operator delivery configuration (${desired})`);
    }
  }
}

function checkOutboundEnv(desiredState: DesiredState | null) {
  const outboundMode = process.env.MAILDESK_OUTBOUND_MODE?.trim() || "disabled";
  if (!isSenderMode(outboundMode)) {
    failures.push(`MAILDESK_OUTBOUND_MODE must be ${senderModeList()}`);
    return;
  }

  const desiredMode = desiredSenderMode(desiredState);
  if (outboundMode !== desiredMode) {
    failures.push(
      `MAILDESK_OUTBOUND_MODE (${outboundMode}) must match desired-state sender.mode (${desiredMode})`,
    );
  }

  if (!senderModeNeedsProviderReadback(outboundMode)) return;

  checkRequiredEnv("MAILDESK_VERIFIED_SENDER_DOMAINS");
  const senderDomains = process.env.MAILDESK_VERIFIED_SENDER_DOMAINS?.trim();
  if (senderDomains && !isExplicitSenderDomainList(senderDomains)) {
    failures.push(
      "MAILDESK_VERIFIED_SENDER_DOMAINS must be a comma-separated list of explicit DNS domains without wildcards",
    );
  }
  if (outboundMode === "cloudflare_email_service") {
    checkSendEmailBinding(process.env.MAILDESK_MAIL_API_WRANGLER_PATH?.trim() || "wrangler.toml");
  }
  if (outboundMode === "resend") {
    checkRequiredEnvAny(["RESEND_API_KEY", "RESEND"]);
  }
}

function checkReplyApiEnv() {
  const replyApiMode = process.env.MAILDESK_REPLY_API_MODE?.trim() || "disabled";
  if (replyApiMode !== "disabled" && replyApiMode !== "token") {
    failures.push("MAILDESK_REPLY_API_MODE must be disabled or token");
    return;
  }
  if (replyApiMode === "token") {
    checkRequiredEnvAny(["MAILDESK_API_TOKEN", "MAILDESK_PROOF_API_TOKEN"]);
  }
}

function checkRequiredEnvAny(names: string[]) {
  if (names.some((name) => hasUsableEnv(name))) return;
  failures.push(`missing environment variable: set one of ${names.join(", ")}`);
}

function checkAccessValidationEnv() {
  checkRequiredEnv("MAILDESK_ACCESS_TEAM_DOMAIN");
  checkRequiredEnv("MAILDESK_ACCESS_AUD");

  const configuredDomain = process.env.MAILDESK_ACCESS_TEAM_DOMAIN?.trim();
  if (!configuredDomain || !isUsableValue(configuredDomain)) return;

  try {
    const domain = new URL(configuredDomain);
    if (
      domain.protocol !== "https:" ||
      !domain.hostname.endsWith(".cloudflareaccess.com") ||
      domain.pathname !== "/" ||
      domain.search ||
      domain.hash
    ) {
      failures.push(
        "MAILDESK_ACCESS_TEAM_DOMAIN must be an HTTPS Cloudflare Access team origin without a path, query, or fragment",
      );
    }
  } catch {
    failures.push("MAILDESK_ACCESS_TEAM_DOMAIN must be a valid URL");
  }
}

function checkWranglerPlaceholders() {
  for (const file of [
    "deploy/mail-router/wrangler.toml",
    "deploy/mail-outbound/wrangler.toml",
    "deploy/routing-health/wrangler.toml",
  ]) {
    const wrangler = readFileSync(resolve(root, file), "utf8");
    if (wrangler.includes("00000000-0000-0000-0000-000000000000")) {
      failures.push(`${file} still contains placeholder Cloudflare resource IDs`);
    }
  }
}

function checkSendEmailBinding(path: string) {
  let wrangler: string;
  try {
    wrangler = readFileSync(resolve(root, path), "utf8");
  } catch {
    failures.push(`Cloudflare Email Service config is unreadable: ${path}`);
    return;
  }
  if (!/^\s*send_email\s*=/m.test(wrangler) || !/\bname\s*=\s*"EMAIL"/.test(wrangler)) {
    failures.push(`cloudflare_email_service mode requires ${path} send_email binding named "EMAIL"`);
  }
}

function checkTemplateExamples() {
  const policy = readFileSync(resolve(root, "config/policy.example.json"), "utf8");
  if (!policy.includes("example.com")) {
    failures.push("template policy must use reserved example domains");
  }
}

function readCfctlDoctor(): CfctlDoctorSummary | null {
  const command = process.env.CFCTL_BIN ?? "cfctl";
  const result = spawnSync(command, ["doctor", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;

  try {
    const parsed = JSON.parse(result.stdout) as CfctlDoctorResponse;
    const healthyLaneCount =
      parsed.summary?.healthy_lane_count ??
      parsed.summary?.healthy_lanes?.length ??
      parsed.result?.lanes?.summary?.healthy_lane_count ??
      parsed.result?.lanes?.summary?.healthy_lanes?.length ??
      0;
    const v2RuntimeHealthy =
      parsed.result?.build_identity_healthy === true &&
      parsed.result?.path_build?.healthy === true &&
      parsed.result?.instruction_drift === 0;
    const selectedProfileHealthy = isUsableValue(parsed.result?.current_profile);
    const configuredProfileHealthy =
      v2RuntimeHealthy && readConfiguredCfctlProfile(command);
    return {
      healthy:
        parsed.ok === true &&
        (healthyLaneCount > 0 ||
          (v2RuntimeHealthy && selectedProfileHealthy) ||
          configuredProfileHealthy),
    };
  } catch {
    return null;
  }
}

function readConfiguredCfctlProfile(command: string): boolean {
  const profile = process.env.MAILDESK_CFCTL_PROFILE?.trim();
  if (!profile || !isUsableValue(profile)) return false;

  const result = spawnSync(command, ["auth", "status", profile, "--json"], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0 || !result.stdout.trim()) return false;

  try {
    const parsed = JSON.parse(result.stdout) as CfctlAuthStatusResponse;
    if (
      parsed.ok !== true ||
      parsed.result?.credential_available !== true ||
      parsed.result?.profile?.id !== profile
    ) {
      return false;
    }

    const expectedAccount = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
    return (
      !expectedAccount ||
      parsed.result.profile.account_id === expectedAccount
    );
  } catch {
    return false;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

function isUsableValue(value: unknown): boolean {
  const text = stringValue(value);
  return Boolean(text && !text.startsWith("<") && !text.includes("replace-me"));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isExplicitSenderDomainList(value: string): boolean {
  const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const domains = value
    .split(",")
    .map((domain) => domain.trim().toLowerCase());
  return domains.length > 0 && domains.every((domain) => domainPattern.test(domain));
}

interface CfctlDoctorSummary {
  healthy: boolean;
}

interface CfctlDoctorResponse {
  ok?: boolean;
  summary?: {
    healthy_lane_count?: number;
    healthy_lanes?: string[];
  };
  result?: {
    build_identity_healthy?: boolean;
    current_profile?: unknown;
    instruction_drift?: number;
    path_build?: {
      healthy?: boolean;
    };
    lanes?: {
      summary?: {
        healthy_lane_count?: number;
        healthy_lanes?: string[];
      };
    };
  };
}

interface CfctlAuthStatusResponse {
  ok?: boolean;
  result?: {
    credential_available?: boolean;
    profile?: {
      id?: string;
      account_id?: string;
    };
  };
}
