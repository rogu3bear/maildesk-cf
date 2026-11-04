export interface RoleProofAlias {
  reply_identity: string;
  sink?: boolean;
  delivery_only?: boolean;
}

function selectRole(roles: Record<string, RoleProofAlias>, declaredAliases: string[], requireReply: boolean): string | null {
  const aliases = declaredAliases.filter((alias) => roles[alias] && roles[alias]!.sink !== true &&
    (!requireReply || roles[alias]!.delivery_only !== true)).sort();
  return aliases.includes("founders") ? "founders" : aliases[0] ?? null;
}

/** Choose a reply-capable declared role for evidence that includes an identity. */
export function roleProofTarget(
  domain: string,
  roles: Record<string, RoleProofAlias>,
  declaredAliases = Object.keys(roles),
): { address: string; replyIdentity: string } | null {
  const alias = selectRole(roles, declaredAliases, true);
  return alias ? { address: `${alias}@${domain}`, replyIdentity: roles[alias]!.reply_identity } : null;
}

/** Inbound-only proof may target delivery-only roles without implying reply authority. */
export function roleInboundTarget(domain: string, roles: Record<string, RoleProofAlias>, declaredAliases = Object.keys(roles)): string | null {
  const alias = selectRole(roles, declaredAliases, false);
  return alias ? `${alias}@${domain}` : null;
}
