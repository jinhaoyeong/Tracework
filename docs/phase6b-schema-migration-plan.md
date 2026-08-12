# Phase 6B1: ownership, visibility, and legacy-migration contract

Status: design-only contract; uncommitted
Frozen implementation checkpoint: b54f13be134ac2b49b2dac9b7081dbdea2f012f9
Scope: schema and migration design only

This document freezes the data model and migration contract needed before
Phase 6B authentication, RLS, and route work. It is not a migration. No SQL
has been executed, no Supabase state has been changed, and no provider call
is part of this work.

## 1. Non-goals and invariants

Phase 6B1 does not:

- execute SQL or create/apply a Supabase migration;
- add authentication, RLS policies, route guards, or client identity plumbing;
- change retrieval, reranking, facet discovery, temporal reasoning, or
  generation;
- change the embedding model, regenerate embeddings, or reindex content;
- change the current anonymous demo behavior;
- publish an empty/status-only commit.

The following decisions are frozen for implementation review:

1. A collection has exactly one security scope: private, workspace, or public.
   Documents inherit the collection scope. There is no document-level
   visibility override.
2. Security scope is collection-level, while retrieval/publication eligibility
   is document-level. A document has one state: pending, published, blocked,
   or superseded.
3. Only documents whose publication_state is published can enter an authorized
   search candidate set. Pending, blocked, and superseded documents remain
   stored but are not searchable.
4. Private and workspace documents become published after successful
   ingestion/indexing. A public user contribution starts pending. A bundled
   system seed document is published.
5. The collection remains the security boundary. Every source has one
   canonical document parent, and every chunk has one canonical source parent.
6. Stable current collection slugs, document IDs, source IDs, chunk IDs,
   provenance, and embeddings are preserved during migration. New collection
   identifiers are opaque and generated, not title-derived.
7. Authorization is applied before similarity filtering, candidate counts,
   top-K selection, reranking, facet discovery, temporal reasoning, or
   generation.
8. Client-side filtering may narrow an already authorized result set for
   presentation; it may not implement visibility, publication, or tenant
   isolation.

## 2. Current production schema audit

The effective schema is the result of:

- supabase/migrations/20260809000100_tracework_pgvector.sql
- supabase/migrations/20260811000100_tracework_knowledge_library.sql

The following is an audit of the repository migrations, not a claim that a
live database has been queried in this design-only step. Migration M1 below
must inventory the actual database before changing anything.

### 2.1 Current tables

| Table | Current columns and constraints | Current indexes/relationships |
| --- | --- | --- |
| tracework_collections | slug text primary key; title text not null; description text not null default ''; kind text not null with note/file/sample check; provenance jsonb not null default '{}'; sort_order integer not null default 0; created_at timestamptz default now(); updated_at timestamptz default now() | Primary-key index on slug; referenced by tracework_library_documents.collection_slug with on delete cascade |
| tracework_library_documents | id text primary key; collection_slug text not null; title; source_path; kind with note/file/sample check; content; provenance jsonb not null default '{}'; sort_order integer default 0; created_at timestamptz default now() | Index on (collection_slug, sort_order); foreign key to collections with on delete cascade |
| tracework_sources | id text primary key; title; source_path; kind with note/file/sample check; content; file_type; created_at timestamptz; provenance jsonb added by the second migration | No document or collection foreign key; source is currently independent of the library-document table |
| tracework_chunks | id text primary key; source_id text not null; chunk_index integer with >= 0 check; content; start_offset integer >= 0; end_offset integer >= start_offset; embedding extensions.vector(1536); embedding_model; created_at | Foreign key to sources with on delete cascade; unique (source_id, chunk_index); HNSW cosine index on embedding |

All four tables currently have RLS enabled but no end-user policies in the
repository migrations. The current intended access path is service-role
execution. That is not yet an ownership model and must not be mistaken for
one.

### 2.2 Current RPC and route dependencies

