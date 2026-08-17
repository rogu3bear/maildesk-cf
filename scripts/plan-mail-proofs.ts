import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isSenderMode, senderModeOrDefault, type SenderMode } from "./sender-mode";
import {
  planLifecycle,
  senderDomainPlanManifestItem,
  senderDomainPlanRequest,
  senderDomainVerifyRequest,
  type PlanLifecycle,
  type SenderDomainPlanRequest,
  type SenderDomainVerifyRequest,
} from "./cfctl-v2-command-contract";

interface Receipt {
  rows: DomainRow[];
  gaps: ReceiptGap[];
}

interface DomainRow {
  domain: string;
  inbound_mx?: Status;
  inbound_mx_provider?: string | null;
  inbound_proof: Status;
  outbound_sender: Status;
  outbound_proof: Status;
  sender_domain?: {
    provider?: string;
  };
}

interface ReceiptGap {
  domain: string;
  field: string;
  status: Status;
  readiness: "local" | "edge" | "mail";
}

interface PolicyFile {
  domains: Record<string, PolicyDomain>;
}

interface PolicyDomain {
  role_aliases: Record<string, RoleAlias>;
  personal_aliases: Record<string, PersonalAlias>;
}

interface RoleAlias {
  operators: string[];
  reply_identity: string;
}

interface PersonalAlias {
  operator: string;
  reply_identity: string;
}

type Status = "ok" | "drift" | "missing" | "not_checked";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const requirePlanReady = args.includes("--require-plan-ready");
const receiptPath = argValue("--receipt");
if (!receiptPath) {
  console.error("missing --receipt <path>");
  process.exit(1);
}

const policyPath = resolve(root, argValue("--policy") ?? defaultPolicyPath());
const receipt = readJson<Receipt>(resolve(root, receiptPath));
const policy = readJson<PolicyFile>(policyPath);
const planManifestPath = argValue("--plan-manifest");
if (
  args.includes("--plan-manifest") &&
  (!planManifestPath || planManifestPath.startsWith("--"))
) {
  console.error("missing --plan-manifest <path>");
  process.exit(1);
}
const planManifest = loadPlanManifest(planManifestPath);
const actions = buildActions(receipt, policy);
const senderDomainPlans = senderDomainPlanSummary(actions);
const plan = {
  generated_at: new Date().toISOString(),
  receipt_path: relativePath(resolve(root, receiptPath)),
  policy_path: relativePath(policyPath),
  summary: {
    action_count: actions.length,
    inbound_probe_count: actions.filter((action) => action.kind === "targeted_inbound_probe").length,
    outbound_reply_probe_count: actions.filter((action) => action.kind === "targeted_outbound_reply_probe").length,
    blocked_count: actions.filter((action) => action.kind === "blocked").length,
    sender_domain_blocked_count: senderDomainPlans.blocked,
    sender_domain_plan_ready_count: senderDomainPlans.ready,
    sender_domain_plan_missing_count: senderDomainPlans.missing,
  },
  actions,
};

if (jsonOutput) {
  console.log(JSON.stringify(plan, null, 2));
} else {
  for (const action of actions) {
    console.log(`${action.kind} ${action.domain}: ${action.description}`);
  }
  console.log("");
  console.log(`actions ${plan.summary.action_count}`);
  console.log(`targeted_inbound_probes ${plan.summary.inbound_probe_count}`);
  console.log(`targeted_outbound_reply_probes ${plan.summary.outbound_reply_probe_count}`);
  console.log(`blocked ${plan.summary.blocked_count}`);
  console.log(
    `sender_domain_plan_ready ${plan.summary.sender_domain_plan_ready_count}/${plan.summary.sender_domain_blocked_count}`,
  );
}

if (requirePlanReady && senderDomainPlans.missing > 0) {
  console.error(
    `sender-domain PlanV2 operations are not ready: missing ${senderDomainPlans.missing} of ${senderDomainPlans.blocked}`,
  );
  process.exit(1);
}

