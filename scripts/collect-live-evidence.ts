import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { senderModeOrDefault } from "./sender-mode";
import { CanonicalDesiredTopology, requireCanonicalDesiredTopology } from "./desired-topology";

interface DesiredState extends CanonicalDesiredTopology {
  domains: Array<{
    name: string;
    inbound_mx_provider?: string;
    role_aliases?: string[];
    personal_aliases?: string[];
    catch_all?: boolean;
  }>;
  sender?: {
    mode?: string;
    candidate_domains?: string[];
  };
}

interface Evidence {
  generated_at: string;
  zones?: string[];
  email_routing?: Record<string, { role_aliases: string[]; personal_aliases: string[] }>;
  dns_mx?: Record<string, string[]>;
  active_policy?: ActivePolicyEvidence;
  readyz?: ReadyzEvidence;
  d1?: {
    tables?: string[];
    audit_event_counts?: Record<string, number>;
  };
  sender_domains?: Record<string, string>;
  inbound_proofs?: Record<string, InboundProof>;
  outbound_proofs?: Record<string, OutboundProof>;
  cfctl_maildesk?: CfctlMaildeskEvidence;
  cfctl_readback?: CfctlReadbackEvidence;
}

interface ReadyzEvidence {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

interface ActivePolicyEvidence {
  active_policy_sha256: string;
  active_policy_r2_key: string;
  revision_r2_key: string;
  object_key: string;
  object_sha256: string;
  expected_domain_count: number;
  expected_route_count: number;
  projected_domain_count: number;
  projected_route_count: number;
  active_desired_state_sha256: string;
  active_projection_sha256: string;
  projection_policy_sha256: string;
}

type Status = "ok" | "drift" | "missing" | "not_checked" | "not_applicable";

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
  catch_all?: Status;
  aliases?: Record<string, Status>;
  dns_authentication?: Record<string, Status>;
}

interface CfctlReadbackEvidence {
  required: boolean;
  attempted: boolean;
  complete: boolean;
  profile_id?: string;
  account_id?: string;
  receipts: CfctlReadReceipt[];
}

interface CfctlReadReceipt {
  capability_id: string;
  ok: boolean;
  performed: boolean;
  verification_state: string;
  evidence_hashes: string[];
  error_code?: string;
  pagination?: {
    kind: "page" | "cursor" | "page_probe";
    page?: number;
    per_page?: number;
    total_pages?: number;
    total_count?: number;
    cursor_present?: boolean;
    item_count?: number;
    terminal?: boolean;
  };
}

type PaginationContract =
  | { kind: "page"; per_page: number }
  | { kind: "cursor" }
  | null;

interface CfctlEnvelope {
  schema_version?: number;
  ok?: boolean;
  performed?: boolean;
  capability_id?: string | null;
  profile_id?: string | null;
  account_id?: string | null;
  verification?: { state?: string };
  evidence?: Array<{ content_hash?: string }>;
  result?: unknown;
  error?: { code?: string } | null;
}

interface CfctlCallResult {
  ok: boolean;
  result?: unknown;
  receipt: CfctlReadReceipt;
}

interface ExpectedWorkerBinding {
  name: string;
  type: "d1" | "r2_bucket" | "queue" | "send_email" | "assets";
  resource?: string;
}

interface ExpectedQueueConsumer {
  script_name: string;
  queue_name: string;
  dead_letter_queue: string;
  batch_size: number;
  max_concurrency: number;
  max_retries: number;
}

interface InboundProof {
  status: "ok";
  envelope_to: string;
  route_kind?: "role_alias" | "personal_alias" | "catch_all" | "sink";
  operator_count?: number;
  policy_sha256?: string;
  provider_message_ids?: string[];
  provider_accepted_at?: string;
  inbox_verified_at?: string;
  forward_errors?: Array<{ recipient?: string; error?: string }>;
  default_reply_identity?: string;
  raw_r2_key?: string;
  provider?: string;
  operator_set_sha256?: string;
  external_receipt_path?: string;
  external_receipt_sha256?: string;
  audit_event_at?: string;
}

interface OutboundProof {
  status: "delivered";
  from_identity: string;
  provider?: string;
  provider_message_id?: string;
  audit_event_at?: string;
}

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const desiredStatePath = resolve(root, argValue("--desired-state") ?? defaultDesiredStatePath());
const policyPath = resolve(root, argValue("--policy") ?? defaultPolicyPath());
const outputPath = resolve(root, argValue("--out") ?? "var/maildesk-live-evidence.json");
const cfctlBin = process.env.CFCTL_BIN ?? argValue("--cfctl") ?? "cfctl";
const wranglerBin = process.env.WRANGLER_BIN ?? argValue("--wrangler") ?? "wrangler";
const readyzUrl = process.env.MAILDESK_READYZ_URL ?? argValue("--readyz-url");
const d1Database = process.env.MAILDESK_D1_DATABASE ?? argValue("--d1-database");
const googleAdminBin = process.env.GOOGLE_ADMIN_BIN ?? argValue("--google-admin");
const desiredState = readJson<DesiredState>(desiredStatePath);
requireCanonicalDesiredTopology(desiredState);
const senderMode = senderModeOrDefault(desiredState.sender?.mode);
const useResend = senderMode === "resend" && !args.includes("--no-resend");
const routerService = desiredState.workers.relay_router.script_name;
const cfctlProfile = process.env.MAILDESK_CFCTL_PROFILE?.trim();
const EMAIL_ROUTING_RULE_SET_SCHEMA_VERSION = 1;
const EMAIL_ROUTING_RULE_PAGE_SIZE = 50;
const EMAIL_ROUTING_RULE_MAX_PAGES = 100;
const evidence: Evidence = {
  generated_at: new Date().toISOString(),
};

const cfctlResult = collectGovernedCfctlEvidence(cfctlProfile);
evidence.cfctl_readback = cfctlResult.readback;
if (cfctlResult.evidence) {
  evidence.cfctl_maildesk = cfctlResult.evidence.cfctl_maildesk;
  evidence.zones = cfctlResult.evidence.zones;
  evidence.email_routing = cfctlResult.evidence.email_routing;
  evidence.dns_mx = cfctlResult.evidence.dns_mx;
}
if (cfctlResult.readback.required && !cfctlResult.readback.complete) {
  writeEvidenceAndExit(1);
}

if (readyzUrl) {
  const readyz = fetchJson(["-fsS", readyzUrl]);
  if (readyz.ok && validReadyzEvidence(readyz.value)) evidence.readyz = readyz.value;
}

const d1Name = desiredState.storage?.d1_database ?? d1Database;
if (d1Name) {
  const activePolicy = collectActivePolicyEvidence(d1Name, desiredState.storage.r2_policy_bucket);
  if (activePolicy) evidence.active_policy = activePolicy;
  const d1Evidence = collectD1Evidence(d1Name);
  if ((d1Evidence.tables?.length ?? 0) > 0 || Object.keys(d1Evidence.audit_event_counts ?? {}).length > 0) {
    evidence.d1 = d1Evidence;
  }
  const inboundProofs = collectInboundProofs(d1Name);
  if (Object.keys(inboundProofs).length > 0) {
    evidence.inbound_proofs = inboundProofs;
  }
  const outboundProofs = collectOutboundProofs(d1Name);
  if (Object.keys(outboundProofs).length > 0) {
    evidence.outbound_proofs = outboundProofs;
  }
}

