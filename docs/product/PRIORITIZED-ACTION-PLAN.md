# Prioritized Action Plan — Production operator desk

## Step 0: Source ledger

- **S1:** Public template purpose and initial milestone (`AGENTS.md`, `README.md`).
- **S2:** Template and operator-surface boundaries (`docs/architecture/template-standard.md`).
- **S3:** Rust routing and reply-identity authority (`docs/architecture/rust-router-contract.md`).
- **S4:** Governed production proof planes (`docs/operations/production-rollout.md`).

## Section 0. Executive summary

- **Situation classification:** Complicated (Cynefin) — the target architecture and control-plane rules are knowable, but multiple contracts and proof planes must be reconciled.
- **The binding constraint:** the repository lacks a trustworthy operator workflow over its existing mail-routing substrate.
- **The critical next effort (P1):** define and implement one authenticated triage-to-authorized-reply slice with explicit readiness and audit state.
- **Overall plan confidence:** Medium — source architecture is strong; customer behavior and final production topology still require evidence.
- **Time-to-value:** useful local workflow evidence after the first end-to-end UI slice; production evidence only after governed deployment.

## Section 1. Product intent

- **Established direction:** turn the public template substrate into a polished,
  trustworthy operator mail desk while preserving a clean private-consumer
  boundary — confidence: High.
- **Out of scope without separate evidence:** generalized helpdesk scope,
  multi-tenant commercialization, and claims about production behavior derived
  only from template proof.

## Section 2. Situation classification (Cynefin)

**Domain:** Complicated
**Source:** S1, S2, S3, S4

The intended outcome is explicit, and the local Leptos and Cloudflare control-plane contracts provide analysable good practices. The uncertainty is primarily integration and missing user evidence, not unknowable cause and effect; therefore the posture is analyse, implement a bounded slice, and verify.

## Section 3. The binding constraint (Theory of Constraints)

- **System and goal:** move from reusable mail-routing template to a production-operable desk.
- **The constraint:** no operator-facing path currently joins authenticated thread state, routing identity, reply authorization, and audit evidence.
- **Source:** S1, S2, S3
- **Candidate constraints considered:** visual quality is downstream of a real workflow; Cloudflare deployment is downstream of a buildable and secure artifact.
- **Why P1 lifts it:** one honest vertical slice creates the surface that design, security, tests, and live verification can all evaluate.

## Section 4. Prioritized questions, gaps, and open decisions

| Rank | Question / gap | Why it matters | Decision required? | How to resolve |
| --- | --- | --- | --- | --- |
| Q1 | Which private instance and route receive production traffic? | Selects real config and verification target | Yes, blocks production apply | Review private desired state and cfctl workspace binding |
| Q2 | Is Cloudflare Access the only operator identity authority? | Changes auth boundary and threat ranking | Yes, blocks security closeout | Confirm Access policy and header contract |
| Q3 | Which task cohort supplies baseline evidence? | Prevents fictional OKR and journey confidence | No for local build | Recruit five target operators |
| Q4 | Which outbound mode is intended at launch? | Changes bindings, sender proof, and protected actions | Yes, blocks mail-ready claim | Validate private desired state and provider readback |

## Section 5. The prioritized action plan

#### P1. Build the trustworthy vertical slice

- **Why:** directly lifts the missing operator-workflow constraint.
- **What:** public Leptos shell plus protected desk, thread detail, policy-selected reply identity, queue handoff, readiness, and audit states.
- **How:** define projections; implement Leptos routes and server boundaries; enforce operator identity; add success/empty/error/blocked states; run focused tests.
- **Confidence:** Medium — supported by repository contracts, pending operator evidence.
- **Source:** S1, S2, S3
- **Expected outcome / success signal:** a target operator can complete the bounded workflow and explain every protected transition.
- **Estimated effort:** several focused engineering sessions plus proof.
- **Dependencies:** current router and storage contracts; an explicit local auth posture.

#### P2. Make trust visible and testable

- **Why:** R1 trust can invalidate the entire slice even when it works functionally.
- **What:** security policy, threat model, authorization tests, accessibility checks, and evidence-plane labels.
- **How:** inventory boundaries; preview policy; validate assumptions; add controls and tests; rerun exact-tree proof.
- **Confidence:** Medium.
- **Source:** S1, S4
- **Expected outcome / success signal:** no high-risk unresolved control gap and no ambiguous readiness claim.
- **Estimated effort:** one security and remediation pass.
- **Dependencies:** P1 boundary shape.

#### P3. Prove the private consumer

- **Why:** template proof cannot establish instance or edge readiness.
- **What:** propagate the accepted source into the private instance and pass production preflight without printing secrets.
- **How:** reconcile source; validate ignored policy/env; build; run closeout; prepare cfctl plans.
- **Confidence:** Medium.
- **Source:** S1, S4
- **Expected outcome / success signal:** exact private commit is instance-ready with a reviewed operation plan.
- **Estimated effort:** one release-prep session after P1/P2.
- **Dependencies:** P1 and P2 accepted; private target confirmed.

#### P4. Apply and verify production

- **Why:** only a governed apply and targeted readback can establish deployed truth.
- **What:** approved cfctl execution, health/readiness checks, and bounded mail proof.
- **How:** resolve capability; read current state; inspect plan; obtain operation approval; run; verify and record evidence class.
- **Confidence:** Medium.
- **Source:** S1, S4
- **Expected outcome / success signal:** edge-ready, with mail-ready claimed only if the targeted mail chain passes.
- **Estimated effort:** one protected release window.
- **Dependencies:** explicit operation-ID approval and valid credentials.

| Now | Next | Later |
| --- | --- | --- |
| P1 | P2, P3 | P4 |

**What to defer / what NOT to do**

- Do not clone a generic helpdesk feature set before the core identity-aware workflow is proven.
- Do not put real domains, operators, account IDs, secrets, or live receipts in the public template.
- Do not treat a deploy response or broad email smoke test as complete mail proof.

## Section 6. Risks and pre-mortem

| Risk | Likelihood | Impact | Early signal | Mitigation | Source |
| --- | --- | --- | --- | --- | --- |
| Beautiful shell masks missing real thread APIs | Medium | High | fixture data persists after backend integration starts | Bind every visible state to a typed projection or explicit preview label | S2, S3 |
| Public and private responsibilities collapse | Medium | High | real identifiers appear in tracked diffs | Keep provider/consumer boundary and run template scrub gate | S1, S4 |
| Reply identity is treated as a cosmetic selector | Medium | High | UI enables identities before router authorization | Server-authorize and return the selected identity before queueing | S3 |
| Production is called complete at deploy | Medium | High | no post-change cfctl readback | Keep edge-ready and mail-ready gates separate | S4 |

## Section 7. Recommended pm-skill prompts

The supporting story, journey, and acceptance-criteria artifacts live beside
this plan and should remain consistent with the public contracts above.

## Section 8. Evidence and source map

| Claim / recommendation | Source ID | Public authority |
| --- | --- | --- |
| The repository is a standalone, reusable Cloudflare mail desk | S1 | Template purpose and initial milestone |
| The operator surface must preserve template and private-consumer boundaries | S2 | Template standard |
| Reply identity and authorization remain Rust-owned policy decisions | S3 | Rust router contract |
| Deployment requires distinct preflight, apply, and readback evidence | S4 | Production rollout contract |

**Inferred (Low confidence) claims:** customer behavior and market demand; neither drives P1.

**Evidence gaps:** target operator research, source-of-truth OKR tracker, production route, Access policy, and outbound provider selection.