function buildActions(receipt: Receipt, policy: PolicyFile): ProofAction[] {
  const rowsByDomain = new Map(receipt.rows.map((row) => [row.domain, row]));
  const actions: ProofAction[] = [];

  for (const gap of receipt.gaps.filter((gap) => gap.readiness === "mail")) {
    const row = rowsByDomain.get(gap.domain);
    const policyDomain = policy.domains[gap.domain];
    if (!row || !policyDomain) continue;

    if (isReservedExampleDomain(gap.domain)) {
      actions.push({
        kind: "blocked",
        domain: gap.domain,
        blocked_by: "template_desired_state",
        description:
          "copy config/desired-state.example.json to config/desired-state.local.json and config/policy.example.json to config/policy.local.json with a real domain before live mail proof",
      });
      continue;
    }

    if (gap.field === "inbound_proof") {
      if (row.inbound_mx_provider && row.inbound_mx_provider !== "cloudflare_email_routing") {
        actions.push({
          kind: "blocked",
          domain: gap.domain,
          blocked_by: "inbound_provider",
          description: "root-domain MX is intentionally handled outside Cloudflare Email Routing",
        });
      } else if (row.inbound_mx && row.inbound_mx !== "ok") {
        actions.push({
          kind: "blocked",
          domain: gap.domain,
          blocked_by: "inbound_mx",
          description: "repair root-domain MX before attempting inbound proof",
        });
      } else {
        const target = inboundTarget(gap.domain, policyDomain);
        actions.push({
          kind: "targeted_inbound_probe",
          domain: gap.domain,
          target,
          description: `send one targeted inbound proof message to ${target}, then recollect evidence`,
        });
      }
    }

    if (gap.field === "outbound_sender") {
      const senderMode = rowSenderMode(row);
      actions.push({
        kind: "blocked",
        domain: gap.domain,
        ...senderRepairAction(senderMode, gap.domain),
      });
    }

    if (gap.field === "outbound_proof") {
      if (row.inbound_mx && row.inbound_mx !== "ok") {
        actions.push({
          kind: "blocked",
          domain: gap.domain,
          blocked_by: "inbound_mx",
          description: "repair root-domain MX before attempting outbound reply proof",
        });
      } else if (row.inbound_mx_provider === "cloudflare_email_routing" && row.inbound_proof !== "ok") {
        actions.push({
          kind: "blocked",
          domain: gap.domain,
          blocked_by: "inbound_proof",
          description: "collect inbound proof first so outbound proof can reply from an audited thread",
        });
      } else if (row.outbound_sender !== "ok") {
        const senderMode = rowSenderMode(row);
        actions.push({
          kind: "blocked",
          domain: gap.domain,
          ...senderRepairAction(senderMode, gap.domain),
        });
      } else {
        const identity = outboundIdentity(gap.domain, policyDomain);
        actions.push({
          kind: "targeted_outbound_reply_probe",
          domain: gap.domain,
          from_identity: identity,
          description: `send one audited reply proof from ${identity}, then recollect evidence`,
        });
      }
    }
  }

  return actions;
}

function senderDomainPlanSummary(actions: ProofAction[]): SenderDomainPlanSummary {
  const blocked = actions.filter(
    (action) => action.kind === "blocked" && action.blocked_by === "sender_domain_not_verified",
  );
  const ready = blocked.filter(
    (action) =>
      typeof action.operation_id === "string" &&
      action.operation_id.length > 0 &&
      Boolean(action.lifecycle),
  );
  return {
    blocked: blocked.length,
    ready: ready.length,
    missing: blocked.length - ready.length,
  };
}

function inboundTarget(domain: string, policyDomain: PolicyDomain): string {
  if (policyDomain.role_aliases.founders) return `founders@${domain}`;
  const role = Object.keys(policyDomain.role_aliases).sort()[0];
  if (role) return `${role}@${domain}`;
  const personal = Object.keys(policyDomain.personal_aliases).sort()[0];
  return `${personal}@${domain}`;
}

function outboundIdentity(domain: string, policyDomain: PolicyDomain): string {
  if (policyDomain.role_aliases.founders) return policyDomain.role_aliases.founders.reply_identity;
  const role = Object.values(policyDomain.role_aliases).sort((left, right) =>
    left.reply_identity.localeCompare(right.reply_identity),
  )[0];
  if (role) return role.reply_identity;
  const personal = Object.values(policyDomain.personal_aliases).sort((left, right) =>
    left.reply_identity.localeCompare(right.reply_identity),
  )[0];
  return personal?.reply_identity ?? `postmaster@${domain}`;
}

