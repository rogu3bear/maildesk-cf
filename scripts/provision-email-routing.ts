// scripts/provision-email-routing.ts — governed inbound Email Routing provisioning.
//
// A state RECONCILER over cfctl's governed lane, not an imperative script:
//   read observed state -> compute desired -> diff -> preflight -> apply delta
//   (draft -> approve -> run) -> verify -> report residual.
// Idempotent and resumable. Every Cloudflare mutation flows through cfctl
// (repo doctrine: "Do not mutate Cloudflare outside cfctl").
//
// Inbound aliases route to the Rust `mail_router` Worker (action type `worker`),
// which needs no verified destination address — matching the architecture where
// the Rust router owns policy. See docs/architecture/email-routing-provisioning.md.
//
// Usage:
//   bun run scripts/provision-email-routing.ts [--plan|--apply] \
//     [--desired-state <path>] [--domain <name>] [--lane <cf-token-lane>] \
//     [--cfctl <bin>] [--json]
//
// --plan (default) reads + diffs + preflights, drafts NOTHING. --apply drafts,
// approves (--yes), and runs each delta. The provisioning token/lane must hold
// `Email Routing Rules Write` + `Zone Settings Write` (see AGENTS.md / cfctl
// `keys mint --zone`).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

type InboundMxProvider = "cloudflare_email_routing" | "google_workspace" | "external";

interface DesiredDomain {
  name: string;
  inbound_mx_provider: InboundMxProvider;
  role_aliases: string[];
  personal_aliases: string[];
  zone_id?: string; // optional pin; otherwise resolved by name (edge case 4)
}

interface DesiredState {
  domains: DesiredDomain[];
  workers: { mail_router: { script_name: string } };
}

// The Email Routing MX hostnames Cloudflare publishes for inbound routing.
const CF_EMAIL_ROUTING_MX = ["mx.cloudflare.net", "route1.mx.cloudflare.net", "route2.mx.cloudflare.net", "route3.mx.cloudflare.net"];

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const apply = args.includes("--apply"); // default is --plan (dry, no mutation)
const lane = argValue("--lane") ?? process.env.CF_TOKEN_LANE;
const cfctlBin = argValue("--cfctl") ?? process.env.CFCTL_BIN ?? "cfctl";
const domainFilter = argValue("--domain");
const desiredStatePath = resolve(root, argValue("--desired-state") ?? defaultDesiredStatePath());

const state = readDesiredState(desiredStatePath);
const workerScript = state.workers?.mail_router?.script_name;

// Edge case 5 (non-CF domains) + --domain filter: only cloudflare_email_routing
// domains get Email Routing mutations; google_workspace/external are skipped so
// we never hijack a domain routed elsewhere.
const targets = state.domains.filter(
  (d) => d.inbound_mx_provider === "cloudflare_email_routing" && (!domainFilter || d.name === domainFilter),
);
const skippedNonCf = state.domains
  .filter((d) => d.inbound_mx_provider !== "cloudflare_email_routing")
  .map((d) => ({ domain: d.name, provider: d.inbound_mx_provider }));

const domainResults = targets.map(reconcileDomain);

const summary = {
  mode: apply ? "apply" : "plan",
  desired_state: relativePath(desiredStatePath),
  lane: lane ?? null,
  worker_script: workerScript ?? null,
  requested_domain: domainFilter ?? null,
  skipped_non_cloudflare: skippedNonCf,
  domains: domainResults,
  failed_count: domainResults.reduce((n, d) => n + d.failed.length + (d.zone_error ? 1 : 0), 0),
  pending_count: domainResults.reduce((n, d) => n + d.pending.length, 0),
};

if (jsonOutput) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  for (const d of domainResults) {
    if (d.zone_error) {
      console.log(`fail ${d.domain}: ${d.zone_error}`);
      continue;
    }
    console.log(
      `${d.domain} [${d.zone}] enabled=${d.routing_enabled} mx_converged=${d.mx_converged} ` +
        `applied=${d.applied.length} already=${d.already.length} pending=${d.pending.length} failed=${d.failed.length}`,
    );
    for (const w of d.warnings) console.log(`  warn: ${w}`);
    for (const f of d.failed) console.log(`  fail: ${f.item} — ${f.reason}`);
  }
  console.log(`mode ${summary.mode}  failed ${summary.failed_count}  pending ${summary.pending_count}`);
}

