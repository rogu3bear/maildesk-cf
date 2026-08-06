import { describe, expect, test } from "bun:test";

import {
  accessConfiguration,
  isDeskPath,
  verifiedAccessRequest,
} from "../../workers/ui/access";

const validEnvironment = {
  MAILDESK_ACCESS_AUD: "example-audience",
  MAILDESK_ACCESS_TEAM_DOMAIN: "https://example-team.cloudflareaccess.com",
};

describe("Leptos UI Cloudflare Access adapter", () => {
  test("matches only the protected desk route boundary", () => {
    expect(isDeskPath("/desk")).toBe(true);
    expect(isDeskPath("/desk/api/load")).toBe(true);
    expect(isDeskPath("/desktop")).toBe(false);
    expect(isDeskPath("/desk-preview")).toBe(false);
  });

  test("accepts only an HTTPS Cloudflare Access team origin", () => {
    expect(accessConfiguration(validEnvironment)).toEqual({
      audience: "example-audience",
      teamDomain: "https://example-team.cloudflareaccess.com",
    });
    expect(
      accessConfiguration({
        ...validEnvironment,
        MAILDESK_ACCESS_TEAM_DOMAIN: "http://example-team.cloudflareaccess.com",
      }),
    ).toBeNull();
    expect(
      accessConfiguration({
        ...validEnvironment,
        MAILDESK_ACCESS_TEAM_DOMAIN: "https://example.com",
      }),
    ).toBeNull();
    expect(
      accessConfiguration({
        ...validEnvironment,
        MAILDESK_ACCESS_TEAM_DOMAIN: "https://example-team.cloudflareaccess.com/path",
      }),
    ).toBeNull();
  });

  test("fails closed when verifier configuration or assertion is missing", async () => {
    const request = new Request("https://desk.example.com/desk");
    const missingConfiguration = await verifiedAccessRequest(request, {});
    expect(missingConfiguration).toBeInstanceOf(Response);
    expect((missingConfiguration as Response).status).toBe(503);

    const missingAssertion = await verifiedAccessRequest(request, validEnvironment);
    expect(missingAssertion).toBeInstanceOf(Response);
    expect((missingAssertion as Response).status).toBe(401);
  });

  test("trusts only the verified claim and overwrites caller identity headers", async () => {
    const request = new Request("https://desk.example.com/desk", {
      headers: {
        "cf-access-authenticated-user-email": "forged@example.com",
        "cf-access-jwt-assertion": "signed-token",
        "x-maildesk-access-validated": "caller-forged",
      },
    });
    const verified = await verifiedAccessRequest(
      request,
      validEnvironment,
      async () => ({ email: "Operator@Example.com" }),
    );

    expect(verified).toBeInstanceOf(Request);
    const headers = (verified as Request).headers;
    expect(headers.get("cf-access-authenticated-user-email")).toBe("operator@example.com");
    expect(headers.get("x-maildesk-access-validated")).toBe("1");
  });

  test("rejects invalid signatures and identity-free service assertions", async () => {
    const request = new Request("https://desk.example.com/desk", {
      headers: { "cf-access-jwt-assertion": "signed-token" },
    });
    const invalidSignature = await verifiedAccessRequest(
      request,
      validEnvironment,
      async () => {
        throw new Error("invalid signature");
      },
    );
    expect((invalidSignature as Response).status).toBe(403);

    const noEmail = await verifiedAccessRequest(
      request,
      validEnvironment,
      async () => ({ email: undefined }),
    );
    expect((noEmail as Response).status).toBe(403);
  });
});
