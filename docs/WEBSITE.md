# Website

## Sitemap

| Route | Audience | Purpose | Primary action |
| --- | --- | --- | --- |
| `/` | Public technical visitor | Explain the product and trust model | Open the desk |
| `/architecture` | Evaluator/operator | Understand the edge chain and readiness planes | Open the desk |
| `/desk` | Authenticated operator | See attention, readiness, and conversations | Select a thread or inspect readiness |
| `/desk/thread/:id` | Authorized operator | Read, understand route, and prepare reply | Queue an authorized reply |
| `/*` | Anyone | Recover from an invalid route | Return home |

## Page Briefs

### `/` (home)

- **Purpose & primary conversion action:** establish the edge-native identity-router wedge and invite the visitor into the desk.
- **Message:** Route shared mail at the edge. Reply with the right identity. Prove every step.
- **CTA:** Open the desk; secondary Read the architecture.
- **Copy blocks:** hero; animated chain of custody; four readiness planes; product principles; closing operator CTA.

### `/architecture`

- **Purpose:** explain Cloudflare Email Routing → Rust policy → D1/R2/Queue → operator → sender provider → audit.
- **CTA:** Open the desk.
- **Copy blocks:** system map; router authority; storage separation; failure policy; proof vocabulary.

### `/desk`

- **Purpose:** present the current operational truth without pretending unavailable data exists.
- **CTA:** select the most important available action.
- **Copy blocks:** evidence bar; attention list; selected thread or useful empty/preview state; audit/activity rail.

### `/desk/thread/:id`

- **Purpose:** support the bounded triage-to-authorized-reply flow.
- **CTA:** Queue reply only after server authorization.
- **Copy blocks:** route and identity header; message timeline; composer; audit evidence.

## Conversion Elements

| Objection (Big 5) | Counter | Placement | Status |
| --- | --- | --- | --- |
| Trust | Explain Rust policy authority and cfctl plan/readback | Hero and architecture | Contract-backed |
| Fit | Explicitly name Cloudflare-native technical teams | Hero eyebrow and best-fit section | Provisional |
| Effort | Show the four-step operator loop | Home workflow section | Provisional |
| Timing | No scarcity claim; production readiness is evidence-gated | Launch copy | Required |
| Price | No pricing claim exists | Omit rather than invent | Required |

## Audit Findings

| Issue | Severity (0-4) | Fix | Status |
| --- | --- | --- | --- |
| Production website is not deployed | 4 | Promote the locally rendered Leptos routes through the governed production plan | Blocked on security context and live control-plane access |
| No validated visitor evidence | 3 | Keep claims provisional and recruit five operators | Open |
| Protected desk live configuration unconfirmed | 4 | Verify the Access application, audience, and policy before production | Open; local JWT verification fails closed |
| Thread API needs production data proof | 4 | Verify bounded D1 projections against the private instance | Local contract implemented; live proof open |
| Compatibility date is stale | 2 | Update during release-prep and rerun gates | Open |

## Lead Capture

No lead quiz or email capture is in scope. The first site has one direct product action.