| Current function | Current behavior | Required Phase 6B disposition |
| --- | --- | --- |
| tracework_upsert_collection(jsonb, jsonb) | Upserts by collection slug, deletes and replaces all library documents, then inserts the supplied documents | Split into ownership-aware collection creation/update and controlled document replacement; assign document publication state per ingestion policy; retain a restricted system-seed path |
| tracework_list_collections() | Lists all collections and document counts | Replace with an authorized invoker path; never expose all rows by default |
| tracework_collection_documents(text) | Lists documents for a supplied slug | Replace with a collection-authorization check; expose publication state only as appropriate and never treat collection scope as document eligibility |
| tracework_replace_source(jsonb, jsonb) | Upserts a source by ID, deletes its chunks, and inserts replacement chunks | Require the canonical document parent and authorization; retain a restricted system-seed path |
| tracework_delete_sources(text[]) | Deletes arbitrary source IDs | Replace with document/collection-scoped deletion; arbitrary source-ID deletion is not an end-user contract |
| tracework_match_chunks(vector(1536), double precision, integer, text) | Joins all chunks to sources, applies kind/distance filters, counts candidates, and returns top-K | Replace with an authorized collection CTE before every candidate operation |

The current API dependencies are:

- GET /api/library/collections -> tracework_list_collections;
- GET /api/library/documents -> tracework_collection_documents;
- POST /api/vector/sync -> tracework_replace_source;
- POST /api/vector/search -> tracework_match_chunks;
- POST /api/vector/delete -> tracework_delete_sources;
- scripts/seed-library.mjs -> tracework_upsert_collection.

TRACEWORK_ALLOW_SHARED_WRITES is only a deployment/write gate. It is not
identity, ownership, authorization, or a substitute for RLS.

## 3. Target ownership graph

The target relationship is:

~~~text
auth.users
  ├── workspaces.created_by_user_id
  ├── workspace_members.user_id
  ├── collections.owner_user_id
  ├── collections.created_by_user_id
  └── library_documents.created_by_user_id

workspaces
  ├── workspace_members
  └── tracework_collections (visibility = workspace)
        └── tracework_library_documents
              └── tracework_sources
                    └── tracework_chunks
~~~

public and private collections do not require a workspace parent. Workspace
collections require one. Documents do not acquire an independent security
scope. A source is a derived indexing representation of one document, and a
chunk is a derived vector representation of one source.

## 4. Proposed table contract

The following is a field-level contract, not executable SQL. Exact SQL types
and helper functions may be adjusted during the implementation review only if
they preserve these invariants.

### 4.1 workspaces

| Column | Contract |
| --- | --- |
| id | uuid primary key default gen_random_uuid() |
| name | text not null, user-visible workspace name |
| created_by_user_id | uuid not null references auth.users(id) on delete restrict |
| created_at, updated_at | timestamptz not null default now() |

The creator is the initial owner candidate. Membership, not the creator column,
is the authoritative access relation after creation.

### 4.2 workspace_members

| Column | Contract |
| --- | --- |
| workspace_id | uuid not null references workspaces(id) on delete cascade |
| user_id | uuid not null references auth.users(id) on delete cascade |
| role | owner, member, or viewer |
| status | invited, active, or suspended |
| invited_by_user_id | nullable uuid references auth.users(id) on delete set null |
| joined_at | nullable timestamptz |
| created_at, updated_at | timestamptz not null default now() |

Primary key: (workspace_id, user_id). Search authorization requires
status = active; an invitation or suspended membership is not sufficient.
Multiple active workspace owners are allowed. The workspace must not be allowed
to reach zero active owners. The final-owner protection is a future
transactional/application-side or database-function invariant, not a partial
unique owner index. The enforcement mechanism remains an implementation
decision for 6B.

### 4.3 tracework_collections

Keep slug text primary key as the compatibility identifier for the first
ownership migration. Existing seed and legacy slugs are preserved. Repository
inspection found that current seed code passes authored literal slugs through
the seed RPC; production code does not currently generate user slugs. The
current text key is therefore stable for the bundled seeds but is not an
opaque/generated identifier contract for future user collections.

The smallest safe 6B rule is: new collections receive a globally unique,
opaque, immutable generated slug, while title remains display-only. A title
such as "notes" must never be used directly as the primary key. A future
human-readable alias would need its own scoped uniqueness model and is outside
6B1. Do not change the existing key shape in this design-only step.

