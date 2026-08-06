# Experiments

## Experiment Cards

### EXP-001 — Evidence vocabulary comprehension

- **Hypothesis:** We believe target operators can distinguish template-ready, instance-ready, edge-ready, and mail-ready when the desk presents each as a named evidence plane with a short definition.
- **Type:** moderated task test
- **Primary metric & threshold:** target and baseline to be set before recruiting; no fabricated threshold
- **Guardrail metric:** no participant interprets a local or deploy state as end-to-end mail proof
- **Decision rule:** simplify vocabulary if operators cannot identify the missing proof plane without assistance
- **Result & verdict:** not run

### EXP-002 — Identity-before-send comprehension

- **Hypothesis:** We believe showing the policy-selected From identity immediately beside the queue action makes operators correctly predict which identity will be authorized.
- **Type:** clickable/working prototype test
- **Primary metric & threshold:** target to be set after baseline
- **Guardrail metric:** zero accepted unauthorized identity attempts
- **Decision rule:** revise hierarchy/explanation if prediction is unreliable
- **Result & verdict:** not run

### EXP-003 — Authorized identity affordance

- **Hypothesis:** We believe a read-only From identity with a policy explanation will prevent operators from interpreting the only authorized identity as a cosmetic preference.
- **Type:** moderated working-prototype task
- **Primary metric & threshold:** 5 of 5 initial participants correctly explain why the identity cannot be changed
- **Guardrail metric:** zero participants believe the browser alone authorizes the identity
- **Decision rule:** add route-policy detail or restore a choice only when the server returns multiple authorized identities
- **Result & verdict:** implementation shipped locally; test not run

### EXP-004 — Reply constraint recovery

- **Hypothesis:** We believe native subject/body constraints with action-specific feedback will let operators recover from an incomplete reply without documentation.
- **Type:** moderated working-prototype task
- **Primary metric & threshold:** 4 of 5 initial participants correct the missing field on the first retry
- **Guardrail metric:** zero empty or oversized replies reach Queue submission
- **Decision rule:** revise the field-level signifier if first-retry recovery misses the threshold
- **Result & verdict:** implementation shipped locally; test not run

## Experiment Backlog

| Idea | ICE (impact/confidence/ease) | Status |
| --- | --- | --- |
| Attention-first desk versus chronological inbox | High / Low / Medium | Awaiting baseline |
| Collapsible evidence rail versus inline evidence | Medium / Low / Medium | Backlog |
| Public hero route animation comprehension | Low / Low / High | Backlog |
| Read-only identity versus single-option selector | High / Medium / High | Implemented; EXP-003 pending |
| Native reply constraints and actionable copy | High / Medium / High | Implemented; EXP-004 pending |
| Integrate `/readyz` truth into the desk evidence panel | High / Medium / Medium | P1 backlog |
| Thread route reachability at desktop/mobile widths | High / High / High | Fixed by rendered route pass |
