import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Mode = "template" | "production";

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
checkJson("config/desired-state.example.json");

const policyPath =
  process.env.MAILDESK_POLICY_PATH ??
  (mode === "production" && existsSync(resolve(root, "config/policy.local.json"))
    ? "config/policy.local.json"
    : "config/policy.example.json");

checkFile(policyPath);
checkPolicy(policyPath);

if (mode === "production") {
  checkRequiredEnv("CLOUDFLARE_ACCOUNT_ID");
  checkCloudflareAuthEnv();
  checkRequiredEnv("MAILDESK_PROJECT_NAME");
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

function checkJson(path: string) {
  try {
    JSON.parse(readFileSync(resolve(root, path), "utf8"));
  } catch (error) {
    failures.push(`invalid JSON in ${path}: ${errorDetail(error)}`);
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

function checkCloudflareAuthEnv() {
  if (hasUsableEnv("CLOUDFLARE_API_TOKEN")) return;
  if (hasUsableEnv("CLOUDFLARE_API_KEY") && hasUsableEnv("CLOUDFLARE_EMAIL")) return;

  failures.push(
    "missing Cloudflare auth: set CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY plus CLOUDFLARE_EMAIL",
  );
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