function collectActivePolicyEvidence(
  databaseName: string,
  policyBucket: string,
): ActivePolicyEvidence | null {
  const [row] = wranglerD1Results(
    databaseName,
    "SELECT rs.active_policy_sha256, rs.active_policy_r2_key, pr.r2_object_key AS revision_r2_key, pr.expected_domain_count, pr.expected_route_count, (SELECT COUNT(*) FROM domains d WHERE EXISTS (SELECT 1 FROM alias_routes ar WHERE ar.domain_id = d.id AND ar.enabled = 1 AND ar.policy_sha256 = rs.active_policy_sha256)) AS projected_domain_count, (SELECT COUNT(*) FROM alias_routes ar WHERE ar.enabled = 1 AND ar.policy_sha256 = rs.active_policy_sha256) AS projected_route_count, (SELECT value FROM policy_projection_state WHERE key = 'active_policy_sha256') AS projection_policy_sha256, (SELECT value FROM policy_projection_state WHERE key = 'active_desired_state_sha256') AS active_desired_state_sha256, (SELECT value FROM policy_projection_state WHERE key = 'active_projection_sha256') AS active_projection_sha256 FROM runtime_state rs JOIN policy_revisions pr ON pr.policy_sha256 = rs.active_policy_sha256 WHERE rs.singleton = 1;",
  );
  if (
    typeof row?.active_policy_sha256 !== "string" ||
    typeof row.active_policy_r2_key !== "string" ||
    typeof row.revision_r2_key !== "string" ||
    typeof row.expected_domain_count !== "number" ||
    typeof row.expected_route_count !== "number" ||
    typeof row.projected_domain_count !== "number" ||
    typeof row.projected_route_count !== "number" ||
    typeof row.projection_policy_sha256 !== "string" ||
    typeof row.active_desired_state_sha256 !== "string" ||
    typeof row.active_projection_sha256 !== "string"
  ) return null;

  const object = spawnSync(
    wranglerBin,
    ["r2", "object", "get", `${policyBucket}/${row.active_policy_r2_key}`, "--remote", "--pipe"],
    { cwd: root, encoding: null, maxBuffer: 16 * 1024 * 1024 },
  );
  if (object.status !== 0 || !object.stdout) return null;

  return {
    active_policy_sha256: row.active_policy_sha256,
    active_policy_r2_key: row.active_policy_r2_key,
    revision_r2_key: row.revision_r2_key,
    object_key: row.active_policy_r2_key,
    object_sha256: createHash("sha256").update(object.stdout).digest("hex"),
    expected_domain_count: row.expected_domain_count,
    expected_route_count: row.expected_route_count,
    projected_domain_count: row.projected_domain_count,
    projected_route_count: row.projected_route_count,
    projection_policy_sha256: row.projection_policy_sha256,
    active_desired_state_sha256: row.active_desired_state_sha256,
    active_projection_sha256: row.active_projection_sha256,
  };
}

if (useResend) {
  const senderDomains = collectResendDomains();
  if (Object.keys(senderDomains).length > 0) {
    evidence.sender_domains = senderDomains;
  }
}

if (googleAdminBin) {
  const externalInboundProofs = collectGoogleWorkspaceProofs(googleAdminBin);
  if (Object.keys(externalInboundProofs).length > 0) {
    evidence.inbound_proofs = { ...(evidence.inbound_proofs ?? {}), ...externalInboundProofs };
  }
}

writeEvidenceAndExit(0);

function writeEvidenceAndExit(status: number): never {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`wrote ${relativePath(outputPath)}`);
  process.exit(status);
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

