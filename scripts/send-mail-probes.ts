import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

interface ProofPlan {
  actions: ProofAction[];
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
  allowed_reply_identities: string[];
}

interface PersonalAlias {
  operator: string;
  reply_identity: string;
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
      description: string;
    };

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const confirmLiveSend = args.includes("--confirm-live-send");
const confirmBulkLiveSend = args.includes("--confirm-bulk-live-send");
const jsonOutput = args.includes("--json");
const kind = argValue("--kind") ?? "inbound";
const inboundProvider = argValue("--inbound-provider") ?? process.env.MAILDESK_INBOUND_PROBE_PROVIDER ?? "manual";
const planPath = resolve(root, argValue("--plan") ?? "var/maildesk-proof-plan.json");
const policyPath = resolve(root, argValue("--policy") ?? defaultPolicyPath());
const from = argValue("--from") ?? (execute ? undefined : "maildesk-proof@example.com");
const to = argValue("--to") ?? (execute && kind === "outbound" ? undefined : "maildesk-proof@example.com");
const apiUrl = argValue("--api-url") ?? process.env.MAILDESK_API_URL;
const apiToken = argValue("--api-token") ?? process.env.MAILDESK_PROOF_API_TOKEN ?? process.env.MAILDESK_API_TOKEN;
const domainFilter = argValue("--domain");
const limit = args.includes("--all") ? Number.POSITIVE_INFINITY : Number(argValue("--limit") ?? "1");

if (kind !== "inbound" && kind !== "outbound") {
  console.error("invalid --kind; expected inbound or outbound");
  process.exit(1);
}
if (inboundProvider !== "manual" && inboundProvider !== "resend") {
  console.error("invalid --inbound-provider; expected manual or resend");
  process.exit(1);
}
if (execute && !confirmLiveSend) {
  console.error("missing --confirm-live-send for --execute");
  process.exit(1);
}
if (kind === "inbound" && !from) {
  console.error("missing --from <verified-sender> for --execute");
  process.exit(1);
}
if (kind === "outbound" && execute && (!apiUrl || !apiToken || !to)) {
  console.error("missing --api-url, --api-token, or --to for outbound --execute");
  process.exit(1);
}
if (!Number.isFinite(limit) && !args.includes("--all")) {
  console.error("invalid --limit");
  process.exit(1);
}

const plan = readJson<ProofPlan>(planPath);
const policy = readJson<PolicyFile>(policyPath);
const probes = plan.actions
  .filter((action) =>
    kind === "inbound"
      ? action.kind === "targeted_inbound_probe"
      : action.kind === "targeted_outbound_reply_probe",
  )
  .filter((action) => !domainFilter || action.domain === domainFilter)
  .slice(0, limit);

if (execute && probes.length > 1 && !confirmBulkLiveSend) {
  console.error("missing --confirm-bulk-live-send for bulk --execute");
  process.exit(1);
}
if (kind === "inbound" && execute && inboundProvider === "manual") {
  console.error("manual inbound probes cannot execute; pass --inbound-provider resend or send the dry-run target manually");
  process.exit(1);
}

const generatedAt = new Date().toISOString();
const results = probes.map((probe) =>
  probe.kind === "targeted_inbound_probe"
    ? sendInboundProbe(probe, generatedAt)
    : sendOutboundProbe(probe, generatedAt),
);
const summary = {
  mode: execute ? "execute" : "dry_run",
  kind,
  plan_path: relativePath(planPath),
  inbound_provider: kind === "inbound" ? inboundProvider : null,
  from: kind === "inbound" ? from : null,
  to: kind === "outbound" ? to : null,
  requested_domain: domainFilter ?? null,
  probe_count: results.length,
  results,
};

if (jsonOutput) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  for (const result of results) {
    console.log(`${result.status} ${result.domain} ${result.target} ${result.id ?? ""}`.trim());
  }
  console.log(`mode ${summary.mode}`);
  console.log(`probe_count ${summary.probe_count}`);
}

