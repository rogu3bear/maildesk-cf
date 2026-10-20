import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectPolicy, type PolicyProjection, type RouterPolicy } from "../workers/shared/router";
import { projectRoutes, projectionSql, type RouteProjectionDesiredState } from "./sync-route-policy";

type Route = PolicyProjection["routes"][number];
export interface PolicyChangeInputs {
  basePolicy: string;
  baseDesiredState: string;
  candidatePolicy: string;
  candidateDesiredState: string;
}

/** Offline preparation only. All policy semantics come from Rust projection. */
export function compilePolicyChange(input: PolicyChangeInputs) {
  const base = project(input.basePolicy, input.baseDesiredState);
  const candidate = project(input.candidatePolicy, input.candidateDesiredState);
  const prior = new Map(base.projection.routes.map((route) => [route.routeRef, route]));
  const next = new Map(candidate.projection.routes.map((route) => [route.routeRef, route]));
  const priorProviders = new Map(base.routes.map((route) => [`${route.domain}\0${route.localPart}`, route.desiredProvider]));
  const nextProviders = new Map(candidate.routes.map((route) => [`${route.domain}\0${route.localPart}`, route.desiredProvider]));
  const changes = [...new Set([...prior.keys(), ...next.keys()])].sort().flatMap((routeRef) => {
    const before = prior.get(routeRef) ?? null;
    const after = next.get(routeRef) ?? null;
    const beforeProvider = before ? priorProviders.get(`${before.domain}\0${before.localPart}`) : null;
    const afterProvider = after ? nextProviders.get(`${after.domain}\0${after.localPart}`) : null;
    return JSON.stringify(before) === JSON.stringify(after) && beforeProvider === afterProvider ? [] : [{
      route_ref: routeRef, before, after,
      before_provider: beforeProvider, after_provider: afterProvider,
      added_members: members(after).filter((member) => !members(before).includes(member)),
      removed_members: members(before).filter((member) => !members(after).includes(member)),
    }];
  });
  const review = {
    schema_version: 1 as const,
    base_policy_sha256: digest(input.basePolicy),
    base_desired_state_sha256: digest(input.baseDesiredState),
    candidate_policy_sha256: digest(input.candidatePolicy),
    candidate_desired_state_sha256: digest(input.candidateDesiredState),
    base_routes: base.routes.length,
    candidate_routes: candidate.routes.length,
    protected_operators_before: base.projection.protectedOperators,
    protected_operators_after: candidate.projection.protectedOperators,
    requires_route_requalification: digest(input.basePolicy) !== digest(input.candidatePolicy) ||
      digest(input.baseDesiredState) !== digest(input.candidateDesiredState)
      ? candidate.projection.routes.map((route) => route.routeRef).sort() : [],
    affected_routes: changes,
    unchanged_routes: [...prior.keys()].filter((key) => next.has(key)).length - changes.filter((change) => change.before && change.after).length,
  };
  const reviewSha256 = digest(JSON.stringify(review));
  const projection = projectionSql(candidate.routes, review.candidate_policy_sha256,
    `config/policy/${review.candidate_policy_sha256}.json`, review.candidate_desired_state_sha256);
  // Preserve the existing projection digest. The additional first statement
  // binds this import to its reviewed base and appends a review record atomically.
  const guard = `INSERT INTO policy_change_reviews (review_sha256, base_policy_sha256, base_desired_state_sha256, candidate_policy_sha256, candidate_desired_state_sha256) VALUES ('${reviewSha256}', '${review.base_policy_sha256}', '${review.base_desired_state_sha256}', '${review.candidate_policy_sha256}', '${review.candidate_desired_state_sha256}');`;
  const prefix = "PRAGMA foreign_keys = ON;\n";
  if (!projection.sql.startsWith(prefix)) throw new Error("projection import format changed");
  const sql = `${prefix}${guard}\n${projection.sql.slice(prefix.length)}`;
  return {
    review: { ...review, review_sha256: reviewSha256, sql_sha256: digest(sql),
      projection_sha256: projection.projectionSha256, performed: false as const,
      execution_supported: false as const, status: "proposed" as const },
    sql,
  };
}

function members(route: Route | null): string[] { return route?.operators ?? []; }
function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function project(policyBytes: string, desiredBytes: string) {
  const policy = JSON.parse(policyBytes) as RouterPolicy;
  const desired = JSON.parse(desiredBytes) as RouteProjectionDesiredState;
  const routes = projectRoutes(policy, desired);
  const projection = projectPolicy(policy);
  if (!projection.ok) throw new Error("Rust rejected policy projection");
  return { routes, projection: projection.value };
}

function main() {
  const args = process.argv.slice(2);
  const names = ["--base-policy", "--base-desired-state", "--policy", "--desired-state", "--out-dir"];
  if (args.length !== names.length * 2) throw new Error("expected base policy/state, candidate policy/state and a new output directory");
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!; const value = args[i + 1]!;
    if (!names.includes(name) || values.has(name) || !value || value.startsWith("--")) throw new Error("invalid or duplicate option");
    values.set(name, value);
  }
  const read = (name: string) => readFileSync(resolve(values.get(name)!), "utf8");
  const result = compilePolicyChange({ basePolicy: read("--base-policy"), baseDesiredState: read("--base-desired-state"),
    candidatePolicy: read("--policy"), candidateDesiredState: read("--desired-state") });
  const directory = resolve(values.get("--out-dir")!);
  mkdirSync(directory, { mode: 0o700 }); // Exclusive: never replace an existing review.
  try {
    writeFileSync(join(directory, "review.json"), `${JSON.stringify(result.review, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    writeFileSync(join(directory, "projection.sql"), result.sql, { mode: 0o600, flag: "wx" });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  console.log(JSON.stringify({ ok: true, performed: false, execution_supported: false,
    review_sha256: result.review.review_sha256, affected_routes: result.review.affected_routes.length,
    candidate_routes: result.review.candidate_routes }));
}

if (import.meta.main) {
  try { main(); }
  catch { console.error("policy change preparation failed; check inputs and use a new output directory"); process.exitCode = 1; }
}
