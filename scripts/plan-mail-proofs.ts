import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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
const receiptPath = argValue("--receipt");
if (!receiptPath) {
  console.error("missing --receipt <path>");
  process.exit(1);
}

const policyPath = resolve(root, argValue("--policy") ?? defaultPolicyPath());
const receipt = readJson<Receipt>(resolve(root, receiptPath));
const policy = readJson<PolicyFile>(policyPath);
const ackManifest = loadAckManifest(argValue("--ack-manifest"));
const actions = buildActions(receipt, policy);
const plan = {
  generated_at: new Date().toISOString(),
  receipt_path: relativePath(resolve(root, receiptPath)),
  policy_path: relativePath(policyPath),
  summary: {
    action_count: actions.length,
    inbound_probe_count: actions.filter((action) => action.kind === "targeted_inbound_probe").length,
    outbound_reply_probe_count: actions.filter((action) => action.kind === "targeted_outbound_reply_probe").length,
    blocked_count: actions.filter((action) => action.kind === "blocked").length,
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
      actions.push({
        kind: "blocked",
        domain: gap.domain,
        blocked_by: "sender_domain_not_verified",
        ...senderDomainRepairCommands(gap.domain),
        description: "repair provider sender-domain verification before attempting outbound reply proof",
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
        actions.push({
          kind: "blocked",
          domain: gap.domain,
          blocked_by: "sender_domain_not_verified",
          ...senderDomainRepairCommands(gap.domain),
          description: "repair sender-domain readiness before attempting outbound reply proof",
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
  const base = `CF_TOKEN_LANE=global cfctl apply sender_domain enable --zone ${domain} --name ${domain}`;
  const ackPreview = ackManifest.get(domain);
  return {
    preview_command: `${base} --plan`,
    ack_command_template: `${base} --ack-plan <operation-id>`,
    ...(ackPreview
      ? {
          operation_id: ackPreview.operation_id,
          ack_command: ackPreview.ack_command,
        }
      : {}),
    verify_command: "cfctl maildesk-cf verify --file config/desired-state.local.json",
  };
}

function loadAckManifest(path: string | undefined): Map<string, AckManifestEntry> {
  if (!path) return new Map();
  const manifest = readJson<AckManifest>(resolve(root, path));
  const items = Array.isArray(manifest) ? manifest : manifest.items ?? [];
  return new Map(
    items
      .map((item) => normalizedAckManifestEntry(item))
      .filter((item): item is AckManifestEntry => Boolean(item))
      .map((item) => [item.domain, item]),
  );
}

function normalizedAckManifestEntry(item: AckManifestItem): AckManifestEntry | null {
  if (item.performed === true) return null;
  if (item.ok === false) return null;
  if (typeof item.operation_id !== "string" || item.operation_id.length === 0) return null;
  if (typeof item.ack_command !== "string" || item.ack_command.length === 0) return null;
  if (isExpired(item.preview_expires_at)) return null;

  const command = parseSenderDomainAckCommand(item.ack_command);
  if (!command) return null;
  const target = typeof item.target === "string" && item.target.length > 0 ? item.target : command.name;
  if (target !== command.name) return null;
  if (item.operation_id !== command.operation_id) return null;

  return {
    domain: target,
    operation_id: item.operation_id,
    ack_command: item.ack_command,
  };
}

function parseSenderDomainAckCommand(command: string): SenderDomainAckCommand | null {
  const match = command.match(
    /cfctl\s+apply\s+sender_domain\s+enable\s+--zone\s+([^\s]+)\s+--name\s+([^\s]+)\s+--ack-plan\s+([^\s]+)/,
  );
  if (!match) return null;
  return { zone: match[1], name: match[2], operation_id: match[3] };
}

function isExpired(value: string | undefined): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
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
        | "template_desired_state";
      preview_command?: string;
      ack_command_template?: string;
      verify_command?: string;
      description: string;
    };

interface SenderDomainRepairCommands {
  preview_command: string;
  ack_command_template: string;
  operation_id?: string;
  ack_command?: string;
  verify_command: string;
}

interface AckManifest {
  items?: AckManifestItem[];
}

interface AckManifestItem {
  ok?: boolean;
  performed?: boolean;
  operation_id?: string;
  ack_command?: string;
  preview_expires_at?: string;
  target?: string;
}

interface AckManifestEntry {
  domain: string;
  operation_id: string;
  ack_command: string;
}

interface SenderDomainAckCommand {
  zone: string;
  name: string;
  operation_id: string;
}
