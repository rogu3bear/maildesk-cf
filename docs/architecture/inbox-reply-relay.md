# Inbox Reply Relay

This is the current reply authorization and recovery contract. Existing provider migrations 0001–0011 remain unchanged. Migration 0012
adds the reusable canary-admission prerequisite; 0013–0015 add dispatch, ordinary
authority and status. Historical records retain their original meaning. The October 2026 rectification changes ordinary authorization, work
queue eligibility, signature-free content, and duplicate recovery ordering.

`inbox_relay` uses an existing operator inbox for reading and composing. Maildesk
owns policy, authorization, bounded recovery spools and body-free operational
state. Access login does not authorize send-as. The private health UI cannot
read message bodies or submit replies; generic `web_desk` compatibility remains
separate and its legacy HTTP reply API is disabled by default.

## Policy and destination authority

Rust validates the entire immutable policy before `project_policy_json` emits
configured roles, effective personal aliases, wildcard catch-all and sinks.
It owns precedence, normalized identities, operator sets, ordered destination
candidates and stable route references. TypeScript joins provider topology and
formats persistence; it does not reconstruct policy semantics. The active R2
policy's original bytes keep their existing SHA-256. D1 route IDs, identities,
operators and enabled inventory must match that canonical projection exactly;
equal counts cannot validate substituted routes or operator membership.
Personal-first policy additionally projects each operator's explicit personal
alias at the receiving domain. `alias_route_reply_identities` mirrors those
operator/public-identity/mode bindings. Inventory parity and each consuming
authority statement compare the complete map; equal membership counts cannot
authorize a substituted identity. The new table's initial role-first projection
preserves the existing policy meaning and creates no ordinary activation.

A policy `work_queue` destination is eligible only when its exact `queue_ref`
has a supported adapter with a durable handoff contract. `MAIL_JOBS` is the
internal mail-event queue and never establishes work-destination eligibility.
No such destination adapter is installed by this change. The supplied baseline
therefore selects the Rust-declared mailbox fallback before a delivery effect.
An unknown handoff outcome cannot cause mailbox fallback. Historical internal
work-item Queue events are reconciliation evidence, never downstream delivery.

## Inbound invariant

The Email Worker creates a 248-bit token encoded as 62 lowercase hex characters;
`r+` and that token fit the 64-character mailbox local-part limit. Historical
64-character tokens remain readable for reconciliation. D1 stores only a token
hash. The raw opaque recipient appears in the operator-facing delivery and its
bounded temporary recovery payload, never in outward correspondent content.

Each policy-selected operator receives a separately addressed bannered copy.
Both MIME alternatives describe the actual availability: disabled, profile
unavailable, quarantined, canary-only awaiting admission, or explicitly ordinary
activated. A mode switch alone cannot advertise ordinary authority. The public
identity is descriptive; the banner itself grants no authority.

A stable fingerprint binds normalized envelope addresses and exact inbound
MIME. Immutable per-recipient spools precede durable claims. Cloudflare assigns
the provider Message-ID; `X-Maildesk-Delivery-ID` carries the deterministic
Maildesk delivery reference. Only an exact, current-policy `pending` recipient
may atomically become `sending`. A `sending`, accepted or uncertain recipient
is never resent automatically. Cloudflare's non-idempotent send boundary cannot
provide an exactly-once delivery guarantee.

Inbound result jobs must match the durable delivery, relay, route, policy,
complete recipient set, spool generations and provider results before projection
or cleanup. An accepted spool's cleanup pointer remains durable until deletion
and its body-free cleanup receipt complete. Superseded all-pending inbound work
may be retired only by the existing exact known-unsent guard.

## Closed reply authorization variants

Canary authorization remains schema 1 in `reply_admissions`: one exact,
controller-issued, single-use transaction with its original evidence fields.
The compiler requires evidence within ten minutes and caps validity at fifteen
minutes; the existing materializer proposes fourteen minutes. Existing expiry
values are preserved. This distinction does not grant ordinary authority.

