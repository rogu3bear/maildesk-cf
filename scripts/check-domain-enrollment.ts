import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type EnrollmentDecision =
  | "enrolled"
  | "scheduled_for_migration"
  | "intentionally_excluded"
  | "pending_owner_decision";
type RegistrarCustody = "cloudflare" | "external" | "unknown";

interface EnrollmentEntry {
  name: string;
  decision: EnrollmentDecision;
  registrar_custody: RegistrarCustody;
  blocker_code?: string;
  reason_code?: string;
  decision_owner_ref?: string;
}

interface EnrollmentLedger {
  schema_version: 1;
  inventory_complete: boolean;
  inventory_blocker_code?: string;
  domains: EnrollmentEntry[];
}

interface DesiredDomain {
  name: string;
  inbound_mx_provider: string;
}

export interface DomainEnrollmentReport {
  schema_version: 1;
  kind: "maildesk_domain_enrollment_report";
  performed: false;
  body_free: true;
  enrollment_sha256: string;
  status: {
    ledger_valid: true;
    associated_domain_inventory_complete: boolean;
    all_active_domains_classified: true;
    full_routing_coverage_claim_allowed: false;
    inventory_blocker_code: string | null;
  };
  counts: {
    total_known_domains: number;
    enrolled_domains: number;
    scheduled_domains: number;
    excluded_domains: number;
    pending_domains: number;
    active_policy_domains: number;
    desired_state_domains: number;
  };
  domains: Array<{
    domain_sha256: string;
    decision: EnrollmentDecision;
    registrar_custody: RegistrarCustody;
    desired_inbound_provider: string | null;
    active_policy: boolean;
    configured: boolean;
    reason_code: string | null;
    blocker_code: string | null;
    decision_owner_ref_sha256: string | null;
    first_blocker: { plane: "enrollment"; code: string } | null;
  }>;
}

const DECISIONS: EnrollmentDecision[] = [
  "enrolled",
  "scheduled_for_migration",
  "intentionally_excluded",
  "pending_owner_decision",
];
const REGISTRAR_CUSTODY: RegistrarCustody[] = ["cloudflare", "external", "unknown"];
const CODE = /^[a-z][a-z0-9_]{0,127}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function compileDomainEnrollment(
  ledgerValue: unknown,
  desiredStateValue: unknown,
  policyValue: unknown,
): DomainEnrollmentReport {
  const ledger = validateLedger(ledgerValue);
  const desiredDomains = validateDesiredState(desiredStateValue);
  const policyDomains = validatePolicy(policyValue);
  const activeDomains = new Set([...desiredDomains.keys(), ...policyDomains]);
  const ledgerByDomain = new Map(ledger.domains.map((entry) => [entry.name, entry]));

  for (const domain of activeDomains) {
    const entry = ledgerByDomain.get(domain);
    if (!entry) throw new Error(`active domain missing from enrollment ledger: ${domainDigest(domain)}`);
    if (!isActiveDecision(entry.decision)) {
      throw new Error(`active domain has a non-active decision: ${domainDigest(domain)}`);
    }
  }
  for (const entry of ledger.domains) {
    const inDesiredState = desiredDomains.has(entry.name);
    const inPolicy = policyDomains.has(entry.name);
    if (entry.decision === "enrolled") {
      if (!inDesiredState || !inPolicy) {
        throw new Error(`enrolled domain must exist in desired state and active policy: ${domainDigest(entry.name)}`);
      }
      if (desiredDomains.get(entry.name) !== "cloudflare_email_routing") {
        throw new Error(`enrolled domain must select cloudflare_email_routing: ${domainDigest(entry.name)}`);
      }
    }
    if (!isActiveDecision(entry.decision) && (inDesiredState || inPolicy)) {
      throw new Error(`non-active decision cannot appear in desired state or active policy: ${domainDigest(entry.name)}`);
    }
  }

  const counts = (decision: EnrollmentDecision) =>
    ledger.domains.filter((entry) => entry.decision === decision).length;
  return {
    schema_version: 1,
    kind: "maildesk_domain_enrollment_report",
    performed: false,
    body_free: true,
    enrollment_sha256: digest(JSON.stringify(ledger)),
    status: {
      ledger_valid: true,
      associated_domain_inventory_complete: ledger.inventory_complete,
      all_active_domains_classified: true,
      full_routing_coverage_claim_allowed: false,
      inventory_blocker_code: ledger.inventory_blocker_code ?? null,
    },
    counts: {
      total_known_domains: ledger.domains.length,
      enrolled_domains: counts("enrolled"),
      scheduled_domains: counts("scheduled_for_migration"),
      excluded_domains: counts("intentionally_excluded"),
      pending_domains: counts("pending_owner_decision"),
      active_policy_domains: policyDomains.size,
      desired_state_domains: desiredDomains.size,
    },
    domains: ledger.domains
      .map((entry) => {
        const desiredProvider = desiredDomains.get(entry.name) ?? null;
        return {
          domain_sha256: domainDigest(entry.name),
          decision: entry.decision,
          registrar_custody: entry.registrar_custody,
          desired_inbound_provider: desiredProvider,
          active_policy: policyDomains.has(entry.name),
          configured: policyDomains.has(entry.name) && desiredProvider !== null,
          reason_code: entry.reason_code ?? null,
          blocker_code: entry.blocker_code ?? null,
          decision_owner_ref_sha256: entry.decision_owner_ref
            ? digest(entry.decision_owner_ref)
            : null,
          first_blocker: firstBlocker(entry),
        };
      })
      .sort((left, right) => left.domain_sha256.localeCompare(right.domain_sha256)),
  };
}