function collectGovernedCfctlEvidence(profileId: string | undefined): {
  readback: CfctlReadbackEvidence;
  evidence?: Pick<Evidence, "zones" | "email_routing" | "dns_mx" | "cfctl_maildesk">;
} {
  if (!profileId) {
    return {
      readback: { required: false, attempted: false, complete: false, receipts: [] },
    };
  }
  if (desiredState.domains.length > 100) {
    return {
      readback: {
        required: true,
        attempted: false,
        complete: false,
        profile_id: profileId,
        receipts: [failureReceipt("desired-state-domain-limit", false, "DOMAIN_LIMIT_EXCEEDED")],
      },
    };
  }

  const profileResult = cfctlProfileAccount(profileId);
  const receipts: CfctlReadReceipt[] = [profileResult.receipt];
  if (!profileResult.ok || !profileResult.account_id) {
    return {
      readback: {
        required: true,
        attempted: true,
        complete: false,
        profile_id: profileId,
        receipts,
      },
    };
  }
  const accountId = profileResult.account_id;

  const zones: string[] = [];
  const emailRouting: NonNullable<Evidence["email_routing"]> = {};
  const dnsMx: NonNullable<Evidence["dns_mx"]> = {};
  const domains: Record<string, CfctlMaildeskDomainEvidence> = {};
  const senderDomains: Record<string, Status> = {};

  for (const desiredDomain of [...desiredState.domains].sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const zoneCall = cfctlCall(
      "zones-get",
      profileId,
      accountId,
      [],
      [["name", desiredDomain.name], ["account.id", accountId], ["page", "1"], ["per_page", "5"]],
      { kind: "page", per_page: 5 },
    );
    receipts.push(zoneCall.receipt);
    if (!zoneCall.ok) return incompleteReadback(profileId, accountId, receipts);
    const zoneRecords = decodePageRecords(zoneCall, validZoneRecord);
    if (!zoneRecords) return malformedReadback(profileId, accountId, receipts, zoneCall.receipt);
    const zone = zoneRecords.find((entry) =>
      normalizeName(stringField(entry, ["name"])) === desiredDomain.name &&
      stringField(entry, ["status"]) === "active"
    );
    const zoneId = stringField(zone, ["id"]);
    if (!zoneId) {
      receipts.push(failureReceipt("zones-get:expected-zone", true, "EXPECTED_ZONE_MISSING"));
      return incompleteReadback(profileId, accountId, receipts);
    }
    zones.push(desiredDomain.name);

    const expectedAliases = [
      ...(desiredDomain.role_aliases ?? []),
      ...(desiredDomain.personal_aliases ?? []),
    ];
    let aliases: string[] = [];
    if (desiredDomain.inbound_mx_provider === "cloudflare_email_routing") {
      const routingProjection = collectEmailRoutingRules(
        "email-routing-routing-rules-list-routing-rules",
        profileId,
        accountId,
        [["zone_id", zoneId]],
      );
      receipts.push(...routingProjection.receipts);
      if (!routingProjection.ok || !routingProjection.records) {
        return incompleteReadback(profileId, accountId, receipts);
      }
      const expectedAliasByHash = new Map(expectedAliases.map((alias) => [
        sha256Identity(`${alias}@${desiredDomain.name}`),
        alias,
      ]));
      aliases = routingProjection.records
        .filter((rule) => rule.enabled && projectedRuleRoutesToMaildesk(rule, routerService))
        .flatMap((rule) => rule.matchers
          .filter((matcher) => matcher.field === "to")
          .map((matcher) => matcher.value_sha256))
        .map((identity) => identity ? expectedAliasByHash.get(identity) : undefined)
        .filter((alias): alias is string => Boolean(alias))
        .sort();
      emailRouting[desiredDomain.name] = {
        role_aliases: unique(aliases),
        personal_aliases: unique(aliases),
      };
    }

    const dnsCall = cfctlCall(
      "dns-records-for-a-zone-list-dns-records",
      profileId,
      accountId,
      [["zone_id", zoneId]],
      [["name", desiredDomain.name], ["type", "MX"], ["page", "1"], ["per_page", "100"]],
      { kind: "page", per_page: 100 },
    );
    receipts.push(dnsCall.receipt);
    if (!dnsCall.ok) return incompleteReadback(profileId, accountId, receipts);
    const dnsRecords = decodePageRecords(dnsCall, validDnsRecord);
    if (!dnsRecords) return malformedReadback(profileId, accountId, receipts, dnsCall.receipt);
    dnsMx[desiredDomain.name] = dnsRecords
      .filter((record) => stringField(record, ["type"]) === "MX" &&
        normalizeName(stringField(record, ["name"])) === desiredDomain.name)
      .map((record) => stringField(record, ["content"]))
      .filter((content): content is string => Boolean(content))
      .sort();

    if (desiredDomain.inbound_mx_provider === "cloudflare_email_routing") {
      const settingsCall = cfctlCall(
        "email-routing-settings-get-email-routing-settings",
        profileId,
        accountId,
        [["zone_id", zoneId]],
      );
      receipts.push(settingsCall.receipt);
      if (!settingsCall.ok) return incompleteReadback(profileId, accountId, receipts);
      const settings = decodeSettings(settingsCall.result);
      if (!settings) return malformedReadback(profileId, accountId, receipts, settingsCall.receipt);
      const catchAllCall = cfctlCall(
        "email-routing-routing-rules-get-catch-all-rule",
        profileId,
        accountId,
        [["zone_id", zoneId]],
      );
      receipts.push(catchAllCall.receipt);
      if (!catchAllCall.ok) return incompleteReadback(profileId, accountId, receipts);
      const catchAllRule = decodeCatchAllRule(catchAllCall.result);
      if (!catchAllRule) return malformedReadback(profileId, accountId, receipts, catchAllCall.receipt);
      domains[desiredDomain.name] = {
        email_routing: settings.enabled === true ? "ok" : "drift",
        catch_all: desiredDomain.catch_all === true
          ? catchAllRule.enabled && routesToMaildesk(catchAllRule, routerService) ? "ok" : "missing"
          : catchAllRule.enabled ? "drift" : "ok",
        aliases: Object.fromEntries(expectedAliases.map((alias) => [
          `${alias}@${desiredDomain.name}`,
          aliases.includes(alias) ? "ok" : "missing",
        ])),
      };
    } else {
      domains[desiredDomain.name] = {
        email_routing: "not_applicable",
        catch_all: desiredDomain.catch_all === true ? "not_checked" : "not_applicable",
      };
    }

    if (
      senderMode === "cloudflare_email_service" &&
      (desiredState.sender?.candidate_domains ?? []).includes(desiredDomain.name)
    ) {
      const senderCall = cfctlCall(
        "email-sending-subdomains-list-sending-subdomains",
        profileId,
        accountId,
        [["zone_id", zoneId]],
      );
      receipts.push(senderCall.receipt);
      if (!senderCall.ok) return incompleteReadback(profileId, accountId, receipts);
      const senderRecords = decodePlainRecords(senderCall.result, validSenderDomainRecord);
      if (!senderRecords) return malformedReadback(profileId, accountId, receipts, senderCall.receipt);
      const sender = senderRecords
        .find((entry) => normalizeName(stringField(entry, ["name", "hostname", "subdomain"])) === desiredDomain.name);
      senderDomains[desiredDomain.name] = sender
        ? verifiedSenderStatus(stringField(sender, ["status", "dns_status"]))
        : "missing";
    }
  }

  const workersCall = cfctlCall(
    "listWorkers",
    profileId,
    accountId,
    [["account_id", accountId]],
    [["page", "1"], ["per_page", "100"]],
    { kind: "page", per_page: 100 },
  );
  receipts.push(workersCall.receipt);
  if (!workersCall.ok) return incompleteReadback(profileId, accountId, receipts);
  const workerRecords = decodePageRecords(workersCall, validWorkerRecord);
  if (!workerRecords) return malformedReadback(profileId, accountId, receipts, workersCall.receipt);
  const workerNames = workerRecords
    .map((entry) => stringField(entry, ["name", "id", "script_name"]))
    .filter((name): name is string => Boolean(name));

  const d1Call = cfctlCall(
    "d1-list-databases",
    profileId,
    accountId,
    [["account_id", accountId]],
    [["page", "1"], ["per_page", "10000"]],
    { kind: "page", per_page: 10000 },
  );
  receipts.push(d1Call.receipt);
  if (!d1Call.ok) return incompleteReadback(profileId, accountId, receipts);
  const d1Records = decodePageRecords(d1Call, validD1Record);
  if (!d1Records) return malformedReadback(profileId, accountId, receipts, d1Call.receipt);
  const d1Names = resourceNames(d1Records);
  const d1Ids = resourceIdentityMap(d1Records, ["uuid", "id"]);

  const r2Call = cfctlCall(
    "r2-list-buckets",
    profileId,
    accountId,
    [["account_id", accountId]],
    [["per_page", "1000"]],
    { kind: "cursor" },
  );
  receipts.push(r2Call.receipt);
  if (!r2Call.ok) return incompleteReadback(profileId, accountId, receipts);
  const r2Records = decodeCursorRecords(r2Call, "buckets", validNamedResourceRecord);
  if (!r2Records) return malformedReadback(profileId, accountId, receipts, r2Call.receipt);
  const r2Names = resourceNames(r2Records);

  const queueCall = cfctlCall("queues-list", profileId, accountId, [["account_id", accountId]]);
  receipts.push(queueCall.receipt);
  if (!queueCall.ok) return incompleteReadback(profileId, accountId, receipts);
  const queueRecords = decodePlainRecords(queueCall.result, validQueueRecord);
  if (!queueRecords) return malformedReadback(profileId, accountId, receipts, queueCall.receipt);
  const queueNames = queueRecords
    .map((entry) => stringField(entry, ["queue_name", "name"]))
    .filter((name): name is string => Boolean(name));
  const queueIds = resourceIdentityMap(queueRecords, ["queue_id", "id"], ["queue_name", "name"]);

  const expectedConsumer = expectedQueueConsumer();
  if (!expectedConsumer) {
    receipts.push(failureReceipt("wrangler-queue-consumer-contract", false, "LOCAL_CONTRACT_MALFORMED"));
    return incompleteReadback(profileId, accountId, receipts);
  }
  const queueId = queueIds.get(expectedConsumer.queue_name);
  if (!queueId) {
    receipts.push(failureReceipt("queues-list:expected-queue", true, "EXPECTED_QUEUE_MISSING"));
    return incompleteReadback(profileId, accountId, receipts);
  }
  const consumersCall = cfctlCall(
    "queues-list-consumers",
    profileId,
    accountId,
    [["queue_id", queueId], ["account_id", accountId]],
  );
  receipts.push(consumersCall.receipt);
  if (!consumersCall.ok) return incompleteReadback(profileId, accountId, receipts);
  const consumerRecords = decodePlainRecords(consumersCall.result, validQueueConsumerRecord);
  if (!consumerRecords) return malformedReadback(profileId, accountId, receipts, consumersCall.receipt);
  const consumerStatus = consumerRecords.some((consumer) =>
    queueConsumerMatches(consumer, expectedConsumer, queueIds)
  ) ? "ok" : "missing";

  const expectedBindings = expectedWorkerBindings();
  if (!expectedBindings) {
    receipts.push(failureReceipt("wrangler-worker-binding-contract", false, "LOCAL_CONTRACT_MALFORMED"));
    return incompleteReadback(profileId, accountId, receipts);
  }
  const workers: Record<string, Status> = {};
  for (const [role, worker] of Object.entries(desiredState.workers)) {
    const settingsCall = cfctlCall(
      "worker-script-get-settings",
      profileId,
      accountId,
      [["account_id", accountId], ["script_name", worker.script_name]],
    );
    receipts.push(settingsCall.receipt);
    if (!settingsCall.ok) return incompleteReadback(profileId, accountId, receipts);
    const bindings = decodeWorkerBindings(settingsCall.result);
    if (!bindings) return malformedReadback(profileId, accountId, receipts, settingsCall.receipt);
    workers[role] = workerNames.includes(worker.script_name) &&
        workerBindingsMatch(bindings, expectedBindings[role] ?? [], d1Ids, queueIds)
      ? "ok"
      : "missing";
  }

  const storage: Record<string, Status> = {
    d1_database: includesStatus(d1Names, desiredState.storage.d1_database),
    r2_policy_bucket: includesStatus(r2Names, desiredState.storage.r2_policy_bucket),
    r2_spool_bucket: includesStatus(r2Names, desiredState.storage.r2_spool_bucket),
    queue: includesStatus(queueNames, desiredState.storage.queue) === "ok" ? consumerStatus : "missing",
    dead_letter_queue: includesStatus(queueNames, desiredState.storage.dead_letter_queue),
  };
  const domainStatuses = Object.values(domains).flatMap((domain) => [
    domain.email_routing ?? "not_checked",
    domain.catch_all ?? "not_checked",
    ...Object.values(domain.aliases ?? {}),
  ]);
  const maildeskEvidence: CfctlMaildeskEvidence = {
    edge_ready: [...domainStatuses, ...Object.values(workers), ...Object.values(storage)]
      .every(readinessSatisfied),
    mail_ready: false,
    domains,
    workers,
    storage,
    ...(senderMode === "cloudflare_email_service" ? { sender_domains: senderDomains } : {}),
  };

  return {
    readback: {
      required: true,
      attempted: true,
      complete: true,
      profile_id: profileId,
      account_id: accountId,
      receipts,
    },
    evidence: {
      zones: zones.sort(),
      email_routing: emailRouting,
      dns_mx: dnsMx,
      cfctl_maildesk: maildeskEvidence,
    },
  };
}