Ordinary authorization requires an explicit schema-1 `route_reply_authorizations`
record. It binds route, exact global policy and desired-state hashes, public
identity/profile, normalized operator-set digest and JSON, sender adapter/domain,
runtime artifacts, topology, fresh exact golden-thread qualification, separate
owner authorization and a governed activation receipt. Ingress and the UI have
no activation path. No enabled flag or historical proof timestamp is backfilled
into route authority. Source examples remain disabled. Unknown authorization
variants fail closed.

Personal-first authority is specific to a route and public identity. Multiple
operators' identities need separate activations; one operator's grant cannot
authorize another prefix. The non-performing activation compiler uses input
schema 2 with an explicit `reply_operator`, its actual-client compatibility
hashes, and owner authorization naming the selected public identity. Rust
selects the profile. Schema-1 input cannot implicitly choose an operator.

The stored relay's historical `reply_identity` remains the intake route's
identity. It is not rewritten when a personal-first operator responds. The
authenticated Rust decision and matching canonical operator binding determine
the public identity for the new immutable admission and dispatch. Queued old
claims retain their original hashes and reconciliation rules.

After activation, each independently authored ordinary message receives a
schema-2 `ordinary_reply_admissions` row and its dispatch attempt in one SQLite
statement/trigger transaction. It binds activation, relay/thread/route, operator,
authenticated bytes, case-preserving Message-ID digest, signed recipient,
immutable outward payload, stored external target, policy/profile/provider and
validity. Expiry cannot exceed the relay or explicit authority expiry. Multiple
distinct replies, including replies by different authorized operators, are
permitted; transport redelivery remains one attempt.

Observation freshness and authority expiry are separate. Stale receipt evidence
does not revoke otherwise current explicit authority. Revocation, actual expiry,
quarantine, policy/profile/operator/provider/artifact/topology drift, or a master
kill switch blocks new sends. Both router and outbound bindings must carry the
same inbound/reply/ordinary processing modes. Ordinary mode additionally needs
matching runtime artifact and topology digests in Worker environment and D1.
A local checkout change alone says nothing about deployed runtime authority.

## Authentication, parsing and privacy

Canaries retain their original aligned DKIM `From` and body contract. Ordinary
messages additionally require one accepted signature to authenticate the exact
selected opaque `To`, case-preserving `Message-ID`, and every present consumed
Subject/MIME/Content-* singleton. Duplicate singleton headers, partial-body
`l=` signatures, unsigned relevant fields, envelope/signed-recipient mismatch,
parser disagreement and unsupported algorithms fail closed. DNS uncertainty is
not authentication. The real Apple Mail/Workspace signing shape must be
qualified with captured fixtures before ordinary activation.

New reply identity hashes use a domain-separated v2 preimage and preserve case.
Legacy lowercase hashes are also looked up to prevent reopening historical
attempts under the new digest. An exact authenticated redelivery resolves its
original immutable claim before looking for a new admitted transaction. An
expired or terminal duplicate is reconciled without creating new authority.

A clean nonempty plaintext reply needs no signature. CRLF/CR normalize to LF;
boundary blank lines are trimmed. Only a conventional `-- ` line or a supported
Apple attribution followed entirely by quoted lines permits removal. Blank
paragraphs, short final paragraphs, sender names and attribution words inside
authored sentences are not signature heuristics. The immutable public signature
is appended once. New claims use payload version 2; only pre-cutover immutable
canary claims may use the frozen version-1 renderer, and their stored digest
must match exactly.

HTML-only replies and outbound attachments remain unsupported. Original HTML
is never forwarded; escaped HTML is regenerated from the accepted plaintext.
Unrecognized retained routing banners, known private operator identities and
opaque relay tokens in text, URLs or outward metadata fail closed. Encoding
inspection is bounded and includes Unicode normalization, entity and percent
decoding. This does not promise semantic anonymization of arbitrary prose.
Encoded messages remain bounded at 5 MiB.

## Dispatch, provider boundary and terminal ownership

