import { expect, test } from "bun:test";

import { loadActivePolicy } from "../../workers/shared/policy-store";

const policyJson = JSON.stringify({
  default_reply_mode: "role_first",
  domains: {
    "example.com": {
      role_aliases: {
        founders: {
          operators: ["operator@example.com"],
          reply_identity: "founders@example.com",
        },
      },
      personal_aliases: {},
    },
  },
});

test("inbox relay loads only the exact D1-selected immutable policy", async () => {
  const digest = await sha256(policyJson);
  const key = `config/policy/${digest}.json`;
  const env = policyEnv({ digest, key, policyJson, projectedRoutes: 1, expectedRoutes: 1 });

  const active = await loadActivePolicy(env as never);

  expect(active?.sha256).toBe(digest);
  expect(active?.r2ObjectKey).toBe(key);
  expect(Object.keys(active?.policy.domains ?? {})).toEqual(["example.com"]);
});

test("inbox relay fails closed on D1, projection, key, or R2 digest drift", async () => {
  const digest = await sha256(policyJson);
  const key = `config/policy/${digest}.json`;
  const cases = [
    policyEnv({ digest, key: "config/policy/wrong.json", policyJson, projectedRoutes: 1, expectedRoutes: 1 }),
    policyEnv({ digest, key, policyJson, projectedRoutes: 0, expectedRoutes: 1 }),
    policyEnv({ digest, key, policyJson, projectedRoutes: 2, expectedRoutes: 2 }),
    policyEnv({ digest, key, policyJson: `${policyJson} `, projectedRoutes: 1, expectedRoutes: 1 }),
  ];

  for (const env of cases) {
    expect(await loadActivePolicy(env as never)).toBeNull();
  }
});

test("inline policy is never accepted in inbox relay mode", async () => {
  expect(await loadActivePolicy({
    MAILDESK_OPERATOR_DELIVERY_MODE: "inbox_relay",
    MAILDESK_POLICY_JSON: policyJson,
    DB: {} as D1Database,
  } as never)).toBeNull();
});

test("inline policy is accepted only for explicit web-desk mode", async () => {
  const active = await loadActivePolicy({
    MAILDESK_OPERATOR_DELIVERY_MODE: "web_desk",
    MAILDESK_POLICY_JSON: policyJson,
    DB: {} as D1Database,
  } as never);

  expect(active?.r2ObjectKey).toBe("inline:development");
  expect(active?.policy).toEqual(JSON.parse(policyJson));
});

test("invalid or omitted delivery modes cannot load inline policy", async () => {
  for (const mode of [undefined, "inbox-relayy", "legacy_web_desk", "disabled"]) {
    expect(await loadActivePolicy({
      MAILDESK_OPERATOR_DELIVERY_MODE: mode,
      MAILDESK_POLICY_JSON: policyJson,
      DB: {} as D1Database,
    } as never)).toBeNull();
  }
});

test("invalid or omitted delivery modes cannot read the active policy store", async () => {
  const digest = await sha256(policyJson);
  const key = `config/policy/${digest}.json`;

  for (const mode of [undefined, "inbox-relayy", "legacy_web_desk", "disabled"]) {
    let dbReads = 0;
    let r2Reads = 0;
    const env = policyEnv({ digest, key, policyJson, projectedRoutes: 1, expectedRoutes: 1 });
    env.MAILDESK_OPERATOR_DELIVERY_MODE = mode;
    env.DB.prepare = () => {
      dbReads += 1;
      return {
        first: async () => ({
          active_policy_sha256: digest,
          active_policy_r2_key: key,
          revision_sha256: digest,
          revision_r2_key: key,
          expected_domain_count: 1,
          expected_route_count: 1,
          projected_route_count: 1,
          projected_domain_count: 1,
        }),
      };
    };
    env.POLICY_STORE.get = async () => {
      r2Reads += 1;
      return { arrayBuffer: async () => new TextEncoder().encode(policyJson).buffer };
    };

    expect(await loadActivePolicy(env as never)).toBeNull();
    expect({ mode, dbReads, r2Reads }).toEqual({ mode, dbReads: 0, r2Reads: 0 });
  }
});

function policyEnv(input: {
  digest: string;
  key: string;
  policyJson: string;
  projectedRoutes: number;
  expectedRoutes: number;
}) {
  return {
    MAILDESK_OPERATOR_DELIVERY_MODE: "inbox_relay",
    DB: {
      prepare: () => ({
        first: async () => ({
          active_policy_sha256: input.digest,
          active_policy_r2_key: input.key,
          revision_sha256: input.digest,
          revision_r2_key: input.key,
          expected_domain_count: 1,
          expected_route_count: input.expectedRoutes,
          projected_route_count: input.projectedRoutes,
          projected_domain_count: 1,
        }),
      }),
    },
    POLICY_STORE: {
      get: async (key: string) => key === input.key
        ? { arrayBuffer: async () => new TextEncoder().encode(input.policyJson).buffer }
        : null,
    },
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
