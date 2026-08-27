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

## ⚠️ The resulting sequence is NOT runtime-proven

Deferring 6D4A changes the order production will apply. **Do not claim this
sequence has been tested, because it has not.**

| Sequence | Status |
|---|---|
| `6D3 -> 6D4A -> 6E` | runtime-proven on a disposable project, 2026-08-15 |
| `6D3 -> 6E` (6D4A absent) | **static analysis only** |

The disposable proof applied the whole chain in filename order, so 6D4A was
already present when 6E ran. The sequence production will now use — 6E straight
after 6D3, with 6D4A never applied — has never been executed against a real
PostgreSQL.

The static case that it will work: 6E's preconditions require only the 6D2B
constraints (`publication_state` and `visibility` CHECKs, validated) and the
three 6D2A functions carrying both containment predicates. They assert nothing
about 6D4A, and every 6D4A mention in the 6E migration is a comment. Its RPCs use
`callSupabaseRpc` (service role) and never the caller-JWT path 6D4A's grants
serve.

That is a strong argument, not a proof. Both defects found in 6E review — the R1
source hijack and the R9 error-message oracle — passed static analysis and were
caught only by execution. Closing this gap needs a new disposable project, which
is a separate authorisation; the previous one (`tpaczjiptkdmahomtffg`) has been
deleted.

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
