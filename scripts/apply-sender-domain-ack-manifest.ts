import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  CFCTL_COMMAND_CONTRACT_VERSION,
  SENDER_DOMAIN_CREATE_CAPABILITY,
  planLifecycle,
  senderDomainPlanManifestItem,
  senderDomainPlanV2Failure,
  type PlanLifecycle,
} from "./cfctl-v2-command-contract";

interface PlanManifest {
  schema_version?: number;
  items?: unknown[];
}

interface ReadyPlan {
  index: number;
  domain: string;
  capability_id: typeof SENDER_DOMAIN_CREATE_CAPABILITY;
  profile_id: string;
  account_id: string;
  zone_id: string;
  operation_id: string;
  plan_content_hash: string;
  evidence_hashes: string[];
  lifecycle: PlanLifecycle;
}

interface CfctlEnvelope {
  schema_version?: number;
  ok?: boolean;
  performed?: boolean;
  operation_id?: string | null;
  error?: { code?: string } | null;
  result?: unknown;
  capability_id?: string | null;
}

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const confirmPlan = args.includes("--confirm-plan");
const confirmBulkPlan = args.includes("--confirm-bulk-plan");
const jsonOutput = args.includes("--json");
const manifestPath = argValue("--manifest") ?? "var/proof/maildesk-sender-domain-plan-manifest.local.json";
const outPath = argValue("--out");
const cfctlBin = argValue("--cfctl") ?? "cfctl";
const domainFilter = argValue("--domain");
const limit = args.includes("--all")
  ? Number.POSITIVE_INFINITY
  : Number(argValue("--limit") ?? (execute ? "1" : "Infinity"));

if (execute && !confirmPlan) {
  console.error("missing --confirm-plan for --execute");
  process.exit(1);
}

if (!Number.isFinite(limit) && !args.includes("--all") && !(!execute && argValue("--limit") === undefined)) {
  console.error("invalid --limit");
  process.exit(1);
}

const manifest = readJson<PlanManifest | unknown[]>(resolve(root, manifestPath));
const items = Array.isArray(manifest) ? manifest : manifest.items ?? [];
const ready = items
  .map((item, index) => normalizedPlan(item, index + 1))
  .filter((item): item is ReadyPlan => Boolean(item))
  .filter((item) => !domainFilter || item.domain === domainFilter)
  .slice(0, limit);

if (execute && ready.length > 1 && !confirmBulkPlan) {
  console.error("missing --confirm-bulk-plan for bulk --execute");
  process.exit(1);
}

const results = ready.map((item) => executePlan(item));
const summary = {
  mode: execute ? "execute" : "dry_run",
  manifest_path: relativePath(resolve(root, manifestPath)),
  requested_domain: domainFilter ?? null,
  ready_count: ready.length,
  executed_count: results.filter((result) => result.status === "executed").length,
  dry_run_count: results.filter((result) => result.status === "dry_run").length,
  results,
};

if (outPath) writeJson(outPath, summary);

if (jsonOutput) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  for (const result of results) console.log(`${result.status} ${result.domain} ${result.operation_id}`);
  console.log(`mode ${summary.mode}`);
  console.log(`ready_count ${summary.ready_count}`);
  console.log(`executed_count ${summary.executed_count}`);
  console.log(`dry_run_count ${summary.dry_run_count}`);
}

function normalizedPlan(value: unknown, index: number): ReadyPlan | null {
  const item = senderDomainPlanManifestItem(value);
  if (!item) return null;
  return {
    index,
    domain: item.target,
    capability_id: SENDER_DOMAIN_CREATE_CAPABILITY,
    profile_id: item.profile_id,
    account_id: item.account_id,
    zone_id: item.zone_id,
    operation_id: item.operation_id,
    plan_content_hash: item.plan_content_hash,
    evidence_hashes: [...item.evidence_hashes],
    lifecycle: planLifecycle(item.operation_id),
  };
}

function executePlan(item: ReadyPlan) {
  if (!execute) {
    return {
      status: "dry_run" as const,
      index: item.index,
      domain: item.domain,
      capability_id: item.capability_id,
      profile_id: item.profile_id,
      account_id: item.account_id,
      zone_id: item.zone_id,
      operation_id: item.operation_id,
      lifecycle: item.lifecycle,
    };
  }

  runLifecycleStep(item, "show", false, true);
  runLifecycleStep(item, "approve", false);
  runLifecycleStep(item, "run", true);
  runLifecycleStep(item, "status", false);
  return {
    status: "executed" as const,
    index: item.index,
    domain: item.domain,
    capability_id: item.capability_id,
    profile_id: item.profile_id,
    account_id: item.account_id,
    zone_id: item.zone_id,
    operation_id: item.operation_id,
  };
}

function runLifecycleStep(
  item: ReadyPlan,
  step: keyof PlanLifecycle,
  expectedPerformed: boolean,
  requirePlanEvidence = false,
): void {
  const argv = item.lifecycle[step];
  const result = spawnSync(cfctlBin, argv.slice(1), { cwd: root, encoding: "utf8" });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0 || !result.stdout) process.exit(result.status ?? 1);
  const envelope = parseJson<CfctlEnvelope>(result.stdout, `PlanV2 ${step}`);
  const shownPlanV2 = isRecord(envelope.result) ? envelope.result.plan_v2 : undefined;
  const planFailure = requirePlanEvidence
    ? senderDomainPlanV2Failure(shownPlanV2, {
        operation_id: item.operation_id,
        profile_id: item.profile_id,
        account_id: item.account_id,
        zone_id: item.zone_id,
        target: item.domain,
        plan_content_hash: item.plan_content_hash,
      })
    : null;
  if (
    envelope.schema_version !== CFCTL_COMMAND_CONTRACT_VERSION ||
    envelope.ok !== true ||
    envelope.performed !== expectedPerformed ||
    envelope.error ||
    (requirePlanEvidence && envelope.capability_id !== item.capability_id) ||
    (envelope.operation_id !== null && envelope.operation_id !== undefined &&
      envelope.operation_id !== item.operation_id) ||
    planFailure
  ) {
    console.error(`PlanV2 ${step} envelope mismatch for ${item.operation_id}`);
    process.exit(1);
  }
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
