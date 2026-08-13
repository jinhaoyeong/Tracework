# Tracework Phase 6B2F: Phase 6B2E migration closeout

Status: closeout draft; uncommitted for review
Closeout date: 2026-08-13
Phase 6B2E classification: **PASS — POST_6B2C state independently verified**

This document closes the reviewed Phase 6B2E schema/lineage migration after a
read-only reconciliation of the live database. It records the migration
execution-process anomaly explicitly: the migration was already present in
remote history when the latest authorization turn began. The latest turn did
not rerun or reapply it. The resulting state was independently reconciled to
the reviewed migration and passes the required preservation and lineage gates.

## Scope and boundary

Target Supabase project:

```text
Name: Tracework
Project ref: xbphaeuvthyfonyflhwb
```

Reviewed migration:

```text
supabase/migrations/20260812000100_tracework_phase6b_ownership_compatibility.sql
```

Repository checkpoint:

```text
HEAD: 68d37642a6974d1a52dc231854df6ba363a5a06a
Short HEAD: 68d3764
Branch: main
origin/main...HEAD: 0 0
```

The Phase 6B2F action was documentation-only. It made no database mutation,
made no provider call, did not modify the migration or application code, and
did not commit or push this report. Phase 6C authentication, Phase 6D RLS
authorization, and Phase 6E retrieval isolation were not started.

## Execution-process anomaly and reconciliation

The latest controlled-migration authorization was not used to execute the SQL:
the fresh remote migration history and catalog preflight already showed the
database in `POST_6B2C`. Reapplying the migration would have violated the
exact-one-execution and no-rerun boundary.

Prior agent-session evidence records the earlier application:

```text
Command: supabase migration up --linked --yes --log-level info
Result: exit code 0
Applied path:
  supabase/migrations/20260812000100_tracework_phase6b_ownership_compatibility.sql
```

The associated agent-side evidence timestamps were:

```text
M1 before-state capture: 2026-08-12T09:32:41.408Z
Migration success evidence: approximately 2026-08-12T09:35:05.020Z
Post-state capture: 2026-08-12T09:36:52.982Z
```

These are timestamps from the prior agent session, not server-side audit-log
timestamps. The available migration history contains only the three expected
migrations, and the reconciliation below proves that the live data matches
the reviewed migration's deterministic result. Exact database actor identity
and an independent server-side commit timestamp could not be proved because
historical Postgres logs were unavailable to the agent session.

## Migration history and catalog state

The linked remote migration history at reconciliation contained exactly these
expected rows and no unrelated recorded migration:

| Version | Name | Statements | Remote statement digest |
| --- | --- | ---: | --- |
| `20260809000100` | `tracework_pgvector` | 19 | `aba250e434d2c17c52f805c859172e17` |
| `20260811000100` | `tracework_knowledge_library` | 23 | `66351b33c43d3cfd31e82ffafddba69c` |
| `20260812000100` | `tracework_phase6b_ownership_compatibility` | 47 | `d5e51ec719c86f8efbf0211e41dd08fa` |

The reviewed migration file remained unchanged from the repository checkpoint
and had SHA-256:

```text
77B120408ACBED0FD966E800D8484930BDF9B299D9392DA34DC8691E71EF1842
```

The read-only catalog preflight reported:

```text
Migration state: POST_6B2C
Expected objects: 18
Present objects: 18
Missing objects: 0
Partial state: NO
```

## Before and after inventory

The M1 baseline was captured at `2026-08-12T09:32:41.408Z` UTC. The expected
data delta was one quarantine collection and one blocked quarantine document
per unmatched legacy source; existing source, chunk, and embedding rows were
not to be rewritten.

| Metric | M1 before | Reconciled after | Delta |
| --- | ---: | ---: | ---: |
| Collections | 4 | 5 | +1 |
| Documents | 7 | 33 | +26 |
| Sources | 30 | 30 | 0 |
| Chunks | 58 | 58 | 0 |
| Embeddings | 58 | 58 | 0 |
| Unmatched legacy sources | 26 | 26 parented to quarantine documents | n/a |

Stable-ID digests were:

| Identity set | M1 before | Reconciled after | Result |
| --- | --- | --- | --- |
| Collections | `5ab404b31d54e94d64afb1f554db02fdb704d9745a1976788ac05e3195e08687` | `96a12de84c2c9dacda882967337d08f2b4426a4f30306935509d7588350c822c` | expected +1 collection |
| Documents | `dde1549886ba427cb8ae4b0e6971db1a64ffaec55053b2588a53c3999cc036da` | `07cc825909865d4ea36d5320b335c5710813b3fa1091ee99f5550da2758af3c5` | expected +26 documents |
| Sources | `132f00afd914b68aa40d9a1fe8a4c9950cbe08add5cd9c4c13bf267324d2ffe0` | `132f00afd914b68aa40d9a1fe8a4c9950cbe08add5cd9c4c13bf267324d2ffe0` | identical |
| Chunks | `6f876f9d002ae39b852a6792408d2608928093351b334b042c6bac3e413eabda` | `6f876f9d002ae39b852a6792408d2608928093351b334b042c6bac3e413eabda` | identical |

## Preservation evidence

The reconciliation proved:

- The original source ID set was identical: 30 of 30 preserved.
- The original chunk ID set was identical: 58 of 58 preserved.
- The original 58 embedding rows were preserved; no re-embedding occurred.
- The source row digest was unchanged:
  `b9c798484a262ccbec4d11b6ba8a748d01b2d1ef2c654af0d05b141e479df08a`.
