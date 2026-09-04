import { spawnSync } from "node:child_process";

export const CFCTL_COMMAND_CONTRACT_VERSION = 2 as const;
export const SENDER_DOMAIN_CREATE_CAPABILITY =
  "email-sending-subdomains-create-sending-subdomain" as const;
export const SENDER_DOMAIN_VERIFY_CAPABILITY =
  "email-sending-subdomains-list-sending-subdomains" as const;
export const ZONE_LOOKUP_CAPABILITY = "zones-get" as const;

export interface NonPerformingCommand {
  purpose: string;
  performed: false;
  argv: string[];
}

export interface SenderDomainPlanRequest {
  schema_version: 2;
  capability_id: typeof SENDER_DOMAIN_CREATE_CAPABILITY;
  target: {
    zone_name: string;
    sending_subdomain_name: string;
  };
  profile_binding: "explicit";
  account_binding: "profile_account";
  zone_binding: {
    capability_id: typeof ZONE_LOOKUP_CAPABILITY;
    exact_name: string;
  };
  body: {
    name: string;
  };
}

export interface SenderDomainVerifyRequest {
  schema_version: 2;
  capability_id: typeof SENDER_DOMAIN_VERIFY_CAPABILITY;
  target: {
    zone_name: string;
    sending_subdomain_name: string;
  };
  profile_binding: "explicit";
  account_binding: "profile_account";
}

export interface PlanLifecycle {
  show: string[];
  approve: string[];
  run: string[];
  status: string[];
}

export interface SenderDomainPlanBinding {
  operation_id: string;
  profile_id: string;
  account_id: string;
  zone_id: string;
  target: string;
  plan_content_hash?: string;
}

export interface SenderDomainPlanManifestItem {
  schema_version: 2;
  ok: true;
  performed: false;
  capability_id: typeof SENDER_DOMAIN_CREATE_CAPABILITY;
  profile_id: string;
  account_id: string;
  zone_id: string;
  target: string;
  operation_id: string;
  plan_content_hash: string;
  evidence_hashes: string[];
  plan_expires_at?: string;
}

export function provisioningDiscoveryCommands(desiredStatePath: string): NonPerformingCommand[] {
  return [
    { purpose: "version", performed: false, argv: ["cfctl", "version", "--json"] },
    { purpose: "doctor", performed: false, argv: ["cfctl", "doctor", "--json"] },
    {
      purpose: "agents_doctor",
      performed: false,
      argv: ["cfctl", "agents", "doctor", "--json"],
    },
    {
      purpose: "resolve_readback",
      performed: false,
      argv: [
        "cfctl",
        "resolve",
        `read Maildesk current state for ${desiredStatePath} without mutation`,
        "--json",
      ],
    },
    {
      purpose: "resolve_plan",
      performed: false,
      argv: [
        "cfctl",
        "resolve",
        `plan one Maildesk desired-state delta for ${desiredStatePath} without applying it`,
        "--json",
      ],
    },
  ];
}

export function senderDomainPlanRequest(domain: string): SenderDomainPlanRequest {
  return {
    schema_version: CFCTL_COMMAND_CONTRACT_VERSION,
    capability_id: SENDER_DOMAIN_CREATE_CAPABILITY,
    target: {
      zone_name: domain,
      sending_subdomain_name: domain,
    },
    profile_binding: "explicit",
    account_binding: "profile_account",
    zone_binding: {
      capability_id: ZONE_LOOKUP_CAPABILITY,
      exact_name: domain,
    },
    body: { name: domain },
  };
}

export function senderDomainVerifyRequest(domain: string): SenderDomainVerifyRequest {
  return {
    schema_version: CFCTL_COMMAND_CONTRACT_VERSION,
    capability_id: SENDER_DOMAIN_VERIFY_CAPABILITY,
    target: {
      zone_name: domain,
      sending_subdomain_name: domain,
    },
    profile_binding: "explicit",
    account_binding: "profile_account",
  };
}

export function planLifecycle(operationId: string): PlanLifecycle {
  return {
    show: ["cfctl", "plans", "show", operationId, "--json"],
    approve: ["cfctl", "plans", "approve", operationId, "--yes", "--json"],
    run: ["cfctl", "plans", "run", operationId, "--json"],
    status: ["cfctl", "plans", "status", operationId, "--json"],
  };
}

