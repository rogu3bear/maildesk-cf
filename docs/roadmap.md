# Roadmap

The current new-instance path is `inbox_relay`: operators read and compose in
an existing inbox; Maildesk preserves public identity and exposes routing
health. `web_desk` is an explicit compatibility mode for existing integrations,
not the next relay milestone. Its token API stays disabled unless intentionally
configured. No existing consumer is removed by this roadmap.

## Current release slice: independent template and recovery

The release owner maintains [acceptance-criteria.md](acceptance-criteria.md)
and runs local CI against the exact candidate. An independent reviewer checks
that candidate before publication. These objectives reinforce each other:

1. Clean-copy setup: initialize real template contents without breaking stable
   schema/operation references; document required tools and one cfctl credential
   lane without workstation-local dependencies.
2. Predictable operation: check the exact installed read contracts before
   production preparation; retain per-capability mutation planning and owned
   application/policy boundaries.
3. Exception completion: distinguish unsent, ambiguous, accepted and missing
   recovery content; test the durable transitions and give the operator the
   [recovery procedure](operations/recovery.md).

Implementation, passing local checks, publication, account deployment and mail
receipt are different statuses. Do not turn this list into deployment proof.
The release work order owns staffing, dates and target-account authorization.

## Subsequent qualification

- Run a clean-operator walkthrough using only public instructions and a
  supported cfctl installation.
- For an explicitly selected instance, prove dark deployment before enabling
  inbound processing; prove inbox receipt before enabling reply processing.
- Record provider acceptance, inbox receipt and external reply receipt
  separately. No fixed SLO or customer outcome is claimed by this template.
- Resolve any capability blocker through cfctl; do not route around it.

## Deliberately outside this slice

New helpdesk/composer/CRM features, new sender adapters, outbound binary
attachment support, and a hard dependency on leptos-cf are deferred. Existing
web-desk and Resend compatibility stays tested. Live observability thresholds
require measured traffic and an operator-owned response policy.

## Provider and consumer boundaries

cfctl owns credential custody, account discovery, pinned plan execution and
post-change readback. Maildesk owns routing/reply semantics, local declarations,
read-consumer contracts and mail evidence interpretation. Registered workspace
operations remain application-owned declarations even when cfctl executes them.

leptos-cf supplies optional Rust/Leptos/Worker conventions. Its repository is
not required to compile or run this one. Changes to shared conventions need
explicit consumer checks, not vendoring or private sibling paths.