function incompleteReadback(
  profileId: string,
  accountId: string,
  receipts: CfctlReadReceipt[],
): { readback: CfctlReadbackEvidence } {
  return {
    readback: {
      required: true,
      attempted: true,
      complete: false,
      profile_id: profileId,
      account_id: accountId,
      receipts,
    },
  };
}

function malformedReadback(
  profileId: string,
  accountId: string,
  receipts: CfctlReadReceipt[],
  receipt: CfctlReadReceipt,
): { readback: CfctlReadbackEvidence } {
  receipt.ok = false;
  receipt.error_code = "CFCTL_RESULT_SHAPE_MALFORMED";
  return incompleteReadback(profileId, accountId, receipts);
}

function cfctlProfileAccount(profileId: string): {
  ok: boolean;
  account_id?: string;
  receipt: CfctlReadReceipt;
} {
  const result = spawnSync(cfctlBin, ["auth", "profiles", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return { ok: false, receipt: failureReceipt("auth-profiles", false, "CFCTL_COMMAND_FAILED") };
  }
  const envelope = parseJson<CfctlEnvelope>(result.stdout);
  if (!envelope) {
    return { ok: false, receipt: failureReceipt("auth-profiles", false, "CFCTL_ENVELOPE_MALFORMED") };
  }
  if (envelope.schema_version !== 2) {
    return {
      ok: false,
      receipt: failureReceipt("auth-profiles", false, "CFCTL_ENVELOPE_VERSION_MISMATCH"),
    };
  }
  if (envelope.ok !== true || envelope.performed !== false || envelope.error) {
    return {
      ok: false,
      receipt: failureReceipt(
        "auth-profiles",
        envelope.performed === true,
        envelope.error?.code ?? "CFCTL_PROFILE_ENVELOPE_INVALID",
      ),
    };
  }
  const profiles = resultRecords((envelope?.result as { profiles?: unknown } | undefined)?.profiles);
  const profile = profiles.find((entry) => stringField(entry, ["id"]) === profileId);
  const accountId = stringField(profile, ["account_id"]);
  if (!accountId) {
    return {
      ok: false,
      receipt: failureReceipt("auth-profiles", false, "PROFILE_ACCOUNT_UNAVAILABLE"),
    };
  }
  return {
    ok: true,
    account_id: accountId,
    receipt: {
      capability_id: "auth-profiles",
      ok: true,
      performed: false,
      verification_state: envelope.verification?.state ?? "not_applicable",
      evidence_hashes: [],
    },
  };
}

function cfctlCall(
  capabilityId: string,
  profileId: string,
  accountId: string,
  selectors: Array<[string, string]>,
  query: Array<[string, string]> = [],
  paginationContract: PaginationContract = null,
): CfctlCallResult {
  const commandArgs = [
    "call",
    capabilityId,
    ...selectors.flatMap(([name, value]) => ["--selector", `${name}=${value}`]),
    ...query.flatMap(([name, value]) => ["--query", `${name}=${value}`]),
    "--profile",
    profileId,
    "--account",
    accountId,
    "--json",
  ];
  const result = spawnSync(cfctlBin, commandArgs, { cwd: root, encoding: "utf8" });
  const envelope = result.status === 0 ? parseJson<CfctlEnvelope>(result.stdout) : null;
  const bindingOk = Boolean(
    result.status === 0 &&
    envelope?.schema_version === 2 &&
    envelope?.ok === true &&
    envelope.performed === true &&
    envelope.capability_id === capabilityId &&
    envelope.profile_id === profileId &&
    envelope.account_id === accountId &&
    !envelope.error &&
    receiptFromEnvelope(capabilityId, envelope).evidence_hashes.length > 0,
  );
  const receipt = envelope
    ? receiptFromEnvelope(capabilityId, envelope)
    : failureReceipt(capabilityId, false, "CFCTL_COMMAND_FAILED");
  const pagination = paginationStatus(envelope?.result, paginationContract);
  if (pagination.summary) receipt.pagination = pagination.summary;
  const ok = bindingOk && pagination.ok;
  if (!ok && !receipt.error_code) {
    receipt.ok = false;
    receipt.error_code = envelope?.schema_version !== 2
      ? "CFCTL_ENVELOPE_VERSION_MISMATCH"
      : bindingOk
        ? pagination.error_code ?? "CFCTL_PAGINATION_MALFORMED"
        : "CFCTL_ENVELOPE_BINDING_MISMATCH";
  }
  return { ok, result: ok ? envelope?.result : undefined, receipt };
}

function collectEmailRoutingRules(
  capabilityId: string,
  profileId: string,
  accountId: string,
  selectors: Array<[string, string]>,
): { ok: boolean; records?: EmailRoutingRule[]; receipts: CfctlReadReceipt[] } {
  const call = cfctlCall(capabilityId, profileId, accountId, selectors);
  const receipts = [call.receipt];
  if (!call.ok) return { ok: false, receipts };

  const projection = decodeEmailRoutingRuleSet(call.result);
  if (!projection) {
    call.receipt.ok = false;
    call.receipt.error_code = "CFCTL_RESULT_SHAPE_MALFORMED";
    return { ok: false, receipts };
  }
  call.receipt.pagination = {
    kind: "page_probe",
    per_page: projection.page_size,
    total_pages: projection.pages,
    total_count: projection.rule_count,
    item_count: projection.rule_count,
    terminal: projection.complete,
  };
  return { ok: true, records: projection.rules, receipts };
}

function decodeEmailRoutingRuleSet(value: unknown): EmailRoutingRuleSet | null {
  if (!isRecord(value) || !isRecord(value.result)) return null;
  const projection = value.result;
  if (
    projection.schema_version !== EMAIL_ROUTING_RULE_SET_SCHEMA_VERSION ||
    projection.complete !== true ||
    projection.page_size !== EMAIL_ROUTING_RULE_PAGE_SIZE ||
    typeof projection.pages !== "number" ||
    !Number.isInteger(projection.pages) ||
    projection.pages < 1 ||
    projection.pages > EMAIL_ROUTING_RULE_MAX_PAGES ||
    typeof projection.rule_count !== "number" ||
    !Number.isInteger(projection.rule_count) ||
    projection.rule_count < 0 ||
    projection.rule_count > (projection.pages - 1) * EMAIL_ROUTING_RULE_PAGE_SIZE ||
    !Array.isArray(projection.rules) ||
    projection.rule_count !== projection.rules.length
  ) return null;
  const rules = projection.rules.filter(isRecord);
  if (rules.length !== projection.rules.length || !rules.every(validProjectedRoutingRule)) return null;
  return {
    schema_version: EMAIL_ROUTING_RULE_SET_SCHEMA_VERSION,
    complete: true,
    page_size: EMAIL_ROUTING_RULE_PAGE_SIZE,
    pages: projection.pages,
    rule_count: projection.rule_count,
    rules: rules as unknown as EmailRoutingRule[],
  };
}

function paginationStatus(value: unknown, contract: PaginationContract): {
  ok: boolean;
  error_code?: string;
  summary?: NonNullable<CfctlReadReceipt["pagination"]>;
} {
  if (!contract) return { ok: true };
  if (!isRecord(value) || !isRecord(value.result_info)) {
    return { ok: false, error_code: "CFCTL_PAGINATION_MALFORMED" };
  }
  const info = value.result_info;
  if (contract.kind === "cursor") {
    if (!("cursor" in info) || (info.cursor !== null && typeof info.cursor !== "string")) {
      return { ok: false, error_code: "CFCTL_PAGINATION_MALFORMED" };
    }
    const cursorPresent = typeof info.cursor === "string" && info.cursor.length > 0;
    return {
      ok: !cursorPresent,
      ...(cursorPresent ? { error_code: "CFCTL_PAGINATION_INCOMPLETE" } : {}),
      summary: { kind: "cursor", cursor_present: cursorPresent },
    };
  }

  for (const cursor of [info.cursor, isRecord(info.cursors) ? info.cursors.after : info.cursors]) {
    if (cursor !== undefined && cursor !== null && typeof cursor !== "string") {
      return { ok: false, error_code: "CFCTL_PAGINATION_MALFORMED" };
    }
    if (typeof cursor === "string" && cursor.length > 0) {
      return { ok: false, error_code: "CFCTL_PAGINATION_INCOMPLETE" };
    }
  }

  const page = integerField(info, "page");
  const perPage = integerField(info, "per_page");
  const totalPages = integerField(info, "total_pages");
  const totalCount = integerField(info, "total_count");
  if (
    page !== 1 ||
    perPage !== contract.per_page ||
    totalPages === null ||
    totalPages < 0 ||
    totalCount === null ||
    totalCount < 0
  ) {
    return { ok: false, error_code: "CFCTL_PAGINATION_MALFORMED" };
  }
  const incomplete = totalPages > 1 || totalCount > contract.per_page;
  return {
    ok: !incomplete,
    ...(incomplete ? { error_code: "CFCTL_PAGINATION_INCOMPLETE" } : {}),
    summary: {
      kind: "page",
      page,
      per_page: perPage,
      total_pages: totalPages,
      total_count: totalCount,
    },
  };
}

function integerField(value: Record<string, unknown>, name: string): number | null {
  const field = value[name];
  return typeof field === "number" && Number.isInteger(field) ? field : null;
}

function receiptFromEnvelope(capabilityId: string, envelope: CfctlEnvelope): CfctlReadReceipt {
  return {
    capability_id: capabilityId,
    ok: envelope.ok === true,
    performed: envelope.performed === true,
    verification_state: envelope.verification?.state ?? "missing",
    evidence_hashes: (envelope.evidence ?? [])
      .map((entry) => entry.content_hash)
      .filter((value): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value)),
    ...(envelope.error?.code ? { error_code: envelope.error.code } : {}),
  };
}

