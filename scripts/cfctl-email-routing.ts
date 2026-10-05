import { createHash } from "node:crypto";

export interface EmailRoutingRule {
  enabled: boolean;
  matchers: Array<{ matcher_type: string; field?: string; value_sha256?: string }>;
  actions: Array<{ action_type: string; worker_targets: string[]; value_count: number }>;
}

export interface EmailRoutingRuleSet {
  schema_version: 1;
  complete: true;
  page_size: 50;
  pages: number;
  rule_count: number;
  rules: EmailRoutingRule[];
}

/** Decode cfctl's complete, body-free rule projection (the provider result). */
export function decodeEmailRoutingRuleSet(value: unknown): EmailRoutingRuleSet | null {
  if (!isRecord(value) || value.schema_version !== 1 || value.complete !== true || value.page_size !== 50 ||
      !Number.isInteger(value.pages) || value.pages < 1 || value.pages > 100 ||
      !Number.isInteger(value.rule_count) || value.rule_count < 0 || value.rule_count > (value.pages - 1) * 50 ||
      !Array.isArray(value.rules) || value.rule_count !== value.rules.length ||
      !value.rules.every(validProjectedRoutingRule)) return null;
  return value as unknown as EmailRoutingRuleSet;
}

export function routingRuleHasAlias(rule: EmailRoutingRule, address: string): boolean {
  const hash = `sha256:${createHash("sha256").update(address.trim().toLowerCase()).digest("hex")}`;
  return rule.matchers.some((matcher) => matcher.matcher_type === "literal" &&
    matcher.field === "to" && matcher.value_sha256 === hash);
}

export function projectedRuleRoutesToWorker(rule: EmailRoutingRule, worker: string): boolean {
  const action = rule.actions[0];
  return rule.enabled && rule.actions.length === 1 && action?.action_type === "worker" &&
    action.value_count === 1 && action.worker_targets.length === 1 && action.worker_targets[0] === worker;
}

function validProjectedRoutingRule(value: unknown): boolean {
  if (!isRecord(value) || typeof value.enabled !== "boolean" ||
      !Array.isArray(value.matchers) || value.matchers.length === 0 ||
      !Array.isArray(value.actions) || value.actions.length === 0) return false;
  const matchersValid = value.matchers.every((matcher: unknown) => {
    if (!isRecord(matcher) || typeof matcher.matcher_type !== "string" || !matcher.matcher_type) return false;
    return (matcher.field === undefined && matcher.value_sha256 === undefined) ||
      (typeof matcher.field === "string" && matcher.field.length > 0 &&
       typeof matcher.value_sha256 === "string" && /^sha256:[a-f0-9]{64}$/.test(matcher.value_sha256));
  });
  const actionsValid = value.actions.every((action: unknown) => isRecord(action) &&
    typeof action.action_type === "string" && action.action_type.length > 0 &&
    Array.isArray(action.worker_targets) &&
    action.worker_targets.every((target: unknown) => typeof target === "string" && target.length > 0) &&
    typeof action.value_count === "number" && Number.isInteger(action.value_count) &&
    action.value_count >= action.worker_targets.length &&
    (action.action_type === "worker" ? action.value_count === action.worker_targets.length : action.worker_targets.length === 0));
  return matchersValid && actionsValid;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