| Column | Contract |
| --- | --- |
| slug | existing stable text primary key for compatibility; immutable; new values are opaque/generated rather than title-derived |
| title, description, kind, sort_order | existing fields and checks retained |
| visibility | private, workspace, or public; default private |
| workspace_id | nullable uuid references workspaces(id) on delete restrict |
| owner_user_id | nullable uuid references auth.users(id) on delete restrict |
| created_by_user_id | nullable uuid references auth.users(id) on delete restrict |
| created_by_system_key | nullable controlled system-contributor identifier |
| provenance | existing jsonb not null default '{}'; retain import/source metadata |
| created_at, updated_at | existing timestamps, made non-null during controlled migration |

Required checks:

- visibility = private -> owner_user_id is present and workspace_id is null;
- visibility = workspace -> workspace_id is present and owner_user_id is null;
- visibility = public -> workspace_id and owner_user_id are null;
- exactly one creator is present: a user creator or a controlled system key;
- a system-created collection must be public;
- a non-public collection must have a user creator;
- collection scope is independent of each document's publication_state;
- the collection has no publication state in Phase 6B1.

owner_user_id means the private collection owner. It is not a substitute for
workspace membership and is intentionally null for workspace collections.

#### Slug audit result

The current repository has four authored seed slugs and passes them unchanged
through the seed script and the collection upsert RPC. The current API also
accepts a caller-supplied slug for document lookup. There is no production
slugify/generation path that proves user titles are safe as globally unique
keys, and the existing primary key has no owner/workspace namespace.

Therefore, keeping the text primary key is safe only as a compatibility
contract for existing stable seed/legacy values plus newly generated opaque
values. 6B must generate a collision-resistant slug before creating a user
collection and must never derive it directly from title text. A human-readable
title remains metadata. A scoped display alias, if later needed, must be a
separate field with an explicit uniqueness policy.

### 4.4 tracework_library_documents

| Column | Contract |
| --- | --- |
| id | existing stable text primary key |
| collection_id | target name; text not null references tracework_collections(slug) on delete cascade |
| collection_slug | temporary compatibility alias during migration only; remove after all readers use collection_id |
| title, source_path, kind, content, sort_order | existing fields and kind check retained |
| publication_state | pending, published, blocked, or superseded; default pending |
| content_hash | deterministic SHA-256 of canonical document content; required before final constraint |
| source_url | nullable source locator |
| document_date, source_last_updated_date | nullable temporal/provenance fields |
| provenance | existing jsonb not null default '{}' |
| created_by_user_id | nullable FK to auth.users(id) on delete restrict |
| created_by_system_key | nullable controlled system-contributor identifier |
| created_at | existing timestamp |

Documents have no visibility, owner, or workspace_id columns. Security scope is
inherited from collection_id, but publication_state is deliberately
document-level. Require exactly one document creator, and enforce uniqueness
of (collection_id, content_hash) after duplicate inventory. Stable IDs must
remain unchanged for known seeded documents.

Publication state is set by ingestion policy: private and workspace documents
become published after successful indexing; public user documents remain
pending until explicit approval; system seed documents are published by the
controlled importer. A document must never become published merely because its
collection is public or already contains other published documents; collections
have no publication state.

### 4.5 tracework_sources

| Column | Contract |
| --- | --- |
| id | existing stable text primary key |
| document_id | new text not null references tracework_library_documents(id) on delete cascade |
| title, source_path, kind, content, file_type | existing source fields and kind check retained |
| indexed_content_hash | SHA-256 of exact content used to create chunks |
| provenance | jsonb not null |
| created_at, updated_at | timestamptz not null |

Phase 6B uses one canonical source per library document, enforced with a
unique index on document_id. If future ingestion needs multiple source
versions, it must add an explicit version model rather than silently dropping
the parent relation.

### 4.6 tracework_chunks

Retain the current chunk identity and vector contract:

- id text primary key;
- source_id text not null with on delete cascade;
- non-negative chunk_index, unique per source;
- content, non-negative offsets, and end_offset >= start_offset;
- extensions.vector(1536) embedding and embedding_model;
- created_at.

