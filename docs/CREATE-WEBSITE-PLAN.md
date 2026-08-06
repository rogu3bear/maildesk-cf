# Create Website Plan

## Context

- Started: 2026-08-05
- Product: Cloudflare-native shared-domain mail desk and identity router
- Primary audience: technical operator responsible for shared role mail and domain identity
- Primary conversion action: **Open the desk**
- Scope: public explanatory routes plus authenticated operator routes
- Stack: Rust, Leptos Router 0.8, Cargo-Leptos, Cloudflare Workers, D1, R2, Queues
- Existing positioning: repository contracts; no validated customer research or proof assets
- Craft bar: design is part of trust; the site should feel like a calm edge control room rather than a starter template
- Execution posture: provisional owner-approved direction inferred from the production mandate; customer claims remain hypothesis-grade
- Routing note: `improve-website` was evaluated and rejected because no live website exists yet; this is a creation journey.

## Phase Status

| Phase | Skill | Status | Artifact | Date |
| --- | --- | --- | --- | --- |
| 1 | one-page-marketing | awaiting-evidence | MARKETING.md, CUSTOMER.md | 2026-08-05 |
| 2 | storybrand-messaging | implemented-awaiting-validation | POSITIONING.md, WEBSITE.md | 2026-08-05 |
| 3 | made-to-stick | awaiting-evidence | POSITIONING.md, WEBSITE.md | 2026-08-05 |
| 4 | top-design | rendered | DESIGN.md | 2026-08-05 |
| 5 | web-typography | rendered | DESIGN.md | 2026-08-05 |
| 6 | refactoring-ui | rendered | DESIGN.md | 2026-08-05 |
| 7 | ux-heuristics | reviewed-with-follow-up | DESIGN.md | 2026-08-05 |
| 8 | cro-methodology | awaiting-evidence | WEBSITE.md, EXPERIMENTS.md | 2026-08-05 |
| 9 | scorecard-marketing | skipped: no nurture motion for first release | WEBSITE.md, MARKETING.md | 2026-08-05 |
| 10 | steve-jobs-design-review | owner-sign-off-pending | WEBSITE.md | 2026-08-05 |

Rendered implementation phases have local desktop and 390px Safari evidence. Product validation and owner sign-off remain non-final.

## Key Decisions

| Date | Phase | Decision | Rationale |
| --- | --- | --- | --- |
| 2026-08-05 | Intake | Keep public template and private deployment consumer separate | Protects template hygiene and live-instance secrets |
| 2026-08-05 | 1 | Target proof-oriented technical operators | Matches the actual workflow and repository contracts |
| 2026-08-05 | 1 | Use “Open the desk” as the single primary action | Concrete and immediately verifiable |
| 2026-08-05 | 2 | Position as an identity-aware edge mail desk, not a helpdesk clone | Preserves the product wedge |
| 2026-08-05 | 4 | Use an editorial control-room visual language | Communicates trust without dashboard clichés |
| 2026-08-05 | 4 | Native cursor and reduced-motion-safe CSS motion | Accessibility and familiarity outweigh novelty |
| 2026-08-05 | 9 | Skip lead quiz/nurture for first release | One direct operator action is sufficient |

## Next Actions

- [x] Implement the accepted provisional direction in Leptos (Engineering).
- [x] Run rendered desktop and 390px mobile review in Safari (Design/QA).
- [x] Confirm the rebuilt horizontal-overflow containment fix in a fresh 390px Safari render (Design/QA).
- [ ] Validate positioning and journey with five target operators (Product).
- [ ] Complete the pre-launch “insanely great / not done” gate after live rendering (Owner).
