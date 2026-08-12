import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type InboundProvider = "cloudflare_email_routing" | "google_workspace" | "external" | "excluded";
type DecisionKind = "role_alias" | "personal_alias" | "catch_all" | "sink";

interface DesiredState {
  storage: { d1_database: string; d1_preview_database?: string };
  domains: Array<{
    name: string;
    inbound_mx_provider: InboundProvider;
    role_aliases: string[];
    personal_aliases: string[];
    catch_all?: boolean;
  }>;
}

interface RouterPolicy {
  domains: Record<string, {
    role_aliases: Record<string, {
      operators: string[];
      reply_identity: string;
      sink?: boolean;
    }>;
    personal_aliases: Record<string, {
      operator: string;
      reply_identity: string;
    }>;
    catch_all?: {
      operators: string[];
      reply_identity: string;
      sink?: boolean;
    };
  }>;
}

interface ProjectedRoute {
  domain: string;
  localPart: string;
  decisionKind: DecisionKind;
  storageKind: "role" | "personal";
  desiredProvider: Exclude<InboundProvider, "excluded">;
  operators: string[];
  replyIdentity: string;
  initialStatus: "local_policy_valid" | "declared" | "intentionally_excluded";
}

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const policyPath = resolve(root, argValue("--policy") ?? defaultPath("config/policy.local.json", "config/policy.example.json"));
const desiredStatePath = resolve(
  root,
  argValue("--desired-state") ?? defaultPath("config/desired-state.local.json", "config/desired-state.example.json"),
);
const executeLocal = args.includes("--local");

if (args.includes("--remote")) {
  fail("remote policy sync is a protected action; use a reviewed cfctl plan instead");
}

const policy = readJson<RouterPolicy>(policyPath, "policy");
const desired = readJson<DesiredState>(desiredStatePath, "desired state");
const routes = projectRoutes(policy, desired);
const projection = projectionSql(routes);
const digest = createHash("sha256").update(projection).digest("hex");

if (executeLocal) {
  executeLocalProjection(projection, argValue("--database") ?? desired.storage.d1_database);
}

console.log(JSON.stringify({
  ok: true,
  mode: executeLocal ? "local" : "dry_run",
  domains: new Set(routes.map((route) => route.domain)).size,
  routes: routes.length,
  role_routes: routes.filter((route) => route.decisionKind === "role_alias").length,
  personal_routes: routes.filter((route) => route.decisionKind === "personal_alias").length,
  catch_all_routes: routes.filter((route) => route.decisionKind === "catch_all").length,
  sink_routes: routes.filter((route) => route.decisionKind === "sink").length,
  projection_sha256: digest,
}, null, 2));

