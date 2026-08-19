import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");

describe("maildesk live-evidence collector", () => {
  test("the tracked canonical desired state selects the relay-router service", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-collect-evidence-"));
    const cfctl = join(dir, "cfctl");
    const cfctlLog = join(dir, "cfctl.log");
    const wrangler = join(dir, "wrangler");
    const out = join(dir, "evidence.json");
    const policyObject = resolve(root, "config/policy.example.json");
    const desiredObject = resolve(root, "config/desired-state.example.json");
    const policySha256 = createHash("sha256").update(readFileSync(policyObject)).digest("hex");
    const policyKey = `config/policy/${policySha256}.json`;
    const projection = projectionSummary(policyObject, desiredObject);
    const d1Result = JSON.stringify([{ results: [{
      active_policy_sha256: policySha256,
      active_policy_r2_key: policyKey,
      revision_r2_key: policyKey,
      expected_domain_count: 1,
      expected_route_count: 11,
      projected_domain_count: 1,
      projected_route_count: 11,
      projection_policy_sha256: policySha256,
      active_desired_state_sha256: projection.desired_state_sha256,
      active_projection_sha256: projection.projection_sha256,
      route_address: "security@example.com",
      route_kind: "role_alias",
      operator_count: 2,
      reply_identity: "security@example.com",
      policy_sha256: policySha256,
      last_inbound_provider_accepted_at: "2026-08-13T00:00:00.000Z",
      last_inbound_provider_message_ids_json: JSON.stringify(["provider-a", "provider-b"]),
      last_inbox_verified_at: "2026-08-13T00:01:00.000Z",
    }] }]);
    writeFileSync(
      cfctl,
      `#!/bin/sh
echo "$@" >> "$MAILDESK_TEST_CFCTL_LOG"
case "$*" in
  "auth profiles --json") echo '{"schema_version":2,"ok":true,"performed":false,"result":{"current":null,"profiles":[{"id":"profile-example","account_id":"account-example","kind":"api_token"}]},"error":null}' ;;
  *"call zones-get"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"zones-get","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"a".repeat(64)}"}],"result":{"result":[{"id":"zone-example","name":"example.com","status":"active"}],"result_info":{"page":1,"per_page":5,"total_pages":1,"total_count":1}},"error":null}' ;;
  *"call email-routing-routing-rules-list-routing-rules"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"email-routing-routing-rules-list-routing-rules","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"b".repeat(64)}"}],"result":{"result":{"schema_version":1,"complete":true,"page_size":50,"pages":2,"rule_count":1,"rules":[{"enabled":true,"matchers":[{"matcher_type":"literal","field":"to","value_sha256":"sha256:786906db96ef646937f205d3e7398630ce2e97df5364baf31b81ef84f1386c3f"}],"actions":[{"action_type":"worker","worker_targets":["maildesk-cf-router"],"value_count":1}]}]}},"error":null}' ;;
  *"call dns-records-for-a-zone-list-dns-records"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"dns-records-for-a-zone-list-dns-records","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"c".repeat(64)}"}],"result":{"result":[{"type":"MX","name":"example.com","content":"route1.mx.cloudflare.net"},{"type":"MX","name":"example.com","content":"route2.mx.cloudflare.net"},{"type":"MX","name":"example.com","content":"route3.mx.cloudflare.net"}],"result_info":{"page":1,"per_page":100,"total_pages":1,"total_count":3}},"error":null}' ;;
  *"call email-routing-settings-get-email-routing-settings"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"email-routing-settings-get-email-routing-settings","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"d".repeat(64)}"}],"result":{"result":{"enabled":true}},"error":null}' ;;
  *"call email-routing-routing-rules-get-catch-all-rule"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"email-routing-routing-rules-get-catch-all-rule","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"7".repeat(64)}"}],"result":{"result":{"enabled":true,"actions":[{"type":"worker","value":["maildesk-cf-router"]}]}},"error":null}' ;;
  *"call listWorkers"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"listWorkers","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"e".repeat(64)}"}],"result":{"result":[{"name":"maildesk-cf-router"},{"name":"maildesk-cf-relay-outbound"},{"name":"maildesk-cf-routing-health"}],"result_info":{"page":1,"per_page":100,"total_pages":1,"total_count":3}},"error":null}' ;;
  *"call worker-script-get-settings"*"script_name=maildesk-cf-router"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"worker-script-get-settings","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"3".repeat(64)}"}],"result":{"result":{"bindings":[{"name":"EMAIL","type":"send_email"},{"name":"DB","type":"d1","id":"d1-example"},{"name":"POLICY_STORE","type":"r2_bucket","bucket_name":"maildesk-cf-policy"},{"name":"RELAY_SPOOL","type":"r2_bucket","bucket_name":"maildesk-cf-relay-spool"},{"name":"MAIL_JOBS","type":"queue","queue_name":"maildesk-cf-relay-jobs"}]}},"error":null}' ;;
  *"call worker-script-get-settings"*"script_name=maildesk-cf-relay-outbound"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"worker-script-get-settings","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"4".repeat(64)}"}],"result":{"result":{"bindings":[{"name":"EMAIL","type":"send_email"},{"name":"DB","type":"d1","id":"d1-example"},{"name":"POLICY_STORE","type":"r2_bucket","bucket_name":"maildesk-cf-policy"},{"name":"RELAY_SPOOL","type":"r2_bucket","bucket_name":"maildesk-cf-relay-spool"}]}},"error":null}' ;;
  *"call worker-script-get-settings"*"script_name=maildesk-cf-routing-health"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"worker-script-get-settings","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"5".repeat(64)}"}],"result":{"result":{"bindings":[{"name":"DB","type":"d1","id":"d1-example"},{"name":"ASSETS","type":"assets"}]}},"error":null}' ;;
  *"call d1-list-databases"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"d1-list-databases","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"f".repeat(64)}"}],"result":{"result":[{"uuid":"d1-example","name":"maildesk-cf-relay-db"}],"result_info":{"page":1,"per_page":10000,"total_pages":1,"total_count":1}},"error":null}' ;;
  *"call r2-list-buckets"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"r2-list-buckets","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"1".repeat(64)}"}],"result":{"result":{"buckets":[{"name":"maildesk-cf-policy"},{"name":"maildesk-cf-relay-spool"}]},"result_info":{"cursor":""}},"error":null}' ;;
  *"call queues-list-consumers"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"queues-list-consumers","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"6".repeat(64)}"}],"result":{"result":[{"type":"worker","script_name":"maildesk-cf-relay-outbound","settings":{"batch_size":1,"max_concurrency":1,"max_retries":5,"dead_letter_queue":"maildesk-cf-relay-dlq"}}]},"error":null}' ;;
  *"call queues-list"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"queues-list","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"2".repeat(64)}"}],"result":{"result":[{"queue_id":"queue-jobs","queue_name":"maildesk-cf-relay-jobs"},{"queue_id":"queue-dlq","queue_name":"maildesk-cf-relay-dlq"}]},"error":null}' ;;
  *) echo '{"schema_version":2,"ok":false,"performed":false,"error":{"code":"UNEXPECTED_CALL"}}' ;;
esac
`,
    );
    chmodSync(cfctl, 0o755);
    writeFileSync(
      wrangler,
      `#!/bin/sh
if [ "$1" = "r2" ]; then
  cat "$MAILDESK_TEST_POLICY_OBJECT"
  exit 0
fi
echo '${d1Result}'
exit 0
`,
    );
    chmodSync(wrangler, 0o755);

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/collect-live-evidence.ts",
        "--",
        "--policy",
        "config/policy.example.json",
        "--desired-state",
        "config/desired-state.example.json",
        "--cfctl",
        cfctl,
        "--wrangler",
        wrangler,
        "--out",
        out,
        "--no-resend",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MAILDESK_CFCTL_PROFILE: "profile-example",
          MAILDESK_TEST_CFCTL_LOG: cfctlLog,
          MAILDESK_TEST_POLICY_OBJECT: policyObject,
        },
      },
    );

    expect(result.status).toBe(0);
    const evidence = JSON.parse(readFileSync(out, "utf8")) as {
      email_routing?: Record<string, { role_aliases: string[] }>;
      inbound_proofs?: Record<string, Record<string, unknown>>;
      active_policy?: Record<string, unknown>;
      cfctl_maildesk?: {
        workers?: Record<string, string>;
        storage?: Record<string, string>;
        domains?: Record<string, { catch_all?: string }>;
      };
      cfctl_readback?: {
        required: boolean;
        attempted: boolean;
        transaction_complete: boolean;
        complete: boolean;
        coverage: {
          mode: string;
          profile: string;
          desired_scope_complete: boolean;
          acceptance_complete: boolean;
        };
        profile_id: string;
        account_id: string;
        receipts: Array<{ capability_id: string; performed: boolean; ok: boolean }>;
      };
    };
    expect(evidence.email_routing?.["example.com"]?.role_aliases).toEqual(["security"]);
    expect(evidence.active_policy).toMatchObject({
      active_policy_sha256: policySha256,
      active_policy_r2_key: policyKey,
      revision_r2_key: policyKey,
      object_key: policyKey,
      object_sha256: policySha256,
      expected_route_count: 11,
      projected_route_count: 11,
      projection_policy_sha256: policySha256,
      active_desired_state_sha256: projection.desired_state_sha256,
      active_projection_sha256: projection.projection_sha256,
    });
    expect(evidence.inbound_proofs?.["example.com"]).toMatchObject({
      status: "ok",
      envelope_to: "security@example.com",
      route_kind: "role_alias",
      operator_count: 2,
      provider_message_ids: ["provider-a", "provider-b"],
      default_reply_identity: "security@example.com",
    });
    expect(JSON.stringify(evidence.inbound_proofs)).not.toContain("forwarded_to");
    expect(JSON.stringify(evidence.inbound_proofs)).not.toContain("raw_r2_key");
    expect(JSON.stringify(evidence.inbound_proofs)).not.toContain("operator@");
    expect(evidence.cfctl_maildesk?.workers).toEqual({
      relay_router: "ok",
      relay_outbound: "ok",
      routing_health: "ok",
    });
    expect(evidence.cfctl_maildesk?.storage).toEqual({
      d1_database: "ok",
      r2_policy_bucket: "ok",
      r2_spool_bucket: "ok",
      queue: "ok",
      dead_letter_queue: "ok",
    });
    expect(evidence.cfctl_maildesk?.domains?.["example.com"]?.catch_all).toBe("ok");
    expect(evidence.cfctl_readback).toMatchObject({
      required: true,
      attempted: true,
      transaction_complete: true,
      complete: false,
      coverage: {
        mode: "full_desired_state",
        profile: "inventory_v1",
        desired_scope_complete: true,
        acceptance_complete: false,
      },
      profile_id: "profile-example",
      account_id: "account-example",
    });
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(evidence.cfctl_readback?.receipts.every((receipt) =>
      receipt.capability_id === "auth-profiles"
        ? receipt.ok && !receipt.performed
        : receipt.ok && receipt.performed
    )).toBe(true);

    const cfctlCalls = readFileSync(cfctlLog, "utf8");
    expect(cfctlCalls).toContain("auth profiles --json");
    for (const capability of [
      "zones-get",
      "email-routing-routing-rules-list-routing-rules",
      "dns-records-for-a-zone-list-dns-records",
      "email-routing-settings-get-email-routing-settings",
      "email-routing-routing-rules-get-catch-all-rule",
      "listWorkers",
      "worker-script-get-settings",
      "d1-list-databases",
      "r2-list-buckets",
      "queues-list",
      "queues-list-consumers",
    ]) {
      expect(cfctlCalls).toContain(`call ${capability}`);
    }
    expect(cfctlCalls).toContain("--profile profile-example");
    expect(cfctlCalls).toContain("--account account-example");
    const routingCall = cfctlCalls.split("\n").find((line) =>
      line.includes("call email-routing-routing-rules-list-routing-rules")
    );
    expect(routingCall).toBeDefined();
    expect(routingCall).not.toContain("--query page=");
    expect(routingCall).not.toContain("--query per_page=");
    expect(cfctlCalls).not.toContain("list zone");
    expect(cfctlCalls).not.toContain("maildesk-cf verify");

    const successfulCfctlStub = readFileSync(cfctl, "utf8");
    const forwardOnlyOut = join(dir, "forward-only-evidence.json");
    writeFileSync(
      cfctl,
      successfulCfctlStub.replace(
        '{"action_type":"worker","worker_targets":["maildesk-cf-router"],"value_count":1}',
        '{"action_type":"forward","worker_targets":[],"value_count":1}',
      ),
      { mode: 0o755 },
    );
    const forwardOnly = spawnSync(
      "bun",
      [
        "run",
        "scripts/collect-live-evidence.ts",
        "--",
        "--policy",
        "config/policy.example.json",
        "--desired-state",
        "config/desired-state.example.json",
        "--cfctl",
        cfctl,
        "--wrangler",
        wrangler,
        "--out",
        forwardOnlyOut,
        "--no-resend",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MAILDESK_CFCTL_PROFILE: "profile-example",
          MAILDESK_TEST_CFCTL_LOG: cfctlLog,
          MAILDESK_TEST_POLICY_OBJECT: policyObject,
        },
      },
    );
    expect(forwardOnly.status).toBe(0);
    const forwardOnlyEvidence = JSON.parse(readFileSync(forwardOnlyOut, "utf8")) as {
      email_routing?: Record<string, { role_aliases: string[] }>;
      cfctl_readback?: { transaction_complete: boolean; complete: boolean };
      cfctl_maildesk?: {
        edge_ready?: boolean;
        domains?: Record<string, { aliases?: Record<string, string> }>;
      };
    };
    expect(forwardOnlyEvidence.cfctl_readback).toMatchObject({ transaction_complete: true, complete: false });
    expect(forwardOnlyEvidence.email_routing?.["example.com"]?.role_aliases).not.toContain("security");
    expect(forwardOnlyEvidence.cfctl_maildesk?.domains?.["example.com"]?.aliases?.["security@example.com"])
      .toBe("missing");
    expect(forwardOnlyEvidence.cfctl_maildesk?.edge_ready).toBe(false);

    const catchAllOut = join(dir, "catch-all-evidence.json");
    writeFileSync(
      cfctl,
      successfulCfctlStub.replace(
        '"result":{"result":{"enabled":true,"actions":[{"type":"worker","value":["maildesk-cf-router"]}]}},"error":null}',
        '"result":{"result":{"enabled":false,"actions":[]}},"error":null}',
      ),
      { mode: 0o755 },
    );
    const catchAll = spawnSync(
      "bun",
      [
        "run",
        "scripts/collect-live-evidence.ts",
        "--",
        "--policy",
        "config/policy.example.json",
        "--desired-state",
        "config/desired-state.example.json",
        "--cfctl",
        cfctl,
        "--wrangler",
        wrangler,
        "--out",
        catchAllOut,
        "--no-resend",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MAILDESK_CFCTL_PROFILE: "profile-example",
          MAILDESK_TEST_CFCTL_LOG: cfctlLog,
          MAILDESK_TEST_POLICY_OBJECT: policyObject,
        },
      },
    );
    expect(catchAll.status).toBe(0);
    const catchAllEvidence = JSON.parse(readFileSync(catchAllOut, "utf8")) as {
      cfctl_readback?: { transaction_complete: boolean; complete: boolean };
      cfctl_maildesk?: {
        edge_ready?: boolean;
        domains?: Record<string, { catch_all?: string }>;
      };
    };
    expect(catchAllEvidence.cfctl_readback).toMatchObject({ transaction_complete: true, complete: false });
    expect(catchAllEvidence.cfctl_maildesk?.domains?.["example.com"]?.catch_all).toBe("missing");
    expect(catchAllEvidence.cfctl_maildesk?.edge_ready).toBe(false);

    const googleDesiredPath = join(dir, "google-desired.json");
    const googleDesired = JSON.parse(readFileSync(desiredObject, "utf8")) as {
      domains: Array<{ inbound_mx_provider: string; catch_all?: boolean }>;
    };
    googleDesired.domains[0]!.inbound_mx_provider = "google_workspace";
    googleDesired.domains[0]!.catch_all = false;
    writeJson(googleDesiredPath, googleDesired);
    const googlePolicyPath = join(dir, "google-policy.json");
    const googlePolicy = JSON.parse(readFileSync(policyObject, "utf8")) as {
      domains: Record<string, { catch_all?: unknown }>;
    };
    delete googlePolicy.domains["example.com"]?.catch_all;
    writeJson(googlePolicyPath, googlePolicy);
    const googleOut = join(dir, "google-evidence.json");
    const googleAdmin = join(dir, "google-admin");
    writeFileSync(
      googleAdmin,
      `#!/bin/sh
cat <<'JSON'
{"receipt_path":"var/proof/google-example.json","snapshot_captured_at":"2026-08-17T00:00:00.000Z","resources":[{"id":"workspace:group:founders@example.com","type":"workspace.group","record":{"email":"founders@example.com"}},{"id":"membership-a","type":"workspace.group_membership","record":{"email":"operator-a@example.com"}},{"id":"membership-b","type":"workspace.group_membership","record":{"email":"operator-b@example.com"}}]}
JSON
`,
      { mode: 0o755 },
    );
    chmodSync(googleAdmin, 0o755);
    const googleMx = [
      "aspmx.l.google.com",
      "alt1.aspmx.l.google.com",
      "alt2.aspmx.l.google.com",
      "alt3.aspmx.l.google.com",
      "alt4.aspmx.l.google.com",
    ];
    const googleDnsResult = googleMx.map((content) => ({
      type: "MX",
      name: "example.com",
      content,
    }));
    writeFileSync(
      cfctl,
      successfulCfctlStub.replace(
        '"result":[{"type":"MX","name":"example.com","content":"route1.mx.cloudflare.net"},{"type":"MX","name":"example.com","content":"route2.mx.cloudflare.net"},{"type":"MX","name":"example.com","content":"route3.mx.cloudflare.net"}],"result_info":{"page":1,"per_page":100,"total_pages":1,"total_count":3}',
        `"result":${JSON.stringify(googleDnsResult)},"result_info":{"page":1,"per_page":100,"total_pages":1,"total_count":5}`,
      ),
      { mode: 0o755 },
    );
    writeFileSync(cfctlLog, "");
    const googleCollection = spawnSync(
      "bun",
      [
        "run",
        "scripts/collect-live-evidence.ts",
        "--",
        "--policy",
        googlePolicyPath,
        "--desired-state",
        googleDesiredPath,
        "--cfctl",
        cfctl,
        "--wrangler",
        wrangler,
        "--out",
        googleOut,
        "--no-resend",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MAILDESK_CFCTL_PROFILE: "profile-example",
          GOOGLE_ADMIN_BIN: googleAdmin,
          MAILDESK_TEST_CFCTL_LOG: cfctlLog,
          MAILDESK_TEST_POLICY_OBJECT: policyObject,
        },
      },
    );
    expect(googleCollection.status).toBe(0);
    const googleCalls = readFileSync(cfctlLog, "utf8");
    expect(googleCalls).not.toContain("email-routing-routing-rules-list-routing-rules");
    expect(googleCalls).not.toContain("email-routing-settings-get-email-routing-settings");
    expect(googleCalls).not.toContain("email-routing-routing-rules-get-catch-all-rule");
    const googleEvidence = JSON.parse(readFileSync(googleOut, "utf8")) as {
      cfctl_readback?: { transaction_complete: boolean; complete: boolean };
      cfctl_maildesk?: {
        domains?: Record<string, { email_routing?: string; catch_all?: string }>;
      };
    };
    expect(googleEvidence.cfctl_readback).toMatchObject({ transaction_complete: true, complete: false });
    expect(googleEvidence.cfctl_maildesk?.domains?.["example.com"]).toMatchObject({
      email_routing: "not_applicable",
      catch_all: "not_applicable",
    });
    const googleEvidenceText = readFileSync(googleOut, "utf8");
    expect(googleEvidenceText).not.toContain("operator-a@example.com");
    expect(googleEvidenceText).not.toContain("operator-b@example.com");
    const googleProof = (JSON.parse(googleEvidenceText) as {
      inbound_proofs?: Record<string, { operator_count?: number; operator_set_sha256?: string }>;
    }).inbound_proofs?.["example.com"];
    expect(googleProof).toMatchObject({
      operator_count: 2,
      operator_set_sha256: createHash("sha256")
        .update(JSON.stringify(["operator-a@example.com", "operator-b@example.com"]))
        .digest("hex"),
    });

    const googleVerification = spawnSync(
      "bun",
      [
        "run",
        "scripts/verify-maildesk.ts",
        "--",
        "--policy",
        googlePolicyPath,
        "--desired-state",
        googleDesiredPath,
        "--evidence",
        googleOut,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(googleVerification.status).toBe(0);
    expect(googleVerification.stdout).not.toContain("operator-a@example.com");
    expect(googleVerification.stdout).not.toContain("operator-b@example.com");
    const googleReceipt = JSON.parse(googleVerification.stdout) as {
      status: { edge_ready: boolean };
      rows: Array<{
        inbound_mx: string;
        role_aliases_wired: string;
        personal_aliases_wired: string;
        catch_all_wired: string;
      }>;
    };
    expect(googleReceipt.rows[0]).toMatchObject({
      inbound_mx: "ok",
      role_aliases_wired: "not_checked",
      personal_aliases_wired: "not_checked",
      catch_all_wired: "not_applicable",
    });
    expect(googleReceipt.status.edge_ready).toBe(false);

    const mismatchedGoogleOut = join(dir, "google-evidence-mismatch.json");
    const mismatchedGoogleEvidence = JSON.parse(googleEvidenceText) as {
      inbound_proofs: Record<string, { operator_set_sha256: string }>;
    };
    mismatchedGoogleEvidence.inbound_proofs["example.com"]!.operator_set_sha256 = "0".repeat(64);
    writeJson(mismatchedGoogleOut, mismatchedGoogleEvidence);
    const mismatchedGoogleVerification = spawnSync(
      "bun",
      [
        "run",
        "scripts/verify-maildesk.ts",
        "--",
        "--policy",
        googlePolicyPath,
        "--desired-state",
        googleDesiredPath,
        "--evidence",
        mismatchedGoogleOut,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(mismatchedGoogleVerification.status).toBe(0);
    expect(JSON.parse(mismatchedGoogleVerification.stdout).rows[0]?.inbound_proof).toBe("drift");
  }, 15_000);

  test("a two-domain canary transaction stays partial against fourteen desired domains", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-coverage-canary-"));
    const fixture = createCoverageFixture(dir);
    const desired = JSON.parse(readFileSync(fixture.desiredPath, "utf8")) as Record<string, unknown>;
    const senderCandidateDomains = fixture.domains.slice(0, 4);
    desired.sender = {
      mode: "cloudflare_email_service",
      candidate_domains: senderCandidateDomains,
    };
    writeJson(fixture.desiredPath, desired);
    const { result, out, log } = runCoverageCollection(fixture, dir, { canary: true });

    expect(result.status).toBe(0);
    const evidence = JSON.parse(readFileSync(out, "utf8")) as {
      cfctl_readback: {
        transaction_complete: boolean;
        complete: boolean;
        coverage: {
          mode: string;
          profile: string;
          expected_domain_count: number;
          selected_domain_count: number;
          observed_domain_count: number;
          selected_scope_complete: boolean;
          desired_scope_complete: boolean;
          acceptance_complete: boolean;
        };
      };
      cfctl_maildesk: {
        edge_ready: boolean;
        domains: Record<string, { email_routing: string; catch_all: string }>;
        sender_domains?: Record<string, string>;
      };
      zones?: string[];
      email_routing?: Record<string, unknown>;
      dns_mx?: Record<string, unknown>;
      sender_domains?: Record<string, string>;
      inbound_proofs?: Record<string, unknown>;
      outbound_proofs?: Record<string, unknown>;
    };
    expect(evidence.cfctl_readback).toMatchObject({
      transaction_complete: true,
      complete: false,
      coverage: {
        mode: "canary",
        profile: "inventory_v1",
        expected_domain_count: 14,
        selected_domain_count: 2,
        observed_domain_count: 2,
        selected_scope_complete: true,
        desired_scope_complete: false,
        acceptance_complete: false,
      },
    });
    expect(evidence.cfctl_maildesk.edge_ready).toBe(false);
    const selectedDomains = fixture.domains.slice(0, 2);
    expect(evidence.zones).toEqual(selectedDomains);
    expect(Object.keys(evidence.email_routing ?? {})).toEqual(selectedDomains);
    expect(Object.keys(evidence.dns_mx ?? {})).toEqual(selectedDomains);
    expect(Object.keys(evidence.cfctl_maildesk.domains)).toEqual(selectedDomains);
    expect(Object.keys(evidence.cfctl_maildesk.sender_domains ?? {})).toEqual(
      senderCandidateDomains.filter((domain) => selectedDomains.includes(domain)),
    );
    const domainMaps = [
      evidence.email_routing ?? {},
      evidence.dns_mx ?? {},
      evidence.cfctl_maildesk.domains,
      evidence.cfctl_maildesk.sender_domains ?? {},
      evidence.sender_domains ?? {},
      evidence.inbound_proofs ?? {},
      evidence.outbound_proofs ?? {},
    ];
    for (const domain of fixture.domains.slice(2)) {
      expect(evidence.zones).not.toContain(domain);
      for (const domainMap of domainMaps) expect(domainMap[domain]).toBeUndefined();
    }
    for (const domain of senderCandidateDomains.filter((domain) => !selectedDomains.includes(domain))) {
      expect(evidence.cfctl_maildesk.sender_domains?.[domain]).toBeUndefined();
    }
    const zoneCalls = readFileSync(log, "utf8").split("\n")
      .filter((line) => line.includes("call zones-get"));
    expect(zoneCalls).toHaveLength(2);
    expect(statSync(out).mode & 0o777).toBe(0o600);

    const verification = spawnSync(
      "bun",
      [
        "run",
        "scripts/verify-maildesk.ts",
        "--",
        "--policy",
        fixture.policyPath,
        "--desired-state",
        fixture.desiredPath,
        "--evidence",
        out,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(verification.status).toBe(0);
    const receipt = JSON.parse(verification.stdout) as {
      status: { live_evidence_present: boolean; edge_ready: boolean };
      gaps: Array<{ domain: string; readiness: string }>;
      rows: Array<{ domain: string; zone_held: string; role_aliases_wired: string }>;
    };
    expect(receipt.status).toMatchObject({ live_evidence_present: true, edge_ready: false });
    expect(receipt.gaps
      .filter((gap) => gap.readiness !== "local")
      .every((gap) => fixture.domains.slice(0, 2).includes(gap.domain))).toBe(true);
    for (const row of receipt.rows.filter((row) => fixture.domains.slice(2).includes(row.domain))) {
      expect(row.zone_held).toBe("not_checked");
      expect(row.role_aliases_wired).toBe("not_checked");
    }
  }, 20_000);

  test("canary scope excludes unselected Google Workspace and D1 proof domains", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-coverage-provider-scope-"));
    const fixture = createCoverageFixture(dir);
    const desired = JSON.parse(readFileSync(fixture.desiredPath, "utf8")) as {
      domains: Array<{ name: string; inbound_mx_provider: string }>;
    };
    desired.domains[0]!.inbound_mx_provider = "google_workspace";
    desired.domains[2]!.inbound_mx_provider = "google_workspace";
    writeJson(fixture.desiredPath, desired);

    const cfctl = join(dir, "cfctl-provider-scope");
    const wrangler = join(dir, "wrangler-provider-scope");
    const googleAdmin = join(dir, "google-admin-provider-scope");
    const cfctlLog = join(dir, "cfctl-provider-scope.log");
    const providerLog = join(dir, "provider-scope.log");
    const out = join(dir, "provider-scope.json");
    writeCoverageCfctl(cfctl);
    writeFileSync(
      wrangler,
      `#!/bin/sh
echo "$*" >> "$MAILDESK_TEST_PROVIDER_LOG"
case "$*" in
  *"last_inbound_provider_accepted_at"*) echo '${JSON.stringify([{ results: [
    {
      route_address: `inbox@${fixture.domains[0]}`,
      route_kind: "role_alias",
      operator_count: 1,
      reply_identity: `inbox@${fixture.domains[0]}`,
      policy_sha256: "a".repeat(64),
      last_inbound_provider_accepted_at: "2026-08-18T00:00:00.000Z",
      last_inbound_provider_message_ids_json: '["selected-inbound"]',
      last_inbox_verified_at: "2026-08-18T00:01:00.000Z",
    },
    {
      route_address: `inbox@${fixture.domains[2]}`,
      route_kind: "role_alias",
      operator_count: 1,
      reply_identity: `inbox@${fixture.domains[2]}`,
      policy_sha256: "a".repeat(64),
      last_inbound_provider_accepted_at: "2026-08-18T00:00:00.000Z",
      last_inbound_provider_message_ids_json: '["unselected-inbound"]',
      last_inbox_verified_at: "2026-08-18T00:01:00.000Z",
    },
  ] }])}' ;;
  *"outbound_reply_delivered"*) echo '${JSON.stringify([{ results: [
    {
      detail_json: JSON.stringify({
        fromIdentity: `inbox@${fixture.domains[0]}`,
        result: { provider: "cloudflare_email_service", providerMessageId: "selected-outbound" },
      }),
      created_at: "2026-08-18T00:02:00.000Z",
    },
    {
      detail_json: JSON.stringify({
        fromIdentity: `inbox@${fixture.domains[2]}`,
        result: { provider: "cloudflare_email_service", providerMessageId: "unselected-outbound" },
      }),
      created_at: "2026-08-18T00:02:00.000Z",
    },
  ] }])}' ;;
  *) echo '[{"results":[]}]' ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(
      googleAdmin,
      `#!/bin/sh
echo "$*" >> "$MAILDESK_TEST_PROVIDER_LOG"
target="$4"
echo "{\"snapshot_captured_at\":\"2026-08-18T00:03:00.000Z\",\"resources\":[{\"id\":\"workspace:group:$target\",\"type\":\"workspace.group\"},{\"type\":\"workspace.group_membership\",\"record\":{\"email\":\"operator@example.com\"}}]}"
`,
      { mode: 0o755 },
    );
    chmodSync(wrangler, 0o755);
    chmodSync(googleAdmin, 0o755);

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/collect-live-evidence.ts",
        "--",
        "--policy",
        fixture.policyPath,
        "--desired-state",
        fixture.desiredPath,
        "--scope-manifest",
        fixture.scopeManifestPath,
        "--cfctl",
        cfctl,
        "--wrangler",
        wrangler,
        "--google-admin",
        googleAdmin,
        "--out",
        out,
        "--no-resend",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MAILDESK_CFCTL_PROFILE: "profile-example",
          MAILDESK_TEST_CFCTL_LOG: cfctlLog,
          MAILDESK_TEST_PROVIDER_LOG: providerLog,
        },
      },
    );

    expect(result.status).toBe(0);
    const providerCalls = readFileSync(providerLog, "utf8");
    expect(providerCalls).toContain(fixture.domains[0]!);
    expect(providerCalls).toContain(fixture.domains[1]!);
    expect(providerCalls).not.toContain(fixture.domains[2]!);
    const evidence = JSON.parse(readFileSync(out, "utf8")) as {
      inbound_proofs?: Record<string, unknown>;
      outbound_proofs?: Record<string, unknown>;
    };
    expect(Object.keys(evidence.inbound_proofs ?? {})).toEqual([fixture.domains[0]!]);
    expect(Object.keys(evidence.outbound_proofs ?? {})).toEqual([fixture.domains[0]!]);
  }, 20_000);

  test("canary scope rejects Resend's account-global domain listing before execution", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-coverage-resend-scope-"));
    const fixture = createCoverageFixture(dir);
    const desired = JSON.parse(readFileSync(fixture.desiredPath, "utf8")) as Record<string, unknown>;
    desired.sender = { mode: "resend", candidate_domains: fixture.domains.slice(0, 2) };
    writeJson(fixture.desiredPath, desired);
    const resend = join(dir, "resend");
    const resendLog = join(dir, "resend.log");
    writeFileSync(resend, `#!/bin/sh\necho "$*" >> "$MAILDESK_TEST_RESEND_LOG"\n`, { mode: 0o755 });
    chmodSync(resend, 0o755);

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/collect-live-evidence.ts",
        "--",
        "--policy",
        fixture.policyPath,
        "--desired-state",
        fixture.desiredPath,
        "--scope-manifest",
        fixture.scopeManifestPath,
        "--wrangler",
        "/bin/false",
        "--out",
        join(dir, "resend-scope.json"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          MAILDESK_TEST_RESEND_LOG: resendLog,
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Resend domain listing is account-global");
    expect(() => readFileSync(resendLog, "utf8")).toThrow();
  });

  test("a second selected-zone denial preserves the bound failure without completing the transaction", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-coverage-denial-"));
    const fixture = createCoverageFixture(dir);
    const { result, out } = runCoverageCollection(fixture, dir, {
      denyDomain: fixture.domains[1],
    });

    expect(result.status).toBe(1);
    const evidence = JSON.parse(readFileSync(out, "utf8")) as {
      cfctl_readback: {
        transaction_complete: boolean;
        complete: boolean;
        coverage: {
          selected_scope_complete: boolean;
          successful_capability_ids: string[];
          failed_capability_ids: string[];
          missing_capability_ids: string[];
        };
        receipts: Array<{ capability_id: string; error_code?: string; performed: boolean }>;
      };
    };
    expect(evidence.cfctl_readback).toMatchObject({
      transaction_complete: false,
      complete: false,
      coverage: {
        selected_scope_complete: false,
        failed_capability_ids: ["email-routing-routing-rules-list-routing-rules"],
      },
    });
    expect(evidence.cfctl_readback.receipts).toContainEqual(expect.objectContaining({
      capability_id: "email-routing-routing-rules-list-routing-rules",
      performed: true,
      error_code: "CFCTL_LIVE_UNAUTHORIZED",
    }));
    const coverage = evidence.cfctl_readback.coverage;
    expect(coverage.successful_capability_ids).not.toContain(
      "email-routing-routing-rules-list-routing-rules",
    );
    expect(new Set([
      ...coverage.successful_capability_ids,
      ...coverage.failed_capability_ids,
      ...coverage.missing_capability_ids,
    ]).size).toBe(
      coverage.successful_capability_ids.length +
        coverage.failed_capability_ids.length +
        coverage.missing_capability_ids.length,
    );
  }, 20_000);

  test("full inventory completion remains below dark acceptance", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-coverage-full-"));
    const fixture = createCoverageFixture(dir);
    const { result, out, log } = runCoverageCollection(fixture, dir);

    expect(result.status).toBe(0);
    const evidence = JSON.parse(readFileSync(out, "utf8")) as {
      cfctl_readback: {
        transaction_complete: boolean;
        complete: boolean;
        coverage: {
          mode: string;
          profile: string;
          expected_domain_count: number;
          selected_domain_count: number;
          observed_domain_count: number;
          selected_scope_complete: boolean;
          desired_scope_complete: boolean;
          acceptance_complete: boolean;
        };
      };
    };
    expect(evidence.cfctl_readback).toMatchObject({
      transaction_complete: true,
      complete: false,
      coverage: {
        mode: "full_desired_state",
        profile: "inventory_v1",
        expected_domain_count: 14,
        selected_domain_count: 14,
        observed_domain_count: 14,
        selected_scope_complete: true,
        desired_scope_complete: true,
        acceptance_complete: false,
      },
    });
    expect(readFileSync(log, "utf8").split("\n")
      .filter((line) => line.includes("call zones-get"))).toHaveLength(14);

    const verification = spawnSync(
      "bun",
      [
        "run",
        "scripts/verify-maildesk.ts",
        "--",
        "--policy",
        fixture.policyPath,
        "--desired-state",
        fixture.desiredPath,
        "--evidence",
        out,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(verification.status).toBe(0);
    expect(JSON.parse(verification.stdout).status).toMatchObject({
      live_evidence_present: true,
      edge_ready: false,
      mail_ready: false,
    });
  }, 20_000);

  test("dark acceptance names every unsupported capability and surface as a typed blocker", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-coverage-dark-"));
    const fixture = createCoverageFixture(dir);
    const { result, out } = runCoverageCollection(fixture, dir, {
      profile: "dark_acceptance_v1",
    });

    expect(result.status).toBe(0);
    const evidence = JSON.parse(readFileSync(out, "utf8")) as {
      cfctl_readback: {
        transaction_complete: boolean;
        complete: boolean;
        coverage: {
          profile: string;
          observed_domain_count: number;
          desired_scope_complete: boolean;
          acceptance_complete: boolean;
          missing_capability_ids: string[];
          missing_acceptance_surfaces: string[];
          blockers: Array<{ code: string; capability_id?: string; surface?: string }>;
        };
      };
    };
    expect(evidence.cfctl_readback).toMatchObject({
      transaction_complete: true,
      complete: false,
      coverage: {
        profile: "dark_acceptance_v1",
        observed_domain_count: 14,
        desired_scope_complete: false,
        acceptance_complete: false,
      },
    });
    expect(evidence.cfctl_readback.coverage.missing_capability_ids).toEqual([
      "access-applications-get-an-access-application",
      "access-policies-get-an-access-policy",
      "access-policies-list-access-app-policies",
      "r2-get-bucket-lifecycle-configuration",
    ]);
    expect(evidence.cfctl_readback.coverage.missing_acceptance_surfaces).toEqual([
      "access_application",
      "access_policies",
      "r2_spool_lifecycle",
      "worker_deployment_identity",
      "worker_route_identity",
      "queue_backlog",
      "dead_letter_queue_backlog",
      "spool_emptiness",
      "readiness_endpoint",
    ]);
    expect(evidence.cfctl_readback.coverage.blockers).toEqual(expect.arrayContaining([
      {
        code: "ACCEPTANCE_SURFACE_UNIMPLEMENTED",
        capability_id: "access-applications-get-an-access-application",
      },
      {
        code: "ACCEPTANCE_SURFACE_UNIMPLEMENTED",
        capability_id: "access-policies-get-an-access-policy",
      },
      {
        code: "ACCEPTANCE_SURFACE_UNIMPLEMENTED",
        surface: "readiness_endpoint",
      },
    ]));
  }, 20_000);

  test("a nonzero governed readback preserves its bound failure envelope", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-collect-evidence-failed-"));
    const cfctl = join(dir, "cfctl");
    const wrangler = join(dir, "wrangler");
    const out = join(dir, "evidence.json");

    writeFileSync(
      cfctl,
      `#!/bin/sh
case "$*" in
  "auth profiles --json") echo '{"schema_version":2,"ok":true,"performed":false,"result":{"current":null,"profiles":[{"id":"profile-example","account_id":"account-example","kind":"api_token"}]},"error":null}' ;;
  *"call zones-get"*) echo '{"schema_version":2,"ok":false,"performed":true,"capability_id":"zones-get","profile_id":"profile-example","account_id":"account-example","verification":{"state":"failed"},"evidence":[],"result":null,"error":{"code":"CFCTL_LIVE_UNAUTHORIZED"}}' >&2; exit 1 ;;
  *) echo '{"schema_version":2,"ok":false,"performed":false,"error":{"code":"UNEXPECTED_CALL"}}' ;;
esac
`,
      { mode: 0o755 },
    );
    chmodSync(cfctl, 0o755);
    writeFileSync(wrangler, "#!/bin/sh\necho '[]'\n", { mode: 0o755 });
    chmodSync(wrangler, 0o755);

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/collect-live-evidence.ts",
        "--",
        "--policy",
        "config/policy.example.json",
        "--desired-state",
        "config/desired-state.example.json",
        "--cfctl",
        cfctl,
        "--wrangler",
        wrangler,
        "--out",
        out,
        "--no-resend",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, MAILDESK_CFCTL_PROFILE: "profile-example" },
      },
    );

    expect(result.status).toBe(1);
    const evidence = JSON.parse(readFileSync(out, "utf8")) as {
      zones?: string[];
      cfctl_readback?: {
        complete: boolean;
        receipts: Array<{ capability_id: string; ok: boolean; performed: boolean; error_code?: string }>;
      };
    };
    expect(evidence.zones).toBeUndefined();
    expect(evidence.cfctl_readback?.complete).toBe(false);
    expect(evidence.cfctl_readback?.receipts).toContainEqual({
      capability_id: "zones-get",
      ok: false,
      performed: true,
      verification_state: "failed",
      evidence_hashes: [],
      error_code: "CFCTL_LIVE_UNAUTHORIZED",
    });

    const unboundOut = join(dir, "unbound-evidence.json");
    writeFileSync(
      cfctl,
      `#!/bin/sh
case "$*" in
  "auth profiles --json") echo '{"schema_version":2,"ok":true,"performed":false,"result":{"current":null,"profiles":[{"id":"profile-example","account_id":"account-example","kind":"api_token"}]},"error":null}' ;;
  *"call zones-get"*) echo '{"schema_version":2,"ok":false,"performed":true,"capability_id":"zones-get","profile_id":"other-profile","account_id":"account-example","verification":{"state":"failed"},"evidence":[],"result":null,"error":{"code":"CFCTL_LIVE_UNAUTHORIZED"}}' >&2; exit 1 ;;
  *) echo '{"schema_version":2,"ok":false,"performed":false,"error":{"code":"UNEXPECTED_CALL"}}' ;;
esac
`,
      { mode: 0o755 },
    );
    chmodSync(cfctl, 0o755);
    const unboundResult = spawnSync(
      "bun",
      [
        "run",
        "scripts/collect-live-evidence.ts",
        "--",
        "--policy",
        "config/policy.example.json",
        "--desired-state",
        "config/desired-state.example.json",
        "--cfctl",
        cfctl,
        "--wrangler",
        wrangler,
        "--out",
        unboundOut,
        "--no-resend",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, MAILDESK_CFCTL_PROFILE: "profile-example" },
      },
    );

    expect(unboundResult.status).toBe(1);
    const unboundEvidence = JSON.parse(readFileSync(unboundOut, "utf8")) as {
      cfctl_readback?: {
        receipts: Array<{ performed: boolean; error_code?: string }>;
      };
    };
    expect(unboundEvidence.cfctl_readback?.receipts.at(-1)).toMatchObject({
      performed: false,
      error_code: "CFCTL_ENVELOPE_BINDING_MISMATCH",
    });
  });

  test("an incomplete Email Routing projection is rejected as malformed evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-collect-evidence-paginated-"));
    const cfctl = join(dir, "cfctl");
    const wrangler = join(dir, "wrangler");
    const out = join(dir, "evidence.json");

    writeFileSync(
      cfctl,
      `#!/bin/sh
case "$*" in
  "auth profiles --json") echo '{"schema_version":2,"ok":true,"performed":false,"result":{"current":null,"profiles":[{"id":"profile-example","account_id":"account-example","kind":"api_token"}]},"error":null}' ;;
  *"call zones-get"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"zones-get","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"a".repeat(64)}"}],"result":{"result":[{"id":"zone-example","name":"example.com","status":"active"}],"result_info":{"page":1,"per_page":5,"total_pages":1,"total_count":1}},"error":null}' ;;
  *"call email-routing-routing-rules-list-routing-rules"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"email-routing-routing-rules-list-routing-rules","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"b".repeat(64)}"}],"result":{"result":{"schema_version":1,"complete":false,"page_size":50,"pages":1,"rule_count":0,"rules":[]}},"error":null}' ;;
  *) echo '{"schema_version":2,"ok":false,"performed":false,"error":{"code":"UNEXPECTED_CALL"}}' ;;
esac
`,
      { mode: 0o755 },
    );
    chmodSync(cfctl, 0o755);
    writeFileSync(wrangler, "#!/bin/sh\necho '[]'\n", { mode: 0o755 });
    chmodSync(wrangler, 0o755);

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/collect-live-evidence.ts",
        "--",
        "--policy",
        "config/policy.example.json",
        "--desired-state",
        "config/desired-state.example.json",
        "--cfctl",
        cfctl,
        "--wrangler",
        wrangler,
        "--out",
        out,
        "--no-resend",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, MAILDESK_CFCTL_PROFILE: "profile-example" },
      },
    );

    expect(result.status).toBe(1);
    const evidence = JSON.parse(readFileSync(out, "utf8")) as {
      cfctl_readback?: {
        complete: boolean;
        receipts: Array<{
          capability_id: string;
          error_code?: string;
        }>;
      };
    };
    expect(evidence.cfctl_readback?.complete).toBe(false);
    expect(evidence.cfctl_readback?.receipts.at(-1)).toMatchObject({
      capability_id: "email-routing-routing-rules-list-routing-rules",
      error_code: "CFCTL_RESULT_SHAPE_MALFORMED",
    });

    const cursorOut = join(dir, "cursor-evidence.json");
    writeFileSync(
      cfctl,
      readFileSync(cfctl, "utf8"),
      { mode: 0o755 },
    );
    const cursorResult = spawnSync(
      "bun",
      [
        "run",
        "scripts/collect-live-evidence.ts",
        "--",
        "--policy",
        "config/policy.example.json",
        "--desired-state",
        "config/desired-state.example.json",
        "--cfctl",
        cfctl,
        "--wrangler",
        wrangler,
        "--out",
        cursorOut,
        "--no-resend",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, MAILDESK_CFCTL_PROFILE: "profile-example" },
      },
    );
    expect(cursorResult.status).toBe(1);
    const cursorEvidence = JSON.parse(readFileSync(cursorOut, "utf8")) as {
      cfctl_readback?: { receipts: Array<{ capability_id: string; error_code?: string }> };
    };
    expect(cursorEvidence.cfctl_readback?.receipts.at(-1)).toMatchObject({
      capability_id: "email-routing-routing-rules-list-routing-rules",
      error_code: "CFCTL_RESULT_SHAPE_MALFORMED",
    });
  });

  test("an Email Routing projection cannot exceed its completed page capacity", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-collect-evidence-oversized-page-"));
    const cfctl = join(dir, "cfctl");
    const wrangler = join(dir, "wrangler");
    const out = join(dir, "evidence.json");
    const rules = Array.from({ length: 51 }, (_, index) => ({
      enabled: true,
      matchers: [{
        matcher_type: "literal",
        field: "to",
        value_sha256: `sha256:${index.toString(16).padStart(64, "0")}`,
      }],
      actions: [{ action_type: "worker", worker_targets: ["maildesk-cf-router"], value_count: 1 }],
    }));

    writeFileSync(
      cfctl,
      `#!/bin/sh
case "$*" in
  "auth profiles --json") echo '{"schema_version":2,"ok":true,"performed":false,"result":{"current":null,"profiles":[{"id":"profile-example","account_id":"account-example","kind":"api_token"}]},"error":null}' ;;
  *"call zones-get"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"zones-get","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"a".repeat(64)}"}],"result":{"result":[{"id":"zone-example","name":"example.com","status":"active"}],"result_info":{"page":1,"per_page":5,"total_pages":1,"total_count":1}},"error":null}' ;;
  *"call email-routing-routing-rules-list-routing-rules"*) echo '${JSON.stringify({ schema_version: 2, ok: true, performed: true, capability_id: "email-routing-routing-rules-list-routing-rules", profile_id: "profile-example", account_id: "account-example", verification: { state: "not_applicable" }, evidence: [{ content_hash: `sha256:${"b".repeat(64)}` }], result: { result: { schema_version: 1, complete: true, page_size: 50, pages: 2, rule_count: rules.length, rules } }, error: null })}' ;;
  *) echo '{"schema_version":2,"ok":false,"performed":false,"error":{"code":"UNEXPECTED_CALL"}}' ;;
esac
`,
      { mode: 0o755 },
    );
    chmodSync(cfctl, 0o755);
    writeFileSync(wrangler, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    chmodSync(wrangler, 0o755);

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/collect-live-evidence.ts",
        "--",
        "--policy",
        "config/policy.example.json",
        "--desired-state",
        "config/desired-state.example.json",
        "--cfctl",
        cfctl,
        "--wrangler",
        wrangler,
        "--out",
        out,
        "--no-resend",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, MAILDESK_CFCTL_PROFILE: "profile-example" },
      },
    );

    expect(result.status).toBe(1);
    const receipt = (JSON.parse(readFileSync(out, "utf8")) as {
      cfctl_readback?: { receipts: Array<{ error_code?: string }> };
    }).cfctl_readback?.receipts.at(-1);
    expect(receipt?.error_code).toBe("CFCTL_RESULT_SHAPE_MALFORMED");
  });

  test("schema-v1 profile metadata is rejected before any governed live call", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-collect-evidence-profile-version-"));
    const cfctl = join(dir, "cfctl");
    const cfctlLog = join(dir, "cfctl.log");
    const out = join(dir, "evidence.json");

    writeFileSync(
      cfctl,
      `#!/bin/sh
echo "$@" >> "${cfctlLog}"
case "$*" in
  "auth profiles --json") echo '{"schema_version":1,"ok":true,"performed":false,"result":{"current":null,"profiles":[{"id":"profile-example","account_id":"account-example","kind":"api_token"}]},"error":null}' ;;
  *) echo '{"schema_version":2,"ok":false,"performed":false,"error":{"code":"UNEXPECTED_CALL"}}' ;;
esac
`,
      { mode: 0o755 },
    );
    chmodSync(cfctl, 0o755);

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/collect-live-evidence.ts",
        "--",
        "--policy",
        "config/policy.example.json",
        "--desired-state",
        "config/desired-state.example.json",
        "--cfctl",
        cfctl,
        "--out",
        out,
        "--no-resend",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, MAILDESK_CFCTL_PROFILE: "profile-example" },
      },
    );

    expect(result.status).toBe(1);
    const calls = readFileSync(cfctlLog, "utf8").trim().split("\n");
    expect(calls).toEqual(["auth profiles --json"]);
    const evidence = JSON.parse(readFileSync(out, "utf8")) as {
      cfctl_readback?: { complete: boolean; receipts: Array<{ error_code?: string }> };
    };
    expect(evidence.cfctl_readback?.complete).toBe(false);
    expect(evidence.cfctl_readback?.receipts.at(-1)?.error_code).toBe(
      "CFCTL_ENVELOPE_VERSION_MISMATCH",
    );
  });

  test("a schema-v1 live-call envelope cannot establish complete readback", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-collect-evidence-call-version-"));
    const cfctl = join(dir, "cfctl");
    const out = join(dir, "evidence.json");

    writeFileSync(
      cfctl,
      `#!/bin/sh
case "$*" in
  "auth profiles --json") echo '{"schema_version":2,"ok":true,"performed":false,"result":{"current":null,"profiles":[{"id":"profile-example","account_id":"account-example","kind":"api_token"}]},"error":null}' ;;
  *"call zones-get"*) echo '{"schema_version":1,"ok":true,"performed":true,"capability_id":"zones-get","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"a".repeat(64)}"}],"result":{"result":[{"id":"zone-example","name":"example.com","status":"active"}],"result_info":{"page":1,"per_page":5,"total_pages":1,"total_count":1}},"error":null}' ;;
  *) echo '{"schema_version":2,"ok":false,"performed":false,"error":{"code":"UNEXPECTED_CALL"}}' ;;
esac
`,
      { mode: 0o755 },
    );
    chmodSync(cfctl, 0o755);

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/collect-live-evidence.ts",
        "--",
        "--policy",
        "config/policy.example.json",
        "--desired-state",
        "config/desired-state.example.json",
        "--cfctl",
        cfctl,
        "--out",
        out,
        "--no-resend",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, MAILDESK_CFCTL_PROFILE: "profile-example" },
      },
    );

    expect(result.status).toBe(1);
    const evidence = JSON.parse(readFileSync(out, "utf8")) as {
      cfctl_readback?: { complete: boolean; receipts: Array<{ error_code?: string }> };
    };
    expect(evidence.cfctl_readback?.complete).toBe(false);
    expect(evidence.cfctl_readback?.receipts.at(-1)?.error_code).toBe(
      "CFCTL_ENVELOPE_VERSION_MISMATCH",
    );
  });

  test("a malformed required capability payload cannot be normalized as drift", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-collect-evidence-shape-"));
    const cfctl = join(dir, "cfctl");
    const out = join(dir, "evidence.json");

    writeFileSync(
      cfctl,
      `#!/bin/sh
case "$*" in
  "auth profiles --json") echo '{"schema_version":2,"ok":true,"performed":false,"result":{"current":null,"profiles":[{"id":"profile-example","account_id":"account-example","kind":"api_token"}]},"error":null}' ;;
  *"call zones-get"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"zones-get","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"a".repeat(64)}"}],"result":{"result":[{"id":"zone-example","name":"example.com","status":"active"}],"result_info":{"page":1,"per_page":5,"total_pages":1,"total_count":1}},"error":null}' ;;
  *"call email-routing-routing-rules-list-routing-rules"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"email-routing-routing-rules-list-routing-rules","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"b".repeat(64)}"}],"result":{"result":[{"recipient":"security@example.com","enabled":true,"actions":[{"type":"worker","value":["maildesk-cf-router"]}]}],"result_info":{"page":1,"per_page":50,"total_pages":1,"total_count":1}},"error":null}' ;;
  *"call dns-records-for-a-zone-list-dns-records"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"dns-records-for-a-zone-list-dns-records","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"c".repeat(64)}"}],"result":{"result":[{"type":"MX","name":"example.com","content":"route1.mx.cloudflare.net"}],"result_info":{"page":1,"per_page":100,"total_pages":1,"total_count":1}},"error":null}' ;;
  *"call email-routing-settings-get-email-routing-settings"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"email-routing-settings-get-email-routing-settings","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"d".repeat(64)}"}],"result":{"result":{"unexpected":true}},"error":null}' ;;
  *) echo '{"schema_version":2,"ok":false,"performed":false,"error":{"code":"UNEXPECTED_CALL"}}' ;;
esac
`,
      { mode: 0o755 },
    );
    chmodSync(cfctl, 0o755);

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/collect-live-evidence.ts",
        "--",
        "--policy",
        "config/policy.example.json",
        "--desired-state",
        "config/desired-state.example.json",
        "--cfctl",
        cfctl,
        "--out",
        out,
        "--no-resend",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, MAILDESK_CFCTL_PROFILE: "profile-example" },
      },
    );

    expect(result.status).toBe(1);
    const evidence = JSON.parse(readFileSync(out, "utf8")) as {
      zones?: string[];
      email_routing?: unknown;
      dns_mx?: unknown;
      cfctl_maildesk?: unknown;
      cfctl_readback?: { complete: boolean; receipts: Array<{ error_code?: string }> };
    };
    expect(evidence.cfctl_readback?.complete).toBe(false);
    expect(evidence.cfctl_readback?.receipts.at(-1)?.error_code).toBe(
      "CFCTL_RESULT_SHAPE_MALFORMED",
    );
    expect(evidence.zones).toBeUndefined();
    expect(evidence.email_routing).toBeUndefined();
    expect(evidence.dns_mx).toBeUndefined();
    expect(evidence.cfctl_maildesk).toBeUndefined();
  });

  test("a disabled required catch-all remains a completed read but fails edge readiness", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-collect-evidence-catch-all-"));
    const cfctl = join(dir, "cfctl");
    const out = join(dir, "evidence.json");

    writeFileSync(
      cfctl,
      `#!/bin/sh
case "$*" in
  "auth profiles --json") echo '{"schema_version":2,"ok":true,"performed":false,"result":{"current":null,"profiles":[{"id":"profile-example","account_id":"account-example","kind":"api_token"}]},"error":null}' ;;
  *"call zones-get"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"zones-get","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"a".repeat(64)}"}],"result":{"result":[{"id":"zone-example","name":"example.com","status":"active"}],"result_info":{"page":1,"per_page":5,"total_pages":1,"total_count":1}},"error":null}' ;;
  *"call email-routing-routing-rules-list-routing-rules"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"email-routing-routing-rules-list-routing-rules","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"b".repeat(64)}"}],"result":{"result":[{"recipient":"security@example.com","enabled":true,"actions":[{"type":"worker","value":["maildesk-cf-router"]}]}],"result_info":{"page":1,"per_page":50,"total_pages":1,"total_count":1}},"error":null}' ;;
  *"call dns-records-for-a-zone-list-dns-records"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"dns-records-for-a-zone-list-dns-records","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"c".repeat(64)}"}],"result":{"result":[{"type":"MX","name":"example.com","content":"route1.mx.cloudflare.net"}],"result_info":{"page":1,"per_page":100,"total_pages":1,"total_count":1}},"error":null}' ;;
  *"call email-routing-settings-get-email-routing-settings"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"email-routing-settings-get-email-routing-settings","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"d".repeat(64)}"}],"result":{"result":{"enabled":true}},"error":null}' ;;
  *"call email-routing-routing-rules-get-catch-all-rule"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"email-routing-routing-rules-get-catch-all-rule","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"7".repeat(64)}"}],"result":{"result":{"enabled":false,"actions":[]}},"error":null}' ;;
  *) echo '{"schema_version":2,"ok":false,"performed":false,"error":{"code":"STOP_AFTER_CATCH_ALL"}}' ;;
esac
`,
      { mode: 0o755 },
    );
    chmodSync(cfctl, 0o755);

    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/collect-live-evidence.ts",
        "--",
        "--policy",
        "config/policy.example.json",
        "--desired-state",
        "config/desired-state.example.json",
        "--cfctl",
        cfctl,
        "--out",
        out,
        "--no-resend",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, MAILDESK_CFCTL_PROFILE: "profile-example" },
      },
    );

    expect(result.status).toBe(1);
    const evidence = JSON.parse(readFileSync(out, "utf8")) as {
      cfctl_readback?: { complete: boolean };
      cfctl_maildesk?: { domains?: Record<string, { catch_all?: string }> };
    };
    expect(evidence.cfctl_readback?.complete).toBe(false);
    expect(evidence.cfctl_maildesk).toBeUndefined();
  });

  test("the public template does not invoke cfctl without an explicit profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "maildesk-collect-evidence-no-profile-"));
    const cfctl = join(dir, "cfctl");
    const wrangler = join(dir, "wrangler");
    const cfctlLog = join(dir, "cfctl.log");
    const out = join(dir, "evidence.json");

    writeFileSync(cfctl, `#!/bin/sh\necho "$@" >> "${cfctlLog}"\nexit 99\n`, { mode: 0o755 });
    chmodSync(cfctl, 0o755);
    writeFileSync(wrangler, "#!/bin/sh\necho '[]'\n", { mode: 0o755 });
    chmodSync(wrangler, 0o755);

    const env = { ...process.env };
    delete env.MAILDESK_CFCTL_PROFILE;
    const result = spawnSync(
      "bun",
      [
        "run",
        "scripts/collect-live-evidence.ts",
        "--",
        "--policy",
        "config/policy.example.json",
        "--desired-state",
        "config/desired-state.example.json",
        "--cfctl",
        cfctl,
        "--wrangler",
        wrangler,
        "--out",
        out,
        "--no-resend",
      ],
      { cwd: root, encoding: "utf8", env },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(out, "utf8")).not.toContain("profile-example");
    const evidence = JSON.parse(readFileSync(out, "utf8")) as {
      cfctl_readback?: {
        required: boolean;
        attempted: boolean;
        transaction_complete: boolean;
        complete: boolean;
        receipts: unknown[];
      };
    };
    expect(evidence.cfctl_readback).toMatchObject({
      required: false,
      attempted: false,
      transaction_complete: false,
      complete: false,
      receipts: [],
    });
    expect((evidence as { d1?: unknown }).d1).toBeUndefined();
    expect(() => readFileSync(cfctlLog, "utf8")).toThrow();

    const verification = spawnSync(
      "bun",
      [
        "run",
        "scripts/verify-maildesk.ts",
        "--",
        "--policy",
        "config/policy.example.json",
        "--desired-state",
        "config/desired-state.example.json",
        "--evidence",
        out,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(verification.status).toBe(0);
    expect(JSON.parse(verification.stdout).status).toMatchObject({
      live_evidence_present: false,
      edge_ready: false,
      mail_ready: false,
    });

    const populatedOut = join(dir, "populated-evidence.json");
    writeFileSync(
      wrangler,
      `#!/bin/sh
echo '[{"results":[{"name":"runtime_state"}]}]'
`,
      { mode: 0o755 },
    );
    const populatedCollection = spawnSync(
      "bun",
      [
        "run",
        "scripts/collect-live-evidence.ts",
        "--",
        "--policy",
        "config/policy.example.json",
        "--desired-state",
        "config/desired-state.example.json",
        "--cfctl",
        cfctl,
        "--wrangler",
        wrangler,
        "--out",
        populatedOut,
        "--no-resend",
      ],
      { cwd: root, encoding: "utf8", env },
    );
    expect(populatedCollection.status).toBe(0);
    const populatedVerification = spawnSync(
      "bun",
      [
        "run",
        "scripts/verify-maildesk.ts",
        "--",
        "--policy",
        "config/policy.example.json",
        "--desired-state",
        "config/desired-state.example.json",
        "--evidence",
        populatedOut,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(populatedVerification.status).toBe(0);
    expect(JSON.parse(populatedVerification.stdout).status.live_evidence_present).toBe(true);
  });
});

function projectionSummary(policyPath: string, desiredPath: string) {
  const result = spawnSync(
    "bun",
    ["run", "scripts/sync-route-policy.ts", "--", "--policy", policyPath, "--desired-state", desiredPath],
    { cwd: root, encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as {
    desired_state_sha256: string;
    projection_sha256: string;
  };
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createCoverageFixture(dir: string) {
  const domains = Array.from({ length: 14 }, (_, index) =>
    `zone${String(index + 1).padStart(2, "0")}.example.com`
  );
  const desiredPath = join(dir, "desired-state.json");
  const policyPath = join(dir, "policy.json");
  const scopeManifestPath = join(dir, "scope-manifest.json");
  const desired = JSON.parse(
    readFileSync(resolve(root, "config/desired-state.example.json"), "utf8"),
  ) as Record<string, unknown>;
  desired.domains = domains.map((name) => ({
    name,
    role_aliases: ["inbox"],
    personal_aliases: [],
    catch_all: false,
    inbound_mx_provider: "cloudflare_email_routing",
  }));
  desired.sender = { mode: "disabled", candidate_domains: [] };
  writeJson(desiredPath, desired);
  writeJson(policyPath, {
    domains: Object.fromEntries(domains.map((domain) => [domain, {
      role_aliases: {
        inbox: {
          operators: ["operator@example.com"],
          reply_identity: `inbox@${domain}`,
          allowed_reply_identities: [`inbox@${domain}`],
        },
      },
      personal_aliases: {},
    }])),
  });
  writeJson(scopeManifestPath, {
    schema_version: 1,
    mode: "canary",
    profile: "inventory_v1",
    domains: domains.slice(0, 2),
  });
  return { domains, desiredPath, policyPath, scopeManifestPath };
}

function writeCoverageCfctl(path: string) {
  writeFileSync(
    path,
    `#!/bin/sh
echo "$@" >> "$MAILDESK_TEST_CFCTL_LOG"
domain=""
for argument in "$@"; do
  case "$argument" in
    name=*) domain="\${argument#name=}" ;;
    zone_id=zone-*) domain="\${argument#zone_id=zone-}" ;;
  esac
done
case "$*" in
  "auth profiles --json") echo '{"schema_version":2,"ok":true,"performed":false,"result":{"current":null,"profiles":[{"id":"profile-example","account_id":"account-example","kind":"api_token"}]},"error":null}' ;;
  *"call zones-get"*) printf '{"schema_version":2,"ok":true,"performed":true,"capability_id":"zones-get","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"a".repeat(64)}"}],"result":{"result":[{"id":"zone-%s","name":"%s","status":"active"}],"result_info":{"page":1,"per_page":5,"total_pages":1,"total_count":1}},"error":null}\n' "$domain" "$domain" ;;
  *"call email-routing-routing-rules-list-routing-rules"*)
    if [ -n "$MAILDESK_TEST_DENY_DOMAIN" ] && [ "$domain" = "$MAILDESK_TEST_DENY_DOMAIN" ]; then
      echo '{"schema_version":2,"ok":false,"performed":true,"capability_id":"email-routing-routing-rules-list-routing-rules","profile_id":"profile-example","account_id":"account-example","verification":{"state":"failed"},"evidence":[],"result":null,"error":{"code":"CFCTL_LIVE_UNAUTHORIZED"}}' >&2
      exit 1
    fi
    echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"email-routing-routing-rules-list-routing-rules","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"b".repeat(64)}"}],"result":{"result":{"schema_version":1,"complete":true,"page_size":50,"pages":1,"rule_count":0,"rules":[]}},"error":null}' ;;
  *"call dns-records-for-a-zone-list-dns-records"*) printf '{"schema_version":2,"ok":true,"performed":true,"capability_id":"dns-records-for-a-zone-list-dns-records","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"c".repeat(64)}"}],"result":{"result":[{"type":"MX","name":"%s","content":"route1.mx.cloudflare.net"},{"type":"MX","name":"%s","content":"route2.mx.cloudflare.net"},{"type":"MX","name":"%s","content":"route3.mx.cloudflare.net"}],"result_info":{"page":1,"per_page":100,"total_pages":1,"total_count":3}},"error":null}\n' "$domain" "$domain" "$domain" ;;
  *"call email-routing-settings-get-email-routing-settings"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"email-routing-settings-get-email-routing-settings","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"d".repeat(64)}"}],"result":{"result":{"enabled":true}},"error":null}' ;;
  *"call email-routing-routing-rules-get-catch-all-rule"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"email-routing-routing-rules-get-catch-all-rule","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"7".repeat(64)}"}],"result":{"result":{"enabled":false,"actions":[]}},"error":null}' ;;
  *"call email-sending-subdomains-list-sending-subdomains"*) printf '{"schema_version":2,"ok":true,"performed":true,"capability_id":"email-sending-subdomains-list-sending-subdomains","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"8".repeat(64)}"}],"result":{"result":[{"name":"%s","status":"verified"}]},"error":null}\n' "$domain" ;;
  *"call listWorkers"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"listWorkers","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"e".repeat(64)}"}],"result":{"result":[{"name":"maildesk-cf-router"},{"name":"maildesk-cf-relay-outbound"},{"name":"maildesk-cf-routing-health"}],"result_info":{"page":1,"per_page":100,"total_pages":1,"total_count":3}},"error":null}' ;;
  *"call worker-script-get-settings"*"script_name=maildesk-cf-router"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"worker-script-get-settings","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"3".repeat(64)}"}],"result":{"result":{"bindings":[{"name":"EMAIL","type":"send_email"},{"name":"DB","type":"d1","id":"d1-example"},{"name":"POLICY_STORE","type":"r2_bucket","bucket_name":"maildesk-cf-policy"},{"name":"RELAY_SPOOL","type":"r2_bucket","bucket_name":"maildesk-cf-relay-spool"},{"name":"MAIL_JOBS","type":"queue","queue_name":"maildesk-cf-relay-jobs"}]}},"error":null}' ;;
  *"call worker-script-get-settings"*"script_name=maildesk-cf-relay-outbound"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"worker-script-get-settings","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"4".repeat(64)}"}],"result":{"result":{"bindings":[{"name":"EMAIL","type":"send_email"},{"name":"DB","type":"d1","id":"d1-example"},{"name":"POLICY_STORE","type":"r2_bucket","bucket_name":"maildesk-cf-policy"},{"name":"RELAY_SPOOL","type":"r2_bucket","bucket_name":"maildesk-cf-relay-spool"}]}},"error":null}' ;;
  *"call worker-script-get-settings"*"script_name=maildesk-cf-routing-health"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"worker-script-get-settings","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"5".repeat(64)}"}],"result":{"result":{"bindings":[{"name":"DB","type":"d1","id":"d1-example"},{"name":"ASSETS","type":"assets"}]}},"error":null}' ;;
  *"call d1-list-databases"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"d1-list-databases","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"f".repeat(64)}"}],"result":{"result":[{"uuid":"d1-example","name":"maildesk-cf-relay-db"}],"result_info":{"page":1,"per_page":10000,"total_pages":1,"total_count":1}},"error":null}' ;;
  *"call r2-list-buckets"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"r2-list-buckets","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"1".repeat(64)}"}],"result":{"result":{"buckets":[{"name":"maildesk-cf-policy"},{"name":"maildesk-cf-relay-spool"}]},"result_info":{"cursor":""}},"error":null}' ;;
  *"call queues-list-consumers"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"queues-list-consumers","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"6".repeat(64)}"}],"result":{"result":[{"type":"worker","script_name":"maildesk-cf-relay-outbound","settings":{"batch_size":1,"max_concurrency":1,"max_retries":5,"dead_letter_queue":"maildesk-cf-relay-dlq"}}]},"error":null}' ;;
  *"call queues-list"*) echo '{"schema_version":2,"ok":true,"performed":true,"capability_id":"queues-list","profile_id":"profile-example","account_id":"account-example","verification":{"state":"not_applicable"},"evidence":[{"content_hash":"sha256:${"2".repeat(64)}"}],"result":{"result":[{"queue_id":"queue-jobs","queue_name":"maildesk-cf-relay-jobs"},{"queue_id":"queue-dlq","queue_name":"maildesk-cf-relay-dlq"}]},"error":null}' ;;
  *) echo '{"schema_version":2,"ok":false,"performed":false,"error":{"code":"UNEXPECTED_CALL"}}' >&2; exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
}

function runCoverageCollection(
  fixture: ReturnType<typeof createCoverageFixture>,
  dir: string,
  options: { canary?: boolean; denyDomain?: string; profile?: "dark_acceptance_v1" } = {},
) {
  const cfctl = join(dir, options.denyDomain ? "cfctl-deny" : options.canary ? "cfctl-canary" : "cfctl-full");
  const wrangler = join(dir, "wrangler-coverage");
  const log = join(dir, `${options.denyDomain ? "deny" : options.canary ? "canary" : "full"}.log`);
  const out = join(dir, `${options.denyDomain ? "deny" : options.canary ? "canary" : "full"}.json`);
  writeCoverageCfctl(cfctl);
  writeFileSync(wrangler, "#!/bin/sh\necho '[]'\n", { mode: 0o755 });
  chmodSync(wrangler, 0o755);
  const command = [
    "run",
    "scripts/collect-live-evidence.ts",
    "--",
    "--policy",
    fixture.policyPath,
    "--desired-state",
    fixture.desiredPath,
    "--cfctl",
    cfctl,
    "--wrangler",
    wrangler,
    "--out",
    out,
    "--no-resend",
  ];
  if (options.canary || options.denyDomain) command.push("--scope-manifest", fixture.scopeManifestPath);
  if (options.profile) command.push("--acceptance-profile", options.profile);
  const result = spawnSync("bun", command, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      MAILDESK_CFCTL_PROFILE: "profile-example",
      MAILDESK_TEST_CFCTL_LOG: log,
      ...(options.denyDomain ? { MAILDESK_TEST_DENY_DOMAIN: options.denyDomain } : {}),
    },
  });
  return { result, out, log };
}