function validateLedger(value: unknown): EnrollmentLedger {
  const ledger = requireRecord(value, "enrollment ledger");
  exactKeys(ledger, ["schema_version", "inventory_complete", "inventory_blocker_code", "domains"], "enrollment ledger");
  if (ledger.schema_version !== 1) throw new Error("enrollment ledger schema_version must be 1");
  if (typeof ledger.inventory_complete !== "boolean") {
    throw new Error("enrollment ledger inventory_complete must be boolean");
  }
  if (!Array.isArray(ledger.domains) || ledger.domains.length === 0 || ledger.domains.length > 500) {
    throw new Error("enrollment ledger domains must contain 1..500 entries");
  }
  if (ledger.inventory_complete === false) {
    requireCode(ledger.inventory_blocker_code, "inventory_blocker_code");
  } else if (ledger.inventory_blocker_code !== undefined) {
    throw new Error("inventory_blocker_code must be absent when inventory_complete is true");
  }

  const domains = ledger.domains.map((entry, index) => validateEntry(entry, index));
  const uniqueDomains = new Set(domains.map((entry) => entry.name));
  if (uniqueDomains.size !== domains.length) throw new Error("enrollment ledger contains a duplicate domain");
  if (ledger.inventory_complete && domains.some((entry) => entry.decision === "pending_owner_decision")) {
    throw new Error("complete enrollment inventory cannot contain a pending owner decision");
  }
  return {
    schema_version: 1,
    inventory_complete: ledger.inventory_complete,
    ...(typeof ledger.inventory_blocker_code === "string"
      ? { inventory_blocker_code: ledger.inventory_blocker_code }
      : {}),
    domains,
  };
}