Authorization, durable dispatch intent, provider claim and terminal result are
separate facts. `receiving`/`queued`/`authorized` plus immutable admission fields
form the dispatch journal. A failed or ambiguous Queue submission retains the
claim and exact spool. Redelivery or `recoverKnownUnsentDispatch(claimId, env)`
reconstructs only the allowlisted job from durable rows and rechecks current
safety. No caller payload or caller-selected R2 path is accepted. Remote redrive
requires a qualified governed capability; this repository adds no scheduler or
raw provider client for that purpose.

Canary admission, ordinary admission and the common provider transition each
compare the exact Rust-projected route row inside their consuming statement:
domain and local part, route/storage kind, default public identity, complete
operator set and exact operator/public-identity bindings. A mutation between an earlier read and the claim produces zero
rows; it cannot consume authority, leave an orphaned dispatch or call a provider.
The current policy/desired-state and quarantine checks remain independent.

One conditional transition owns the first provider call. A competing consumer
cannot write a false failure over another sender's in-flight outcome. Before-
boundary rejection conditionally closes only a still-claimed authorization.
Trigger-backed claims abort the entire statement when ownership is lost; a D1
batch returning zero changed rows is never treated as rollback. D1 metadata
counts include trigger writes, so uniquely keyed transitions test positive
change rather than assuming exactly one total changed row.

Cloudflare `sending` with no confirmed result remains unknown and is never
replayed. Accepted audit evidence resumes only terminal projection and spool
cleanup. Resend recovery additionally requires the same provider, idempotency
key, exact serialized request hash, current safety bindings and an age below
23 hours, within its documented 24-hour key retention. Historical claims lacking
that time/hash binding require reconciliation. Provider switching is forbidden.
The historical `outbound_reply_delivered` audit key remains readable; new records
explicitly map its outcome to `provider_accepted`, never external receipt.

## Evidence and health

`route_proofs`, `route_proof_ledger`, coverage records and admission/containment
receipts retain their own historical evidence meaning. `route_health` is a
mutable operational rollup. `route_status_projection` is a disposable body-free
read model, revision `route-operational-v1`; it is neither proof nor authority.
Source-generation changes invalidate it, and publication uses a generation
check. Its validity stops at the earliest relevant future proof/authority expiry.

The canonical TypeScript projection separates processing modes, ordinary
activation, provider outcomes, independent inbox/reply freshness, pending
dispatch, queued work, unknown sends, reasons and one bounded next action.
Rust consumes these classifications and reports missing/stale/incompatible
projections as unknown or stale. Sinks are intentional no-delivery routes with
reply not applicable. Enrollment and fleet coverage remain separately qualified;
a selected canary never proves the fleet. Canary/fleet receipt validators keep
plane-specific selectors, chronology and coverage checks. The canary, fleet
compiler and verifier also consume the same closed operational projection with
policy, generation and expiry checks. Missing or incompatible fields remain
unknown; stale projections retain historical authority facts without establishing
current readiness. Unknown outcomes require reconciliation. Proof expiry is
inclusive at the expiry instant.
For personal-first groups, status requires matching activation coverage for
every distinct Rust-selected public profile. Its representative activation ID
is an actual member of that complete set, and proof freshness uses the oldest
member's qualification evidence. A single successful operator cannot qualify
the group.

Fresh receipt planes can qualify a canary while an operational blocker remains.
The verifier exposes `canary_receipts_verified` separately from
`operational_ready`; `mail_ready` requires both. The controller then stops at
`operational_reconciliation` with no executable command, so this state cannot
manufacture activation or recovery permission. Fleet receipt-plane results remain
visible, while full coverage additionally requires current operational state.
An explicitly graduated sink records provider-delivery and inbox/reply planes
as not applicable; it never needs a nonexistent operator inbox receipt.
The existing provider V2 evidence contract lacks the new operational fields;
its output therefore remains operationally unknown until a governed extension
is implemented and qualified. No reviewed capability or query pin is changed.

The activation/recovery/containment compilers are non-performing contracts. No
ordinary provider capability is claimed installed. Qualify a governed operation
pack and actual client signing fixtures before activation. Keep ordinary mode
disabled before considering any downgrade, retain all terminal history, and do
not downgrade to a binary that cannot interpret new authorization records.
