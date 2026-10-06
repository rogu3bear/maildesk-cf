export interface RoleProofAlias {
  reply_identity: string;
  sink?: boolean;
}

/** Choose one declared, non-sink role consistently for collection and planning. */
export function roleProofTarget(
  domain: string,
  roles: Record<string, RoleProofAlias>,
  declaredAliases = Object.keys(roles),
): { address: string; replyIdentity: string } | null {
  const aliases = declaredAliases.filter((alias) => roles[alias] && roles[alias]!.sink !== true).sort();
  const alias = aliases.includes("founders") ? "founders" : aliases[0];
  if (!alias) return null;
  return { address: `${alias}@${domain}`, replyIdentity: roles[alias]!.reply_identity };
}