function failureReceipt(
  capabilityId: string,
  performed: boolean,
  errorCode: string,
): CfctlReadReceipt {
  return {
    capability_id: capabilityId,
    ok: false,
    performed,
    verification_state: "failed",
    evidence_hashes: [],
    error_code: errorCode,
  };
}

function decodePageRecords(
  call: CfctlCallResult,
  validate: (value: Record<string, unknown>) => boolean,
): Array<Record<string, unknown>> | null {
  if (!isRecord(call.result) || !Array.isArray(call.result.result)) return null;
  const records = call.result.result.filter(isRecord);
  if (records.length !== call.result.result.length || !records.every(validate)) return null;
  const pagination = call.receipt.pagination;
  if (
    pagination?.kind !== "page" ||
    pagination.total_count !== records.length
  ) return null;
  return records;
}

function decodeCursorRecords(
  call: CfctlCallResult,
  collectionKey: string,
  validate: (value: Record<string, unknown>) => boolean,
): Array<Record<string, unknown>> | null {
  if (!isRecord(call.result) || !isRecord(call.result.result)) return null;
  const collection = call.result.result[collectionKey];
  if (!Array.isArray(collection)) return null;
  const records = collection.filter(isRecord);
  if (records.length !== collection.length || !records.every(validate)) return null;
  return call.receipt.pagination?.kind === "cursor" ? records : null;
}