Chunks contain no copied visibility, workspace, owner, or publication fields.
Their security is derived through source_id -> document_id -> collection_id.
Retain the composite unique index (source_id, chunk_index) and the HNSW
cosine index on embedding.

## 5. Scope and document publication state machine

Collection scope and document retrieval eligibility are separate dimensions:

~~~text
collection
  └── visibility / owner / workspace
        └── document
              └── publication_state
                    └── source -> chunks
~~~

The collection has no publication state in Phase 6B1. A collection can contain
many documents with different moderation or supersession states.
An active/archived collection lifecycle is also omitted from Phase 6B1; the
document states, explicit deletion workflow, and provenance retention are
enough for the current security boundary.

| Collection scope/origin | Document after successful ingestion | Searchable state | Approval rule |
| --- | --- | --- | --- |
| private user collection | published automatically after indexing succeeds | only to the private owner | no separate human publish step |
| workspace collection | published automatically after indexing succeeds | only to active workspace members | no separate human publish step for normal workspace ingestion |
| public user contribution | pending | not globally searchable until published | explicit moderation/approval workflow |
| bundled system seed | published | searchable within the public system-seed boundary | controlled system import only |

Document state transitions are:

~~~text
pending -> published
pending -> blocked
published -> blocked
published -> superseded
blocked -> pending       (explicit review only)
~~~

Private/workspace auto-publication occurs only after successful source/chunk
creation and embedding persistence. An ingestion failure leaves the document
pending or marks it blocked according to the failure policy; it must not enter
retrieval partially.

superseded is terminal for the indexed document version unless an explicit
review reactivates it or a replacement document is created. A blocked or
superseded document is retained for provenance/history but fails the
authorized-search predicate. Blocking Document B does not hide Document A in
the same collection. Superseding Document C does not supersede the collection.

The Phase 5D claim-level temporal state remains separate. Document publication
eligibility answers whether a document may enter retrieval; claim-level
temporal reasoning answers whether a proposition is current, historical,
proposed, or otherwise applicable within an already authorized document.

## 6. Contributor, owner, workspace, and provenance

These concepts are separate:

| Concept | Meaning | Stored where |
| --- | --- | --- |
| contributor | actor that created or imported a collection/document | created_by_user_id or controlled created_by_system_key |
| owner | user who controls a private collection or explicit ownership workflow | owner_user_id on a private collection; one or more active owner roles for workspace scope |
| workspace | membership boundary for shared collections | workspace_id plus active workspace_members rows |
| provenance | evidence about origin, source, importer, dates, and lineage | provenance JSON plus normalized dates/locators |

Do not encode user identity in free-form provenance, client metadata, or
user_metadata. Foreign keys and active membership are authoritative.

The bundled seed contributor is the controlled key system:bundled-library. It
has no fake auth.users row, no owner, and no workspace. The four known seed
collections are:

- workshop-notes;
- meridian-access-programme;
- phase-5c-conflict-set;
- phase-5c-authority-record.

They remain public collections whose seven bundled documents are published
system content. Their stable collection slugs, document IDs, source IDs, chunk
IDs, provenance, and embeddings must be preserved. An unknown document added
under one of these collections is still blocked or pending according to its
own state; it does not inherit the seed documents' publication eligibility.

## 7. Derived lineage and deletion

The canonical chain is:

~~~text
collection -> document -> source -> chunk
~~~

Every source must point to exactly one document. Every chunk must point to
exactly one source. A search row must walk this chain without guessing from a
path, title, or JSON provenance.

The intended delete behavior is:

- deleting a workspace cascades to memberships and is blocked if a collection
  still references it via on delete restrict;
- deleting a collection cascades to its documents, sources, and chunks;
- deleting a document cascades to its source and chunks;
- replacing a source replaces its chunks only after authorization and hash
  validation;
- deleting by an arbitrary source-ID list is not an end-user operation.

Ownership and creator foreign keys use restrict or an explicit account deletion
workflow. Account deletion must not silently transfer private data to an
unrelated user.

## 8. Authorized-search contract

The search RPC must authenticate the principal and authorize collections before
selecting published documents or performing any operation that can reveal
membership, corpus size, relevance, or content. The required logical order is:

~~~text
authenticate principal
        -> authorized collections
        -> documents where publication_state = published
        -> sources
        -> chunks
        -> vector/lexical similarity
        -> candidate count
        -> top-K
        -> optional rerank
        -> facet/temporal/coverage processing
        -> generation, only if the deterministic gate permits it
~~~

The authorization CTE below is pseudocode for review. It is deliberately not a
migration and omits implementation-specific parameter declarations:

~~~sql
with authorized_collections as (
  select c.slug, c.visibility
  from public.tracework_collections as c
  where (
      c.visibility = 'public'
      or (
        c.visibility = 'private'
        and c.owner_user_id = auth.uid()
      )
      or (
        c.visibility = 'workspace'
        and exists (
          select 1
          from public.workspace_members as wm
          where wm.workspace_id = c.workspace_id
            and wm.user_id = auth.uid()
            and wm.status = 'active'
        )
      )
    )
    and (p_collection_ids is null or c.slug = any(p_collection_ids))
    and (p_workspace_id is null or c.workspace_id = p_workspace_id)
),
authorized_documents as (
  select
    d.id,
    d.collection_id,
    d.title,
    d.publication_state,
    ac.visibility
  from public.tracework_library_documents as d
  join authorized_collections as ac on ac.slug = d.collection_id
  where d.publication_state = 'published'
),
authorized_chunks as (
  select
    ch.id,
    ch.source_id,
    ch.content,
    ch.embedding,
    ad.id as document_id,
    ad.collection_id,
    ad.visibility
  from public.tracework_chunks as ch
  join public.tracework_sources as s on s.id = ch.source_id
  join authorized_documents as ad on ad.id = s.document_id
),
candidate_pool as (
  select
    ac.*,
    ac.embedding <=> p_query_embedding as distance
  from authorized_chunks as ac
  where ac.embedding <=> p_query_embedding <= p_match_threshold
)
select ...
from candidate_pool
order by distance asc
limit p_top_k;
~~~

The final implementation must bind caller identity through the authenticated
database context, not through a caller-supplied user ID. Public scope alone
never authorizes a row for anonymous demo search, and public scope alone never
implies that a document is eligible. The document publication predicate is
mandatory.

Candidate counts must count candidate_pool, never all chunks and never a
pre-authorization pool. Similarity thresholds must not be applied to rows the
caller is not authorized to see. Reranking, facet discovery, temporal
reasoning, and coverage operate only on authorized, published documents. A
route may request a narrow collection or workspace filter, but a client filter
cannot broaden the authorized set.

### 8.1 Anonymous demo boundary

Anonymous demo search is a deliberately narrower case:

- it may search only documents belonging to the four known system seed
  collections;
- those collections must be public, and each returned document must be
  published;
- it may not search public user contributions, including published public user
  documents, until that product behavior is explicitly approved;
- it may not search private or workspace collections;
- the system-seed collection allow-list and document publication predicate must
  be enforced in the database search path, not only in the browser;
- demo quota/rate limits remain a separate unresolved product decision.

This keeps the current demo useful while preventing the anonymous path from
becoming an accidental public tenant.

## 9. RPC and privilege transition

The current service-role-only functions should be replaced in stages. The
target is an authenticated invoker surface with RLS-compatible predicates and
a separately restricted internal import surface.

| Capability | Authenticated surface | Restricted internal surface |
| --- | --- | --- |
| create workspace/member | owner/workspace workflow | none beyond controlled account operations |
| create collection | user or workspace authorization; establishes collection scope only | system seed/import function |
| update title/content metadata | collection owner or workspace role | system seed/import function |
| publish/block/supersede document | owner for private; workspace owner/moderator; explicit public moderation workflow | system seed publication |
| list collections/documents | only authorized collections | internal inventory |
| replace document/source/chunks | authorized collection writer; canonical document parent required; set document state by scope policy | controlled system importer |
| delete | owner/workspace policy; document-scoped | controlled cleanup/import |
| match chunks | authorized invoker path | internal diagnostics with the same scope contract |

