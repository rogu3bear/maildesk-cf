# Customer

## Segments & Best-Fit Customer

The best-fit first customer is a technical operator at a small team that owns one or more shared domain aliases, already uses or intends to use Cloudflare Email Routing, and values explicit identity and infrastructure proof over a feature-heavy helpdesk. They can understand DNS and deployment concepts, but want daily mail work to happen in a calm product surface.

Adjacent but not primary segments include security/abuse mailbox operators and platform teams embedding maildesk-cf as an extension. Consumer mailbox users, bulk marketers, and large call-center operations are not represented by this first release.

See `docs/product/PERSONA.md` for the proto Product Persona. Behavioral details remain hypotheses pending observed sessions.

## Job Statement

When shared-domain mail reaches a small technical team, I want to understand
why it reached me, which identity I may use, and what actually happened after I
acted, so I can respond without breaking domain continuity or mistaking partial
readiness for a working mail chain.

This is primarily a Little Hire: the repeated triage-and-reply decision. The
Big Hire remains relevant because connecting Cloudflare resources and Access is
still a specialist setup path, but it is not the current experience target.

## Job Dimensions

| Dimension | Progress sought | Current underdelivery |
|---|---|---|
| Functional | Triage assigned mail and authorize the correct reply identity | D1/Access/Queue behavior is locally proven but not yet authenticated against a private production instance |
| Emotional | Feel certain about what is safe and what remains unproven | Readiness language can still outpace live provider evidence; this is the worst current dimension |
| Social | Be accountable to teammates and domain owners | Audit transitions exist, but alerts and an operator recovery view for incomplete outbound work do not |

## Competing Alternatives

| Alternative | Why it is hired | Weakness for this job |
|---|---|---|
| Forward aliases into personal inboxes | Familiar daily workflow and near-zero setup | Reply identity, shared ownership, and account proof fragment across providers |
| Generic helpdesk | Mature triage and collaboration | Cloudflare state and domain-identity policy become vendor abstractions |
| Dashboard-and-script assembly | Maximum infrastructure control | Hidden operator knowledge and weak repeatable proof |
| Do nothing / reply manually | No migration cost | Identity drift and incomplete audit remain accepted risk |
