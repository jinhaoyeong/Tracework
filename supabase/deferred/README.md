# Deferred migrations

Migrations here are **reviewed and merged but deliberately excluded from the
rollout**. `supabase db push` reads `supabase/migrations/` only, so nothing in
this directory is applied to any environment.

They are not abandoned and their history is intact. Moving a file back into
`supabase/migrations/` is all that is needed to reinstate it.

## `20260815000100_tracework_6d4a_authenticated_library_read.sql`

Phase 6D4A — authenticated private/workspace library reads. Merged in `56105c0`,
never applied to any environment except a disposable proof project that has since
been deleted.

**Why it is deferred.** 6D4A grants `authenticated` direct `SELECT` through
PostgREST on `tracework_collections`, `tracework_library_documents`, and four
columns of `workspace_members`. Those grants are reachable independently of the
application: `TRACEWORK_AUTHENTICATED_LIBRARY_READS` gates Tracework's route
composition, **not** the Data API surface the grants create. Turning the flag off
does not revoke them; only a `REVOKE` does.

The shared public-index product — a signed-in user submits, a publisher reviews,
anyone reads once published — does not need any of that. It runs entirely on the
6D2A service-role RPC path.

**Nothing depends on it.** Audited 2026-08-15:

* Phase 6E's preconditions require the 6D2B constraints and the three 6D2A
  functions. They assert nothing about 6D4A, so 6E applies cleanly straight after
  6D3. Every 6D4A mention in the 6E migration is a comment.
* The 6E handlers use `callSupabaseRpc` (service role). `callSupabaseRest`, the
  caller-JWT path that needs 6D4A's grants, is used only inside the flag-gated
  composed branch of the pre-existing catalog routes.
* No 6E client code reads the 6D4A-only `scope` field.

## The resulting sequence IS runtime-proven

Deferring 6D4A changed the order production will apply, and that order has now
been executed against a real PostgreSQL.

| Sequence | Status |
|---|---|
| `6D3 -> 6D4A -> 6E` | runtime-proven on a disposable project, 2026-08-15 |
| `6D3 -> 6E` (6D4A absent) | **runtime-proven, 2026-08-27** |

The 2026-08-27 proof ran on disposable project `vxdcgixymlltdjpujgwu`, created
for it and retained for review. Production (`xbphaeuvthyfonyflhwb`) was not
touched: no migration, no SQL, no Auth mutation, no environment change, no
deployment. No provider call of any kind was made — every embedding was a
deterministic synthetic 1536-dimension vector.

**What it established.**

* The chain `6B -> 6D2A -> 6D2B -> 6D3 -> 6E` applies cleanly with 6D4A absent.
  `20260815000100` was never applied and is absent from `schema_migrations`.
* Measured in the live catalogs rather than inferred from SQL: `authenticated`
  holds **no** table privilege and **no** column privilege on any of the six
  tables, so 6D4A's Data API grants are genuinely absent and the six 6D3
  policies are inert. `anon` holds nothing either. Only `service_role` has DML.
* All nine `tracework_*` functions are `SECURITY INVOKER`, with `EXECUTE` to
  `service_role` alone. The three 6D2A read functions still carry both
  containment predicates; 6E did not redefine them.
* `scripts/bootstrap-shared-collection.mjs` was proven against a real project:
  eight fail-closed guards, dry-run with zero writes, `--apply`, `--verify`,
  overwrite refusal, rollback while empty, recreate, and rollback **refused**
  once the collection held documents.
* The lifecycle works end to end. Ingest lands `pending`; publish promotes to
  `published`; only then does the document reach an anonymous reader.
* R1 (source-id hijack) fails closed. An attacker's own new document claiming
  another document's source id is refused, the victim keeps its lineage and its
  chunks, and the refusal names neither id.
* R9 (existence oracle) stays closed. For an unauthorised caller an existing and
  a nonexistent document return identical status, error code, message and
  response shape.
* 6D2A containment holds against real rows. With four documents in one
  collection sharing an identical embedding, anonymous search returned exactly
  one candidate — the `published` one. `pending`, `blocked` and `superseded`
  were hidden from both the catalog and the candidate set, so hidden rows do not
  influence `candidateCount`.

**What it did NOT establish.** The eleven Phase 6B identity rows — four
collection slugs and seven document ids — had to be hand-seeded before the chain
would pass, using the committed `scripts/seed-library.mjs`. That was explicit
test setup for the known portability debt, not a fix for it.
**Empty-database portability remains OPEN**: the chain still cannot replay from
a genuinely empty project, because `20260812000100` asserts content that no
migration creates.

