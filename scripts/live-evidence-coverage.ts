import { createHash } from "node:crypto";

export type CfctlReadbackMode = "canary" | "full_desired_state";
export type CfctlAcceptanceProfile = "inventory_v1" | "dark_acceptance_v1";

export const DARK_ACCEPTANCE_SURFACES = [
  "access_application",
  "access_policies",
  "r2_spool_lifecycle",
  "worker_deployment_identity",
  "worker_route_identity",
  "queue_backlog",
  "dead_letter_queue_backlog",
  "spool_emptiness",
  "readiness_endpoint",
] as const;

export const DARK_ACCEPTANCE_CAPABILITY_IDS = [
  "access-applications-get-an-access-application",
  "access-policies-list-access-app-policies",
  "r2-get-bucket-lifecycle-configuration",
] as const;

export type DarkAcceptanceSurface = typeof DARK_ACCEPTANCE_SURFACES[number];

export interface CfctlCoverageBlocker {
  code:
    | "PARTIAL_DESIRED_SCOPE"
    | "ACCEPTANCE_PROFILE_INVENTORY_ONLY"
    | "ACCEPTANCE_SURFACE_UNIMPLEMENTED"
    | "PROVIDER_READ_FAILED";
  capability_id?: string;
  surface?: DarkAcceptanceSurface;
}

export interface CfctlReadbackCoverage {
  mode: CfctlReadbackMode;
  profile: CfctlAcceptanceProfile;
  desired_state_sha256: string;
  scope_manifest_sha256?: string;
  expected_domain_count: number;
  selected_domain_count: number;
  observed_domain_count: number;
  selected_domain_sha256s: string[];
  observed_domain_sha256s: string[];
  required_capability_ids: string[];
  successful_capability_ids: string[];
  failed_capability_ids: string[];
  missing_capability_ids: string[];
  required_acceptance_surfaces: DarkAcceptanceSurface[];
  successful_acceptance_surfaces: DarkAcceptanceSurface[];
  missing_acceptance_surfaces: DarkAcceptanceSurface[];
  selected_scope_complete: boolean;
  desired_scope_complete: boolean;
  acceptance_complete: boolean;
  blockers: CfctlCoverageBlocker[];
}

export interface CfctlReadbackAuthority {
  required?: boolean;
  attempted?: boolean;
  transaction_complete?: boolean;
  complete?: boolean;
  coverage?: CfctlReadbackCoverage;
}

export function coverageDomainSha256(domain: string): string {
  return createHash("sha256").update(domain.trim().toLowerCase()).digest("hex");
}

export function domainSelectedByCoverage(
  coverage: CfctlReadbackCoverage | undefined,
  domain: string,
): boolean {
  if (!coverage || coverage.mode !== "canary") return true;
  return coverage.selected_domain_sha256s.includes(coverageDomainSha256(domain));
}

export function validReadbackCoverage(
  coverage: CfctlReadbackCoverage | undefined,
  expectedDesiredStateSha256: string,
  expectedDomains: string[],
): boolean {
  const expectedDomainSha256s = expectedDomains.map(coverageDomainSha256).sort();
  const expectedDomainCount = expectedDomainSha256s.length;
  if (!coverage || !isSha256(coverage.desired_state_sha256)) return false;
  if (coverage.desired_state_sha256 !== expectedDesiredStateSha256) return false;
  if (coverage.scope_manifest_sha256 !== undefined && !isSha256(coverage.scope_manifest_sha256)) return false;
  if (coverage.mode !== "canary" && coverage.mode !== "full_desired_state") return false;
  if (coverage.profile !== "inventory_v1" && coverage.profile !== "dark_acceptance_v1") return false;
  if (coverage.expected_domain_count !== expectedDomainCount) return false;
  if (!validCount(coverage.selected_domain_count) || !validCount(coverage.observed_domain_count)) return false;
  if (coverage.selected_domain_count > expectedDomainCount) return false;
  if (coverage.observed_domain_count > coverage.selected_domain_count) return false;
  if (!validSha256Set(coverage.selected_domain_sha256s, coverage.selected_domain_count)) return false;
  if (!validSha256Set(coverage.observed_domain_sha256s, coverage.observed_domain_count)) return false;
  if (!coverage.selected_domain_sha256s.every((digest) => expectedDomainSha256s.includes(digest))) return false;
  if (!coverage.observed_domain_sha256s.every((digest) => coverage.selected_domain_sha256s.includes(digest))) {
    return false;
  }
  if (coverage.mode === "canary") {
    if (!coverage.scope_manifest_sha256 || coverage.selected_domain_count >= expectedDomainCount) return false;
  } else if (
    coverage.scope_manifest_sha256 !== undefined ||
    !sameStringSet(coverage.selected_domain_sha256s, expectedDomainSha256s)
  ) return false;
  for (const values of [
    coverage.required_capability_ids,
    coverage.successful_capability_ids,
    coverage.failed_capability_ids,
    coverage.missing_capability_ids,
  ]) {
    if (!validStringSet(values)) return false;
  }
  if (!coverage.successful_capability_ids.every((id) => coverage.required_capability_ids.includes(id))) return false;
  if (!coverage.failed_capability_ids.every((id) => coverage.required_capability_ids.includes(id))) return false;
  if (!coverage.missing_capability_ids.every((id) => coverage.required_capability_ids.includes(id))) return false;
  const classifiedCapabilities = [
    ...coverage.successful_capability_ids,
    ...coverage.failed_capability_ids,
    ...coverage.missing_capability_ids,
  ];
  if (
    new Set(classifiedCapabilities).size !== classifiedCapabilities.length ||
    !sameStringSet(classifiedCapabilities, coverage.required_capability_ids)
  ) return false;
  if (!validAcceptanceSurfaces(coverage)) return false;
  if (!Array.isArray(coverage.blockers) || !coverage.blockers.every(validBlocker)) return false;

  const selectedScopeComplete =
    coverage.observed_domain_count === coverage.selected_domain_count &&
    coverage.failed_capability_ids.length === 0 &&
    coverage.missing_capability_ids.length === 0 &&
    sameStringSet(coverage.successful_capability_ids, coverage.required_capability_ids);
  if (coverage.selected_scope_complete !== selectedScopeComplete) return false;

  const desiredScopeComplete = coverage.mode === "full_desired_state" &&
    selectedScopeComplete &&
    coverage.selected_domain_count === expectedDomainCount &&
    coverage.observed_domain_count === expectedDomainCount;
  if (coverage.desired_scope_complete !== desiredScopeComplete) return false;

  const acceptanceComplete = coverage.profile === "dark_acceptance_v1" &&
    desiredScopeComplete &&
    coverage.failed_capability_ids.length === 0 &&
    coverage.missing_capability_ids.length === 0 &&
    coverage.missing_acceptance_surfaces.length === 0 &&
    coverage.required_acceptance_surfaces.every((surface) =>
      coverage.successful_acceptance_surfaces.includes(surface)
    );
  return coverage.acceptance_complete === acceptanceComplete &&
    (!acceptanceComplete || coverage.blockers.length === 0);
}