// Fail closed if anything failed or a zone could not be resolved.
process.exit(summary.failed_count > 0 ? 1 : 0);

// --------------------------------------------------------------------------

function reconcileDomain(domain: DesiredDomain) {
  const warnings: string[] = [];
  const applied: Array<{ item: string; operation_id: string }> = [];
  const already: string[] = [];
  const pending: Array<{ item: string; reason: string }> = [];
  const failed: Array<{ item: string; reason: string }> = [];

  // Edge case 4: resolve domain -> exactly one active zone (or an explicit pin).
  const zone = resolveZone(domain);
  if (!zone.zone_id) {
    return {
      domain: domain.name,
      zone: null,
      zone_error: zone.error,
      routing_enabled: null,
      mx_converged: null,
      applied,
      already,
      pending,
      failed,
      warnings,
    };
  }
  const zoneId = zone.zone_id;

  // Edge case 3: the mail_router Worker must exist before a worker-action rule.
  if (!workerScript) {
    failed.push({ item: "preflight:worker", reason: "desired-state has no workers.mail_router.script_name" });
  }

  // Observe current state (edge cases 1, 2, 8 hinge on this).
  const settings = cfctlRead("email-routing-settings-get-email-routing-settings", { zone_id: zoneId });
  const observedEnabled = settings.ok ? Boolean(settings.result?.enabled) : null;
  const rulesRead = cfctlRead("email-routing-routing-rules-list-routing-rules", { zone_id: zoneId });
  const observedRules: EmailRule[] = rulesRead.ok && Array.isArray(rulesRead.result) ? rulesRead.result : [];
  if (!rulesRead.ok) warnings.push("could not list existing routing rules; treating as empty (re-run to reconcile)");

  // Edge case 10: enabled(setting) != mx_converged(delivery). Read both.
  const mx = readMx(zoneId);
  const mxConverged = mx.records.length > 0 && mx.records.every((r) => CF_EMAIL_ROUTING_MX.includes(r.toLowerCase()));
  if (mx.records.length > 0 && !mxConverged) {
    warnings.push(
      `zone MX points elsewhere (${mx.records.join(", ")}); Email Routing will not deliver until MX targets Cloudflare. ` +
        "This tool never overwrites MX — repoint it deliberately.",
    );
  }

  // ---- Diff ----
  const deltas: Delta[] = [];

  // Edge case 1: draft enable only when observed enabled === false.
  if (observedEnabled === false) {
    deltas.push({ item: "enable-routing", capability: "email-routing-settings-enable-email-routing", body: undefined });
  } else if (observedEnabled === null) {
    warnings.push("could not read Email Routing settings; skipping enable (re-run to reconcile)");
  } else {
    already.push("enable-routing");
  }

  // Edge case 2: dedupe aliases, key desired rules by matcher identity, create
  // only the missing ones. Edge case 5: worker action -> no destination address.
  const aliases = [...new Set([...(domain.role_aliases ?? []), ...(domain.personal_aliases ?? [])])];
  for (const alias of aliases) {
    const address = `${alias}@${domain.name}`;
    const desired = desiredRule(address, workerScript ?? "", domain.name);
    const existing = observedRules.find((r) => literalMatcherValue(r) === address.toLowerCase());
    if (!existing) {
      deltas.push({ item: `rule:${address}`, capability: "email-routing-routing-rules-create-routing-rule", body: desired });
    } else if (!ruleMatchesDesired(existing, workerScript ?? "")) {
      // Matcher exists but action drifted (e.g. points at a different worker).
      warnings.push(`rule for ${address} exists but does not route to ${workerScript}; leaving it (manual review)`);
      already.push(`rule:${address} (drift)`);
    } else {
      already.push(`rule:${address}`);
    }
  }

  if (deltas.length === 0) {
    // Nothing to do — fully converged (or blocked by an unreadable observation).
  } else if (!apply) {
    for (const d of deltas) pending.push({ item: d.item, reason: "plan-only (run with --apply to mutate)" });
  } else {
    // ---- Apply (edge cases 6, 7, 8) ----
    for (const delta of deltas) {
      const outcome = applyGoverned(zoneId, delta, workerScript);
      if (outcome.status === "applied") applied.push({ item: delta.item, operation_id: outcome.operation_id });
      else if (outcome.status === "pending") pending.push({ item: delta.item, reason: outcome.reason });
      else failed.push({ item: delta.item, reason: outcome.reason }); // continue, do not abort the batch
    }
  }

  // ---- Verify (re-read; report setting vs delivery honestly) ----
  const post = apply ? cfctlRead("email-routing-settings-get-email-routing-settings", { zone_id: zoneId }) : settings;
  const routingEnabled = post.ok ? Boolean(post.result?.enabled) : observedEnabled;

  return {
    domain: domain.name,
    zone: zoneId,
    zone_error: null,
    routing_enabled: routingEnabled,
    mx_converged: mxConverged,
    applied,
    already,
    pending,
    failed,
    warnings,
  };
}

