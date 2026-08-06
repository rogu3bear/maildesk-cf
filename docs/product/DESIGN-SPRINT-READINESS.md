# Design Sprint Readiness Assessment: Operator desk vertical slice

The challenge is to make routing, identity, readiness, and reply authorization understandable in one operator workflow without building a generic helpdesk.

## Inputs Captured

**Challenge description:**

> Design and test the first authenticated triage-to-authorized-reply flow for a Cloudflare-native shared-domain mail operator.

**Existing hypothesis:**

> If the desk presents attention, routing evidence, and the authorized reply identity in one calm flow, operators will resolve shared-domain mail faster without weakening trust. The highest-risk assumption is that the proposed evidence vocabulary is understandable outside the repository team.

**Customer access status:** No named recruiter, source, or five-customer schedule is confirmed.

**Decider name and availability:** The repository owner is the presumed Decider; required attendance windows are not confirmed.

**Team composition draft:** No 4–7 person roster is confirmed.

**Prototype medium:** A real Leptos vertical slice is feasible, but a one-day clickable prototype would be cheaper for pure workflow learning.

## Readiness Verdict: **Wait**

Customer access and the decision-making roster are hard failures. Building the bounded internal vertical slice may still proceed, but calling that work a Design Sprint would be sprint theater.

| Criterion | Status | Notes |
| --- | --- | --- |
| 1. Challenge is named and sprint-worthy | PASS | Specific, costly if identity/evidence direction is wrong |
| 2. Stakes are meaningful | PASS | Trust and domain identity are core product boundaries |
| 3. Decider available for load-bearing moments | FAIL | Availability is unconfirmed |
| 4. Team size appropriate (4-7) | FAIL | No roster exists |
| 5. Team can clear 5 consecutive days | FAIL | No schedule exists |
| 6. Customer access for Friday testing secured | FAIL | No recruiting source or sessions exist |
| 7. Prototype medium feasible in 1 day | PASS | Clickable prototype is feasible |
| 8. Sprint output has a path forward | PASS | Build/iterate/stop maps to the launch plan |

## Diagnosis

The challenge and downstream decision are strong, but four load-bearing coordination inputs are absent. Most importantly, Friday testing cannot happen without five target-profile operators. The current implementation program should use hypothesis labels and bounded validation instead of pretending a formal sprint has occurred.

## Recommended Preconditions

1. **Name the Decider and reserve Mon AM, Wed AM, and Fri PM** (Launch owner; before scheduling).
2. **Recruit five target operators plus one buffer** (Research owner; 7–10 days before Friday testing).
3. **Confirm a 4–7 person core team and five consecutive days** (Facilitator; before the sprint brief).
4. **Choose prototype versus real-slice testing** (Decider; before Monday).

## Decider Checkpoint

- [ ] Decider confirms the Wait verdict or supplies the missing conditions.
- [ ] Decider commits to the load-bearing windows before a sprint is scheduled.
- [ ] Decider authorizes a customer recruiting plan and honoraria before recruiting.
- [ ] Decider agrees that the sprint output is a scorecard and build/iterate/pivot/stop call, not production code.

**Signed:** pending
