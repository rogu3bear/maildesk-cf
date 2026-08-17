import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");
const forbiddenExecutable = [
  /\bcfctl\s+maildesk-cf\b/,
  /\bcfctl\s+list\b/,
  /\bcfctl\s+apply\b/,
  /\bCF_TOKEN_LANE=global\b/,
  /--ack-plan\b/,
  /\bcfctl\s+previews\b/,
  /\bcfctl\s+standards\b/,
  /\bcfctl\s+classify\b/,
];

describe("cfctl v2 operator-command authority", () => {
  test("keeps executable scripts free of legacy cfctl command forms", () => {
    const files = trackedFiles(["scripts"]);
    const failures = forbiddenMatches(files, false);
    expect(failures).toEqual([]);
  });

  test("keeps operator guidance code blocks free of legacy cfctl command forms", () => {
    const files = ["AGENTS.md", "README.md", ...trackedFiles(["docs", "ops/cfctl"])]
      .filter((path, index, all) => all.indexOf(path) === index);
    const failures = forbiddenMatches(files, true);
    expect(failures).toEqual([]);
  });

  test("keeps closeout ownership aligned with the retired preview-cleanup lane", () => {
    const ownership = readFileSync(resolve(root, "docs/SCRIPT-OWNERSHIP.md"), "utf8");
    const row = ownership.split("\n").find((line) =>
      line.includes("`scripts/check-maildesk-closeout.ts`")
    );
    expect(row).toContain("It never searches for, bulk-cleans, or retires plans.");
    expect(row).not.toMatch(/duplicate active|expired local preview|preview records/);
  });

  test("requires one typed command contract with the governed PlanV2 lifecycle", async () => {
    const contract = await import("../../scripts/cfctl-v2-command-contract");
    expect(contract.CFCTL_COMMAND_CONTRACT_VERSION).toBe(2);
    expect(contract.SENDER_DOMAIN_CREATE_CAPABILITY).toBe(
      "email-sending-subdomains-create-sending-subdomain",
    );
    expect(contract.SENDER_DOMAIN_VERIFY_CAPABILITY).toBe(
      "email-sending-subdomains-list-sending-subdomains",
    );
    expect(contract.planLifecycle("operation-example")).toEqual({
      show: ["cfctl", "plans", "show", "operation-example", "--json"],
      approve: ["cfctl", "plans", "approve", "operation-example", "--yes", "--json"],
      run: ["cfctl", "plans", "run", "operation-example", "--json"],
      status: ["cfctl", "plans", "status", "operation-example", "--json"],
    });
    const planV2 = senderDomainPlanV2("operation-example");
    expect(contract.senderDomainPlanV2Failure(planV2, {
      operation_id: "operation-example",
      profile_id: "profile-example",
      account_id: "account-example",
      zone_id: "zone-example",
      target: "example.com",
      plan_content_hash: planV2.content_hash,
    })).toBeNull();
    planV2.plan.input.body.name = "other.example.com";
    expect(contract.senderDomainPlanV2Failure(planV2, {
      operation_id: "operation-example",
      profile_id: "profile-example",
      account_id: "account-example",
      zone_id: "zone-example",
      target: "example.com",
      plan_content_hash: planV2.content_hash,
    })).toBe("PlanV2 selector or request body drifted");
  });
});

function senderDomainPlanV2(operationId: string) {
  return {
    schema_version: 2,
    content_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    plan: {
      schema_version: 1,
      operation_id: operationId,
      profile_id: "profile-example",
      account_id: "account-example",
      capability: { id: "email-sending-subdomains-create-sending-subdomain" },
      targets: { selectors: { zone_id: "zone-example" }, account_id: "account-example" },
      input: {
        selectors: { zone_id: "zone-example" },
        query: {},
        body: { name: "example.com" },
      },
    },
  };
}

function trackedFiles(prefixes: string[]): string[] {
  const result = spawnSync("git", ["ls-files", "--", ...prefixes], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || "git ls-files failed");
  return result.stdout.split("\n").filter(Boolean);
}

function forbiddenMatches(paths: string[], codeBlocksOnly: boolean): string[] {
  const failures: string[] = [];
  for (const path of paths) {
    const source = readFileSync(resolve(root, path), "utf8");
    const inspected = codeBlocksOnly ? markdownCodeBlocks(source) : source;
    for (const [index, line] of inspected.split("\n").entries()) {
      if (forbiddenExecutable.some((pattern) => pattern.test(line))) {
        failures.push(`${path}:${index + 1}:${line.trim()}`);
      }
    }
  }
  return failures;
}

function markdownCodeBlocks(source: string): string {
  const blocks: string[] = [];
  let inBlock = false;
  for (const line of source.split("\n")) {
    if (line.trim().startsWith("```")) {
      inBlock = !inBlock;
      continue;
    }
    if (inBlock) blocks.push(line);
  }
  return blocks.join("\n");
}
