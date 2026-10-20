# Reviewed alias and group policy changes

Use the existing named mailbox destination membership. Rust owns the effective
recipient sets, public identities and destination order; there is no second group
model. This workflow prepares a review and atomic SQL import without executing it.

1. Obtain the current immutable policy and desired-state bytes through the
   governed owner. Verify the exact active revision and full inventory, not counts.
2. Prepare candidate policy/desired-state files. Keep private bytes in protected,
   ignored files. Validate both complete policies through the Rust projection.
3. Run the offline compiler into a new private directory:

   ```bash
   bun scripts/compile-policy-change.ts \
     --base-policy var/base-policy.json --base-desired-state var/base-desired.json \
     --policy var/candidate-policy.json --desired-state var/candidate-desired.json \
     --out-dir var/policy-change-review
   ```

4. Review every affected alias, complete before/after Rust decision, added/removed
   members and provider change. The review hashes bind all four input files and
   exact SQL. Review-only output contains no current activation or approval.
   A policy or desired-state digest change invalidates policy-bound proof and
   ordinary authority for every route in that revision; the review lists that
   larger requalification scope even when only two aliases change recipients.
5. Qualify additive migration 0016 and the selected governed atomic import path.
   Upload the candidate content-addressed R2 policy through its separately
   reviewed operation, then apply the exact guarded SQL as **one transaction**.
   Never split its review guard from its projection. No raw remote execution is
   offered by this compiler. Existing bootstrap compilation remains compatible.
6. If either active base digest changed, the database aborts before replacement.
   Fetch current evidence and prepare a new review; never overwrite the newer
   state or replay an uncertain operation. A later SQL failure must roll back
   the entire import, including the review record. The provider path must prove
   this behavior before use; local SQLite qualification is not remote D1 proof.
7. Read back exact candidate policy, inventory, review row and runtime bindings.
   Incomplete/unknown effects require reconciliation. Bind the review to the
   governed operation's actor and approval receipt for audit correlation.

Policy changes affect future admission. Old claims, accepted sends and uncertain
attempts retain their original identity; current safety checks may deny pending
dispatch. Changing membership grants no ordinary reply activation, cannot recall
mail already delivered, and never authorizes replay of an ambiguous send.

`review.json` and `projection.sql` are mode-0600 private preparation artifacts.
Treat an unneeded candidate R2 object as staged data, not an active policy.
Containment and recovery retain the existing reply and cutover contracts.