function decodePlainRecords(
  value: unknown,
  validate: (entry: Record<string, unknown>) => boolean,
): Array<Record<string, unknown>> | null {
  if (!isRecord(value) || !Array.isArray(value.result)) return null;
  const records = value.result.filter(isRecord);
  return records.length === value.result.length && records.every(validate) ? records : null;
}

function decodeSettings(value: unknown): { enabled: boolean } | null {
  if (!isRecord(value) || !isRecord(value.result) || typeof value.result.enabled !== "boolean") {
    return null;
  }
  return { enabled: value.result.enabled };
}

function decodeCatchAllRule(value: unknown): RoutingRule | null {
  if (!isRecord(value) || !isRecord(value.result)) return null;
  const rule = value.result;
  if (typeof rule.enabled !== "boolean" || !Array.isArray(rule.actions)) return null;
  if (!rule.actions.every((action) =>
    isRecord(action) &&
    typeof action.type === "string" &&
    (action.value === undefined ||
      (Array.isArray(action.value) && action.value.every((entry) => typeof entry === "string")))
  )) return null;
  return rule as RoutingRule;
}

function resultRecords(value: unknown, nestedKeys: string[] = []): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  if (Array.isArray(value.result)) return value.result.filter(isRecord);
  if (isRecord(value.result)) {
    for (const key of nestedKeys) {
      if (Array.isArray(value.result[key])) return value.result[key].filter(isRecord);
    }
  }
  for (const key of nestedKeys) {
    if (Array.isArray(value[key])) return value[key].filter(isRecord);
  }
  return [];
}

function resourceNames(records: Array<Record<string, unknown>>): string[] {
  return records
    .map((entry) => stringField(entry, ["name", "database_name", "bucket_name"]))
    .filter((name): name is string => Boolean(name));
}

function resourceIdentityMap(
  records: Array<Record<string, unknown>>,
  idFields: string[],
  nameFields: string[] = ["name", "database_name", "bucket_name"],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const record of records) {
    const name = stringField(record, nameFields);
    const id = stringField(record, idFields);
    if (name && id) result.set(name, id);
  }
  return result;
}

function validZoneRecord(value: Record<string, unknown>): boolean {
  return typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.status === "string";
}

function validProjectedRoutingRule(value: Record<string, unknown>): boolean {
  if (
    typeof value.enabled !== "boolean" ||
    !Array.isArray(value.matchers) ||
    value.matchers.length === 0 ||
    !Array.isArray(value.actions) ||
    value.actions.length === 0
  ) return false;
  const matchersValid = value.matchers.every((matcher) => {
    if (!isRecord(matcher) || typeof matcher.matcher_type !== "string" || matcher.matcher_type.length === 0) {
      return false;
    }
    const fieldPresent = typeof matcher.field === "string" && matcher.field.length > 0;
    const identityPresent = typeof matcher.value_sha256 === "string" &&
      /^sha256:[a-f0-9]{64}$/.test(matcher.value_sha256);
    return (matcher.field === undefined && matcher.value_sha256 === undefined) ||
      (fieldPresent && identityPresent);
  });
  const actionsValid = value.actions.every((action) =>
    isRecord(action) &&
    typeof action.action_type === "string" &&
    action.action_type.length > 0 &&
    Array.isArray(action.worker_targets) &&
    action.worker_targets.every((entry) => typeof entry === "string" && entry.length > 0) &&
    typeof action.value_count === "number" &&
    Number.isInteger(action.value_count) &&
    action.value_count >= action.worker_targets.length &&
    (action.action_type === "worker"
      ? action.value_count === action.worker_targets.length
      : action.worker_targets.length === 0)
  );
  return matchersValid && actionsValid;
}

function validDnsRecord(value: Record<string, unknown>): boolean {
  return typeof value.type === "string" &&
    typeof value.name === "string" &&
    typeof value.content === "string";
}

function validWorkerRecord(value: Record<string, unknown>): boolean {
  return Boolean(stringField(value, ["name", "id", "script_name"]));
}

function validNamedResourceRecord(value: Record<string, unknown>): boolean {
  return Boolean(stringField(value, ["name", "database_name", "bucket_name"]));
}

function validD1Record(value: Record<string, unknown>): boolean {
  return validNamedResourceRecord(value) && Boolean(stringField(value, ["uuid", "id"]));
}

function validQueueRecord(value: Record<string, unknown>): boolean {
  return Boolean(stringField(value, ["queue_name", "name"])) &&
    Boolean(stringField(value, ["queue_id", "id"]));
}

function validSenderDomainRecord(value: Record<string, unknown>): boolean {
  return Boolean(stringField(value, ["name", "hostname", "subdomain"])) &&
    Boolean(stringField(value, ["status", "dns_status"]));
}

function validQueueConsumerRecord(value: Record<string, unknown>): boolean {
  if (
    typeof value.type !== "string" ||
    typeof value.script_name !== "string" ||
    !isRecord(value.settings)
  ) return false;
  return ["batch_size", "max_concurrency", "max_retries"].every((field) =>
    typeof value.settings[field] === "number" && Number.isInteger(value.settings[field])
  ) && typeof value.settings.dead_letter_queue === "string";
}

function queueConsumerMatches(
  value: Record<string, unknown>,
  expected: ExpectedQueueConsumer,
  queueIds: Map<string, string>,
): boolean {
  if (!isRecord(value.settings)) return false;
  const expectedDlqId = queueIds.get(expected.dead_letter_queue);
  return value.type === "worker" &&
    value.script_name === expected.script_name &&
    value.settings.batch_size === expected.batch_size &&
    value.settings.max_concurrency === expected.max_concurrency &&
    value.settings.max_retries === expected.max_retries &&
    (value.settings.dead_letter_queue === expected.dead_letter_queue ||
      value.settings.dead_letter_queue === expectedDlqId);
}

function decodeWorkerBindings(value: unknown): Array<Record<string, unknown>> | null {
  if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.bindings)) {
    return null;
  }
  const bindings = value.result.bindings.filter(isRecord);
  if (
    bindings.length !== value.result.bindings.length ||
    bindings.some((binding) => typeof binding.name !== "string" || typeof binding.type !== "string")
  ) return null;
  return bindings;
}

