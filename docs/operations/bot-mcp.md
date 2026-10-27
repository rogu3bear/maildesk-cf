# Read-only bot access

Keep the existing mailbox host, content connector and human mail client unchanged.
This optional MCP resource server adds Maildesk route and delivery
evidence alongside that workflow. It does not search or retain mail, supply a
composer, send messages, or change bot routines and email triggers.

`workers/mail-mcp/src/index.ts` uses the official MCP SDK and Streamable HTTP.
The closed build includes `generated/mail-workers/mail-mcp/`. The separate
`wrangler.mail-mcp.toml` example stays disabled, with no public route, Email,
Queue, relay-spool or schedule binding. A source build is not a deployment or a
live bot connection.

## Tools and authorization

| Tool | Required scope | Result |
| --- | --- | --- |
| `list_authorized_routes` | `maildesk.routes.read` | At most 32 public route descriptors; policy/principal-bound pagination |
| `get_delivery_status` | `maildesk.status.read` | One assigned route's existing body-free projection, including freshness, provider outcomes and independent proof state |

Every request authenticates a signed OAuth access token. Issuer, resource
audience, RS256, `typ=at+jwt`, issued-at, expiry and scope are verified; the
maximum accepted token age is one hour. The operator is selected by an exact
operator-owned `(subject, client_id)` binding, never by tool arguments or a
token's email claim. The issuer must issue these resource-bound access tokens;
an OIDC ID token or browser Access assertion is not interchangeable with them.

Configure the trusted issuer and its same-origin JWKS URL, the exact HTTPS
resource URL ending in `/mcp`, and `MAILDESK_MCP_BINDINGS_JSON`. A documentation
example binding is:

```json
[{"subject":"operator-subject","client_id":"approved-mcp-client","operator":"operator@example.net"}]
```

The issuer owns user login, consent, client registration, PKCE, refresh and
revocation. This project implements the resource server, not an authorization
server. No real issuer, client registration or account grant is configured by
the example. Revocation requirements must be qualified: JWT validation is not
per-request token introspection. Disabling MCP or removing a binding blocks
subsequent requests once that configuration is effective; expiry is also
enforced. Do not grant a bot an account-wide Cloudflare credential.

Tool discovery exposes only granted scopes. Each data call reloads the exact
D1-selected immutable policy and verifies complete Rust/D1 inventory parity.
Only routes whose canonical operator set contains the bound operator are
visible. Sink routes with no operator grant no implicit access. Body-free
organization dashboard access is not a message or route grant for this server.
Unknown and unassigned route IDs share one denial. Private operators, message
content, raw object keys, relay tokens, signatures and activation IDs are absent
from results. No caller-supplied SQL, mailbox or public send identity is accepted.

Status reads reuse `readRouteStatusProjection`, including policy/generation,
schema, time and expiry checks. Stale facts stay marked stale; malformed or
missing projections stay unknown. A read never calls the status refresher.
Provider acceptance is not inbox receipt, and a next-action suggestion does not
execute recovery. Policy and recipient changes during a status read withhold the
result. Pagination is a bounded query aid, not an atomic snapshot or authority.

Requests have a 64 KiB body limit and five-second deadline. Late read completion
cannot return a result after the deadline. Finite response bodies, including
legacy SSE replies, complete inside that deadline; token expiry is rechecked
before the response is released. Underlying D1 reads cannot be
cancelled individually; there is no write/send to reconcile. Host and Origin
checks use the configured resource, response caching is disabled, and errors
omit provider/SQL details. Normal provider/rate limits still need a pilot plan.

## Local qualification

```bash
bun test ./tests/workers/mail-mcp.test.ts
bun run build:mail-workers
bun run typecheck:workers
```

Tests drive the real SDK client and Streamable HTTP transport through the
production fetch handler in process, with fixture-signed tokens, isolated SQLite
and mock policy storage. They cover legacy and automatic protocol negotiation,
discovery/invocation, cross-user denial, strict inputs, scope isolation, policy
drift, stale/generation-fenced status, unknown sends and zero SQL writes. This
does not prove Grok, ChatGPT, OAuth login, provider access or email-triggered
routines. Full repository CI remains required before publication.

## Connection prerequisites

Before an actual pilot, choose and qualify an existing OAuth authorization
server that satisfies the access-token contract, bind each client's subject and
client ID, and authorize only the required read scopes. Keep the mailbox connector's scopes and
send permissions separate. Confirm the selected database's additive schema,
immutable policy parity and current status readers before enabling this Worker.
There is no production resource or release operation added by this example.

The resource publishes OAuth protected-resource metadata at
`/.well-known/oauth-protected-resource/mcp`; its `WWW-Authenticate` challenge
points there. The issuer must separately publish usable authorization-server
discovery and login/token endpoints. Grok and ChatGPT custom MCP forms take the
qualified `/mcp` resource URL and perform the issuer's consent flow; visible
forms alone do not establish compatible tokens, transport or successful use.
No OAuth clients, credentials, DNS, grants or deployments are created locally.

OpenAI Secure MCP Tunnel is another possible ChatGPT transport for a private
server. It still requires a separately authorized Platform tunnel, running
client, workspace association and runtime credential, plus this server's own
authentication. It does not establish Grok reachability or create bot triggers.
Do not start a tunnel, expose a local server or change release custody as an
implicit part of local tests. A fixture-only ChatGPT pilot is technically
plausible after those transport and auth prerequisites are explicitly bound.

Use the existing release owner and governed preparation/readback contracts for
any later runtime. Private consumers retain their accepted public pin until
upstream review and separately scoped adoption. No mail or activation is part
of MCP connection testing.

References: [MCP SDK HTTP/testing](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.4.0/docs/testing.md),
[Grok custom connectors](https://docs.x.ai/grok/connectors),
[ChatGPT custom MCP](https://developers.openai.com/api/docs/guides/custom-mcp-server),
[OpenAI authentication](https://developers.openai.com/plugins/build/auth),
[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).
