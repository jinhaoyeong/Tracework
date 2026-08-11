# Phase 6 requirement: shared must mean intentionally shared

Recorded 2026-08-11, when the knowledge library moved into Postgres. Nothing here
is implemented. It exists so Phase 6 starts from a concrete requirement instead
of an unscoped "add auth" task.

## What the library foundation actually delivered

A **system-seeded** shared library: an operator runs `npm run seed:library`, and
every device reading the same database discovers the same catalog.

```text
operator seeds  ->  database library  ->  everyone consumes
```

The originally described model is a **user-contributed** one, and it is not built:

```text
user uploads -> ownership -> visibility -> safe mutation -> others retrieve
```

## The boundary this exposed

Every route under `api/` runs on the Supabase service role and has no notion of a
caller. There is no authentication, origin check, or rate limit. On a reachable
deployment with the environment configured, that made `/api/vector/sync` and
`/api/vector/delete` an anonymous write and delete path into shared knowledge.
The vector-shape validation on `sync` was not a barrier, because an attacker can
mint conforming vectors for free from the same deployment's `/api/embed`.

Stable library ids (`library-meridian-access-programme`) are **correct** and
should not be reverted — they are what stops two devices producing duplicate rows
for one source. Predictability was never the defect. The defect was a predictable
id plus an unauthenticated privileged delete endpoint.

## Current stopgap, and its limits

`TRACEWORK_ALLOW_SHARED_WRITES` gates the two write routes. Deployed handlers
refuse unless it is exactly `true`, so forgetting the variable leaves a
deployment safe rather than open; the local Vite dev server allows writes unless
it is `false`. When writes are refused, pgvector retrieval degrades to read-only
rather than failing, so a public demo can still search the seeded library.

This removes the poisoning and deletion paths. It does **not** establish
identity, so it is a mode switch, not a permission model:

| Route | Development / private | Public demo |
| --- | --- | --- |
| `/api/library/*` | allowed | allowed |
| `/api/vector/search` | allowed | allowed |
| `/api/vector/sync` | allowed | refused |
| `/api/vector/delete` | allowed | refused |
| `/api/embed`, `/api/generate` | allowed | still consumable; use deployment protection |

`/api/embed` and `/api/generate` remain open on an enabled deployment because a
public app needs them to work. Without identity, anyone can spend the quota.
Deployment protection is the honest operational answer today; rate limiting
reduces abuse but does not establish identity or ownership.

Until the model below exists: do not put private or company data in the shared
production library.

## Required permission model

```text
read shared library              authenticated
create knowledge                 authenticated
update own knowledge             owner or admin
delete own knowledge             owner or admin
delete system/library knowledge  admin only
publish private -> shared        permission-controlled
embed / generate                 authenticated, with quota and rate limit
vector RPC                       server validates caller and ownership;
                                 never trusted from browser identity alone
```

## Schema this implies

Sources need `created_by`, `workspace_id`, `visibility` (`private` / `shared` /
`system`), `source_role`, `created_at`, `updated_at`, alongside the existing
`provenance`. `system` marks the seeded collections so ordinary users cannot
mutate them.

The principle to hold on to: **shared knowledge must be knowledge someone
intentionally shared — not knowledge that is reachable because every request
happens to run through a service-role backend.**
