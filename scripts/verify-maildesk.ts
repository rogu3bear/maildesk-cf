import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type Status = "ok" | "drift" | "missing" | "not_checked";

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

interface DesiredState {
  domains: DesiredDomain[];
  sender?: {
    authenticated_domains?: string[];
  };
}

interface DesiredDomain {
  name: string;
  role_aliases: string[];
  personal_aliases: string[];
}

interface LiveEvidence {
  zones?: string[];
  email_routing?: Record<string, RoutingEvidence>;
  r2_policy_sha256?: string;
  readyz?: {
    ok?: boolean;
    checks?: Array<{ name: string; ok: boolean; detail?: string }>;
  };
  d1?: D1Evidence;
  sender_domains?: Record<string, string> | string[];
  inbound_proofs?: Record<string, ProofEvidence>;
  outbound_proofs?: Record<string, ProofEvidence>;
}

interface D1Evidence {
  tables?: string[];
  audit_event_counts?: Record<string, number>;
}

interface RoutingEvidence {
  role_aliases?: string[];
  personal_aliases?: string[];
}

interface ProofEvidence {
  status?: string;
  detail?: string;
  alias?: string;
  envelope_to?: string;
  route_kind?: "role_alias" | "personal_alias";
  forwarded_to?: string[];
  forward_errors?: Array<{ recipient?: string; error?: string }>;
  default_reply_identity?: string;
  raw_r2_key?: string;
  audit_event_at?: string;
}

interface DomainRow {
  domain: string;
  operators: string[];
  reply_identities: string[];
  policy_desired: Status;
  zone_held: Status;
  role_aliases_wired: Status;
  personal_aliases_wired: Status;
  r2_policy: Status;
  worker_bindings: Status;
  d1_queue: Status;
  inbound_proof: Status;
  outbound_sender: Status;
}

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const argSet = new Set(args);
const jsonOutput = argSet.has("--json");
const requireLive = argSet.has("--require-live");
const policyPath = resolve(root, argValue("--policy") ?? defaultPolicyPath());
const desiredStatePath = resolve(
  root,
  argValue("--desired-state") ?? defaultDesiredStatePath(),
);
const evidencePath = argValue("--evidence");
const policyText = readFileSync(policyPath, "utf8");
const policy = JSON.parse(policyText) as PolicyFile;
const desiredState = readJson<DesiredState>(desiredStatePath);
const evidence = evidencePath ? readJson<LiveEvidence>(resolve(root, evidencePath)) : {};
const policySha256 = sha256(policyText);
const rows = buildRows(policy, desiredState, evidence, policySha256);
const localFailures = rows.filter((row) => row.policy_desired !== "ok");
const edgeFailures = rows.filter((row) =>
  [
    row.zone_held,
    row.role_aliases_wired,
    row.personal_aliases_wired,
    row.r2_policy,
    row.worker_bindings,
    row.d1_queue,
  ].some((status) => status !== "ok"),
);
const mailFailures = rows.filter((row) =>
  [
    row.zone_held,
    row.role_aliases_wired,
    row.personal_aliases_wired,
    row.r2_policy,
    row.worker_bindings,
    row.d1_queue,
    row.inbound_proof,
    row.outbound_sender,
  ].some((status) => status !== "ok"),
);
const receipt = {
  generated_at: new Date().toISOString(),
  policy_path: relativePath(policyPath),
  desired_state_path: relativePath(desiredStatePath),
  evidence_path: evidencePath ? relativePath(resolve(root, evidencePath)) : null,
  local_policy_sha256: policySha256,
  status: {
    local_truth_ok: localFailures.length === 0,
    edge_ready: edgeFailures.length === 0 && hasLiveEvidence(evidence),
    mail_ready: mailFailures.length === 0 && hasLiveEvidence(evidence),
    live_evidence_present: hasLiveEvidence(evidence),
  },
  rows,
};

if (jsonOutput) {
  console.log(JSON.stringify(receipt, null, 2));
} else {
  printTable(rows);
  console.log("");
  console.log(`local_policy_sha256 ${policySha256}`);
  console.log(`local_truth_ok ${receipt.status.local_truth_ok}`);
  console.log(`live_evidence_present ${receipt.status.live_evidence_present}`);
  console.log(`edge_ready ${receipt.status.edge_ready}`);
  console.log(`mail_ready ${receipt.status.mail_ready}`);
}