function projectRoutes(policy: RouterPolicy, desired: DesiredState): ProjectedRoute[] {
  if (!policy.domains || Object.keys(policy.domains).length === 0) fail("policy must contain domains");
  if (!Array.isArray(desired.domains) || desired.domains.length === 0) fail("desired state must contain domains");
  const desiredByDomain = new Map(desired.domains.map((domain) => [normalizeDomain(domain.name), domain]));
  const routes: ProjectedRoute[] = [];

  for (const [rawDomain, domainPolicy] of Object.entries(policy.domains)) {
    const domain = normalizeDomain(rawDomain);
    const desiredDomain = desiredByDomain.get(domain);
    if (!desiredDomain) fail(`policy domain is missing from desired state: ${domain}`);
    const desiredRoles = new Set(desiredDomain.role_aliases.map(normalizeLocalPart));
    const desiredPersonal = new Set(desiredDomain.personal_aliases.map(normalizeLocalPart));
    const policyRoles = new Set(Object.keys(domainPolicy.role_aliases).map(normalizeLocalPart));
    const policyPersonal = new Set(Object.keys(domainPolicy.personal_aliases).map(normalizeLocalPart));
    requireSameSet(desiredRoles, policyRoles, `${domain} role aliases`);
    requireSameSet(desiredPersonal, policyPersonal, `${domain} personal aliases`);
    if (Boolean(desiredDomain.catch_all) !== Boolean(domainPolicy.catch_all)) {
      fail(`${domain} catch_all must match between desired state and private policy`);
    }

    for (const [rawLocalPart, route] of Object.entries(domainPolicy.role_aliases)) {
      const localPart = normalizeLocalPart(rawLocalPart);
      const decisionKind: DecisionKind = route.sink ? "sink" : "role_alias";
      routes.push(projectedRoute(
        domain,
        localPart,
        decisionKind,
        "role",
        desiredDomain.inbound_mx_provider,
        route.sink ? [] : route.operators,
        route.reply_identity,
      ));
    }
    for (const [rawLocalPart, route] of Object.entries(domainPolicy.personal_aliases)) {
      routes.push(projectedRoute(
        domain,
        normalizeLocalPart(rawLocalPart),
        "personal_alias",
        "personal",
        desiredDomain.inbound_mx_provider,
        [route.operator],
        route.reply_identity,
      ));
    }
    if (domainPolicy.catch_all) {
      routes.push(projectedRoute(
        domain,
        "*",
        domainPolicy.catch_all.sink ? "sink" : "catch_all",
        "role",
        desiredDomain.inbound_mx_provider,
        domainPolicy.catch_all.sink ? [] : domainPolicy.catch_all.operators,
        domainPolicy.catch_all.reply_identity,
      ));
    }
  }

  for (const desiredDomain of desired.domains) {
    const domain = normalizeDomain(desiredDomain.name);
    if (policy.domains[domain]) continue;
    const aliasCount = desiredDomain.role_aliases.length + desiredDomain.personal_aliases.length + Number(Boolean(desiredDomain.catch_all));
    if (aliasCount > 0 && desiredDomain.inbound_mx_provider !== "excluded") {
      fail(`desired-state routes are missing from private policy: ${domain}`);
    }
  }
  return routes.sort((a, b) => `${a.domain}\0${a.localPart}`.localeCompare(`${b.domain}\0${b.localPart}`));
}

function projectedRoute(
  domain: string,
  localPart: string,
  decisionKind: DecisionKind,
  storageKind: "role" | "personal",
  provider: InboundProvider,
  rawOperators: string[],
  rawReplyIdentity: string,
): ProjectedRoute {
  const operators = [...new Set(rawOperators.map(normalizeMailbox))].sort();
  const replyIdentity = normalizeMailbox(rawReplyIdentity);
  if (decisionKind !== "sink" && operators.length === 0) fail(`${localPart}@${domain} has no operator destination`);
  const desiredProvider = provider === "excluded" ? "external" : provider;
  const initialStatus = decisionKind === "sink" || provider === "excluded"
    ? "intentionally_excluded"
    : provider === "cloudflare_email_routing"
      ? "local_policy_valid"
      : "declared";
  return { domain, localPart, decisionKind, storageKind, desiredProvider, operators, replyIdentity, initialStatus };
}