export function senderDomainPlanV2Failure(
  value: unknown,
  expected: SenderDomainPlanBinding,
): string | null {
  if (!isRecord(value) || value.schema_version !== 2) return "PlanV2 schema mismatch";
  if (typeof value.content_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.content_hash)) {
    return "PlanV2 content hash is missing or malformed";
  }
  if (expected.plan_content_hash && value.content_hash !== expected.plan_content_hash) {
    return "PlanV2 content hash drifted";
  }
  if (!isRecord(value.plan)) return "PlanV2 plan is missing";
  const plan = value.plan;
  if (plan.schema_version !== 1 || plan.operation_id !== expected.operation_id) {
    return "PlanV2 operation identity drifted";
  }
  if (plan.profile_id !== expected.profile_id || plan.account_id !== expected.account_id) {
    return "PlanV2 profile or account drifted";
  }
  if (!isRecord(plan.capability) || plan.capability.id !== SENDER_DOMAIN_CREATE_CAPABILITY) {
    return "PlanV2 capability drifted";
  }
  if (!isRecord(plan.input) || !isRecord(plan.input.selectors) || !isRecord(plan.input.body)) {
    return "PlanV2 input is missing";
  }
  if (plan.input.selectors.zone_id !== expected.zone_id || plan.input.body.name !== expected.target) {
    return "PlanV2 selector or request body drifted";
  }
  if (!isRecord(plan.targets) || !isRecord(plan.targets.selectors) ||
    plan.targets.selectors.zone_id !== expected.zone_id ||
    plan.targets.account_id !== expected.account_id) {
    return "PlanV2 target pins drifted";
  }
  return null;
}

export function planV2ContentHash(value: unknown): string | null {
  return isRecord(value) && typeof value.content_hash === "string" &&
      /^sha256:[a-f0-9]{64}$/.test(value.content_hash)
    ? value.content_hash
    : null;
}

export function senderDomainPlanManifestItem(
  value: unknown,
  now = Date.now(),
): SenderDomainPlanManifestItem | null {
  if (!isRecord(value) || value.schema_version !== CFCTL_COMMAND_CONTRACT_VERSION) return null;
  if (value.ok !== true || value.performed !== false) return null;
  if (value.capability_id !== SENDER_DOMAIN_CREATE_CAPABILITY) return null;
  for (const field of ["profile_id", "account_id", "zone_id", "target", "operation_id"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) return null;
  }
  if (typeof value.plan_content_hash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.plan_content_hash)) return null;
  if (!Array.isArray(value.evidence_hashes) || value.evidence_hashes.length === 0 ||
    value.evidence_hashes.some((entry) =>
      typeof entry !== "string" || !/^sha256:[a-f0-9]{64}$/.test(entry)
    )) return null;
  if (value.plan_expires_at !== undefined) {
    if (typeof value.plan_expires_at !== "string") return null;
    const expiration = Date.parse(value.plan_expires_at);
    if (!Number.isFinite(expiration) || expiration <= now) return null;
  }
  return {
    schema_version: CFCTL_COMMAND_CONTRACT_VERSION,
    ok: true,
    performed: false,
    capability_id: SENDER_DOMAIN_CREATE_CAPABILITY,
    profile_id: value.profile_id,
    account_id: value.account_id,
    zone_id: value.zone_id,
    target: value.target,
    operation_id: value.operation_id,
    plan_content_hash: value.plan_content_hash,
    evidence_hashes: [...value.evidence_hashes],
    ...(value.plan_expires_at ? { plan_expires_at: value.plan_expires_at } : {}),
  };
}

