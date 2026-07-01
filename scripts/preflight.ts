import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Mode = "template" | "production";

interface DesiredState {
  project?: {
    name?: unknown;
    account_id?: unknown;
    account_id_env?: unknown;
  };
}

const root = resolve(import.meta.dir, "..");
const args = new Set(process.argv.slice(2));
const failures: string[] = [];
const warnings: string[] = [];
const mode: Mode = args.has("--mode")
  ? parseMode(process.argv[process.argv.indexOf("--mode") + 1])
  : args.has("--production")
    ? "production"
    : "template";

checkCommand("bun", ["--version"], true);
checkCommand("cargo", ["--version"], true);
checkCommand("rustc", ["--version"], true);
checkCommand(process.env.CFCTL_BIN ?? "cfctl", ["--help"], mode === "production");

checkFile("Cargo.toml");
checkFile("wrangler.toml");
checkFile("wrangler.mail-router.toml");
checkFile("config/policy.example.json");
checkFile("config/desired-state.example.json");
checkFile("scripts/check-template.sh");

const desiredStatePath =
  process.env.MAILDESK_DESIRED_STATE_PATH ??
  (mode === "production" && existsSync(resolve(root, "config/desired-state.local.json"))
    ? "config/desired-state.local.json"
    : "config/desired-state.example.json");
const desiredState = checkJson<DesiredState>(desiredStatePath);

const policyPath =
  process.env.MAILDESK_POLICY_PATH ??
  (mode === "production" && existsSync(resolve(root, "config/policy.local.json"))
    ? "config/policy.local.json"
    : "config/policy.example.json");

checkFile(policyPath);
checkPolicy(policyPath);

if (mode === "production") {
  const cfctlDoctor = readCfctlDoctor();
  checkCloudflareAccountTarget(desiredState, cfctlDoctor);
  checkCloudflareAuthEnv(cfctlDoctor);
  checkProjectName(desiredState);
  checkRequiredEnv("MAILDESK_API_TOKEN");
  checkOutboundEnv();
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

function checkFile(path: string) {
  if (!existsSync(resolve(root, path))) {
    failures.push(`missing required file: ${path}`);
  }
}

function checkCommand(command: string, args: string[], required: boolean) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status === 0) return;

  const message = `command unavailable or failing: ${command}`;
  if (required) failures.push(message);
  else warnings.push(message);
}

function checkPolicy(path: string) {
  const result = spawnSync(
    "cargo",
    ["run", "--quiet", "--bin", "maildesk-policy-check", "--", path],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status === 0) return;

  failures.push(
    `policy validation failed for ${path}: ${result.stderr.trim() || result.stdout.trim()}`,
  );
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
  cfctlDoctor: CfctlDoctorSummary | null,
) {
  if (hasUsableEnv("CLOUDFLARE_ACCOUNT_ID")) return;
  if (isUsableValue(desiredState?.project?.account_id)) return;

  const accountIdEnv = stringValue(desiredState?.project?.account_id_env);
  if (accountIdEnv && hasUsableEnv(accountIdEnv)) return;
  if (cfctlDoctor?.healthy) return;

  failures.push(
    "missing Cloudflare account target: set CLOUDFLARE_ACCOUNT_ID, desired-state project.account_id, or provide a healthy cfctl doctor lane",
  );
}

function checkCloudflareAuthEnv(cfctlDoctor: CfctlDoctorSummary | null) {
  if (hasUsableEnv("CLOUDFLARE_API_TOKEN")) return;
  if (hasUsableEnv("CLOUDFLARE_API_KEY") && hasUsableEnv("CLOUDFLARE_EMAIL")) return;
  if (hasUsableEnv("CF_DEV_TOKEN") || hasUsableEnv("CF_GLOBAL_TOKEN")) return;
  if (cfctlDoctor?.healthy) return;

  failures.push(
    "missing Cloudflare auth: set CLOUDFLARE_API_TOKEN, CLOUDFLARE_API_KEY plus CLOUDFLARE_EMAIL, CF_DEV_TOKEN, CF_GLOBAL_TOKEN, or provide a healthy cfctl doctor lane",
  );
}

function checkOutboundEnv() {
  const outboundMode = process.env.MAILDESK_OUTBOUND_MODE?.trim() || "disabled";
  const validModes = new Set(["disabled", "cloudflare_email_service", "resend"]);
  if (!validModes.has(outboundMode)) {
    failures.push(
      "MAILDESK_OUTBOUND_MODE must be disabled, cloudflare_email_service, or resend",
    );
    return;
  }

  if (outboundMode === "disabled") return;

  checkRequiredEnv("MAILDESK_VERIFIED_SENDER_DOMAINS");
  if (outboundMode === "resend") {
    checkRequiredEnvAny(["RESEND_API_KEY", "RESEND"]);
  }
}

function checkRequiredEnvAny(names: string[]) {
  if (names.some((name) => hasUsableEnv(name))) return;
  failures.push(`missing environment variable: set one of ${names.join(", ")}`);
}

function checkWranglerPlaceholders() {
  for (const file of ["wrangler.toml", "wrangler.mail-router.toml"]) {
    const wrangler = readFileSync(resolve(root, file), "utf8");
    if (wrangler.includes("00000000-0000-0000-0000-000000000000")) {
      failures.push(`${file} still contains placeholder Cloudflare resource IDs`);
    }
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
  const result = spawnSync(command, ["doctor"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) return null;

  try {
    const parsed = JSON.parse(result.stdout) as CfctlDoctorResponse;
    const healthyLaneCount =
      parsed.summary?.healthy_lane_count ??
      parsed.summary?.healthy_lanes?.length ??
      parsed.result?.lanes?.summary?.healthy_lane_count ??
      parsed.result?.lanes?.summary?.healthy_lanes?.length ??
      0;
    return { healthy: parsed.ok === true && healthyLaneCount > 0 };
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

function isUsableValue(value: unknown): boolean {
  const text = stringValue(value);
  return Boolean(text && !text.startsWith("<") && !text.includes("replace-me"));
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
    lanes?: {
      summary?: {
        healthy_lane_count?: number;
        healthy_lanes?: string[];
      };
    };
  };
}