function projectionSql(routes: ProjectedRoute[]): string {
  const statements = ["PRAGMA foreign_keys = ON;", "BEGIN TRANSACTION;"];
  for (const route of routes) {
    const domainId = stableId("domain", route.domain);
    const identityId = stableId("identity", route.replyIdentity);
    const routeId = stableId("route", route.domain, route.localPart);
    statements.push(
      `INSERT OR IGNORE INTO domains (id, domain) VALUES (${sql(domainId)}, ${sql(route.domain)});`,
      `INSERT INTO identities (id, domain_id, address, kind) VALUES (${sql(identityId)}, ${sql(domainId)}, ${sql(route.replyIdentity)}, ${sql(route.storageKind)}) ON CONFLICT(id) DO UPDATE SET address = excluded.address, kind = excluded.kind;`,
      `INSERT INTO alias_routes (id, domain_id, local_part, kind, default_reply_identity_id, decision_kind) VALUES (${sql(routeId)}, ${sql(domainId)}, ${sql(route.localPart)}, ${sql(route.storageKind)}, ${sql(identityId)}, ${sql(route.decisionKind)}) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, default_reply_identity_id = excluded.default_reply_identity_id, decision_kind = excluded.decision_kind;`,
      `DELETE FROM alias_route_operators WHERE route_id = ${sql(routeId)};`,
    );
    for (const operator of route.operators) {
      const operatorId = stableId("operator", operator);
      statements.push(
        `INSERT INTO operators (id, email) VALUES (${sql(operatorId)}, ${sql(operator)}) ON CONFLICT(id) DO UPDATE SET email = excluded.email;`,
        `INSERT OR IGNORE INTO alias_route_operators (route_id, operator_id) VALUES (${sql(routeId)}, ${sql(operatorId)});`,
      );
    }
    statements.push(
      `INSERT INTO route_health (route_id, route_address, decision_kind, desired_provider, operator_count, reply_identity, inbound_status, reply_status, updated_at) VALUES (${sql(routeId)}, ${sql(`${route.localPart}@${route.domain}`)}, ${sql(route.decisionKind)}, ${sql(route.desiredProvider)}, ${route.operators.length}, ${sql(route.replyIdentity)}, ${sql(route.initialStatus)}, ${sql(route.initialStatus)}, CURRENT_TIMESTAMP) ON CONFLICT(route_id) DO UPDATE SET route_address = excluded.route_address, decision_kind = excluded.decision_kind, desired_provider = excluded.desired_provider, operator_count = excluded.operator_count, reply_identity = excluded.reply_identity, inbound_status = CASE WHEN route_health.desired_provider <> excluded.desired_provider OR excluded.inbound_status = 'intentionally_excluded' THEN excluded.inbound_status ELSE route_health.inbound_status END, reply_status = CASE WHEN route_health.desired_provider <> excluded.desired_provider OR excluded.reply_status = 'intentionally_excluded' THEN excluded.reply_status ELSE route_health.reply_status END, updated_at = CURRENT_TIMESTAMP;`,
    );
  }
  statements.push("COMMIT;");
  return `${statements.join("\n")}\n`;
}

function executeLocalProjection(sqlText: string, database: string) {
  if (!/^[a-zA-Z0-9._-]+$/.test(database)) fail("D1 database name is invalid");
  const directory = mkdtempSync(join(tmpdir(), "maildesk-policy-sync-"));
  const file = join(directory, "projection.sql");
  try {
    writeFileSync(file, sqlText, { encoding: "utf8", mode: 0o600 });
    const result = spawnSync(
      "bunx",
      ["wrangler", "d1", "execute", database, "--local", "--file", file],
      { cwd: root, encoding: "utf8", env: process.env },
    );
    if (result.status !== 0) fail(`local D1 policy sync failed: ${boundedError(result.stderr || result.stdout)}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function requireSameSet(left: Set<string>, right: Set<string>, label: string) {
  const missing = [...left].filter((value) => !right.has(value));
  const extra = [...right].filter((value) => !left.has(value));
  if (missing.length > 0 || extra.length > 0) fail(`${label} differ between desired state and private policy`);
}

function normalizeDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  if (!/^(?=.{1,253}$)[a-z0-9.-]+$/.test(domain)) fail("domain is invalid");
  return domain;
}

function normalizeLocalPart(value: string): string {
  const localPart = value.trim().toLowerCase();
  if (localPart !== "*" && !/^[a-z0-9][a-z0-9._+-]*$/.test(localPart)) fail("alias local part is invalid");
  return localPart;
}

function normalizeMailbox(value: string): string {
  const mailbox = value.trim().toLowerCase();
  const [localPart, domain, extra] = mailbox.split("@");
  if (!localPart || !domain || extra || /[\s\x00-\x1f\x7f]/.test(mailbox)) fail("mailbox is invalid");
  normalizeDomain(domain);
  return mailbox;
}

function stableId(prefix: string, ...parts: string[]): string {
  return [prefix, ...parts.map((value) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, "_"))].join(":");
}

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function readJson<T>(path: string, label: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    fail(`${label} is missing or invalid JSON`);
  }
}

function defaultPath(local: string, example: string): string {
  try {
    readFileSync(resolve(root, local));
    return local;
  } catch {
    return example;
  }
}

function argValue(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function boundedError(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, 500) || "unknown error";
}

function fail(message: string): never {
  console.error(`fail: ${message}`);
  process.exit(1);
}