function workerBindingsMatch(
  actual: Array<Record<string, unknown>>,
  expected: ExpectedWorkerBinding[],
  d1Ids: Map<string, string>,
  queueIds: Map<string, string>,
): boolean {
  return expected.every((expectedBinding) => actual.some((binding) => {
    if (binding.name !== expectedBinding.name || binding.type !== expectedBinding.type) return false;
    if (expectedBinding.type === "d1") {
      return binding.id === d1Ids.get(expectedBinding.resource ?? "");
    }
    if (expectedBinding.type === "r2_bucket") {
      return binding.bucket_name === expectedBinding.resource;
    }
    if (expectedBinding.type === "queue") {
      return binding.queue_name === expectedBinding.resource ||
        binding.queue_id === queueIds.get(expectedBinding.resource ?? "");
    }
    return true;
  }));
}

function expectedWorkerBindings(): Record<string, ExpectedWorkerBinding[]> | null {
  const result: Record<string, ExpectedWorkerBinding[]> = {};
  for (const [role, worker] of Object.entries(desiredState.workers)) {
    const config = readWranglerConfig(worker.config);
    if (!config) return null;
    const bindings: ExpectedWorkerBinding[] = [];
    for (const entry of Array.isArray(config.d1_databases) ? config.d1_databases : []) {
      if (!isRecord(entry) || typeof entry.binding !== "string" || typeof entry.database_name !== "string") {
        return null;
      }
      bindings.push({ name: entry.binding, type: "d1", resource: entry.database_name });
    }
    for (const entry of Array.isArray(config.r2_buckets) ? config.r2_buckets : []) {
      if (!isRecord(entry) || typeof entry.binding !== "string" || typeof entry.bucket_name !== "string") {
        return null;
      }
      bindings.push({ name: entry.binding, type: "r2_bucket", resource: entry.bucket_name });
    }
    const queues = isRecord(config.queues) ? config.queues : {};
    for (const entry of Array.isArray(queues.producers) ? queues.producers : []) {
      if (!isRecord(entry) || typeof entry.binding !== "string" || typeof entry.queue !== "string") {
        return null;
      }
      bindings.push({ name: entry.binding, type: "queue", resource: entry.queue });
    }
    for (const entry of Array.isArray(config.send_email) ? config.send_email : []) {
      if (!isRecord(entry) || typeof entry.name !== "string") return null;
      bindings.push({ name: entry.name, type: "send_email" });
    }
    if (isRecord(config.assets) && typeof config.assets.binding === "string") {
      bindings.push({ name: config.assets.binding, type: "assets" });
    }
    result[role] = bindings;
  }
  return result;
}

function expectedQueueConsumer(): ExpectedQueueConsumer | null {
  const config = readWranglerConfig(desiredState.workers.relay_outbound.config);
  if (!config || !isRecord(config.queues) || !Array.isArray(config.queues.consumers)) return null;
  const [consumer] = config.queues.consumers;
  if (
    !isRecord(consumer) ||
    typeof consumer.queue !== "string" ||
    typeof consumer.dead_letter_queue !== "string" ||
    !Number.isInteger(consumer.max_batch_size) ||
    !Number.isInteger(consumer.max_concurrency) ||
    !Number.isInteger(consumer.max_retries)
  ) return null;
  return {
    script_name: desiredState.workers.relay_outbound.script_name,
    queue_name: consumer.queue,
    dead_letter_queue: consumer.dead_letter_queue,
    batch_size: consumer.max_batch_size as number,
    max_concurrency: consumer.max_concurrency as number,
    max_retries: consumer.max_retries as number,
  };
}

