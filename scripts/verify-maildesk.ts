import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isSenderMode, senderModeOrDefault, type SenderMode } from "./sender-mode";
import { CanonicalDesiredTopology, requireCanonicalDesiredTopology } from "./desired-topology";

type Status = "ok" | "drift" | "missing" | "not_checked";

interface PolicyFile {
  domains: Record<string, PolicyDomain>;
}

interface PolicyDomain {
  role_aliases: Record<string, RoleAlias>;
  personal_aliases: Record<string, PersonalAlias>;
  catch_all?: {
    operators: string[];
    reply_identity: string;
    sink?: boolean;
  };
}

interface RoleAlias {
  operators: string[];
  reply_identity: string;
  allowed_reply_identities: string[];
  /** When true, mail is archived but never forwarded (e.g. dmarc@ reports). */
  sink?: boolean;
}

interface PersonalAlias {
  operator: string;
  reply_identity: string;
}

interface DesiredState extends CanonicalDesiredTopology {
  domains: DesiredDomain[];
  sender?: {
    mode?: string;
    candidate_domains?: string[];
  };
}

interface DesiredDomain {
  name: string;
  role_aliases: string[];
  personal_aliases: string[];
  inbound_mx_provider?: InboundMxProvider;
  catch_all?: boolean;
}

type InboundMxProvider = "cloudflare_email_routing" | "google_workspace" | "external";

interface LiveEvidence {
  zones?: string[];
  email_routing?: Record<string, RoutingEvidence>;
  dns_mx?: Record<string, string[]>;
  active_policy?: ActivePolicyEvidence;
  readyz?: {
    ok?: boolean;
    checks?: Array<{ name: string; ok: boolean; detail?: string }>;
  };
  d1?: D1Evidence;
  sender_domains?: Record<string, string> | string[];
  inbound_proofs?: Record<string, ProofEvidence>;
  outbound_proofs?: Record<string, ProofEvidence>;
  cfctl_maildesk?: CfctlMaildeskEvidence;
}

interface ActivePolicyEvidence {
  active_policy_sha256?: string;
  active_policy_r2_key?: string;
  revision_r2_key?: string;
  object_key?: string;
  object_sha256?: string;
  expected_domain_count?: number;
  expected_route_count?: number;
  projected_domain_count?: number;
  projected_route_count?: number;
  active_desired_state_sha256?: string;
  active_projection_sha256?: string;
  projection_policy_sha256?: string;
}

interface LocalProjectionEvidence {
  domains: number;
  routes: number;
  desired_state_sha256: string;
  projection_sha256: string;
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
  route_kind?: "role_alias" | "personal_alias" | "catch_all" | "sink";
  forwarded_to?: string[];
  forward_errors?: Array<{ recipient?: string; error?: string }>;
  default_reply_identity?: string;
  raw_r2_key?: string;
  audit_event_at?: string;
  from_identity?: string;
  provider?: string;
  external_receipt_path?: string;
  provider_message_id?: string;
  operator_count?: number;
  policy_sha256?: string;
  provider_message_ids?: string[];
  provider_accepted_at?: string;
  inbox_verified_at?: string;
}

interface CfctlMaildeskEvidence {
  edge_ready?: boolean;
  mail_ready?: boolean;
  domains?: Record<string, CfctlMaildeskDomainEvidence>;
  workers?: Record<string, Status>;
  storage?: Record<string, Status>;
  sender_domains?: Record<string, Status>;
}

interface CfctlMaildeskDomainEvidence {
  email_routing?: Status;
  aliases?: Record<string, Status>;
  dns_authentication?: Record<string, Status>;
}

interface DomainRow {
  domain: string;
  operators: string[];
  reply_identities: string[];
  routes: RouteSummary[];
  sender_domain: SenderSummary;
  inbound_mx_records: string[];
  inbound_mx_provider: string | null;
  evidence: EvidenceSummary;
  policy_desired: Status;
  zone_held: Status;
  role_aliases_wired: Status;
  personal_aliases_wired: Status;
  inbound_mx: Status;
  r2_policy: Status;
  worker_bindings: Status;
  d1_queue: Status;
  inbound_proof: Status;
  outbound_sender: Status;
  outbound_proof: Status;
}