function sendInboundProbe(
  probe: Extract<ProofAction, { kind: "targeted_inbound_probe" }>,
  generatedAt: string,
): { domain: string; target: string; status: "sent" | "dry_run"; provider: string; id?: string } {
  const idempotencyKey = `maildesk-proof:${probe.domain}:${tagValue(from as string)}:${generatedAt.slice(0, 10)}`;
  if (!execute) {
    return {
      domain: probe.domain,
      target: probe.target,
      status: "dry_run",
      provider: inboundProvider,
    };
  }

  const commandArgs = [
    "emails",
    "send",
    "--from",
    from as string,
    "--to",
    probe.target,
    "--subject",
    `Maildesk proof ${probe.domain} ${generatedAt}`,
    "--text",
    `Maildesk targeted inbound proof for ${probe.domain}\nGenerated at: ${generatedAt}\nTarget: ${probe.target}\n`,
    "--headers",
    `X-Maildesk-Proof-Domain=${probe.domain}`,
    `X-Maildesk-Proof-Generated-At=${generatedAt}`,
    "--tags",
    "category=maildesk-proof",
    `domain=${tagValue(probe.domain)}`,
    "--idempotency-key",
    idempotencyKey,
    "--json",
  ];
  const result = spawnSync("resend", commandArgs, { cwd: root, encoding: "utf8" });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  const parsed = parseJson<{ id?: string }>(result.stdout, "resend emails send");
  return {
    domain: probe.domain,
    target: probe.target,
    status: "sent",
    provider: "resend",
    ...(parsed.id ? { id: parsed.id } : {}),
  };
}

function sendOutboundProbe(
  probe: Extract<ProofAction, { kind: "targeted_outbound_reply_probe" }>,
  generatedAt: string,
): { domain: string; from_identity: string; status: "queued" | "dry_run"; message_id?: string } {
  const envelopeTo = probe.from_identity;
  const operator = routeOperator(envelopeTo);
  const messageId = `maildesk-proof-${probe.domain}-${generatedAt}`.replace(/[^A-Za-z0-9_.:-]/g, "-");
  const body = {
    kind: "outbound_reply_requested",
    messageId,
    threadId: `maildesk-proof-${probe.domain}`,
    operator,
    envelopeTo,
    fromIdentity: probe.from_identity,
    requestedIdentity: probe.from_identity,
    to: [to as string],
    subject: `Maildesk outbound proof ${probe.domain} ${generatedAt}`,
    text: `Maildesk targeted outbound proof for ${probe.domain}\nGenerated at: ${generatedAt}\nFrom identity: ${probe.from_identity}\n`,
    headers: {
      "X-Maildesk-Proof-Domain": probe.domain,
      "X-Maildesk-Proof-Generated-At": generatedAt,
    },
    queuedAt: generatedAt,
  };

  if (!execute) {
    return {
      domain: probe.domain,
      from_identity: probe.from_identity,
      status: "dry_run",
      message_id: messageId,
    };
  }

  const result = spawnSync(
    "curl",
    [
      "-fsS",
      "-X",
      "POST",
      `${apiUrl}/api/replies`,
      "-H",
      "content-type: application/json",
      "-H",
      `authorization: Bearer ${apiToken}`,
      "--data-binary",
      JSON.stringify(body),
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  parseJson<unknown>(result.stdout, "maildesk reply API");
  return {
    domain: probe.domain,
    from_identity: probe.from_identity,
    status: "queued",
    message_id: messageId,
  };
}

function routeOperator(envelopeTo: string): string {
  const mailbox = parseMailbox(envelopeTo);
  const domainPolicy = mailbox ? policy.domains[mailbox.domain] : undefined;
  const route =
    mailbox && (domainPolicy?.role_aliases[mailbox.localPart] ?? domainPolicy?.personal_aliases[mailbox.localPart]);
  const operator = route && "operators" in route ? route.operators[0] : route?.operator;
  if (!operator) {
    console.error(`no operator found for ${envelopeTo}`);
    process.exit(1);
  }
  return operator;
}

function parseMailbox(address: string): { localPart: string; domain: string } | null {
  const normalized = address.trim().toLowerCase();
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === normalized.length - 1) return null;
  return {
    localPart: normalized.slice(0, atIndex),
    domain: normalized.slice(atIndex + 1),
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

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.error(`${label} did not produce valid JSON`);
    throw error;
  }
}

function relativePath(path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function tagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}
