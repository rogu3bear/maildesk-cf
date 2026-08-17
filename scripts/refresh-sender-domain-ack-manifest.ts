import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  CFCTL_COMMAND_CONTRACT_VERSION,
  SENDER_DOMAIN_CREATE_CAPABILITY,
  ZONE_LOOKUP_CAPABILITY,
  isSenderDomainPlanRequest,
  planV2ContentHash,
  planLifecycle,
  senderDomainPlanV2Failure,
  type SenderDomainPlanRequest,
} from "./cfctl-v2-command-contract";

interface ProofPlan {
  actions?: ProofAction[];
}

interface ProofAction {
  kind?: string;
  blocked_by?: string;
  plan_request?: unknown;
}

interface CfctlEnvelope {
  schema_version?: number;
  ok?: boolean;
  performed?: boolean;
  capability_id?: string | null;
  operation_id?: string | null;
  profile_id?: string | null;
  account_id?: string | null;
  evidence?: Array<{ content_hash?: string }>;
  result?: unknown;
  error?: { code?: string } | null;
}

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const planPath = argValue("--plan") ?? "var/maildesk-proof-plan.json";
const outPath = argValue("--out") ?? "var/proof/maildesk-sender-domain-plan-manifest.local.json";
const previewDir = argValue("--preview-dir") ?? "var/proof/sender-domain-plan-previews";
const cfctlBin = argValue("--cfctl") ?? "cfctl";
const profileId = argValue("--profile") ?? process.env.MAILDESK_CFCTL_PROFILE?.trim();

if (!profileId) {
  console.error("missing explicit cfctl profile: set MAILDESK_CFCTL_PROFILE or pass --profile");
  process.exit(1);
}

const accountId = resolveProfileAccount(profileId);
const proofPlan = readJson<ProofPlan>(resolve(root, planPath));
const planActions = (proofPlan.actions ?? []).filter(
  (action): action is ProofAction & { plan_request: SenderDomainPlanRequest } =>
    action.kind === "blocked" &&
    action.blocked_by === "sender_domain_not_verified" &&
    isSenderDomainPlanRequest(action.plan_request),
);

mkdirSync(resolve(root, previewDir), { recursive: true });

const items = planActions.map((action, index) => {
  const request = action.plan_request;
  const zoneId = resolveZoneId(request.target.zone_name, profileId, accountId);
  const result = spawnSync(
    cfctlBin,
    [
      "call",
      request.capability_id,
      "--selector",
      `zone_id=${zoneId}`,
      "--profile",
      profileId,
      "--account",
      accountId,
      "--body-stdin",
      "--json",
    ],
    {
      cwd: root,
      encoding: "utf8",
      input: `${JSON.stringify(request.body)}\n`,
    },
  );
  const previewPath = resolve(root, previewDir, `plan-${String(index + 1).padStart(2, "0")}.json`);
  if (result.stdout) {
    writeFileSync(previewPath, result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
  }
  if (result.status !== 0 || !result.stdout) {
    if (result.stderr) process.stderr.write(result.stderr);
    console.error(`sender-domain PlanV2 preview failed at index ${index + 1}`);
    process.exit(result.status ?? 1);
  }

  const envelope = parseJson<CfctlEnvelope>(result.stdout, `sender-domain PlanV2 preview ${index + 1}`);
  const operationId = envelope.operation_id;
  const planEvidenceHashes = evidenceHashes(envelope);
  if (
    envelope.schema_version !== CFCTL_COMMAND_CONTRACT_VERSION ||
    envelope.ok !== true ||
    envelope.performed !== false ||
    envelope.error ||
    envelope.capability_id !== SENDER_DOMAIN_CREATE_CAPABILITY ||
    envelope.profile_id !== profileId ||
    envelope.account_id !== accountId ||
    typeof operationId !== "string" ||
    operationId.length === 0 ||
    planEvidenceHashes.length === 0
  ) {
    console.error(`sender-domain PlanV2 preview envelope mismatch at index ${index + 1}`);
    process.exit(1);
  }
  const planV2 = recordValue(envelope.result, "plan_v2");
  const planFailure = senderDomainPlanV2Failure(planV2, {
    operation_id: operationId,
    profile_id: profileId,
    account_id: accountId,
    zone_id: zoneId,
    target: request.target.sending_subdomain_name,
  });
  const planContentHash = planV2ContentHash(planV2);
  if (planFailure || !planContentHash) {
    console.error(`sender-domain PlanV2 content mismatch at index ${index + 1}: ${planFailure}`);
    process.exit(1);
  }

  const expiresAt = planExpiresAt(envelope.result);
  return {
    schema_version: CFCTL_COMMAND_CONTRACT_VERSION,
    index: index + 1,
    ok: true,
    performed: false,
    capability_id: SENDER_DOMAIN_CREATE_CAPABILITY,
    profile_id: profileId,
    account_id: accountId,
    zone_id: zoneId,
    target: request.target.sending_subdomain_name,
    operation_id: operationId,
    plan_content_hash: planContentHash,
    evidence_hashes: planEvidenceHashes,
    ...(expiresAt ? { plan_expires_at: expiresAt } : {}),
    lifecycle: planLifecycle(operationId),
  };
});

writeJson(outPath, { schema_version: CFCTL_COMMAND_CONTRACT_VERSION, items });

const summary = {
  plan_path: relativePath(resolve(root, planPath)),
  manifest_path: relativePath(resolve(root, outPath)),
  preview_dir: relativePath(resolve(root, previewDir)),
  preview_count: items.length,
  plan_ready_count: items.length,
  failed_count: 0,
};

if (jsonOutput) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`plan ${summary.plan_path}`);
  console.log(`manifest ${summary.manifest_path}`);
  console.log(`preview_dir ${summary.preview_dir}`);
  console.log(`sender_domain_plans ${summary.preview_count}`);
  console.log(`sender_domain_plan_ready ${summary.plan_ready_count}/${summary.preview_count}`);
}