// Edge case 4: exactly-one-active-zone, or an explicit per-domain pin.
function resolveZone(domain: DesiredDomain): { zone_id?: string; error?: string } {
  if (domain.zone_id) return { zone_id: domain.zone_id };
  const res = cfctlRead("zones-get", {}, { name: domain.name });
  if (!res.ok) return { error: `zone lookup failed for ${domain.name}: ${res.error ?? "cfctl error"}` };
  const zones = (Array.isArray(res.result) ? res.result : []).filter(
    (z: { name?: string; status?: string }) => z.name === domain.name && z.status === "active",
  );
  if (zones.length === 0) return { error: `no active zone named ${domain.name} in the account (is it added to Cloudflare?)` };
  if (zones.length > 1) return { error: `ambiguous: ${zones.length} active zones named ${domain.name}; pin zone_id in desired-state` };
  return { zone_id: (zones[0] as { id: string }).id };
}

// Governed apply of one delta: draft -> approve -> run, with a single drift
// retry (edge case 7) and per-item failure isolation (edge case 8).
function applyGoverned(zoneId: string, delta: Delta, worker: string | undefined, retry = true): ApplyOutcome {
  const draft = cfctlCall(["call", delta.capability, "--selector", `zone_id=${zoneId}`, ...bodyArgs(delta.body)]);
  if (!draft.ok || !draft.envelope.operation_id) {
    return { status: "failed", reason: `draft failed: ${draft.error ?? errText(draft.envelope)}` };
  }
  const op = draft.envelope.operation_id;
  const approve = cfctlCall(["plans", "approve", op, "--yes"]);
  if (!approve.ok) return { status: "failed", reason: `approve failed: ${approve.error ?? errText(approve.envelope)}` };
  const run = cfctlCall(["plans", "run", op]);
  if (run.ok && run.envelope.performed) return { status: "applied", operation_id: op };

  const msg = (run.error ?? errText(run.envelope) ?? "").toString();
  // Edge case 7: drift between draft and run -> re-diff/re-draft once.
  if (retry && /drift|Base branch was modified|precondition/i.test(msg)) {
    return applyGoverned(zoneId, delta, worker, false);
  }
  // Edge case 3/9: worker-missing or auth are actionable, not silent.
  if (/worker|script/i.test(msg) && delta.capability.includes("rules")) {
    return { status: "failed", reason: `rule rejected — is the Worker "${worker}" deployed? (${msg})` };
  }
  if (/401|403|permission|token/i.test(msg)) {
    return { status: "failed", reason: `authorization — lane needs Email Routing Rules Write + Zone Settings Write (${msg})` };
  }
  return { status: "failed", reason: `run failed: ${msg}` };
}

// A per-alias literal rule routing to the mail_router Worker (edge case 5).
function desiredRule(address: string, worker: string, domainName: string): unknown {
  return {
    name: `maildesk:${address}`, // stable identity for reconciliation
    enabled: true,
    matchers: [{ type: "literal", field: "to", value: address }],
    actions: [{ type: "worker", value: [worker] }],
    priority: 0,
  };
}

