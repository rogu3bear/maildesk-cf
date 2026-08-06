# Positioning & Messaging

## Competitive Alternatives

- Forward shared aliases into personal inboxes and coordinate manually.
- Use a generic helpdesk that owns the workflow but obscures Cloudflare account truth.
- Assemble Email Routing, Workers, storage, and sending through dashboard-only operations.
- Do nothing and accept fragile identity and audit behavior.

## Unique Attributes → Value Themes

| Attribute | Value (so what) | Proof |
| --- | --- | --- |
| Rust router owns route and reply policy | Identity decisions are deterministic and testable without Cloudflare | Router contract and tests |
| D1/R2/Queues split state by responsibility | Metadata, raw artifacts, and async work stay explicit | Runtime contract and bindings |
| cfctl governs account mutations | Plans and live readback remain distinct from source intent | Control-plane contract |
| Readiness has four named planes | The product cannot hide an incomplete mail chain behind one green badge | Template standard |

## Best-Fit Customer

Small technical teams that own domain mail, want Cloudflare-native infrastructure, and care more about provable identity and calm operations than incumbent helpdesk breadth.

## Market Category

**Subcategory: Cloudflare-native mail desk and identity router.** It is recognizable as a shared inbox, but differentiated by edge-native policy, explicit infrastructure authority, and domain-consistent replies.

## One-Liner

**Route shared mail at the edge. Reply with the right identity. Prove every step.**

## Brand Script (StoryBrand)

- **Character:** a technical operator responsible for shared domain mail.
- **External problem:** mail routing, storage, replies, and infrastructure evidence are fragmented.
- **Internal problem:** they cannot feel certain that a reply or readiness claim tells the whole truth.
- **Philosophical problem:** infrastructure handling sensitive communication should be understandable and governed.
- **Guide:** maildesk-cf provides a Rust policy core, an operator desk, and a cfctl-controlled Cloudflare path.
- **Plan:** connect policy; triage with route context; authorize the identity; verify the result.
- **Direct call to action:** Open the desk.
- **Transitional call to action:** Read the architecture.
- **Failure:** lost context, incorrect sender identity, ambiguous delivery, and unprovable account state.
- **Success:** one calm operational surface with domain continuity and explicit evidence.

## Key Messages

| Surface | Message | Status |
| --- | --- | --- |
| Hero | Route shared mail at the edge. Reply with the right identity. Prove every step. | Provisional |
| Trust rail | Policy, storage, delivery, and live account state remain distinct—and visible. | Provisional |
| Desk empty state | No conversations are available yet. Your readiness evidence still is. | Provisional |
| Identity gate | The router selects the default. The server authorizes the final From identity. | Provisional |
| Deployment | A deploy is not mail-ready until targeted live proof closes the chain. | Contract-backed |
| Desk loading | Loading the mail assigned to you… | SUCCESs 4/6 static pass; unvalidated |
| Desk failure | Your desk could not be loaded. Try again. | SUCCESs 4/6 static pass; unvalidated |
| Reply identity | Policy authorizes this identity for the current route and operator. | SUCCESs 5/6 static pass; contract-backed |
| Reply success | Reply authorized and queued. Delivery remains a separate audit event. | SUCCESs 5/6 static pass; contract-backed |

No customer result, testimonial, time-saving number, or conversion claim is authorized yet.

The Commander's Intent is one sentence per operator surface: the desk says what
needs attention; the thread says which identity is safe; the action result says
only what the system has actually proven.