No function should be a broad service-role bridge that accepts a collection or
source ID and then bypasses ownership. If a privileged function is required for
an internal import, it must be non-exposed or tightly execute-granted, use a
fixed search_path, validate the system contributor key, and record an audit
event. SECURITY DEFINER is not a reason to skip authorization; it is a
privilege boundary that requires its own review.

The existing functions are not to be edited in 6B1. During 6B implementation,
the replacement sequence should be:

1. add and test the new ownership-aware functions;
2. keep old functions available only for the controlled compatibility window;
3. switch routes and seed tooling to the new functions;
4. revoke old execution grants;
5. remove old functions only after route and rollback verification.

## 10. Legacy-data mapping

Migration M1 must inventory live rows before applying any mapping. The
repository's bundled definitions are an allow-list for known seed identity,
not proof of what is present in the database.

### 10.1 Known bundled seed rows

The following four stable collection slugs map to:

| Legacy collection | Target scope | Target document state | Target contributor |
| --- | --- | --- | --- |
| workshop-notes | public | all known bundled documents published | system:bundled-library |
| meridian-access-programme | public | all known bundled documents published | system:bundled-library |
| phase-5c-conflict-set | public | all known bundled documents published | system:bundled-library |
| phase-5c-authority-record | public | all known bundled documents published | system:bundled-library |

For known seeds:

- preserve the existing collection slug;
- preserve every known document ID and collection association;
- preserve source and chunk IDs where they already exist;
- preserve content, provenance, source paths, and timestamps where possible;
- compute and record hashes without rewriting content;
- preserve every embedding and embedding model;
- attach each source to its known document;
- set collection/document creator to system:bundled-library, with no fake auth user;
- set each known bundled document to publication_state = published;
- do not re-embed or silently normalize source text.

If a new or unknown document is found under one of these known public
collections, classify that document independently. It must remain pending or
blocked until its own ingestion/moderation policy permits publication; it must
not inherit the known seed documents' state.

### 10.2 Unknown and orphan rows

Rows not proven to be one of the known bundled seeds must not be silently
published. They map to an explicit legacy quarantine:

- collection scope: public, so the row remains structurally migratable;
- every quarantined document: publication_state = blocked;
- creator: system:legacy-import;
- provenance: preserve original identifiers and add quarantine reason;
- search: excluded by the document publication predicate;
- owner/workspace: null until an explicit review assigns them.

The quarantine collection's public value is scope metadata only. No public read,
RLS, or search policy may test visibility = public by itself. Every retrieval
path must require the authorized public scope and document publication_state =
published. Quarantine documents therefore remain zero-candidate data even if
their holding collection has public visibility.

Unknown collections retain their stable legacy slug when it is unique. If a
legacy slug collides with a known seed, retain the original data under a
deterministic quarantine slug such as legacy-quarantine/<stable-hash> and
record the original slug in provenance. The exact slug encoding must be
collision-safe and deterministic.

An orphan library document gets a deterministic quarantine collection and keeps
its stable document ID; its document state is blocked. An orphan source gets a
deterministic quarantine document, preserves its source ID and chunks, and its
document is blocked from search. An orphan chunk with no source is a migration
error: do not invent a source or silently discard it. Stop before the
constraint step and retain an export for review.

Quarantine is not an implicitly readable public collection. It is a public-
scoped, document-blocked holding state whose purpose is to preserve data and
make unresolved ownership visible.

### 10.3 Compatibility fields

The existing document collection_slug column remains during the transition:

1. add collection_id nullable;
2. backfill collection_id from collection_slug;
3. compare both values for every row;
4. switch readers and writers to collection_id;
5. retain the old column through rollback verification;
6. remove it only in a later cleanup migration.

The same compatibility principle applies to source-to-document linkage: do not
drop or repurpose source IDs while adding document_id.

## 11. Migration order

This is the intended order for a future implementation migration. It is not
authorization to execute any item now.

### M1 - inventory and freeze

Record, without mutation:

- table row counts and primary keys;
- collection/document/source/chunk ID sets;
- collection/document parent mismatches;
- orphan documents, sources, and chunks;
- duplicate content and duplicate source identities;
- content hashes and embedding hashes/models;
- current RPC definitions, grants, and route callers;
- the four known seed identities.

Abort if the live inventory differs in a way that would make the mapping
ambiguous.

