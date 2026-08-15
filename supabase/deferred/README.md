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