if (localFailures.length > 0 || (requireLive && mailFailures.length > 0)) {
  process.exit(1);
}

function defaultPolicyPath(): string {
  return existsSync(resolve(root, "config/policy.local.json"))
    ? "config/policy.local.json"
    : "config/policy.example.json";
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

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildRows(
  policyFile: PolicyFile,
  desired: DesiredState,
  live: LiveEvidence,
  localPolicySha256: string,
): DomainRow[] {
  const desiredByDomain = new Map(desired.domains.map((domain) => [domain.name, domain]));
  const domainNames = unique([...Object.keys(policyFile.domains), ...desired.domains.map((domain) => domain.name)]).sort();
  return domainNames.map((domainName) => {
    const policyDomain = policyFile.domains[domainName];
    const desiredDomain = desiredByDomain.get(domainName);
    const routingEvidence = live.email_routing?.[domainName];

    return {
      domain: domainName,
      operators: policyDomain ? domainOperators(policyDomain) : [],
      reply_identities: policyDomain ? replyIdentities(policyDomain) : [],
      policy_desired: comparePolicyAndDesired(policyDomain, desiredDomain),
      zone_held: checkIncludes(live.zones, domainName),
      role_aliases_wired: checkRouting(routingEvidence?.role_aliases, desiredDomain?.role_aliases),
      personal_aliases_wired: checkRouting(routingEvidence?.personal_aliases, desiredDomain?.personal_aliases),
      r2_policy: live.r2_policy_sha256 ? (live.r2_policy_sha256 === localPolicySha256 ? "ok" : "drift") : "not_checked",
      worker_bindings: checkWorkerBindings(live),
      d1_queue: checkD1Queue(live),
      inbound_proof: checkInboundProof(domainName, policyDomain, live.inbound_proofs?.[domainName]),
      outbound_sender: checkSender(domainName, desired, live),
    };
  });
}

function comparePolicyAndDesired(
  policyDomain: PolicyDomain | undefined,
  desiredDomain: DesiredDomain | undefined,
): Status {
  if (!policyDomain || !desiredDomain) return "missing";
  const policyRoles = Object.keys(policyDomain.role_aliases).sort();
  const desiredRoles = [...desiredDomain.role_aliases].sort();
  const policyPersonal = Object.keys(policyDomain.personal_aliases).sort();
  const desiredPersonal = [...desiredDomain.personal_aliases].sort();
  return same(policyRoles, desiredRoles) && same(policyPersonal, desiredPersonal) ? "ok" : "drift";
}

function checkIncludes(values: string[] | undefined, expected: string): Status {
  if (!values) return "not_checked";
  return values.includes(expected) ? "ok" : "missing";
}

function checkRouting(actual: string[] | undefined, expected: string[] | undefined): Status {
  if (!expected) return "missing";
  if (!actual) return "not_checked";
  return expected.every((alias) => actual.includes(alias)) ? "ok" : "missing";
}

function checkWorkerBindings(live: LiveEvidence): Status {
  if (!live.readyz?.checks) return "not_checked";
  return requiredReadyzChecks(live, ["db_binding", "raw_mail_binding", "mail_jobs_binding", "policy_config"])
    ? "ok"
    : "drift";
}

function checkD1Queue(live: LiveEvidence): Status {
  if (!live.readyz?.checks) return "not_checked";
  if (!requiredReadyzChecks(live, ["db_query", "mail_jobs_binding"])) return "drift";
  if (!live.d1) return "ok";
  if (!live.d1.tables) return "drift";

  const requiredTables = [
    "audit_events",
    "messages",
    "threads",
    "alias_routes",
    "identities",
    "operators",
  ];
  return requiredTables.every((table) => live.d1?.tables?.includes(table)) ? "ok" : "drift";
}

function requiredReadyzChecks(live: LiveEvidence, names: string[]): boolean {
  return names.every((name) => live.readyz?.checks?.some((check) => check.name === name && check.ok));
}

function checkInboundProof(
  domainName: string,
  policyDomain: PolicyDomain | undefined,
  proof: ProofEvidence | undefined,
): Status {
  if (!proof) return "not_checked";
  if (!isOkProofStatus(proof.status)) return "drift";
  if (!policyDomain) return "missing";

  const target = proof.envelope_to ?? proof.alias;
  if (!target) return "drift";
  const mailbox = parseMailbox(target);
  if (!mailbox || mailbox.domain !== domainName) return "drift";

  const roleAlias = policyDomain.role_aliases[mailbox.localPart];
  if (roleAlias) {
    return proofMatchesRoute(proof, "role_alias", roleAlias.operators, roleAlias.reply_identity);
  }

  const personalAlias = policyDomain.personal_aliases[mailbox.localPart];
  if (personalAlias) {
    return proofMatchesRoute(proof, "personal_alias", [personalAlias.operator], personalAlias.reply_identity);
  }

  return "drift";
}

function proofMatchesRoute(
  proof: ProofEvidence,
  expectedRouteKind: "role_alias" | "personal_alias",
  expectedOperators: string[],
  expectedReplyIdentity: string,
): Status {
  if (proof.route_kind && proof.route_kind !== expectedRouteKind) return "drift";
  if (proof.default_reply_identity && normalizeMailbox(proof.default_reply_identity) !== normalizeMailbox(expectedReplyIdentity)) {
    return "drift";
  }
  if (proof.forward_errors && proof.forward_errors.length > 0) return "drift";
  if (!proof.raw_r2_key) return "drift";
  if (!proof.forwarded_to) return "drift";

  const actualRecipients = proof.forwarded_to.map(normalizeMailbox);
  const expectedRecipients = expectedOperators.map(normalizeMailbox);
  return expectedRecipients.every((recipient) => actualRecipients.includes(recipient)) ? "ok" : "drift";
}

function isOkProofStatus(status: string | undefined): boolean {
  return status === "ok" || status === "delivered";
}

function checkSender(domainName: string, desired: DesiredState, live: LiveEvidence): Status {
  const desiredAuthenticated = desired.sender?.authenticated_domains?.includes(domainName) ?? false;
  if (!desiredAuthenticated) return "missing";
  if (!live.sender_domains) return "not_checked";
  if (Array.isArray(live.sender_domains)) {
    return live.sender_domains.includes(domainName) ? "ok" : "missing";
  }
  const status = live.sender_domains[domainName];
  return status === "verified" || status === "ok" ? "ok" : status ? "drift" : "missing";
}

function domainOperators(domain: PolicyDomain): string[] {
  return unique(Object.values(domain.role_aliases).flatMap((alias) => alias.operators)).sort();
}

function replyIdentities(domain: PolicyDomain): string[] {
  return unique([
    ...Object.values(domain.role_aliases).map((alias) => alias.reply_identity),
    ...Object.values(domain.role_aliases).flatMap((alias) => alias.allowed_reply_identities),
    ...Object.values(domain.personal_aliases).map((alias) => alias.reply_identity),
  ]).sort();
}

function same(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function parseMailbox(address: string): { localPart: string; domain: string } | null {
  const normalized = normalizeMailbox(address);
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === normalized.length - 1) return null;
  return {
    localPart: normalized.slice(0, atIndex),
    domain: normalized.slice(atIndex + 1),
  };
}

function normalizeMailbox(address: string): string {
  return address.trim().toLowerCase();
}

function hasLiveEvidence(live: LiveEvidence): boolean {
  return Boolean(
    live.zones ||
      live.email_routing ||
      live.r2_policy_sha256 ||
      live.readyz ||
      live.d1 ||
      live.sender_domains ||
      live.inbound_proofs ||
      live.outbound_proofs,
  );
}

function relativePath(path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function printTable(tableRows: DomainRow[]) {
  const headers = [
    "domain",
    "operators",
    "policy",
    "zone",
    "roles",
    "personal",
    "r2",
    "bindings",
    "d1_queue",
    "inbound",
    "sender",
  ];
  const values = tableRows.map((row) => [
    row.domain,
    row.operators.join(","),
    row.policy_desired,
    row.zone_held,
    row.role_aliases_wired,
    row.personal_aliases_wired,
    row.r2_policy,
    row.worker_bindings,
    row.d1_queue,
    row.inbound_proof,
    row.outbound_sender,
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...values.map((row) => row[index]?.length ?? 0)),
  );
  console.log(formatRow(headers, widths));
  console.log(formatRow(widths.map((width) => "-".repeat(width)), widths));
  for (const row of values) {
    console.log(formatRow(row, widths));
  }
}

function formatRow(values: string[], widths: number[]): string {
  return values.map((value, index) => value.padEnd(widths[index] ?? 0)).join("  ");
}