function readWranglerConfig(path: string): Record<string, unknown> | null {
  const absolutePath = resolve(root, path);
  if (!absolutePath.startsWith(`${root}/`) || !existsSync(absolutePath)) return null;
  try {
    const parsed = Bun.TOML.parse(readFileSync(absolutePath, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(
  value: Record<string, unknown> | undefined,
  names: string[],
): string | undefined {
  if (!value) return undefined;
  for (const name of names) {
    if (typeof value[name] === "string") return value[name] as string;
  }
  return undefined;
}

function includesStatus(values: string[], expected: string): Status {
  return values.includes(expected) ? "ok" : "missing";
}

function readinessSatisfied(status: Status): boolean {
  return status === "ok" || status === "not_applicable";
}

function verifiedSenderStatus(value: string | undefined): Status {
  return value === "verified" || value === "active" || value === "ready" || value === "ok"
    ? "ok"
    : "drift";
}

function fetchJson(fetchArgs: string[]): { ok: true; value: unknown } | { ok: false } {
  const result = spawnSync("curl", fetchArgs, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch {
    return { ok: false };
  }
}

function validReadyzEvidence(value: unknown): value is ReadyzEvidence {
  if (!isRecord(value) || typeof value.ok !== "boolean" || !Array.isArray(value.checks)) {
    return false;
  }
  return value.checks.length > 0 && value.checks.every((check) =>
    isRecord(check) &&
    typeof check.name === "string" &&
    check.name.length > 0 &&
    typeof check.ok === "boolean" &&
    (check.detail === undefined || typeof check.detail === "string")
  );
}

function collectD1Evidence(databaseName: string): Evidence["d1"] {
  const tables = wranglerD1Results(
    databaseName,
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;",
  )
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string");

  const auditRows = wranglerD1Results(
    databaseName,
    "SELECT action, COUNT(*) AS count FROM audit_events GROUP BY action ORDER BY action;",
  );
  const audit_event_counts = Object.fromEntries(
    auditRows
      .filter((row) => typeof row.action === "string" && typeof row.count === "number")
      .map((row) => [row.action as string, row.count as number]),
  );

  return {
    ...(tables.length > 0 ? { tables } : {}),
    ...(Object.keys(audit_event_counts).length > 0 ? { audit_event_counts } : {}),
  };
}

function collectInboundProofs(databaseName: string): Record<string, InboundProof> {
  const rows = wranglerD1Results(
    databaseName,
    "SELECT rh.route_address, rh.decision_kind AS route_kind, rh.operator_count, rh.reply_identity, rh.policy_sha256, rh.last_inbound_provider_accepted_at, rh.last_inbound_provider_message_ids_json, rh.last_inbox_verified_at FROM route_health rh JOIN alias_routes ar ON ar.id = rh.route_id AND ar.enabled = 1 AND ar.policy_sha256 = rh.policy_sha256 JOIN runtime_state rs ON rs.singleton = 1 AND rs.active_policy_sha256 = rh.policy_sha256 WHERE rh.inbound_status IN ('inbox_verified', 'reply_verified') AND rh.last_inbound_provider_accepted_at IS NOT NULL AND rh.last_inbox_verified_at IS NOT NULL ORDER BY rh.last_inbox_verified_at DESC LIMIT 200;",
  );
  const proofs: Record<string, InboundProof> = {};

  for (const row of rows) {
    if (
      typeof row.route_address !== "string" ||
      typeof row.route_kind !== "string" ||
      typeof row.operator_count !== "number" ||
      typeof row.reply_identity !== "string" ||
      typeof row.policy_sha256 !== "string" ||
      typeof row.last_inbound_provider_accepted_at !== "string" ||
      typeof row.last_inbox_verified_at !== "string"
    ) continue;
    const providerMessageIds = typeof row.last_inbound_provider_message_ids_json === "string"
      ? parseJson<unknown>(row.last_inbound_provider_message_ids_json)
      : null;
    if (!Array.isArray(providerMessageIds) || providerMessageIds.some((value) => typeof value !== "string")) continue;
    const domain = domainPart(row.route_address);
    if (!domain) continue;
    if (proofs[domain]) continue;
    proofs[domain] = {
      status: "ok",
      envelope_to: row.route_address,
      route_kind: row.route_kind as InboundProof["route_kind"],
      operator_count: row.operator_count,
      policy_sha256: row.policy_sha256,
      provider_message_ids: providerMessageIds as string[],
      provider_accepted_at: row.last_inbound_provider_accepted_at,
      inbox_verified_at: row.last_inbox_verified_at,
      default_reply_identity: row.reply_identity,
      provider: "cloudflare_email_service",
    };
  }

  return proofs;
}

function collectOutboundProofs(databaseName: string): Record<string, OutboundProof> {
  const rows = wranglerD1Results(
    databaseName,
    "SELECT detail_json, created_at FROM audit_events WHERE action = 'outbound_reply_delivered' ORDER BY created_at DESC LIMIT 200;",
  );
  const proofs: Record<string, OutboundProof> = {};

  for (const row of rows) {
    if (typeof row.detail_json !== "string") continue;
    const detail = parseJson<OutboundAuditDetail>(row.detail_json);
    if (!detail?.fromIdentity || proofs[domainPart(detail.fromIdentity)]) continue;

    const domain = domainPart(detail.fromIdentity);
    if (!domain) continue;
    proofs[domain] = {
      status: "delivered",
      from_identity: detail.fromIdentity,
      provider: detail.result?.provider,
      provider_message_id: detail.result?.providerMessageId ?? detail.result?.id,
      audit_event_at: typeof row.created_at === "string" ? row.created_at : undefined,
    };
  }

  return proofs;
}

function wranglerD1Results(databaseName: string, sql: string): Array<Record<string, unknown>> {
  const result = spawnSync(wranglerBin, ["d1", "execute", databaseName, "--remote", "--command", sql], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) return [];

  const start = result.stdout.indexOf("[");
  if (start === -1) return [];
  try {
    const parsed = JSON.parse(result.stdout.slice(start)) as Array<{ results?: Array<Record<string, unknown>> }>;
    return parsed.flatMap((entry) => entry.results ?? []);
  } catch {
    return [];
  }
}

function collectResendDomains(): Record<string, string> {
  const result = spawnSync("resend", ["domains", "list", "--json", "--limit", "100"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) return {};
  try {
    const parsed = JSON.parse(result.stdout) as { data?: Array<{ name?: string; status?: string }> };
    return Object.fromEntries(
      (parsed.data ?? [])
        .filter((domain) => domain.name && domain.status)
        .map((domain) => [domain.name as string, domain.status as string]),
    );
  } catch {
    return {};
  }
}

function collectGoogleWorkspaceProofs(bin: string): Record<string, InboundProof> {
  const proofs: Record<string, InboundProof> = {};
  for (const domain of desiredState.domains.filter((entry) => entry.inbound_mx_provider === "google_workspace")) {
    const target = `founders@${domain.name}`;
    const result = spawnSync(bin, ["resource", "search", "--json", target], {
      cwd: root,
      encoding: "utf8",
    });
    if (result.status !== 0) continue;
    const parsed = parseJson<GoogleResourceSearch>(result.stdout);
    const resources = parsed?.resources ?? [];
    const group = resources.find((resource) => resource.id === `workspace:group:${target}`);
    const members = resources
      .filter((resource) => resource.type === "workspace.group_membership")
      .map((resource) => resource.record?.email)
      .filter((email): email is string => typeof email === "string")
      .map((email) => email.trim().toLowerCase())
      .sort();
    if (!group || members.length === 0) continue;
    proofs[domain.name] = {
      status: "ok",
      envelope_to: target,
      route_kind: "role_alias",
      operator_count: members.length,
      operator_set_sha256: sha256(JSON.stringify(members)),
      forward_errors: [],
      default_reply_identity: target,
      audit_event_at: parsed?.snapshot_captured_at,
      provider: "google_workspace",
      external_receipt_path: parsed?.receipt_path,
      external_receipt_sha256: sha256(result.stdout),
    };
  }
  return proofs;
}

function routesToMaildesk(rule: RoutingRule, routerService: string): boolean {
  return (rule.actions ?? []).some((action) => {
    return action.type === "worker" && action.value?.includes(routerService) === true;
  });
}

function projectedRuleRoutesToMaildesk(rule: EmailRoutingRule, routerService: string): boolean {
  return rule.actions.some((action) =>
    action.action_type === "worker" && action.worker_targets.includes(routerService)
  );
}

function localPart(address: string | undefined): string | undefined {
  const atIndex = address?.lastIndexOf("@") ?? -1;
  if (!address || atIndex <= 0) return undefined;
  return address.slice(0, atIndex).toLowerCase();
}

function domainPart(address: string | undefined): string | undefined {
  const atIndex = address?.lastIndexOf("@") ?? -1;
  if (!address || atIndex <= 0 || atIndex === address.length - 1) return undefined;
  return address.slice(atIndex + 1).toLowerCase();
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function normalizeName(name: string | undefined): string {
  return (name ?? "").replace(/\.$/, "").toLowerCase();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Identity(value: string): string {
  return `sha256:${sha256(value)}`;
}

function relativePath(path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

interface RoutingRule {
  recipient?: string;
  enabled?: boolean;
  matchers?: Array<{ field?: string; value?: string }>;
  actions?: Array<{ type?: string; value?: string[] }>;
}

interface EmailRoutingRuleSet {
  schema_version: 1;
  complete: true;
  page_size: 50;
  pages: number;
  rule_count: number;
  rules: EmailRoutingRule[];
}

interface EmailRoutingRule {
  enabled: boolean;
  matchers: Array<{
    matcher_type: string;
    field?: string;
    value_sha256?: string;
  }>;
  actions: Array<{
    action_type: string;
    worker_targets: string[];
    value_count: number;
  }>;
}

interface GoogleResourceSearch {
  receipt_path?: string;
  snapshot_captured_at?: string;
  resources?: Array<{
    id?: string;
    type?: string;
    record?: {
      email?: string;
    };
  }>;
}

interface OutboundAuditDetail {
  fromIdentity?: string;
  result?: {
    provider?: string;
    providerMessageId?: string;
    id?: string;
  };
}