function literalMatcherValue(rule: EmailRule): string | null {
  const m = (rule.matchers ?? []).find((x) => x.type === "literal" && x.field === "to");
  return m?.value ? m.value.toLowerCase() : null;
}

function ruleMatchesDesired(rule: EmailRule, worker: string): boolean {
  const a = (rule.actions ?? []).find((x) => x.type === "worker");
  return Boolean(a && Array.isArray(a.value) && a.value.includes(worker));
}

// Edge case 10: read the zone's MX so we can report delivery convergence and
// warn on third-party MX — without ever mutating DNS.
function readMx(zoneId: string): { records: string[] } {
  const res = cfctlRead("dns-records-for-a-zone-list-dns-records", { zone_id: zoneId }, { type: "MX" });
  if (!res.ok || !Array.isArray(res.result)) return { records: [] };
  return { records: res.result.map((r: { content?: string }) => (r.content ?? "").trim()).filter(Boolean) };
}

// --------------------------------------------------------------------------
// cfctl invocation helpers

function cfctlRead(capability: string, selectors: Record<string, string>, query?: Record<string, string>): CfctlResult {
  const sel = Object.entries(selectors).flatMap(([k, v]) => ["--selector", `${k}=${v}`]);
  const q = Object.entries(query ?? {}).flatMap(([k, v]) => ["--query", `${k}=${v}`]);
  const r = cfctlCall(["call", capability, ...sel, ...q]);
  return { ok: r.ok && r.envelope.ok !== false, result: r.envelope.result, error: r.error };
}

function cfctlCall(subArgs: string[]): { ok: boolean; envelope: CfctlEnvelope; error?: string } {
  const result = spawnSync(cfctlBin, [...subArgs, "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...(lane ? { CF_TOKEN_LANE: lane } : {}) },
  });
  if (result.error) return { ok: false, envelope: {}, error: String(result.error) };
  let envelope: CfctlEnvelope = {};
  try {
    envelope = JSON.parse(result.stdout || "{}") as CfctlEnvelope;
  } catch {
    return { ok: false, envelope: {}, error: `non-JSON cfctl output: ${(result.stdout || result.stderr || "").slice(0, 200)}` };
  }
  return { ok: result.status === 0 && envelope.ok !== false, envelope };
}

function bodyArgs(body: unknown): string[] {
  return body === undefined ? [] : ["--body-json", JSON.stringify(body)];
}

function errText(env: CfctlEnvelope | undefined): string | undefined {
  if (!env) return undefined;
  const e = env.error as { message?: string } | undefined;
  const cf = Array.isArray(env.result?.errors) ? (env.result?.errors as Array<{ message?: string }>) : [];
  return e?.message ?? (cf.map((x) => x.message).filter(Boolean).join("; ") || undefined);
}

// --------------------------------------------------------------------------

function readDesiredState(path: string): DesiredState {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DesiredState;
  } catch (error) {
    console.error(`invalid desired-state at ${relativePath(path)}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function defaultDesiredStatePath(): string {
  return existsSync(resolve(root, "config/desired-state.local.json"))
    ? "config/desired-state.local.json"
    : "config/desired-state.example.json";
}

function argValue(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function relativePath(path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

// --------------------------------------------------------------------------
// types

interface EmailRule {
  id?: string;
  name?: string;
  enabled?: boolean;
  matchers?: Array<{ type?: string; field?: string; value?: string }>;
  actions?: Array<{ type?: string; value?: string[] }>;
}

interface Delta {
  item: string;
  capability: string;
  body: unknown;
}

interface CfctlEnvelope {
  ok?: boolean;
  performed?: boolean;
  operation_id?: string;
  result?: { enabled?: boolean; errors?: unknown } & Record<string, unknown> & unknown[];
  error?: unknown;
}

interface CfctlResult {
  ok: boolean;
  result?: any;
  error?: string;
}

type ApplyOutcome =
  | { status: "applied"; operation_id: string }
  | { status: "pending"; reason: string }
  | { status: "failed"; reason: string };
