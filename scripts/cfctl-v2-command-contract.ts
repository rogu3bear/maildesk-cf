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