- The chunk row digest was unchanged:
  `b0220c5441f1b7a295a552daab0095be903c9e649ea04aee2f6807528aa9a1da`.
- The embedding-vector preservation digest was unchanged:
  `43f5145271c843cbb9d5fe59570293afc52bf7a4488f382a620a9caee97b91f3`.
- Source and chunk content/hash comparisons reported zero mismatches.
- All 58 current chunks reconstructed from the preserved source content using
  the repository chunker (`src/lib/rag.ts`, maximum chunk size 720): 30/30
  sources and 58/58 chunks matched, with no offset or text mismatches.
- Every embedding remained model `text-embedding-3-small`, dimension 1536;
  null embeddings and malformed embeddings were both zero.

No source content, chunk content, provenance, stable identity, vector payload,
or embedding model was rewritten.

## Known source/document lineage

The four deterministic known source mappings were exact stable-identity
mappings and had zero mismatches:

| Source ID | Document ID |
| --- | --- |
| `library-meridian-access-programme` | `library-meridian-access-programme` |
| `library-phase5c-authoritative-readme` | `library-phase5c-authoritative-readme` |
| `library-phase5c-changelog` | `library-phase5c-changelog` |
| `library-phase5c-project-history` | `library-phase5c-project-history` |

No title, path, content, provenance, similarity, or other inference was used
to assign these known parents.

The three Workshop documents remained legitimate published system catalog
records with no fabricated indexing rows:

```text
library-workshop-market-identity:      sources 0, chunks 0
library-workshop-trip-intelligence:    sources 0, chunks 0
library-workshop-rag-lab-notes:        sources 0, chunks 0
```

## Legacy quarantine

The 26 unmatched legacy sources present in the M1 baseline were retained and
each received exactly one deterministic quarantine document. The migration
created the `legacy-quarantine` collection with public scope metadata and the
controlled contributor `system:legacy-import`; this scope metadata does not
make its blocked documents searchable.

Each quarantine document used the retry-stable identifier:

```text
legacy-quarantine-source-<sha256(source_id)>
```

All 26 quarantine documents were verified as:

```text
collection_id       = legacy-quarantine
publication_state   = blocked
created_by_system_key = system:legacy-import
provenance          includes legacySourceId
provenance          includes quarantineReason = unresolved-parentage
provenance          includes migrationBatch = 20260812000100
```

The original source IDs, source content, source provenance, chunk IDs, chunk
content, and embeddings remained attached to their original source rows. The
reconciliation reported:

```text
Unmatched sources before:       26
Quarantine documents created:   26
Sources successfully parented:  30/30
Ambiguous mappings:             0
Unparented sources:             0
Orphan sources:                 0
Orphan chunks:                  0
```

Using the reviewed future eligibility predicate — authorized collection,
public scope, and `publication_state = 'published'` — zero blocked quarantine
documents were eligible. This proves the migrated metadata is ready for the
future isolation predicate; it does not claim that the current production
retrieval route already enforces that predicate.

## Scope and publication result

```text
Known system collections:              4, all visibility = public
Known bundled documents:               7, all publication_state = published
Quarantine documents:                  26, all publication_state = blocked
Unknown documents accidentally public: 0
```

The four known collections retained the bundled system contributor contract.
The seven known bundled documents retained `system:bundled-library` as their
system contributor. The 26 unknown legacy items were not promoted to
`published`.

## Security surface intentionally not cut over

Phase 6B2E prepared schema, publication metadata, and canonical lineage only.
It did not complete the security implementation:

| Surface | Closeout result |
| --- | --- |
| Authentication / principal | Not implemented |
| New end-user RLS policies | None; public policy count 0 |
| Table-level RLS | Enabled on the protected Tracework tables; not forced; no end-user policy cutover |
| RPC cutover | None; six existing RPCs remain `SECURITY INVOKER`, owner `postgres` |
| Route cutover | None |
| Retrieval behavior | Unchanged |
| Generation behavior | Unchanged |
| Provider calls | 0 |

The current grants also remained service-role-only for the Tracework tables
and RPC execution; no anonymous or authenticated end-user access model was
introduced by this closeout. Authentication, authorization policies,
authenticated RPCs, route guards, retrieval isolation, contribution controls,
and provider-cost controls remain later-phase work.

## Verification record

The reconciliation used read-only migration-history checks, the catalog
preflight, the M1/post inventory comparison, direct preservation digests,
known-lineage checks, quarantine checks, and deterministic chunk
reconstruction. Repository checks recorded at the 6B2E checkpoint passed:

```text
npm.cmd run check                         PASS
npm.cmd run build                         PASS
npm.cmd run validate:phase6b-migration   PASS
npm.cmd run validate:phase6b-catalog-preflight PASS
npm.cmd run inventory:phase6b -- --plan  PASS
git diff --check                          PASS
```

The validators and migration file remain repository-local artifacts. No
credential or database secret is included in this closeout.

## Final classification and next boundary

```text
PHASE 6B2E
PASS  POST_6B2C state independently verified
```

Phase 6B2F is complete as a documentation-only closeout and this file remains
uncommitted for review. Do not begin Phase 6C, 6D, or 6E from this checkpoint;
publication of this report and the next phase require separate review and
authorization.