export function readbackAuthorizesReadiness(
  readback: CfctlReadbackAuthority | undefined,
  expectedDesiredStateSha256: string,
  expectedDomains: string[],
): boolean {
  const coverage = readback?.coverage;
  return readback?.required === true &&
    readback.attempted === true &&
    readback.transaction_complete === true &&
    readback.complete === true &&
    validReadbackCoverage(coverage, expectedDesiredStateSha256, expectedDomains) &&
    coverage?.mode === "full_desired_state" &&
    coverage.profile === "dark_acceptance_v1" &&
    coverage.selected_scope_complete === true &&
    coverage.desired_scope_complete === true &&
    coverage.acceptance_complete === true;
}

function validAcceptanceSurfaces(coverage: CfctlReadbackCoverage): boolean {
  const allowed = new Set<string>(DARK_ACCEPTANCE_SURFACES);
  for (const values of [
    coverage.required_acceptance_surfaces,
    coverage.successful_acceptance_surfaces,
    coverage.missing_acceptance_surfaces,
  ]) {
    if (!Array.isArray(values) || new Set(values).size !== values.length) return false;
    if (!values.every((value) => allowed.has(value))) return false;
  }
  if (coverage.profile === "inventory_v1") {
    return coverage.required_acceptance_surfaces.length === 0 &&
      coverage.successful_acceptance_surfaces.length === 0 &&
      coverage.missing_acceptance_surfaces.length === 0 &&
      coverage.acceptance_complete === false;
  }
  return DARK_ACCEPTANCE_CAPABILITY_IDS.every((capability) =>
    coverage.required_capability_ids.includes(capability)
  ) &&
    DARK_ACCEPTANCE_SURFACES.every((surface) => coverage.required_acceptance_surfaces.includes(surface)) &&
    coverage.successful_acceptance_surfaces.every((surface) =>
      coverage.required_acceptance_surfaces.includes(surface)
    ) &&
    coverage.missing_acceptance_surfaces.every((surface) =>
      coverage.required_acceptance_surfaces.includes(surface)
    );
}

function validBlocker(blocker: unknown): blocker is CfctlCoverageBlocker {
  if (!blocker || typeof blocker !== "object") return false;
  const value = blocker as Partial<CfctlCoverageBlocker>;
  return [
    "PARTIAL_DESIRED_SCOPE",
    "ACCEPTANCE_PROFILE_INVENTORY_ONLY",
    "ACCEPTANCE_SURFACE_UNIMPLEMENTED",
    "PROVIDER_READ_FAILED",
  ].includes(value.code ?? "") &&
    (value.capability_id === undefined || (typeof value.capability_id === "string" && value.capability_id.length > 0)) &&
    (value.surface === undefined || DARK_ACCEPTANCE_SURFACES.includes(value.surface));
}

function validCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function validStringSet(values: string[]): boolean {
  return Array.isArray(values) &&
    values.every((value) => typeof value === "string" && value.length > 0) &&
    new Set(values).size === values.length;
}

function validSha256Set(values: string[], expectedLength: number): boolean {
  return Array.isArray(values) &&
    values.length === expectedLength &&
    values.every(isSha256) &&
    new Set(values).size === values.length;
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}
