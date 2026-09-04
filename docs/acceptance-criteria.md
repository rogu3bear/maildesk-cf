---
artifact: acceptance-criteria
version: "1.0"
created: 2026-09-04
status: candidate
---

# Acceptance Criteria: Independent inbox-relay template and recovery

## Story Context

A technical operator can copy the public template, prepare one supported
inbox-relay instance without hidden workstation dependencies, and distinguish
successful delivery from an exception with a safe next action. Existing
web-desk integrations retain their explicit compatibility mode. This slice
covers local template behavior and operational guidance; publication and
account-specific deployment/receipt qualification remain separate release
stages. It adds no new helpdesk or sender product.

## Happy Path

### AC-1: Initialize a real template

**Given** a clean copy of the real public template and a valid new project name

**When** the operator initializes the project

**Then** resource names use the new name while every referenced stable schema
and operation identifier remains resolvable under its documented name.

### AC-2: Confirm installed control-plane compatibility

**Given** the declared instance configuration and a supported cfctl installation

**When** the operator runs the installed compatibility check

**Then** the result identifies all consumed read capabilities as compatible
without claiming account access, mutation readiness or mail delivery.

### AC-3: Relay inbound mail to authorized operators

**Given** an enabled route with two authorized operators and available storage

**When** an accepted message arrives

**Then** each generated delivery is addressed to its authorized operator with
the public reply identity, and provider acceptance is recorded independently of
inbox receipt.

### AC-4: Preserve existing web-desk integration behavior

**Given** an existing integration explicitly configured for web-desk mode

**When** an authorized reply is submitted through its explicitly enabled API

**Then** the existing policy authorization and queued-reply behavior is preserved.

## Edge Cases

### AC-5: Resume only an unsent recipient

**Given** one recipient has been accepted and another remains provably unsent
with its exact recovery content available

**When** the same inbound message is redelivered under the active policy

**Then** only the unsent recipient is delivered and the accepted recipient is
not sent the message again.

### AC-6: Finish an accepted result after projection or cleanup failure

**Given** provider acceptance is durably recorded but local projection or
content cleanup was interrupted

**When** the original work is redelivered after availability is restored

**Then** projection and cleanup finish without another provider send.

### AC-7: Reject a changed recovery payload

**Given** retained recovery content no longer matches the authenticated claim

**When** processing attempts to resume

**Then** no provider send occurs and the original claim remains available for
investigation rather than authorizing the changed content.

## Error States

### AC-8: Stop on a missing or incompatible cfctl capability

**Given** a consumed capability is missing, blocked, malformed, mutating or has
an incompatible target contract

**When** the operator checks installed compatibility or runs production preflight

**Then** the check fails with the affected capability identified before account
work can be considered ready, and directs the operator to cfctl discovery.

### AC-9: Preserve an ambiguous send

**Given** an outbound provider attempt may have occurred but no terminal result
was durably recorded

**When** the work is redelivered

**Then** it is reported as recovery-required without another send, and the
operator procedure requires exact reconciliation evidence or an explicitly
unresolved outcome.

### AC-10: Keep missing unsent content distinct from an attempted send

**Given** one recipient remains unsent and its retained recovery content is
missing while another recipient is already accepted

**When** the inbound message is redelivered

**Then** the result preserves partial delivery and identifies the pending
recipient as unsent, sends neither recipient again, and the recovery procedure
identifies exact-content restoration or a separately authorized replacement.

## Non-Functional Criteria

### AC-11: Reject an unauthenticated operator

**Given** an inbox-relay reply lacks aligned authenticated operator identity

**When** it is processed

**Then** it is rejected before provider send.

### AC-12: Operate from public contracts

**Given** an operator has only the public repository and its declared tools

**When** they follow setup, credential and recovery instructions

**Then** no private sibling file or external rotation executable is required,
account actions use cfctl, and every documented recovery state identifies its
allowed next action and retention limit without promising delivery from local proof.

### AC-13: Reject substituted authenticated content

**Given** a queued reply's content differs from the authenticated claim

**When** processing attempts to resume

**Then** the changed content is rejected before provider send.

### AC-14: Reject disallowed outward identity

**Given** an authenticated reply contains a disallowed private operator identity
in outward content

**When** it is processed

**Then** it is rejected before provider send.

### AC-15: Keep audit output body-free

**Given** relay processing produces an audit record or a provider exception

