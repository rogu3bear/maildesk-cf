# D1 schema evidence contract

`scripts/d1-schema-evidence.ts` is a pure, offline comparator. It neither calls a
provider nor executes SQL, authorizes migrations, advances readiness, or proves
that a response came from a provider. Its result always has
`qualifies_release: false`.

The caller supplies independently authenticated, reviewed inputs:

- An exact source commit and tree, ordered migration names and byte digests,
  ledger bootstrap byte digest, and expected-schema digest. The source owner
  must independently derive and review the expected schema from the complete
  frozen migration bytes and the target's separately qualified ledger
  bootstrap. The comparator checks those supplied bytes against the reviewed
  digests; it does not itself authenticate Git objects or prove that an
  arbitrary expected schema was derived from them. A caller must not construct
  both its trust anchors and observations from the same untrusted response.
- An exact account/database target and independently authenticated, complete
  fixed-query receipts for the ledger and schema responses. Each receipt names
  the target, response kind and SHA-256 of the original response bytes. The
  transport owner must establish that the receipts bind the exact requests,
  provider, execution, response and freshness; a caller-supplied `complete`
  flag alone is not that proof.
- Original JSON response bytes, not reserialized JSON. The complete ledger is
  ordered by ID; the schema rows are ordered by type and name and contain the
  exact SQLite schema definitions. Bounds are strictly below 100 ledger rows
  and 500 schema rows, so a query reaching its limit holds. The current caller
  must issue bounded queries that can prove completeness.

The comparator requires the ledger to contain exactly the reviewed ordered
migration names, validates original-byte hashes and target bindings, and checks
all schema rows—including definitions of tables, indexes, views and triggers—
against the separately reviewed schema. Duplicate JSON keys, duplicate or
reordered rows, malformed envelopes, changed definitions, partial data and
wrong-target receipts hold. SQL is compared exactly; semantically equivalent
provider formatting or SQLite-version differences can hold and require review,
not weaker comparison. The result separates each original response-byte hash
from a comparison hash over the parsed ledger and reviewed schema.

Public and private migration numbering and content differ. Each consumer must
bind its own complete source manifest, bootstrap and independently reviewed
expected schema; never reuse one repository's migration manifest for the other.
The fixture derives a reference by applying the public committed migration
sequence to disposable in-memory SQLite and verifies the 0018 no-reopen and
cross-mode protections. This is a local comparison oracle, not an actual D1
schema receipt. Provider execution, drain, independent post-effect readback,
pending/unknown outcome preservation, cleanup, retention and authenticated
provider-ID correlation remain separate gates. The existing D1 readiness check
remains `not_checked` until an owned evidence adapter and its trust boundary are
independently qualified.