function validateEntry(value: unknown, index: number): EnrollmentEntry {
  const entry = requireRecord(value, `domains[${index}]`);
  const decision = entry.decision;
  if (typeof decision !== "string" || !DECISIONS.includes(decision as EnrollmentDecision)) {
    throw new Error(`domains[${index}].decision is invalid`);
  }
  const allowedFields = ["name", "decision", "registrar_custody"];
  if (decision === "scheduled_for_migration") allowedFields.push("blocker_code");
  if (decision === "intentionally_excluded") allowedFields.push("reason_code");
  if (decision === "pending_owner_decision") allowedFields.push("decision_owner_ref");
  exactKeys(entry, allowedFields, `domains[${index}]`);

  if (typeof entry.name !== "string" || entry.name !== entry.name.toLowerCase() || !DOMAIN.test(entry.name)) {
    throw new Error(`domains[${index}].name must be one normalized domain`);
  }
  if (
    typeof entry.registrar_custody !== "string" ||
    !REGISTRAR_CUSTODY.includes(entry.registrar_custody as RegistrarCustody)
  ) throw new Error(`domains[${index}].registrar_custody is invalid`);
  if (decision === "scheduled_for_migration") requireCode(entry.blocker_code, "blocker_code");
  if (decision === "intentionally_excluded") requireCode(entry.reason_code, "reason_code");
  if (decision === "pending_owner_decision") requireCode(entry.decision_owner_ref, "decision_owner_ref");
  return entry as unknown as EnrollmentEntry;
}

function validateDesiredState(value: unknown): Map<string, string> {
  const root = requireRecord(value, "desired state");
  if (!Array.isArray(root.domains)) throw new Error("desired state domains must be an array");
  const result = new Map<string, string>();
  for (const [index, value] of root.domains.entries()) {
    const entry = requireRecord(value, `desired state domains[${index}]`);
    if (typeof entry.name !== "string" || !DOMAIN.test(entry.name)) {
      throw new Error(`desired state domains[${index}].name is invalid`);
    }
    if (typeof entry.inbound_mx_provider !== "string") {
      throw new Error(`desired state domains[${index}].inbound_mx_provider is invalid`);
    }
    if (result.has(entry.name)) throw new Error("desired state contains a duplicate domain");
    result.set(entry.name, entry.inbound_mx_provider);
  }
  return result;
}

function validatePolicy(value: unknown): Set<string> {
  const root = requireRecord(value, "policy");
  const domains = requireRecord(root.domains, "policy domains");
  const result = new Set<string>();
  for (const domain of Object.keys(domains)) {
    if (domain !== domain.toLowerCase() || !DOMAIN.test(domain)) throw new Error("policy contains an invalid domain");
    result.add(domain);
  }
  return result;
}

function firstBlocker(entry: EnrollmentEntry): { plane: "enrollment"; code: string } | null {
  if (entry.decision === "scheduled_for_migration") {
    return { plane: "enrollment", code: entry.blocker_code! };
  }
  if (entry.decision === "pending_owner_decision") {
    return { plane: "enrollment", code: "owner_decision_pending" };
  }
  return null;
}

function isActiveDecision(value: EnrollmentDecision): boolean {
  return value === "enrolled" || value === "scheduled_for_migration";
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${label} contains an unexpected field`);
}

function requireCode(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !CODE.test(value)) throw new Error(`${label} must be a bounded code`);
}

function domainDigest(domain: string): string {
  return digest(domain);
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const enrollmentPath = resolve(root, argValue(args, "--enrollment") ?? defaultPath(root, "domain-enrollment"));
  const desiredStatePath = resolve(root, argValue(args, "--desired-state") ?? defaultPath(root, "desired-state"));
  const policyPath = resolve(root, argValue(args, "--policy") ?? defaultPath(root, "policy"));
  try {
    const report = compileDomainEnrollment(
      JSON.parse(readFileSync(enrollmentPath, "utf8")),
      JSON.parse(readFileSync(desiredStatePath, "utf8")),
      JSON.parse(readFileSync(policyPath, "utf8")),
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`domain enrollment check failed: ${message}\n`);
    process.exit(1);
  }
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function defaultPath(root: string, basename: string): string {
  const local = resolve(root, `config/${basename}.local.json`);
  return existsSync(local) ? local : resolve(root, `config/${basename}.example.json`);
}