export function isSenderDomainPlanRequest(value: unknown): value is SenderDomainPlanRequest {
  if (!isRecord(value) || value.schema_version !== CFCTL_COMMAND_CONTRACT_VERSION) return false;
  if (value.capability_id !== SENDER_DOMAIN_CREATE_CAPABILITY) return false;
  if (value.profile_binding !== "explicit" || value.account_binding !== "profile_account") return false;
  if (!isRecord(value.target) || !isRecord(value.zone_binding) || !isRecord(value.body)) return false;
  const zoneName = value.target.zone_name;
  const sendingName = value.target.sending_subdomain_name;
  return typeof zoneName === "string" && zoneName.length > 0 &&
    sendingName === zoneName &&
    value.zone_binding.capability_id === ZONE_LOOKUP_CAPABILITY &&
    value.zone_binding.exact_name === zoneName &&
    value.body.name === sendingName;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Read contracts consumed by collect-live-evidence, checked before production
// admission. This proves catalog compatibility only, never account readiness.
export interface MaildeskReadContract {
  id: string;
  selectors: string[];
}

export function maildeskReadContracts(options: {
  emailRouting: boolean;
  senderDomains: boolean;
  darkAcceptance: boolean;
}): MaildeskReadContract[] {
  const account = ["account_id"];
  const zone = ["zone_id"];
  const script = ["account_id", "script_name"];
  const contracts: MaildeskReadContract[] = [
    { id: "zones-get", selectors: ["name"] },
    { id: "dns-records-for-a-zone-list-dns-records", selectors: zone },
    { id: "listWorkers", selectors: account },
    { id: "worker-script-get-settings", selectors: script },
    { id: "worker-deployments-list-deployments", selectors: script },
    { id: "worker-versions-get-version-detail", selectors: [...script, "version_id"] },
    { id: "d1-list-databases", selectors: account },
    { id: "r2-list-buckets", selectors: account },
    { id: "queues-list", selectors: account },
    { id: "queues-list-consumers", selectors: [...account, "queue_id"] },
  ];
  if (options.emailRouting) contracts.push(
    { id: "email-routing-routing-rules-list-routing-rules", selectors: zone },
    { id: "email-routing-settings-get-email-routing-settings", selectors: zone },
    { id: "email-routing-routing-rules-get-catch-all-rule", selectors: zone },
  );
  if (options.senderDomains) contracts.push({ id: SENDER_DOMAIN_VERIFY_CAPABILITY, selectors: zone });
  if (options.darkAcceptance) contracts.push(
    { id: "access-applications-get-an-access-application", selectors: [...account, "app_id"] },
    { id: "access-policies-list-access-app-policies", selectors: [...account, "app_id"] },
    { id: "access-policies-get-an-access-policy", selectors: [...account, "app_id", "policy_id"] },
    { id: "r2-get-bucket-lifecycle-configuration", selectors: [...account, "bucket_name"] },
  );
  return contracts.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function incompatibleMaildeskRead(contract: MaildeskReadContract, envelope: unknown): string | null {
  const value = envelope as {
    schema_version?: unknown; command?: unknown; ok?: unknown; performed?: unknown;
    result?: {
      id?: unknown; adapter_status?: unknown; blocked_reason?: unknown;
      method?: unknown; effect?: unknown; mutating?: unknown;
      response_contract?: { body_mode?: unknown };
      selectors?: Array<{ name?: unknown; value_type?: unknown; required?: unknown }>;
    };
  } | null;
  if (!value || value.schema_version !== 2 || value.command !== "catalog show" || value.ok !== true || value.performed !== false) {
    return `${contract.id}: catalog must return a successful non-performing ResultEnvelopeV2`;
  }
  const capability = value.result;
  if (!capability || capability.id !== contract.id ||
      !["native", "dynamic_api"].includes(String(capability.adapter_status)) ||
      capability.blocked_reason != null || capability.method !== "GET" ||
      capability.effect !== "read_only" || capability.mutating !== false ||
      capability.response_contract?.body_mode !== "cloudflare_json_envelope") {
    return `${contract.id}: required non-mutating API read is unavailable or incompatible`;
  }
  if (!Array.isArray(capability.selectors) || contract.selectors.some((name) =>
    !capability.selectors!.some((selector) => selector?.name === name && selector.value_type === "string")
  )) return `${contract.id}: required string selectors are missing or incompatible`;
  if (capability.selectors.some((selector) => selector?.required === true &&
    !contract.selectors.includes(String(selector.name))
  )) return `${contract.id}: catalog requires a selector not supplied by Maildesk`;
  return null;
}

const accessAppFields = ["allowed_idps", "app_launcher_visible", "auto_redirect_to_identity", "destinations", "domain", "enable_binding_cookie", "http_only_cookie_attribute", "name", "options_preflight_bypass", "policies", "session_duration", "type"];
const accessPolicyFields = ["name", "decision", "include", "exclude", "require", "precedence"];

export function maildeskAccessOperations() {
  return [
    { resource: "access_application", action: "create_owned_self_hosted_whole_host", capability_id: "access-applications-create-owned-self-hosted-whole-host", method: "POST", path: "/accounts/{account_id}/access/apps", selectors: ["account_id"], body: accessAppFields, rollback: "delete_only_returned_app_id_in_separate_reviewed_plan" },
    { resource: "access_application", action: "update_owned_self_hosted_whole_host", capability_id: "access-applications-update-owned-self-hosted-whole-host", method: "PUT", path: "/accounts/{account_id}/access/apps/{app_id}", selectors: ["account_id", "app_id"], body: [...accessAppFields, "self_hosted_domains"], rollback: "restore_exact_prior_owned_application_snapshot_in_separate_reviewed_plan" },
    { resource: "access_policy", action: "create_owned_operator_allow_policy", capability_id: "access-policies-create-operator-group-allow-policy", method: "POST", path: "/accounts/{account_id}/access/apps/{app_id}/policies", selectors: ["account_id", "app_id"], body: accessPolicyFields, rollback: "delete_only_returned_policy_id_in_separate_reviewed_plan" },
    { resource: "access_policy", action: "update_owned_operator_allow_policy", capability_id: "access-policies-update-operator-group-allow-policy", method: "PUT", path: "/accounts/{account_id}/access/apps/{app_id}/policies/{policy_id}", selectors: ["account_id", "app_id", "policy_id"], body: accessPolicyFields, rollback: "restore_exact_prior_owned_policy_snapshot_in_separate_reviewed_plan" },
  ];
}

export function incompatibleMaildeskAccess(operation: ReturnType<typeof maildeskAccessOperations>[number], envelope: unknown): string | null {
  const fail = (reason: string) => `${operation.capability_id}: ${reason}`;
  if (!isRecord(envelope) || envelope.schema_version !== 2 || envelope.command !== "catalog show" || envelope.ok !== true || envelope.performed !== false) return fail("expected non-performing catalog ResultEnvelopeV2");
  const c = envelope.result;
  if (!isRecord(c) || c.id !== operation.capability_id || c.adapter_status !== "dynamic_api" || c.blocked_reason != null || c.method !== operation.method || c.path !== operation.path || c.mutating !== true || c.effect !== "identity_or_ownership" || c.verification?.required !== true || c.rollback?.supported !== true || c.response_contract?.body_mode !== "cloudflare_json_envelope") return fail("owned mutation, verification or compensation contract is unavailable");
  if (!Array.isArray(c.selectors) || c.selectors.length !== operation.selectors.length || operation.selectors.some(name => !c.selectors.some((selector: any) => selector?.name === name && selector.required === true && selector.location === "path" && selector.value_type === "string"))) return fail("exact account/resource selectors drifted");
  const schema = c.request_schema;
  if (!isRecord(schema) || schema.type !== "object" || schema.additionalProperties !== false || !Array.isArray(schema.required) || schema.required.length !== operation.body.length || operation.body.some(name => !schema.required.includes(name)) || !isRecord(schema.properties)) return fail("closed required request fields drifted; inspect cfctl guide");
  const fields = schema.properties;
  const onlyEnum = (field: any, value: unknown) => Array.isArray(field?.enum) && field.enum.length === 1 && field.enum[0] === value;
  if (operation.resource === "access_application") {
    if (!onlyEnum(fields.type, "self_hosted") || fields.domain?.format !== "hostname" || fields.destinations?.type !== "array" || fields.destinations.minItems !== 1 || fields.destinations.maxItems !== 1 || fields.destinations.items?.additionalProperties !== false || !onlyEnum(fields.destinations.items?.properties?.type, "public") || fields.destinations.items?.properties?.uri?.format !== "hostname") return fail("whole-host application schema drifted");
    if (operation.method === "POST" && (Object.keys(fields).length !== operation.body.length || fields.policies?.maxItems !== 0 || !onlyEnum(fields.options_preflight_bypass, false))) return fail("create must be initially deny-all with an empty policy set");
    if (operation.method === "PUT" && fields.policies?.minItems !== 1) return fail("update must preserve existing policy references");
  } else if (!onlyEnum(fields.decision, "allow") || fields.include?.minItems !== 1 || fields.include?.maxItems !== 1 || fields.include?.items?.additionalProperties !== false || JSON.stringify(fields.include?.items?.required) !== '["group"]' || fields.include?.items?.properties?.group?.additionalProperties !== false || JSON.stringify(fields.include?.items?.properties?.group?.required) !== '["id"]' || fields.exclude?.maxItems !== 0 || fields.require?.maxItems !== 0) return fail("single operator-group allow policy schema drifted");
  return null;
}


export function discoverMaildeskAccess(installed: boolean) {
  const failures: string[] = [];
  if (installed) for (const operation of maildeskAccessOperations()) {
    const result = spawnSync(process.env.CFCTL_BIN ?? "cfctl", ["catalog", "show", operation.capability_id, "--json"], { encoding: "utf8", timeout: 10_000 });
    if (result.status !== 0) { failures.push(`${operation.capability_id}: catalog unavailable; inspect cfctl guide`); continue; }
    try {
      const error = incompatibleMaildeskAccess(operation, JSON.parse(result.stdout));
      if (error) failures.push(error);
    } catch { failures.push(`${operation.capability_id}: malformed catalog envelope`); }
  }
  return { status: !installed ? "not_checked" : failures.length ? "incompatible" : "compatible", performed: false, account_authority_proven: false, failures };
}
