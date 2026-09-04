/** Maildesk requires an explicit managed profile pinned to its desired account. */
export function cfctlExecutable(explicit?: string, env = process.env): string {
  return explicit?.trim() || env.CFCTL_BIN?.trim() || "cfctl";
}

export function cfctlAccountTarget(project: { account_id?: unknown; account_id_env?: unknown } | null | undefined, env = process.env): string | null {
  const custom = typeof project?.account_id_env === "string" ? env[project.account_id_env.trim()] : undefined;
  for (const value of [env.CLOUDFLARE_ACCOUNT_ID, project?.account_id, custom]) {
    if (typeof value !== "string") continue;
    const account = value.trim();
    if (account && !account.startsWith("<") && !account.includes("replace-me")) return account;
  }
  return null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cfctlLocalResult(value: unknown, command: string): Record<string, unknown> | null {
  if (!record(value) || value.schema_version !== 2 || value.command !== command ||
      value.ok !== true || value.performed !== false || value.error != null || !record(value.result)) return null;
  return value.result;
}

export function managedProfileHealthy(doctor: unknown, auth: unknown, profile: string, account: string): boolean {
  const runtime = cfctlLocalResult(doctor, "doctor");
  const status = cfctlLocalResult(auth, "auth status");
  return Boolean(profile && account && runtime?.build_identity_healthy === true &&
    record(runtime.path_build) && runtime.path_build.healthy === true && runtime.instruction_drift === 0 &&
    status?.credential_available === true && record(status.profile) &&
    ["api_token", "o_auth"].includes(String(status.profile.kind)) && status.profile.emergency_only !== true &&
    status.profile.id === profile && status.profile.account_id === account);
}
