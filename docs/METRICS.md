# Metrics

## Funnel

| Stage | User outcome | Evidence source | Current baseline |
| --- | --- | --- | --- |
| Understand | Visitor can state what the product does | Moderated five-second test | Not measured |
| Enter | Authorized operator reaches the desk | Access/route event | Not instrumented |
| Orient | Operator identifies the top actionable state | Task observation/event | Not measured |
| Resolve | Operator reaches an authorized queued reply | Server event plus audit | Not measured |
| Confirm | Operator distinguishes queued from delivered | Task observation/audit view | Not measured |

## Stage & One Metric That Matters

**Current stage:** pre-launch learning.

**Metric:** completion of the core triage-to-authorized-reply task with correct explanation of identity and readiness. Baseline and target must be established before use.

## Baselines & Targets

| Metric | Baseline | Target | Miss response |
| --- | --- | --- | --- |
| LCP | Not measured | Set from production build before launch | Profile hero/assets and fix the largest delay |
| INP | Not measured | Set before launch, guided by current CWV good threshold | Reduce hydration/work on interaction path |
| CLS | Not measured | Set before launch, guided by current CWV good threshold | Reserve dimensions and inspect font/assets |
| Core task completion | Not measured | Set after five baseline sessions | Rework the highest-friction stage |
| Unauthorized accepted actions | Expected zero; unverified | Zero | No-go and security remediation |