function isReservedExampleDomain(domain: string): boolean {
  return domain === "example.com" || domain === "example.net" || domain === "example.org";
}

function senderDomainRepairCommands(domain: string): SenderDomainRepairCommands {
  const preparedPlan = planManifest.get(domain);
  return {
    plan_request: senderDomainPlanRequest(domain),
    verify_request: senderDomainVerifyRequest(domain),
    ...(preparedPlan
      ? {
          operation_id: preparedPlan.operation_id,
          lifecycle: planLifecycle(preparedPlan.operation_id),
        }
      : {}),
  };
}

function senderRepairAction(mode: SenderMode, domain: string): SenderRepairAction {
  if (mode === "cloudflare_email_service") {
    return {
      blocked_by: "sender_domain_not_verified",
      ...senderDomainRepairCommands(domain),
      description:
        "repair Cloudflare Email Service sender-domain verification before attempting outbound reply proof",
    };
  }

  if (mode === "resend") {
    return {
      blocked_by: "resend_sender_domain_not_verified",
      description:
        "repair Resend sender-domain verification and refresh Resend provider readback before attempting outbound reply proof",
      verify_command: "resend domains list --json --limit 100",
    };
  }

  return {
    blocked_by: "outbound_disabled",
    description: "outbound sending is disabled by desired state; enable a sender mode before outbound reply proof",
  };
}

function rowSenderMode(row: DomainRow): SenderMode {
  const provider = row.sender_domain?.provider;
  if (provider === undefined) return "cloudflare_email_service";
  return isSenderMode(provider) ? provider : senderModeOrDefault(provider);
}

function loadPlanManifest(path: string | undefined): Map<string, PlanManifestEntry> {
  if (!path) return new Map();
  const manifestPath = resolve(root, path);
  let manifest: PlanManifest;
  try {
    manifest = readJson<PlanManifest>(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const items = Array.isArray(manifest) ? manifest : manifest.items ?? [];
  return new Map(
    items
      .map((item) => normalizedPlanManifestEntry(item))
      .filter((item): item is PlanManifestEntry => Boolean(item))
      .map((item) => [item.domain, item]),
  );
}

function normalizedPlanManifestEntry(value: unknown): PlanManifestEntry | null {
  const item = senderDomainPlanManifestItem(value);
  if (!item) return null;

  return {
    domain: item.target,
    operation_id: item.operation_id,
  };
}

function defaultPolicyPath(): string {
  return existsSync(resolve(root, "config/policy.local.json"))
    ? "config/policy.local.json"
    : "config/policy.example.json";
}

function argValue(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function relativePath(path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

type ProofAction =
  | {
      kind: "targeted_inbound_probe";
      domain: string;
      target: string;
      description: string;
    }
  | {
      kind: "targeted_outbound_reply_probe";
      domain: string;
      from_identity: string;
      description: string;
    }
  | {
      kind: "blocked";
      domain: string;
      blocked_by:
        | "inbound_mx"
        | "inbound_provider"
        | "inbound_proof"
        | "sender_domain_not_verified"
        | "resend_sender_domain_not_verified"
        | "outbound_disabled"
        | "template_desired_state";
      plan_request?: SenderDomainPlanRequest;
      verify_request?: SenderDomainVerifyRequest;
      operation_id?: string;
      lifecycle?: PlanLifecycle;
      verify_command?: string;
      description: string;
    };

interface SenderDomainRepairCommands {
  plan_request: SenderDomainPlanRequest;
  verify_request: SenderDomainVerifyRequest;
  operation_id?: string;
  plan_content_hash?: string;
  evidence_hashes?: string[];
  lifecycle?: PlanLifecycle;
}

interface SenderRepairAction extends Partial<SenderDomainRepairCommands> {
  blocked_by: Extract<
    ProofAction,
    { kind: "blocked" }
  >["blocked_by"];
  description: string;
}

interface PlanManifest {
  items?: unknown[];
}

interface PlanManifestEntry {
  domain: string;
  operation_id: string;
}

interface SenderDomainPlanSummary {
  blocked: number;
  ready: number;
  missing: number;
}
