# Build Risk Review: Production operator desk

**Mode:** Feature-change | **Date:** 2026-08-05

## Verdict

**Build small.** The operator desk is a core-workflow gap, but the first release must prove a narrow triage-to-authorized-reply path before expanding into a generic helpdesk.

## Biggest risk

- **R1 trust:** operators will not rely on the desk if authentication, reply identity, readiness, and audit evidence are visually polished but operationally ambiguous.
- **R2 feature-fit:** a broad inbox UI could outrun the existing authenticated thread and identity contracts.
- **R3 positioning:** a generic helpdesk presentation would erase the Cloudflare-native identity-router wedge.
- **R4 retention:** without a real recurring triage loop, the site could remain a compelling demo rather than an operating tool.

## Demand level

**L3 — workflow blocker.** The repository's own operator-desk milestone cannot be completed without thread review, identity selection, reply composition, and audit visibility. External market demand remains unvalidated.

## Evidence ledger

| Signal | Strength | What it does or does not prove |
| --- | --- | --- |
| `apps/maildesk-ui` is only a placeholder | medium | Proves a product gap, not market demand |
| Roadmap requires the operator desk for Milestone 2 | medium | Proves architectural intent and workflow necessity |
| User explicitly requested a beautiful production Leptos experience | medium | Strong owner commitment; still not multi-customer demand |
| Router, persistence, reply authorization, and provisioning lanes already exist | strong technical readiness | Proves a buildable substrate, not operator usability |

## Validation plan

1. Run five template-safe operator sessions on the built desk; pass only if participants can explain route, readiness, and reply identity without assistance and no safety invariant fails.
2. Operate one private instance through a bounded real workflow; pass only when source, local proof, deployment, and targeted live readback remain distinguishable in the evidence.

## Routing

→ `deliver-user-stories` to bound the small release, followed by testable acceptance criteria.

## Sources

- `apps/maildesk-ui/README.md`
- `docs/roadmap.md`
- `docs/architecture/runtime-contract.md`
- `workers/mail-api/src/index.ts`