function resolveProfileAccount(profile: string): string {
  const result = spawnSync(cfctlBin, ["auth", "profiles", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout) {
    console.error("cfctl profile read failed");
    process.exit(1);
  }
  const envelope = parseJson<CfctlEnvelope>(result.stdout, "cfctl profiles");
  if (
    envelope.schema_version !== CFCTL_COMMAND_CONTRACT_VERSION ||
    envelope.ok !== true ||
    envelope.performed !== false ||
    envelope.error
  ) {
    console.error("cfctl profile envelope is not a valid non-performing v2 result");
    process.exit(1);
  }
  const profiles = recordArray(recordValue(envelope.result, "profiles"));
  const selected = profiles.find((entry) => entry.id === profile);
  if (typeof selected?.account_id !== "string" || selected.account_id.length === 0) {
    console.error("explicit cfctl profile is not bound to an account");
    process.exit(1);
  }
  return selected.account_id;
}

function resolveZoneId(domain: string, profile: string, account: string): string {
  const result = spawnSync(
    cfctlBin,
    [
      "call",
      ZONE_LOOKUP_CAPABILITY,
      "--query",
      `name=${domain}`,
      "--query",
      `account.id=${account}`,
      "--query",
      "page=1",
      "--query",
      "per_page=5",
      "--profile",
      profile,
      "--account",
      account,
      "--json",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0 || !result.stdout) {
    console.error(`zone lookup failed for ${domain}`);
    process.exit(1);
  }
  const envelope = parseJson<CfctlEnvelope>(result.stdout, `zone lookup for ${domain}`);
  if (
    envelope.schema_version !== CFCTL_COMMAND_CONTRACT_VERSION ||
    envelope.ok !== true ||
    envelope.performed !== true ||
    envelope.error ||
    envelope.capability_id !== ZONE_LOOKUP_CAPABILITY ||
    envelope.profile_id !== profile ||
    envelope.account_id !== account ||
    evidenceHashes(envelope).length === 0
  ) {
    console.error(`zone lookup envelope mismatch for ${domain}`);
    process.exit(1);
  }
  const records = recordArray(recordValue(envelope.result, "result"));
  const matches = records.filter((entry) => entry.name === domain && entry.status === "active");
  if (matches.length !== 1 || typeof matches[0]?.id !== "string" || matches[0].id.length === 0) {
    console.error(`zone lookup did not return one active exact match for ${domain}`);
    process.exit(1);
  }
  return matches[0].id;
}

function evidenceHashes(envelope: CfctlEnvelope): string[] {
  return (envelope.evidence ?? [])
    .map((entry) => entry.content_hash)
    .filter((value): value is string =>
      typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value)
    );
}

function planExpiresAt(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  for (const candidate of [result.preview_expires_at, result.expires_at]) {
    if (typeof candidate === "string" && Number.isFinite(Date.parse(candidate))) return candidate;
  }
  if (isRecord(result.plan) && typeof result.plan.expires_at === "string") return result.plan.expires_at;
  return undefined;
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function recordArray(value: unknown): Array<Record<string, any>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function argValue(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.error(`${label} did not produce valid JSON`);
    throw error;
  }
}

function writeJson(path: string, value: unknown): void {
  const absolutePath = resolve(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`);
}

function relativePath(path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
