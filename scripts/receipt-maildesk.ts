import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { collectGitCandidate, type GitCandidate } from "./git-candidate";

interface Receipt {
  candidate?: GitCandidate;
  candidate_sha256?: string;
  status?: {
    local_truth_ok?: boolean;
    edge_ready?: boolean;
    mail_ready?: boolean;
    live_evidence_present?: boolean;
  };
  rows?: unknown[];
  gaps?: Array<{ readiness?: string }>;
}

interface ProofPlan {
  candidate?: GitCandidate;
  candidate_sha256?: string;
  summary?: {
    action_count?: number;
    inbound_probe_count?: number;
    outbound_reply_probe_count?: number;
    blocked_count?: number;
    sender_domain_blocked_count?: number;
    sender_domain_plan_ready_count?: number;
    sender_domain_plan_missing_count?: number;
  };
}

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const requireLive = args.includes("--require-live");
const requirePlanReady = args.includes("--require-plan-ready");
const skipCollect = args.includes("--skip-collect");
const explicitEvidencePath = Boolean(argValue("--evidence"));
const evidencePath = argValue("--evidence") ?? "var/maildesk-live-evidence.json";
const receiptPath = argValue("--receipt") ?? "var/maildesk-receipt.json";
const planPath = argValue("--plan") ?? "var/maildesk-proof-plan.json";
const summaryPath = argValue("--summary");

if (!skipCollect) {
  const collectArgs = [
    "--out",
    evidencePath,
    ...forwardValue("--policy"),
    ...forwardValue("--desired-state"),
    ...forwardValue("--cfctl"),
    ...forwardValue("--wrangler"),
    ...forwardValue("--readyz-url"),
    ...forwardValue("--d1-database"),
    ...forwardValue("--google-admin"),
    ...(args.includes("--no-resend") ? ["--no-resend"] : []),
  ];
  runInherited("collect live evidence", ["run", "scripts/collect-live-evidence.ts", "--", ...collectArgs]);
}

const verifyArgs = [
  ...(skipCollect && !explicitEvidencePath ? [] : ["--evidence", evidencePath]),
  "--json",
  ...forwardValue("--policy"),
  ...forwardValue("--desired-state"),
  ...(requireLive ? ["--require-live"] : []),
];
const verify = runCaptured("verify maildesk receipt", ["run", "scripts/verify-maildesk.ts", "--", ...verifyArgs]);
const verifiedReceipt = parseJson<Receipt>(verify.stdout, "verify maildesk receipt");
const candidateBinding = collectGitCandidate(root);
const receipt: Receipt = { ...verifiedReceipt, ...candidateBinding };
writeJson(receiptPath, receipt);

const planArgs = [
  "--receipt",
  receiptPath,
  "--json",
  ...forwardValue("--policy"),
  ...forwardValue("--plan-manifest"),
  ...(requirePlanReady ? ["--require-plan-ready"] : []),
];
const planResult = runCaptured("plan mail proof gaps", ["run", "scripts/plan-mail-proofs.ts", "--", ...planArgs]);
const proofPlan = parseJson<ProofPlan>(planResult.stdout, "plan mail proof gaps");
writeJson(planPath, proofPlan);

const summary = {
  ...candidateBinding,
  evidence_path: skipCollect && !explicitEvidencePath ? null : relativePath(resolve(root, evidencePath)),
  receipt_path: relativePath(resolve(root, receiptPath)),
  plan_path: relativePath(resolve(root, planPath)),
  summary_path: summaryPath ? relativePath(resolve(root, summaryPath)) : null,
  local_truth_ok: receipt.status?.local_truth_ok ?? false,
  live_evidence_present: receipt.status?.live_evidence_present ?? false,
  edge_ready: receipt.status?.edge_ready ?? false,
  mail_ready: receipt.status?.mail_ready ?? false,
  domain_count: receipt.rows?.length ?? 0,
  gap_count: receipt.gaps?.length ?? 0,
  local_gap_count: countReadiness(receipt, "local"),
  edge_gap_count: countReadiness(receipt, "edge"),
  mail_gap_count: countReadiness(receipt, "mail"),
  proof_actions: proofPlan.summary?.action_count ?? 0,
  targeted_inbound_probes: proofPlan.summary?.inbound_probe_count ?? 0,
  targeted_outbound_reply_probes: proofPlan.summary?.outbound_reply_probe_count ?? 0,
  blocked_proofs: proofPlan.summary?.blocked_count ?? 0,
  sender_domain_blocked_count: proofPlan.summary?.sender_domain_blocked_count ?? 0,
  sender_domain_plan_ready_count: proofPlan.summary?.sender_domain_plan_ready_count ?? 0,
  sender_domain_plan_missing_count: proofPlan.summary?.sender_domain_plan_missing_count ?? 0,
};

if (summaryPath) {
  writeJson(summaryPath, summary);
}

if (jsonOutput) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`evidence ${summary.evidence_path}`);
  console.log(`receipt ${summary.receipt_path}`);
  console.log(`proof_plan ${summary.plan_path}`);
  console.log(`domains ${summary.domain_count}`);
  console.log(`local_truth_ok ${summary.local_truth_ok}`);
  console.log(`live_evidence_present ${summary.live_evidence_present}`);
  console.log(`edge_ready ${summary.edge_ready}`);
  console.log(`mail_ready ${summary.mail_ready}`);
  console.log(
    `gaps local=${summary.local_gap_count} edge=${summary.edge_gap_count} mail=${summary.mail_gap_count}`,
  );
  console.log(
    `proof_actions total=${summary.proof_actions} inbound=${summary.targeted_inbound_probes} outbound=${summary.targeted_outbound_reply_probes} blocked=${summary.blocked_proofs}`,
  );
  console.log(
    `sender_domain_plan_ready ${summary.sender_domain_plan_ready_count}/${summary.sender_domain_blocked_count}`,
  );
}

if (verify.status !== 0 || planResult.status !== 0) {
  process.exit(1);
}

function argValue(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function forwardValue(name: string): string[] {
  const value = argValue(name);
  return value ? [name, value] : [];
}

function runInherited(label: string, commandArgs: string[]): void {
  const result = spawnSync("bun", commandArgs, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`${label} failed`);
    process.exit(result.status ?? 1);
  }
}

function runCaptured(label: string, commandArgs: string[]): { status: number; stdout: string } {
  const result = spawnSync("bun", commandArgs, { cwd: root, encoding: "utf8" });
  if (result.stderr) process.stderr.write(result.stderr);
  if (!result.stdout) {
    console.error(`${label} produced no output`);
    process.exit(result.status ?? 1);
  }
  return { status: result.status ?? 0, stdout: result.stdout };
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

function countReadiness(receipt: Receipt, readiness: string): number {
  return receipt.gaps?.filter((gap) => gap.readiness === readiness).length ?? 0;
}

function relativePath(path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