`TRACEWORK_ALLOW_SHARED_WRITES` was enabled only inside the disposable runtime,
and only after the writes-closed state had been verified. It stays off
everywhere else.

**Consequence while deferred.** The composed catalog path in
`server/traceworkApi.ts` is unreachable: its flag is unset and its grants are
absent. `CollectionScope`, the `scope` field and the scope badges in
`KnowledgeLibrary.tsx` are inert. They are kept rather than excised because the
code is already inert and removing it would mean a large edit to files that are
covered by passing tests, for no runtime change.

**If private cloud storage is wanted later**, prefer an owner-scoped
`SECURITY DEFINER` RPC over reinstating this migration. That gives the same
capability without granting `authenticated` direct table access that no
application flag can withdraw.

`scripts/test-phase6d4a.mjs` still runs and still passes; it reads the migration
from this directory. It analyses the SQL statically and proves the migration is
correct **if applied** — which remains true while it is deferred.

## Phase 6E activation order

This order is authoritative. It is derived from the executable contracts — the
migration, the bootstrap script and the route handlers — and not from any commit
message. Each step is separately authorised; recording the order here is not a
licence to run it.

None of it has been executed. `6D3 -> 6E` with 6D4A absent is still **not**
runtime-proven, per the section above. This describes what to do once that proof
exists, not a state that has been reached.

### 1. Apply the Phase 6E migration

```
supabase/migrations/20260815081045_tracework_6e_explicit_publication.sql
```

Its preconditions are the 6D2B constraints and the three 6D2A functions, which
the migration asserts fail-closed before doing anything. It creates the three
publication RPCs and nothing else: no policy, no table grant, and no dependency
on any process environment value. **No mutation surface opens at this step.**

### 2. Configure `TRACEWORK_PUBLISHERS`

It must be configured **independently in two places**:

* the deployed Tracework runtime, which reads it when authorising a publish
  (`server/traceworkApi.ts:1071`);
* the operator environment running `scripts/bootstrap-shared-collection.mjs`,
  which reads it before any request and refuses to run when it is empty
  (`scripts/bootstrap-shared-collection.mjs:193`).

These are separate processes. Setting it in the deployment does not configure
the operator shell, and setting it in the shell does not configure the
deployment.

### 3. Bootstrap the shared collection

```
dry-run  ->  --apply  ->  --verify
```

The bootstrap:

* uses the service role and writes through PostgREST, never through a 6E RPC;
* requires the publisher allowlist, and requires `--owner` to be in it;
* requires a real `auth.users` owner, checked through the Auth admin API;
* does **not** read `TRACEWORK_ALLOW_SHARED_WRITES`;
* runs once per environment, outside the migration chain, after the chain has
  been applied;
* defaults to dry-run, refuses to modify an existing collection, and refuses
  rollback once the collection holds documents.

### 4. Verify mutation is still closed

Before activation, ingest and publish must still fail closed with:

```
shared_writes_disabled
```

This is the evidence that steps 1-3 did not open mutation. Applying the
migration, configuring publishers and creating the collection must all leave the
write boundary shut.

### 5. Set `TRACEWORK_ALLOW_SHARED_WRITES=true` LAST

This is the runtime activation switch for mutation
(`server/traceworkApi.ts:1053`). It must not be enabled until:

* the 6E RPCs exist;
* the publisher allowlist is configured;
* the contributable collection exists;
* the writes-closed state has been verified.

### The `8ee98d2` commit message is superseded

The commit message for `8ee98d2` described an earlier ordering in which
`TRACEWORK_ALLOW_SHARED_WRITES` was enabled *before* the Phase 6E migration was
applied. That ordering is superseded by this section.

The executable contracts are authoritative, and they say:

* the Phase 6E migration does not depend on process environment — its only
  mention of `TRACEWORK_PUBLISHERS` is a comment recording that the database has
  no notion of that value;
* `bootstrap-shared-collection.mjs` states it runs once per environment, outside
  the migration chain, **after** the chain has been applied;
* the bootstrap requires `TRACEWORK_PUBLISHERS` and never reads
  `TRACEWORK_ALLOW_SHARED_WRITES`;
* `TRACEWORK_ALLOW_SHARED_WRITES` is the final switch that opens mutation.

History is not rewritten and `8ee98d2` is not amended. The commit prose stays as
a record of the reasoning at the time; this section is what to follow.

### What the bootstrap does not solve

`scripts/bootstrap-shared-collection.mjs` creates the first
contributor-writable collection. It does **not** solve the Phase 6B
empty-database requirement for the eleven pre-existing corpus identity rows —
four collection slugs and seven document ids that `20260812000100` asserts and
that no migration creates.

Those are different problems. The empty-database replay debt remains open.