### M2 - add parent and identity tables

Create workspaces and workspace_members with constraints and indexes. No
existing content depends on them yet.

### M3 - add nullable ownership/state columns

Add collection visibility, owner/workspace/creator fields, document
publication_state and creator/hash fields, and source document/hash fields as
nullable compatibility columns. Do not make current rows fail before backfill.

### M4 - backfill canonical relationships

Backfill collection_id, classify known seeds, set document publication state,
attach sources to documents, and record all unresolved rows. Validate
one-parent lineage before adding final foreign keys.

### M5 - create quarantine parents

Create deterministic public-scoped system-legacy-import collection/document
parents for unknown/orphan rows. Set every quarantine document to blocked,
preserve original IDs and provenance, and do not make quarantine rows
searchable.

### M6 - classify known seeds

Set the four known bundled collections to public and their known bundled
documents to publication_state = published with system:bundled-library.
Validate IDs, content hashes, and embedding identity against M1.

### M7 - quarantine all unresolved content

Set unknown documents to publication_state = blocked and system:legacy-import.
Leave no row with an ambiguous owner, scope, document publication state, or
source parent.

### M8 - validate and measure

Run the invariant, lineage, hash, ID, and search-suppression checks in section
14. Stop on any mismatch.

### M9 - add final constraints and indexes

Only after M8 passes, enforce creator XOR, collection scope shape, document
publication values, non-null canonical parents, hashes, foreign keys, and the
planned indexes.

### M10 - install replacement functions

Create the ownership-aware functions and restricted system import functions.
Keep old functions behind the compatibility boundary until M11 verification.

### M11 - switch access surfaces

Only in later 6B/6C work: configure Auth context, RLS policies, grants, route
identity propagation, and the authenticated search/write paths. This step is
explicitly outside 6B1.

## 12. Index and constraint plan

The target indexes should support authorization without leaking through an
unscoped scan:

- workspace_members partial index on (user_id, workspace_id) where status is
  active;
- collections index on (owner_user_id) for private access;
- collections index on (workspace_id) for workspace access;
- collections index on (visibility) for public/system scope;
- documents index on (collection_id, publication_state, sort_order, id);
- partial documents index on (collection_id, id) where publication_state is
  published;
- documents unique index on (collection_id, content_hash);
- sources unique index on (document_id);
- chunks unique index on (source_id, chunk_index);
- existing HNSW cosine index on chunk embeddings.

Constraints are part of the security contract, not merely data quality:

- scope-shape checks on collections;
- creator XOR on collections and documents;
- controlled system-key check;
- document publication-state enum/check;
- canonical source/document and chunk/source foreign keys;
- non-negative offsets and chunk indexes;
- stable hash format and duplicate policy.

## 13. Safety, checkpoints, and rollback

The migration must be checkpointed and reversible. Before M2, capture a
read-only export or equivalent reproducible inventory of:

- all IDs and parent relationships;
- all content hashes;
- all embedding vectors or embedding digests and models;
- all provenance JSON;
- all row counts;
- current function definitions and execute grants;
- known seed classification.

Recommended checkpoints:

| Checkpoint | Required condition |
| --- | --- |
| C0 | inventory captured; no write has started |
| C1 | parent tables exist; existing tables unchanged |
| C2 | nullable fields added; compatibility reads still pass |
| C3 | relationships and quarantine backfill complete |
| C4 | all invariants and identity/hash comparisons pass |
| C5 | final constraints/indexes and replacement functions pass offline checks |
| C6 | route/grant switch separately reviewed and verified |

If a checkpoint fails:

1. stop the migration;
2. do not continue by disabling constraints or publishing rows;
3. restore from the preceding checkpoint or drop only newly created staging
   objects;
4. retain the inventory and failure report;
5. leave the compatibility column and old functions intact until recovery is
   verified.

No rollback may regenerate embeddings, overwrite source content, or delete
quarantine data. A partial migration must be distinguishable from a successful
publication.

## 14. Acceptance and adversarial tests

Before any production route switch, the implementation must prove:

### Scope and state