interface RouteSummary {
  kind: "role_alias" | "personal_alias";
  mailbox: string;
  operators: string[];
  reply_identity: string;
  allowed_reply_identities: string[];
  wired: Status;
}

interface SenderSummary {
  authenticated: boolean;
  provider: SenderMode | "invalid";
  provider_status: string | null;
}

interface EvidenceSummary {
  inbound: {
    status: string | null;
    envelope_to: string | null;
    forwarded_to: string[];
    default_reply_identity: string | null;
    raw_r2_key: string | null;
    provider: string | null;
    external_receipt_path: string | null;
    audit_event_at: string | null;
    operator_count: number | null;
    policy_sha256: string | null;
    provider_message_ids: string[];
    provider_accepted_at: string | null;
    inbox_verified_at: string | null;
  };
  outbound: {
    status: string | null;
    from_identity: string | null;
    provider: string | null;
    provider_message_id: string | null;
    audit_event_at: string | null;
  };
}

interface ReceiptGap {
  domain: string;
  field: keyof Pick<
    DomainRow,
    | "policy_desired"
    | "zone_held"
    | "role_aliases_wired"
    | "personal_aliases_wired"
    | "inbound_mx"
    | "r2_policy"
    | "worker_bindings"
    | "d1_queue"
    | "inbound_proof"
    | "outbound_sender"
    | "outbound_proof"
  >;
  status: Status;
  readiness: "local" | "edge" | "mail";
  detail: string | null;
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
requireCanonicalDesiredTopology(desiredState);
const localProjection = collectLocalProjection(policyPath, desiredStatePath);
const evidence = evidencePath ? readJson<LiveEvidence>(resolve(root, evidencePath)) : {};
const policySha256 = sha256(policyText);
const rows = buildRows(policy, desiredState, evidence, policySha256, localProjection);
const gaps = buildGaps(rows);
const localFailures = rows.filter((row) => row.policy_desired !== "ok");
const edgeFailures = rows.filter((row) =>
  [
    row.zone_held,
    row.role_aliases_wired,
    row.personal_aliases_wired,
    row.inbound_mx,
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
    row.inbound_mx,
    row.r2_policy,
    row.worker_bindings,
    row.d1_queue,
    row.inbound_proof,
    row.outbound_sender,
    row.outbound_proof,
  ].some((status) => status !== "ok"),
);
const receipt = {
  generated_at: new Date().toISOString(),
  policy_path: relativePath(policyPath),
  desired_state_path: relativePath(desiredStatePath),
  evidence_path: evidencePath ? relativePath(resolve(root, evidencePath)) : null,
  local_policy_sha256: policySha256,
  local_projection: localProjection,
  status: {
    local_truth_ok: localFailures.length === 0,
    edge_ready: edgeFailures.length === 0 && hasLiveEvidence(evidence),
    mail_ready: mailFailures.length === 0 && hasLiveEvidence(evidence),
    live_evidence_present: hasLiveEvidence(evidence),
  },
  gaps,
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
  localProjection: LocalProjectionEvidence,
): DomainRow[] {
  const desiredByDomain = new Map(desired.domains.map((domain) => [domain.name, domain]));
  const domainNames = unique([
    ...Object.keys(policyFile.domains),
    ...desired.domains.map((domain) => domain.name),
    ...(live.zones ?? []),
  ]).sort();
  return domainNames.map((domainName) => {
    const policyDomain = policyFile.domains[domainName];
    const desiredDomain = desiredByDomain.get(domainName);
    const routingEvidence =
      live.email_routing?.[domainName] ??
      routingEvidenceFromCfctl(domainName, desiredDomain, live.cfctl_maildesk?.domains?.[domainName]);

    return {
      domain: domainName,
      operators: policyDomain ? domainOperators(policyDomain) : [],
      reply_identities: policyDomain ? replyIdentities(policyDomain) : [],
      routes: policyDomain ? domainRoutes(domainName, policyDomain, routingEvidence) : [],
      sender_domain: senderSummary(domainName, desired, live),
      inbound_mx_records: normalizedMxRecords(live.dns_mx?.[domainName]),
      inbound_mx_provider: inboundMxProvider(live.dns_mx?.[domainName]),
      evidence: evidenceSummary(live.inbound_proofs?.[domainName], live.outbound_proofs?.[domainName]),
      policy_desired: comparePolicyAndDesired(policyDomain, desiredDomain),
      zone_held: checkZone(live, domainName),
      role_aliases_wired: checkRouting(routingEvidence?.role_aliases, desiredDomain?.role_aliases),
      personal_aliases_wired: checkRouting(routingEvidence?.personal_aliases, desiredDomain?.personal_aliases),
      inbound_mx: checkInboundMx(live.dns_mx?.[domainName], desiredDomain, live.cfctl_maildesk?.domains?.[domainName]),
      r2_policy: checkR2Policy(live, localPolicySha256, localProjection),
      worker_bindings: checkWorkerBindings(live),
      d1_queue: checkD1Queue(live),
      inbound_proof: checkInboundProof(
        domainName,
        policyDomain,
        desiredDomain,
        live.inbound_proofs?.[domainName],
        localPolicySha256,
      ),
      outbound_sender: checkSender(domainName, desired, live),
      outbound_proof: checkOutboundProof(domainName, desired, live.outbound_proofs?.[domainName]),
    };
  });
}

function buildGaps(rows: DomainRow[]): ReceiptGap[] {
  const fields: Array<ReceiptGap["field"]> = [
    "policy_desired",
    "zone_held",
    "role_aliases_wired",
    "personal_aliases_wired",
    "inbound_mx",
    "r2_policy",
    "worker_bindings",
    "d1_queue",
    "inbound_proof",
    "outbound_sender",
    "outbound_proof",
  ];

  return rows.flatMap((row) =>
    fields
      .filter((field) => row[field] !== "ok")
      .map((field) => ({
        domain: row.domain,
        field,
        status: row[field],
        readiness: gapReadiness(field),
        detail: gapDetail(row, field),
      })),
  );
}

function gapDetail(row: DomainRow, field: ReceiptGap["field"]): string | null {
  if (field === "inbound_mx") {
    if (row.inbound_mx_records.length === 0) return "no root-domain MX records were found in live DNS evidence";
    const provider = row.inbound_mx_provider ?? "unknown";
    return `root-domain MX provider is ${provider}: ${row.inbound_mx_records.join(", ")}`;
  }
  if (field === "outbound_sender") {
    return `sender provider status is ${row.sender_domain.provider_status ?? "not present"}`;
  }
  if (field === "inbound_proof") {
    return row.evidence.inbound.status
      ? `inbound proof status is ${row.evidence.inbound.status}`
      : "no targeted inbound proof evidence was found";
  }
  if (field === "outbound_proof") {
    return row.evidence.outbound.status
      ? `outbound proof status is ${row.evidence.outbound.status}`
      : "no outbound reply audit proof evidence was found";
  }
  return null;
}

function gapReadiness(field: ReceiptGap["field"]): ReceiptGap["readiness"] {
  if (field === "policy_desired") return "local";
  if (field === "inbound_proof" || field === "outbound_sender" || field === "outbound_proof") return "mail";
  return "edge";
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
  return same(policyRoles, desiredRoles) &&
      same(policyPersonal, desiredPersonal) &&
      Boolean(policyDomain.catch_all) === Boolean(desiredDomain.catch_all)
    ? "ok"
    : "drift";
}

function checkIncludes(values: string[] | undefined, expected: string): Status {
  if (!values) return "not_checked";
  return values.includes(expected) ? "ok" : "missing";
}

function checkZone(live: LiveEvidence, domainName: string): Status {
  const zone = checkIncludes(live.zones, domainName);
  if (zone === "ok") return "ok";
  const cfctlDomain = live.cfctl_maildesk?.domains?.[domainName];
  if (cfctlDomain?.email_routing === "ok") return "ok";
  return zone;
}

function checkRouting(actual: string[] | undefined, expected: string[] | undefined): Status {
  if (!expected) return "missing";
  if (!actual) return "not_checked";
  return expected.every((alias) => actual.includes(alias)) ? "ok" : "missing";
}

function routingEvidenceFromCfctl(
  domainName: string,
  desiredDomain: DesiredDomain | undefined,
  cfctlDomain: CfctlMaildeskDomainEvidence | undefined,
): RoutingEvidence | undefined {
  if (!desiredDomain || !cfctlDomain?.aliases) return undefined;
  const okAlias = (alias: string) => cfctlDomain.aliases?.[`${alias}@${domainName}`] === "ok";
  return {
    role_aliases: desiredDomain.role_aliases.filter(okAlias),
    personal_aliases: desiredDomain.personal_aliases.filter(okAlias),
  };
}

function checkInboundMx(
  actual: string[] | undefined,
  desiredDomain: DesiredDomain | undefined,
  cfctlDomain: CfctlMaildeskDomainEvidence | undefined,
): Status {
  const expectedProvider = desiredDomain?.inbound_mx_provider ?? "cloudflare_email_routing";
  if (!actual && expectedProvider === "cloudflare_email_routing" && cfctlDomain?.email_routing === "ok") return "ok";
  if (!actual) return "not_checked";
  const actualProvider = inboundMxProvider(actual);
  if (expectedProvider === "external") return actualProvider === "mixed_or_external" ? "ok" : "drift";
  return actualProvider === expectedProvider ? "ok" : "drift";
}

function checkR2Policy(
  live: LiveEvidence,
  localPolicySha256: string,
  localProjection: LocalProjectionEvidence,
): Status {
  const proof = live.active_policy;
  if (!proof) return "not_checked";
  const canonicalKey = `config/policy/${localPolicySha256}.json`;
  return proof.active_policy_sha256 === localPolicySha256 &&
      proof.active_policy_r2_key === canonicalKey &&
      proof.revision_r2_key === canonicalKey &&
      proof.object_key === canonicalKey &&
      proof.object_sha256 === localPolicySha256 &&
      proof.projection_policy_sha256 === localPolicySha256 &&
      proof.expected_domain_count === localProjection.domains &&
      proof.expected_route_count === localProjection.routes &&
      proof.expected_domain_count === proof.projected_domain_count &&
      proof.expected_route_count === proof.projected_route_count &&
      proof.active_desired_state_sha256 === localProjection.desired_state_sha256 &&
      proof.active_projection_sha256 === localProjection.projection_sha256
    ? "ok"
    : "drift";
}

function collectLocalProjection(policyFile: string, desiredFile: string): LocalProjectionEvidence {
  const result = spawnSync(
    process.execPath,
    [resolve(root, "scripts/sync-route-policy.ts"), "--policy", policyFile, "--desired-state", desiredFile],
    { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`local policy projection failed: ${String(result.stderr || result.stdout).trim().slice(0, 240)}`);
  }
  const parsed = JSON.parse(result.stdout) as Partial<LocalProjectionEvidence>;
  if (
    typeof parsed.domains !== "number" ||
    typeof parsed.routes !== "number" ||
    typeof parsed.desired_state_sha256 !== "string" ||
    typeof parsed.projection_sha256 !== "string"
  ) {
    throw new Error("local policy projection returned an invalid proof summary");
  }
  return parsed as LocalProjectionEvidence;
}

function cloudflareEmailRoutingMx(): string[] {
  return ["route1.mx.cloudflare.net", "route2.mx.cloudflare.net", "route3.mx.cloudflare.net"];
}

function normalizedMxRecords(actual: string[] | undefined): string[] {
  return (actual ?? []).map((value) => value.replace(/\.$/, "").toLowerCase()).sort();
}

function inboundMxProvider(actual: string[] | undefined): string | null {
  const normalized = normalizedMxRecords(actual);
  if (normalized.length === 0) return null;
  if (cloudflareEmailRoutingMx().every((mx) => normalized.includes(mx))) return "cloudflare_email_routing";
  if (
    normalized.every((mx) =>
      mx === "aspmx.l.google.com" || /^alt[1-4]\.aspmx\.l\.google\.com$/.test(mx),
    )
  ) {
    return "google_workspace";
  }
  return "mixed_or_external";
}

function checkWorkerBindings(live: LiveEvidence): Status {
  const workers = live.cfctl_maildesk?.workers;
  if (workers) {
    return workers.relay_router === "ok" &&
      workers.relay_outbound === "ok" &&
      workers.routing_health === "ok"
      ? "ok"
      : "drift";
  }
  // A single Worker's /readyz cannot prove the required three-Worker
  // least-privilege topology. Keep that evidence honest until cfctl readback
  // names every canonical role.
  return "not_checked";
}

function checkD1Queue(live: LiveEvidence): Status {
  const storage = live.cfctl_maildesk?.storage;
  if (storage) {
    return storage.d1_database === "ok" &&
      storage.r2_spool_bucket === "ok" &&
      storage.queue === "ok" &&
      storage.dead_letter_queue === "ok"
      ? "ok"
      : "drift";
  }
  if (!live.readyz?.checks) return "not_checked";
  if (!requiredReadyzChecks(live, ["db_query", "mail_jobs_binding", "relay_spool_binding"])) return "drift";
  if (!live.d1?.tables) return "not_checked";

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
  desiredDomain: DesiredDomain | undefined,
  proof: ProofEvidence | undefined,
  localPolicySha256: string,
): Status {
  if (!proof) return "not_checked";
  if (!isOkProofStatus(proof.status)) return "drift";
  if (!policyDomain) return "missing";

  const target = proof.envelope_to ?? proof.alias;
  if (!target) return "drift";
  const mailbox = parseMailbox(target);
  if (!mailbox || mailbox.domain !== domainName) return "drift";

  const roleAlias = policyDomain.role_aliases[mailbox.localPart];
  const provider = desiredDomain?.inbound_mx_provider ?? "cloudflare_email_routing";
  if (roleAlias) {
    if (roleAlias.sink) {
      return provider === "cloudflare_email_routing"
        ? proofMatchesInboxRelay(proof, "sink", 0, roleAlias.reply_identity, localPolicySha256)
        : proofMatchesSink(proof, false);
    }
    return provider === "cloudflare_email_routing"
      ? proofMatchesInboxRelay(
        proof,
        "role_alias",
        roleAlias.operators.length,
        roleAlias.reply_identity,
        localPolicySha256,
      )
      : proofMatchesRoute(proof, "role_alias", roleAlias.operators, roleAlias.reply_identity, false);
  }

  const personalAlias = policyDomain.personal_aliases[mailbox.localPart];
  if (personalAlias) {
    return provider === "cloudflare_email_routing"
      ? proofMatchesInboxRelay(proof, "personal_alias", 1, personalAlias.reply_identity, localPolicySha256)
      : proofMatchesRoute(proof, "personal_alias", [personalAlias.operator], personalAlias.reply_identity, false);
  }

  return "drift";
}

function proofMatchesInboxRelay(
  proof: ProofEvidence,
  expectedRouteKind: "role_alias" | "personal_alias" | "sink",
  expectedOperatorCount: number,
  expectedReplyIdentity: string,
  localPolicySha256: string,
): Status {
  if (proof.route_kind !== expectedRouteKind) return "drift";
  if (proof.operator_count !== expectedOperatorCount) return "drift";
  if (proof.policy_sha256 !== localPolicySha256) return "drift";
  if (normalizeMailbox(proof.default_reply_identity ?? "") !== normalizeMailbox(expectedReplyIdentity)) {
    return "drift";
  }
  if (!proof.provider_accepted_at || !proof.inbox_verified_at) return "drift";
  if (!proof.provider_message_ids || proof.provider_message_ids.length !== expectedOperatorCount) return "drift";
  if (proof.forwarded_to || proof.raw_r2_key) return "drift";
  return "ok";
}

function proofMatchesRoute(
  proof: ProofEvidence,
  expectedRouteKind: "role_alias" | "personal_alias",
  expectedOperators: string[],
  expectedReplyIdentity: string,
  requireRawR2Key: boolean,
): Status {
  if (proof.route_kind && proof.route_kind !== expectedRouteKind) return "drift";
  if (proof.default_reply_identity && normalizeMailbox(proof.default_reply_identity) !== normalizeMailbox(expectedReplyIdentity)) {
    return "drift";
  }
  if (proof.forward_errors && proof.forward_errors.length > 0) return "drift";
  if (requireRawR2Key && !proof.raw_r2_key) return "drift";
  if (!requireRawR2Key && !proof.provider && !proof.external_receipt_path) return "drift";
  if (!proof.forwarded_to) return "drift";

  const actualRecipients = proof.forwarded_to.map(normalizeMailbox);
  const expectedRecipients = expectedOperators.map(normalizeMailbox);
  return expectedRecipients.every((recipient) => actualRecipients.includes(recipient)) ? "ok" : "drift";
}

function proofMatchesSink(proof: ProofEvidence, requireRawR2Key: boolean): Status {
  // A sink alias is accepted and archived but never forwarded. Expect
  // route_kind "sink" (older rows may predate the field), an empty
  // forwarded_to, no forward errors, and the raw archive present when inbound
  // is Cloudflare-routed.
  if (proof.route_kind && proof.route_kind !== "sink") return "drift";
  if (proof.forward_errors && proof.forward_errors.length > 0) return "drift";
  if (requireRawR2Key && !proof.raw_r2_key) return "drift";
  if ((proof.forwarded_to ?? []).length > 0) return "drift";
  return "ok";
}

function isOkProofStatus(status: string | undefined): boolean {
  return status === "ok" || status === "delivered";
}

function checkSender(domainName: string, desired: DesiredState, live: LiveEvidence): Status {
  const mode = desiredSenderMode(desired);
  if (mode === "invalid") return "drift";
  if (mode === "disabled") return "ok";

  const desiredCandidate = desired.sender?.candidate_domains?.includes(domainName) ?? false;
  if (!desiredCandidate) return "missing";

  if (mode === "cloudflare_email_service") {
    const cfctlStatus = live.cfctl_maildesk?.sender_domains?.[domainName];
    if (cfctlStatus) return senderStatus(cfctlStatus);
    if (live.cfctl_maildesk?.sender_domains) return "missing";
    return "not_checked";
  }

  if (!live.sender_domains) return "not_checked";
  if (Array.isArray(live.sender_domains)) {
    return live.sender_domains.includes(domainName) ? "ok" : "missing";
  }

  const status = live.sender_domains[domainName];
  return status === "verified" || status === "ok" ? "ok" : status ? "drift" : "missing";
}

function senderStatus(status: Status): Status {
  return status === "ok" ? "ok" : status === "missing" ? "missing" : "drift";
}

function checkOutboundProof(domainName: string, desired: DesiredState, proof: ProofEvidence | undefined): Status {
  const mode = desiredSenderMode(desired);
  if (mode === "disabled") return "ok";
  if (mode === "invalid") return "drift";
  if (!proof) return "not_checked";
  if (!isOkProofStatus(proof.status)) return "drift";
  if (!proof.from_identity) return "drift";
  const mailbox = parseMailbox(proof.from_identity);
  if (!mailbox || mailbox.domain !== domainName) return "drift";
  if (proof.provider && proof.provider !== mode) return "drift";
  return proof.provider || proof.provider_message_id || proof.audit_event_at ? "ok" : "drift";
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

function domainRoutes(
  domainName: string,
  domain: PolicyDomain,
  routingEvidence: RoutingEvidence | undefined,
): RouteSummary[] {
  const roleRoutes = Object.entries(domain.role_aliases).map(([alias, route]) => ({
    kind: "role_alias" as const,
    mailbox: `${alias}@${domainName}`,
    operators: [...route.operators].sort(),
    reply_identity: route.reply_identity,
    allowed_reply_identities: [...route.allowed_reply_identities].sort(),
    wired: checkRouting(routingEvidence?.role_aliases, [alias]),
  }));
  const personalRoutes = Object.entries(domain.personal_aliases).map(([alias, route]) => ({
    kind: "personal_alias" as const,
    mailbox: `${alias}@${domainName}`,
    operators: [route.operator],
    reply_identity: route.reply_identity,
    allowed_reply_identities: [route.reply_identity],
    wired: checkRouting(routingEvidence?.personal_aliases, [alias]),
  }));
  return [...roleRoutes, ...personalRoutes].sort((left, right) => left.mailbox.localeCompare(right.mailbox));
}

function senderSummary(domainName: string, desired: DesiredState, live: LiveEvidence): SenderSummary {
  const mode = desiredSenderMode(desired);
  return {
    authenticated: mode !== "disabled" && checkSender(domainName, desired, live) === "ok",
    provider: mode,
    provider_status: senderProviderStatus(domainName, desired, live),
  };
}

function senderProviderStatus(domainName: string, desired: DesiredState, live: LiveEvidence): string | null {
  const mode = desiredSenderMode(desired);
  if (mode === "disabled") return "disabled";
  if (mode === "invalid") return "invalid";
  if (mode === "cloudflare_email_service") {
    return live.cfctl_maildesk?.sender_domains?.[domainName] ?? null;
  }
  if (!live.sender_domains) return null;
  if (Array.isArray(live.sender_domains)) {
    return live.sender_domains.includes(domainName) ? "listed" : null;
  }
  return live.sender_domains[domainName] ?? null;
}

function desiredSenderMode(desired: DesiredState): SenderMode | "invalid" {
  if (desired.sender?.mode !== undefined && !isSenderMode(desired.sender.mode)) return "invalid";
  return senderModeOrDefault(desired.sender?.mode);
}

function evidenceSummary(
  inbound: ProofEvidence | undefined,
  outbound: ProofEvidence | undefined,
): EvidenceSummary {
  return {
    inbound: {
      status: inbound?.status ?? null,
      envelope_to: inbound?.envelope_to ?? inbound?.alias ?? null,
      forwarded_to: inbound?.forwarded_to ?? [],
      default_reply_identity: inbound?.default_reply_identity ?? null,
      raw_r2_key: inbound?.raw_r2_key ?? null,
      provider: inbound?.provider ?? null,
      external_receipt_path: inbound?.external_receipt_path ?? null,
      audit_event_at: inbound?.audit_event_at ?? null,
      operator_count: inbound?.operator_count ?? null,
      policy_sha256: inbound?.policy_sha256 ?? null,
      provider_message_ids: inbound?.provider_message_ids ?? [],
      provider_accepted_at: inbound?.provider_accepted_at ?? null,
      inbox_verified_at: inbound?.inbox_verified_at ?? null,
    },
    outbound: {
      status: outbound?.status ?? null,
      from_identity: outbound?.from_identity ?? null,
      provider: outbound?.provider ?? null,
      provider_message_id: outbound?.provider_message_id ?? null,
      audit_event_at: outbound?.audit_event_at ?? null,
    },
  };
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
      live.dns_mx ||
      live.active_policy ||
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
    "mx",
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
    row.inbound_mx,
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