**When** that record is emitted

**Then** audit output excludes message bodies, raw reply tokens and provider
exception secrets.

### AC-16: Reject an incomplete or bound template before renaming

**Given** initialization is requested with an invalid project name, a missing
required input, a symlinked input or provider-bound template configuration

**When** initialization is attempted

**Then** it fails before changing any template file and reports the rejected
input class.

### AC-17: Keep compiled claims separate from authenticated evidence

**Given** a coherent synthetic fleet input with all plane states declared proven

**When** fleet readiness is compiled

**Then** the report explicitly states that plane artifacts were not authenticated
and that the report does not authorize live readiness.

### AC-18: Reject metadata-only deployment identity

**Given** an active Worker version carries matching source/artifact annotations
but no authenticated artifact-byte join

**When** deployment evidence is collected

**Then** its annotation claim remains metadata-only and cannot satisfy Worker
deployment identity or edge readiness, including when its provider etag changes.

### AC-19: Bind immutable asset URLs to final bytes

**Given** generated JavaScript is unchanged while its referenced WASM changes

**When** UI assets are hashed and verified

**Then** the rewritten JavaScript receives a new URL whose digest matches the
written bytes; every manifest asset digest matches its actual file.

### AC-20: Discover owned Access support without granting authority

**Given** the explicitly selected cfctl exposes all four closed Access contracts

**When** installed Access compatibility is checked

**Then** only the catalog dependency is cleared; no operation ID, account
ownership, approval or live readiness is inferred.

### AC-21: Stop on missing or broadened Access support

**Given** an owned Access capability is missing or permits a broader target,
request or policy shape than the template contract

**When** installed Access compatibility is checked

**Then** the capability remains a named planning blocker without a generic API fallback.

## Notes

- Supported new instances use inbox relay and routing health. Web-desk and
  Resend behavior is retained compatibility, not expanded scope.
- Outbound attachments are intentionally unsupported; inbound attachments are
  preserved. A missing/expired spool or unavailable provider receipt may be
  irrecoverable. Honest unresolved outcomes satisfy recovery accounting, not
  successful mail delivery.
- Local CI is `bun run ci`. Build/tool installation may require network and
  explicit environment setup; see `operations/getting-started.md`.
- The installed check proves the exact catalog read contract. Specialized
  mutation support, selected profile/account authority and owned Access
  reconciliation remain separate capability-specific gates. No generic Access
  mutation or raw SQL is an authorized fallback.
- A release owner and independent reviewer bind passing checks to the exact
  Git candidate. Actual publication, deployment, provider acceptance, inbox
  receipt and external reply receipt are recorded separately outside tracked
  public source. No real account or domain is embedded in this document.

## Direct Proof Map

| Criteria | Repository-native proof |
|---|---|
| AC-1, AC-16 | `tests/scripts/init.test.ts`: real file contents and resolvable schema/operation references after initialization |
| AC-2, AC-8 | `tests/scripts/cfctl-installed-contract.test.ts`; production preflight integration in `tests/scripts/preflight.test.ts`; `check:cfctl-provisioning -- --installed` |
| AC-3, AC-5, AC-7, AC-10 | `tests/workers/inbox-relay.test.ts`: actual ingress with D1/R2/Queue fault injection |
| AC-4, AC-6, AC-9, AC-11, AC-13, AC-14, AC-15 | `tests/workers/mail-api.test.ts`, `tests/workers/dkim.test.ts`, `tests/workers/mail-router.test.ts` |
| AC-18 | `tests/scripts/worker-runtime-provenance.test.ts` forged/different-etag regression; collector coverage remains blocked |
| AC-19 | `tests/scripts/hash-ui-assets.test.ts`; `scripts/verify-ui-build.mjs` compares manifest digests to generated bytes |
| AC-20, AC-21 | `tests/scripts/cfctl-installed-contract.test.ts`: explicit selected-binary discovery, schema drift and non-authorizing output |
| AC-17 | `tests/scripts/compile-fleet-readiness.test.ts`: synthetic full coverage retains non-authoritative evidence status |
| AC-12 | `scripts/check-template.sh` includes tracked AGENTS.md in the scrub boundary; review `AGENTS.md`, current roadmap, getting-started and recovery runbooks against the actual source transitions |

A checked command is local proof only. Release handoff carries current test
results; this stable criteria file does not cache a green status for future
source changes.