- a private collection requires its owner and no workspace;
- a workspace collection requires its workspace and active membership to search;
- a public collection has no owner/workspace parent;
- private documents auto-publish only after successful indexing and are
  searchable only by their owner;
- workspace documents auto-publish only after successful indexing and are
  searchable only by active workspace members;
- a public user contribution starts pending and is not globally searchable;
- a system seed collection is public and its known seed documents are
  published with the controlled system key;
- pending, blocked, and superseded documents produce zero search candidates;
- documents cannot override collection scope, but each document has its own
  publication state;
- adding pending Document C to an already published public collection does not
  make C searchable and does not hide already published Documents A and B;
- blocking Document B does not hide Document A;
- superseding Document C does not supersede the collection;
- a public-scoped quarantine collection whose documents are blocked produces
  zero candidates;
- no public read, RLS, or search policy authorizes on visibility = public alone;
  it always requires document publication_state = published.

### Lineage and preservation

- every source has one document parent;
- every chunk has one source parent;
- deleting a collection cannot leave searchable descendants;
- known seed IDs, content hashes, provenance, embeddings, and embedding models
  are unchanged;
- unknown rows are public-scoped only as a structural quarantine and have
  blocked document publication state;
- orphan chunks stop migration rather than being invented or dropped.

### Query-order and leakage

- unauthorized collections are removed before similarity calculation;
- documents are filtered to publication_state = published before source/chunk
  selection;
- candidate counts are over authorized candidates only;
- top-K and reranking see authorized rows only;
- facet, temporal, coverage, and generation stages receive no unauthorized row;
- adversarial mixed-ID requests cannot broaden visibility;
- client filters can narrow results but cannot authorize a collection;
- anonymous search sees only explicit public system-seed collections with
  published seed documents;

### RPC and privilege

- authenticated callers cannot invoke internal seed/import functions;
- an authorized user cannot replace or delete another collection's source;
- a workspace viewer cannot write or publish;
- owner transfer and account deletion follow an explicit policy;
- old broad service-role RPCs are not reachable from end-user routes after switch.

The test suite must include empty results, a blocked-only corpus, mixed public
and private IDs, inactive membership, a published collection with a pending
new document, blocking one document while another remains searchable,
superseding one document without hiding its collection, publication races,
duplicate hashes, deleted parents, and a source whose legacy collection
metadata disagrees with its canonical document parent.

## 15. Unresolved decisions for 6B implementation review

These are intentionally not chosen in 6B1:

1. Exact Supabase Auth integration and how the authenticated database context is
   propagated from the server route.
2. Final RLS helper functions and policy SQL, including whether any narrowly
   scoped SECURITY DEFINER helper is necessary.
3. Public-contribution moderation roles, approval UI, and audit-event storage.
4. Whether workspace membership supports invitations, groups, or only direct
   user membership in the first release.
5. Ownership transfer and account deletion semantics for private collections.
6. Whether content hashes are computed from raw source text or a canonical
   normalized representation.
7. Storage and retention for quarantined legacy rows and migration exports.
8. Anonymous-demo rate limits and whether published user contributions may
   eventually be included in anonymous search.
9. Whether future multi-source/version documents need a separate document
   version table rather than the Phase 6B one-source contract.
10. Trust/ranking, automated moderation, and abuse handling for public user
    contributions.
11. Whether final-active-workspace-owner protection is enforced by an
    application transaction, an invoker function, or a narrowly scoped
    database function. Multiple active owners remain allowed.
12. Whether a future human-readable collection alias is needed; it must not
    replace the opaque global collection key without a separate migration.

None of these decisions authorize widening the current search surface.

## 16. Review evidence and final boundary

The design is based on the two repository migrations, the bundled collection
definitions, the current seed script, and the existing vector/library route
callers. Official Supabase guidance remains relevant when implementation
begins:

- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://supabase.com/docs/guides/database/secure-data
- https://supabase.com/docs/guides/database/postgres/column-level-security

The Phase 6B1 deliverable is this document only. At the end of this task:

- no SQL has been executed;
- no Supabase schema or data has been mutated;
- no authentication or RLS policy has been implemented;
- no route, retrieval, or generation behavior has changed;
- no provider or network call has been made;
- the document remains uncommitted for review.
