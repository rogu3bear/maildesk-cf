import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

interface DesiredState {
  domains: Array<{ name: string; inbound_mx_provider?: string }>;
  workers?: {
    mail_router?: {
      script_name?: string;
    };
  };
  storage?: {
    d1_database?: string;
  };
}

interface Evidence {
  generated_at: string;
  zones?: string[];
  email_routing?: Record<string, { role_aliases: string[]; personal_aliases: string[] }>;
  dns_mx?: Record<string, string[]>;
  r2_policy_sha256?: string;
  readyz?: unknown;
  d1?: {
    tables?: string[];
    audit_event_counts?: Record<string, number>;
  };
  sender_domains?: Record<string, string>;
  inbound_proofs?: Record<string, InboundProof>;
  outbound_proofs?: Record<string, OutboundProof>;
}

interface InboundProof {
  status: "ok";
  envelope_to: string;
  route_kind?: "role_alias" | "personal_alias" | "catch_all" | "sink";
  forwarded_to: string[];
  forward_errors: Array<{ recipient?: string; error?: string }>;
  default_reply_identity?: string;
  raw_r2_key?: string;
  provider?: string;
  external_receipt_path?: string;
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
const readyzUrl = process.env.MAILDESK_READYZ_URL ?? argValue("--readyz-url");
const r2PolicyPath = process.env.MAILDESK_R2_POLICY_PATH ?? argValue("--r2-policy-path");
const d1Database = process.env.MAILDESK_D1_DATABASE ?? argValue("--d1-database");
const googleAdminBin = process.env.GOOGLE_ADMIN_BIN ?? argValue("--google-admin");
const useResend = !args.includes("--no-resend");
const desiredState = readJson<DesiredState>(desiredStatePath);
const routerService = desiredState.workers?.mail_router?.script_name;
const evidence: Evidence = {
  generated_at: new Date().toISOString(),
};

const zones = cfctlJson(["list", "zone", "--json"]);
if (zones.ok && Array.isArray(zones.value.result)) {
  evidence.zones = zones.value.result.map((zone: { name?: string }) => zone.name).filter(Boolean).sort();
}

const routing: Evidence["email_routing"] = {};
const dnsMx: Evidence["dns_mx"] = {};
for (const domain of desiredState.domains.map((entry) => entry.name).sort()) {
  const rules = cfctlJson(["list", "email.routing_rule", "--zone", domain, "--json"]);
  if (rules.ok && Array.isArray(rules.value.result)) {
    const aliases = rules.value.result
      .filter((rule: RoutingRule) => rule.enabled !== false && routesToMaildesk(rule, routerService))
      .map((rule: RoutingRule) => localPart(rule.recipient ?? matcherValue(rule)))
      .filter(Boolean)
      .sort();

    routing[domain] = {
      role_aliases: unique(aliases),
      personal_aliases: unique(aliases),
    };
  }

  const dnsRecords = cfctlJson(["list", "dns.record", "--zone", domain, "--json"]);
  if (dnsRecords.ok && Array.isArray(dnsRecords.value.result)) {
    const mxRecords = dnsRecords.value.result
      .filter((record: DnsRecord) => record.type === "MX" && normalizeName(record.name) === domain)
      .map((record: DnsRecord) => record.content)
      .filter((content): content is string => typeof content === "string")
      .sort();
    if (mxRecords.length > 0) dnsMx[domain] = mxRecords;
  }
}
if (Object.keys(routing).length > 0) {
  evidence.email_routing = routing;
}
if (Object.keys(dnsMx).length > 0) {
  evidence.dns_mx = dnsMx;
}

if (r2PolicyPath) {
  evidence.r2_policy_sha256 = sha256(readFileSync(resolve(root, r2PolicyPath), "utf8"));
} else if (process.env.MAILDESK_ASSUME_LOCAL_POLICY_IN_R2 === "1") {
  evidence.r2_policy_sha256 = sha256(readFileSync(policyPath, "utf8"));
}

if (readyzUrl) {
  const readyz = fetchJson(["-fsS", readyzUrl]);
  if (readyz.ok) evidence.readyz = readyz.value;
}

const d1Name = desiredState.storage?.d1_database ?? d1Database;
if (d1Name) {
  evidence.d1 = collectD1Evidence(d1Name);
  const inboundProofs = collectInboundProofs(d1Name);
  if (Object.keys(inboundProofs).length > 0) {
    evidence.inbound_proofs = inboundProofs;
  }
  const outboundProofs = collectOutboundProofs(d1Name);
  if (Object.keys(outboundProofs).length > 0) {
    evidence.outbound_proofs = outboundProofs;
  }
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

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`wrote ${relativePath(outputPath)}`);

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

function cfctlJson(cfctlArgs: string[]): { ok: true; value: any } | { ok: false } {
  const result = spawnSync(cfctlBin, cfctlArgs, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch {
    return { ok: false };
  }
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
    "SELECT detail_json, created_at FROM audit_events WHERE action = 'inbound_email_received' ORDER BY created_at DESC LIMIT 200;",
  );
  const proofs: Record<string, InboundProof> = {};

  for (const row of rows) {
    if (typeof row.detail_json !== "string") continue;
    const detail = parseJson<InboundAuditDetail>(row.detail_json);
    if (!detail?.envelopeTo || proofs[domainPart(detail.envelopeTo)]) continue;
    if (!detail.rawR2Key || detail.storageError) continue;
    if (detail.forwardErrors && detail.forwardErrors.length > 0) continue;

    const domain = domainPart(detail.envelopeTo);
    if (!domain) continue;
    proofs[domain] = {
      status: "ok",
      envelope_to: detail.envelopeTo,
      route_kind: detail.routeKind,
      forwarded_to: detail.forwardedTo ?? [],
      forward_errors: detail.forwardErrors ?? [],
      default_reply_identity: detail.defaultReplyIdentity,
      raw_r2_key: detail.rawR2Key,
      audit_event_at: typeof row.created_at === "string" ? row.created_at : undefined,
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
      provider_message_id: detail.result?.id,
      audit_event_at: typeof row.created_at === "string" ? row.created_at : undefined,
    };
  }

  return proofs;
}

function wranglerD1Results(databaseName: string, sql: string): Array<Record<string, unknown>> {
  const result = spawnSync("wrangler", ["d1", "execute", databaseName, "--remote", "--command", sql], {
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
      .sort();
    if (!group || members.length === 0) continue;
    proofs[domain.name] = {
      status: "ok",
      envelope_to: target,
      route_kind: "role_alias",
      forwarded_to: members,
      forward_errors: [],
      default_reply_identity: target,
      audit_event_at: parsed?.snapshot_captured_at,
      provider: "google_workspace",
      external_receipt_path: parsed?.receipt_path,
    };
  }
  return proofs;
}

function routesToMaildesk(rule: RoutingRule, routerService: string | undefined): boolean {
  return (rule.actions ?? []).some((action) => {
    if (action.type === "worker") {
      return !routerService || action.value?.includes(routerService);
    }
    if (action.type === "forward") {
      return true;
    }
    return false;
  });
}

function matcherValue(rule: RoutingRule): string | undefined {
  return rule.matchers?.find((matcher) => matcher.field === "to")?.value;
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

function relativePath(path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

interface RoutingRule {
  recipient?: string;
  enabled?: boolean;
  matchers?: Array<{ field?: string; value?: string }>;
  actions?: Array<{ type?: string; value?: string[] }>;
}

interface DnsRecord {
  name?: string;
  type?: string;
  content?: string;
}

interface InboundAuditDetail {
  envelopeTo?: string;
  routeKind?: "role_alias" | "personal_alias" | "catch_all" | "sink";
  forwardedTo?: string[];
  forwardErrors?: Array<{ recipient?: string; error?: string }>;
  defaultReplyIdentity?: string;
  rawR2Key?: string;
  storageError?: string;
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
    id?: string;
  };
}
