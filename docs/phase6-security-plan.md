# Phase 6A security, authentication, ownership, and knowledge isolation plan

Status: planning and audit only

```text
Implementation changes       none
Schema changes               none
Migrations executed          none
Production routes changed    none
Provider calls               0
Phase 5E checkpoint          ba3891c
```

## 1. Revised goal

Tracework is intended to become a growing knowledge network, not a collection
of permanently isolated personal indexes. User A may contribute knowledge that
User B can later discover when the contribution was intentionally placed in a
scope that permits it.

The security invariant is therefore:

> User B can retrieve User A's contribution only when its explicit visibility,
> publication, and authorization rules permit it.

It is not:

> User A's data can never be retrieved by User B.

The first three visibility scopes are:

```text
private    only the owner
workspace  authorized members of a workspace
public     searchable by all authenticated Tracework users
```

`curated` or `verified` is a future trust state, not a fourth visibility scope
in Phase 6A. Visibility answers **who may search**. Publication/trust state
answers **whether a contribution is eligible to appear** and how it should be
treated by provenance and contradiction reasoning.

The target authorized search universe is:

```text
current user's private knowledge
+ current user's authorized workspace knowledge
+ published public/community knowledge
```

The system must not make every newly indexed item public by accident.

## 2. Phase 6A boundary

This document freezes the security contract and records the current-state audit.
It does not implement:

- authentication or session handling;
- database schema changes or migrations;
- RLS policies or RPC rewrites;
- route changes;
- workspace UI;
- file-storage changes;
- provider calls, embeddings, or generation changes;
- community moderation automation.

The implementation sequence begins only after this plan is reviewed.

## 3. Current-state audit

### 3.1 Current data model

The repository currently has four relevant Postgres tables:

| Current table | Current role | Security-relevant finding |
| --- | --- | --- |
| `tracework_collections` | Shared catalog identity, title, kind, provenance, ordering | No owner, workspace, visibility, or publication state |
| `tracework_library_documents` | Catalog document text under a collection | No owner, workspace, visibility, or publication state |
| `tracework_sources` | Indexed source content and provenance | No owner, workspace, visibility, or contributor identity |
| `tracework_chunks` | Chunk text, offsets, and 1536d embeddings | Scope is inherited only by an unmodeled source relationship |

RLS is enabled on the four tables, but the migrations do not define user or
workspace policies. Direct `anon` and `authenticated` table grants and RPC
execution are revoked, while `service_role` receives the privileged access.
The server therefore reaches the database through a service-role path that
bypasses the intended row boundary. RLS being enabled is not, by itself, an
authorization model.

Existing `provenance` is evidence metadata used by Phase 5C reasoning. It is
not ownership, visibility, or permission data and must not be overloaded for
those purposes.

### 3.2 Current privileged functions

The current migrations define these service-role RPCs:

| Function | Current behavior | Phase 6 risk |
| --- | --- | --- |
| `tracework_upsert_collection` | Replaces a collection's catalog documents by caller-supplied slug | Any privileged caller can rewrite shared catalog content |
| `tracework_list_collections` | Lists every collection and aggregate count | No caller scope; currently intended as shared catalog read |
| `tracework_collection_documents` | Returns every document for a supplied slug | Caller-controlled slug is not an authorization check |
| `tracework_replace_source` | Upserts a source by caller-supplied ID, deletes its chunks, inserts new chunks | Can overwrite another source or poison its embeddings |
| `tracework_delete_sources` | Deletes every source whose ID is supplied | Arbitrary privileged deletion |
| `tracework_match_chunks` | Searches all chunks, filtering only by source kind and similarity | Unauthorized rows enter the vector candidate set before ranking |

The vector RPC joins `tracework_chunks` to `tracework_sources` but has no
visibility, owner, workspace, publication, or current-user predicate. Its
`candidate_count` therefore describes the whole ownerless search universe.

### 3.3 Current routes and actions

| Route/action | Current identity | Current operation | Current boundary | Main risk |
| --- | --- | --- | --- | --- |
| `/api/library/collections` | None | Read catalog through service role | All catalog collections | Cross-user exposure once private collections exist |
| `/api/library/documents` | None | Read documents for caller-supplied slug | Slug validation only | IDOR-style collection/document disclosure |
| `/api/vector/search` | None | Vector search through service role | `kind` filter only | Private/workspace chunks enter candidates and results |
| `/api/vector/sync` | None | Write sources/chunks through service role | Deployed shared-write flag; vector/model validation | Anonymous overwrite, poisoning, and provider-cost abuse |
| `/api/vector/delete` | None | Delete sources through service role | Deployed shared-write flag; ID format validation | Anonymous arbitrary deletion |
| `/api/embed` | None | Proxy embedding requests to OpenAI | API-key presence and input shape | Unauthenticated embedding cost and abuse |
| `/api/generate` | None | Proxy grounded generation requests to OpenAI | API-key, mode, context, and size checks | Unauthenticated generation cost and abuse |
| `npm run seed:library` | Operator process | Seed bundled collections through service role | Server/operator environment | Must remain a trusted system-seed operation, not a user route |
| Browser local index | Browser state | Local hashed/neural/lexical retrieval | Device-local storage | Must not be mistaken for shared authorization or cross-device state |

`TRACEWORK_ALLOW_SHARED_WRITES` is a useful stopgap: deployed writes default to
denied and local development can opt out. It is not identity, ownership,
workspace isolation, or public-contribution authorization. The current seeded
library is intentionally shared system data; the problem is that the database
has no way to distinguish that from a future private or user-contributed item.

## 4. Target ownership and visibility model

### 4.1 Hierarchy

```text
auth.users
  └── workspaces
        ├── workspace_members
        └── collections
              └── library_documents
                    └── sources
                          └── chunks / embeddings
```

Stable concepts:

```ts
User
Workspace
WorkspaceMember
Collection
LibraryDocument
Source
Chunk
```

`LibraryDocument` is the canonical knowledge item. `Source` and `Chunk` are
derived/indexed representations and must not become independent security
roots. A chunk inherits the effective scope of its parent document/collection;
there is no client-controlled chunk visibility override.

### 4.2 Scope fields

The target model should derive access from the smallest authoritative parent
relationship and avoid copying mutable ownership into every chunk.

| Concept | Required target data | Purpose |
| --- | --- | --- |
| Workspace | `id`, `name`, timestamps | Tenant boundary for team knowledge |
| Workspace member | `workspace_id`, `user_id`, `role`, status, timestamps | Membership and role checks |
| Collection | `visibility`, `workspace_id` when workspace-scoped, `owner_user_id` when private, `created_by`, publication state | Default namespace and access boundary |
| Library document | `collection_id`, effective visibility or explicit inherited-scope marker, `created_by`, content hash, source metadata, publication state | Canonical contribution and provenance root |
| Source | `document_id`/canonical parent reference, indexed content, provenance, embedding metadata | Derived searchable representation |
| Chunk | `source_id`, text, offsets, embedding, model, timestamps | Derived retrieval unit; no independent owner |

The exact table names and whether collections or documents carry the final
effective visibility can be chosen during 6B. The invariant is fixed:

```text
private  -> owner_user_id is present; workspace_id is absent
workspace -> workspace_id is present; membership is required
public   -> explicitly published public scope; no workspace membership required
```

`created_by` records the contributor for audit in every user-created case.
`owner_user_id` is the private access owner, not a substitute for contributor
provenance. System-seeded public content uses an explicit system contributor
identity or role rather than an accidental ownerless row.

### 4.3 Publication and trust are separate from visibility

Recommended initial publication states:

```text
pending    accepted for processing but not in the public retrieval universe
published  eligible for the visibility rules
blocked    excluded from retrieval except for authorized moderation/audit views
superseded retained for provenance/history, not current retrieval
```

An authenticated contributor may create a public contribution, but the initial
product policy should decide whether it becomes `published` immediately or
enters `pending` moderation. Either way, `public` must never mean “anonymous
write and immediate global retrieval.”

Future trust states such as `community`, `curated`, and `verified` may influence
ranking, display, and conflict reasoning, but must not replace the basic
visibility check. A verified public source is still public; a private source is
not made visible by a trust label.

### 4.4 Provenance for community contributions

A public contribution should retain, at minimum:

```text
uploaded_by / created_by
original source and source URL, if applicable
upload timestamp
document date and last-updated date, if known
visibility and workspace scope
content hash
publication/trust state
superseded_by or supersedes
```

The existing Phase 5C provenance record remains the evidence-authority layer.
These new fields answer who contributed the material, where it came from, and
whether it is eligible for a search; they do not assert that the source is true.

## 5. Role model

Keep the first role system small:

| Role | Read/search | Create private/public contribution | Edit/delete own contribution | Edit/delete workspace content | Manage members/settings |
| --- | --- | --- | --- | --- | --- |
| Owner | Yes | Yes | Yes | Yes | Yes |
| Member/editor | Yes | Yes, subject to publication policy | Yes | Yes where the collection grants editor access | No |
| Viewer | Yes | No | No | No | No |

Additional rules:

- A private item is visible only to its owner, regardless of workspace role.
- A workspace item requires active membership and the collection's role policy.
- A public item is readable by authenticated users only when published.
- Publishing or unpublishing a public item is a distinct permission from merely
  creating a pending contribution; the initial implementation should choose a
  single owner/moderator rule and test it explicitly.
- Workspace deletion and ownership transfer are owner-only and must not be
  implemented as ordinary document deletion.
- No authorization decision may use editable `user_metadata` claims. Use the
  authenticated subject and database membership rows; coarse trusted claims,
  if used later, belong in server-controlled app metadata and must tolerate JWT
  staleness.

## 6. RLS and database authorization design

### 6.1 Database-first invariant

RLS must be enabled on every exposed table, with policies that encode the
visibility model. Application checks are useful for clear errors, but they are
not the final boundary. A manually altered identifier, route payload, or client
workspace field must not expand access.

The conceptual read predicate is:

```sql
visibility = 'public'
  and publication_state = 'published'
  and auth.uid() is not null

or visibility = 'private'
  and owner_user_id = auth.uid()

or visibility = 'workspace'
  and exists (
    select 1
    from workspace_members
    where workspace_members.workspace_id = record.workspace_id
      and workspace_members.user_id = auth.uid()
      and workspace_members.status = 'active'
  )
```

This is a design expression, not migration SQL. The final implementation must
use `TO authenticated`, explicit `auth.uid()` checks, and matching `USING` and
`WITH CHECK` clauses for updates.

### 6.2 Table policy shape

Policies should cover at least:

- `workspaces`: members can read; owners manage settings and deletion;
- `workspace_members`: members can read their own workspace membership as
  appropriate; owners manage invitations, roles, and removal;
- `tracework_collections`: visible through public/private/workspace scope;
  insert/update/delete follows the role matrix;
- `tracework_library_documents`: access is inherited from the authorized
  collection/document scope; updates cannot move a document into another
  workspace or change its owner without permission;
- `tracework_sources`: access is derived from the canonical document; users
  should not update or delete an indexed source by guessed source ID;
- `tracework_chunks`: readable only through an authorized source/document
  relationship; ordinary clients should not write chunks directly;
- publication/moderation records: separate policies for contributor, owner,
  and moderator operations.

For `UPDATE`, the policy must protect both the old row and the new row. A user
must not be able to update an owned record by changing `owner_user_id`,
`workspace_id`, or `visibility` to a scope they do not control. For public
publication, use a dedicated transition controlled by the chosen publication
role rather than allowing arbitrary visibility mutation.

### 6.3 RPC and function boundary

The current public functions are a major Phase 6 boundary because the server
currently calls them with the service role.

Target behavior:

1. Normal user reads/writes use an authenticated Supabase context so RLS sees
   the caller.
2. Search RPCs are `SECURITY INVOKER` by default and execute the authorized
   scope predicate inside the database.
3. If a privileged function is genuinely unavoidable, keep it in a private or
   non-exposed schema, restrict `EXECUTE`, validate `auth.uid()` and the target
   scope inside the function, fix its `search_path`, and test it as an
   adversarial API. Do not add `SECURITY DEFINER` merely to bypass an RLS error.
4. The service role remains server-only and is reserved for explicit system
   operations such as seeding or moderation jobs after an application-level
   authorization check.

### 6.4 Vector search must filter before similarity and limit

The target `tracework_match_chunks` shape must be conceptually:

```text
authorized_documents
  -> authorized_sources
  -> authorized_chunks
  -> vector distance / lexical candidate generation
  -> threshold and limit
```

The authorized universe must be built before vector ranking, candidate counts,
top-K limiting, union construction, or result serialization. The same rule
applies to any future lexical/BM25 RPC.

The RPC must not trust a client-supplied `workspace_id`, owner ID, or visibility
as authorization. Optional filters may narrow the authorized universe, never
expand it. `candidate_count` must count only authorized candidates so it cannot
leak the existence or approximate volume of private/workspace material.

## 7. Retrieval isolation architecture

### 7.1 Scope-aware request context

Every server-backed retrieval operation should receive an authenticated
principal resolved from the access token, for example:

```ts
{
  userId,
  authorizedWorkspaceIds,
  requestedCollectionIds?,
  roleClaimsFromDatabase
}
```

The client may request a narrower collection filter, but it cannot supply the
authoritative authorized workspace set. The server/database derives that set
from Auth and membership rows.

### 7.2 Candidate pipeline invariant

Unauthorized chunks must never enter:

```text
dense candidates
lexical candidates
union reservoir
reranker
synthesis facets
generation packet
```

The combined search path is:

```text
private owner scope
+ active workspace-member scopes
+ published public scope
        ↓
authorized candidate retrieval
        ↓
dense/lexical fusion and rerank
        ↓
Phase 5C-5E provenance, temporal, conflict, and coverage reasoning
        ↓
answer packet and generation
```

The existing browser-local index remains device-local and must be labelled as
such. It is not a substitute for server authorization. When shared results
are merged with local results, each result must retain its scope and provenance
so a private local note cannot accidentally be synced or displayed as public.

### 7.3 Generation and embedding cost boundary

`/api/embed` and `/api/generate` do not themselves grant document access, but
they expose provider cost and can be abused with arbitrary input. The target
default is authenticated access, per-user/workspace quotas, request-size
limits, and rate limits. An anonymous demo mode, if retained, must be an
explicit separately budgeted public feature and must never be used as evidence
that private/workspace authorization exists.

## 8. Public/community contribution safeguards

Public knowledge is intentionally shareable, not automatically trustworthy.
Phase 6 should design the following controls before enabling public writes:

| Concern | Required design direction |
| --- | --- |
| Provenance | Preserve contributor, original source, dates, URL, content hash, and publication state |
| Duplicate information | Hash normalized source content; detect same-source and near-duplicate submissions before indexing |
| Source attribution | Keep source/document identity through chunks, citations, and answer provenance |
| Temporal validity | Store document/effective dates; reuse Phase 5D `asOf` and currentness logic |
| Supersession | Link superseding documents; retain old material for history but exclude it from current claims when appropriate |
| Contradictions | Reuse Phase 5C provenance/conflict handling; never resolve by majority or retrieval rank alone |
| Spam/abuse | Per-user/workspace quotas, size/type limits, rate limits, reports, and moderation state |
| Poisoned documents | Treat uploaded text as data, not instructions; preserve the existing generation prompt boundary; scan/inspect before public publication |
| Trust state | Keep `pending`, `published`, `blocked`, and `superseded` distinct from visibility; defer curated/verified ranking until later |
| Public writes | Require authenticated contribution and an explicit publication transition; never expose anonymous service-role sync |

The existing deterministic evidence discipline is an advantage here. A public
source can be searchable while still being marked community-contributed,
temporally stale, contradicted, or not authoritative.

## 9. Service-role policy

The service-role key must remain server-only and must never appear in a browser
bundle, route response, log, or client environment variable.

Target policy:

```text
authenticated user-scoped read/write
  -> authenticated database context + RLS

system seed / migration / moderation job
  -> service role, explicit server authorization, audit trail

public browser request
  -> never direct service-role database access
```

If a server route temporarily retains the service role for an operation, it
must first resolve the authenticated principal, authorize the target document
and scope, validate ownership/publication transitions, and log the decision.
The service role must not be treated as a replacement for those checks.

## 10. Legacy/shared-data migration strategy

No migration is executed in Phase 6A. The eventual 6B migration should be
staged and reversible.

### 10.1 Existing seeded collections

The four existing benchmark/demo collections are system content. Preserve their
stable IDs and embeddings, but make their shareability explicit:

```text
visibility          public
publication_state   published
contributor         system seed / operator
trust state         system or curated-by-policy, as decided later
workspace_id        null
```

They must not be assigned to a real private user. The system contributor is an
explicit principal, not an ownerless accident.

### 10.2 Unknown or future user data

Rows without a trustworthy contributor or scope must not be auto-published.
Inventory them, place them in a quarantined legacy/system workspace or blocked
state, and require explicit assignment before they enter a private, workspace,
or public universe.

### 10.3 Migration invariants

- Preserve stable collection, document, source, and chunk IDs where possible.
- Preserve existing embeddings when model and dimension contracts match.
- Add content hashes and provenance without rewriting source meaning.
- Backfill parent relationships before enabling user-facing scoped retrieval.
- Keep a rollback path and a row-count/hash report for every backfill batch.
- Do not combine ownership migration with an unrelated retrieval or prompt
  change.
- Do not seed private data into the public/demo scope merely because it existed
  in the current shared database.

## 11. API permission matrix

This is the target contract, not current behavior.

| Route | Auth required | Workspace required | Minimum role | Allowed operation | DB credential | Main abuse/cost control | Expected failure |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/api/library/collections` | Yes by default | No; returns authorized public/private/workspace catalog | Viewer | List visible collections only | Authenticated/RLS context | Pagination and rate limit | 401/403; no unauthorized rows |
| `/api/library/documents` | Yes | Only when requested collection is workspace-scoped | Viewer | Read documents in authorized collection | Authenticated/RLS context | Scope and pagination | 401/403/404 without existence leakage |
| `/api/vector/search` | Yes | Derived from memberships; optional narrowing only | Viewer | Search authorized public/private/workspace chunks | Authenticated invoker RPC | Query limits and candidate filtering before ranking | 401/403/400; zero unauthorized candidates |
| `/api/vector/sync` | Yes | For workspace scope; absent for private/public | Member/editor | Create or update an owned/contributed item | Authenticated RLS or checked server RPC | Upload, chunk, embedding, and storage quotas | 401/403/409/413 |
| `/api/vector/delete` | Yes | Derived from target document | Owner/editor or moderator | Delete permitted owned/workspace item; never arbitrary IDs | Authenticated RLS or checked server RPC | Audit, soft-delete, rate limit | 401/403/404 without ID probing |
| `/api/embed` | Yes by default | No | Authenticated user | Generate embeddings for an authorized operation | Server provider proxy | Per-user/workspace quota and rate limit | 401/429/413/provider error |
| `/api/generate` | Yes by default | No | Authenticated user | Generate from supplied authorized context | Server provider proxy | Token budget, rate limit, usage quota | 401/429/413/provider error |
| `seed:library` | Operator/service identity | System scope | Operator/admin | Replace explicitly declared system seed | Service role | CI/operator credential and audit | Fail closed; no public route |

Public content is readable across workspaces only when explicitly published.
Private and workspace rows must not be exposed merely because the route uses a
server-side credential.

## 12. Security acceptance tests to freeze before implementation

### Visibility and ownership

- User A can create private knowledge and retrieve it.
- User B cannot list, fetch, vector-search, or lexical-search User A's private
  knowledge by guessed collection, document, source, or chunk IDs.
- User A can publish an allowed contribution to the public scope.
- User B can search User A's published public contribution.
- User B cannot search User A's pending, blocked, or private contribution.
- A workspace member can read workspace knowledge; a non-member cannot.
- A viewer cannot sync, edit, publish, or delete.
- A member/editor can create permitted contributions but cannot change roles,
  delete the workspace, or mutate another user's private item.
- An owner can manage membership and workspace-owned content.

### Identifier and RPC adversaries

- A request supplies User A's `workspace_id` and User B's `document_id`; it
  fails closed.
- A request supplies a public collection ID with a private document ID; no
  private document is returned.
- A guessed source ID cannot overwrite or delete another scope.
- A guessed chunk ID cannot be inserted into a user's candidate set.
- `tracework_match_chunks` returns only authorized candidates and counts.
- Vector filtering occurs before distance threshold, top-K, candidate count,
  reranking, and synthesis packet construction.
- A lexical search cannot bypass the vector scope predicate.
- A service-role route still performs application authorization before any
  privileged RPC.

### Public knowledge and evidence safety

- Published public content is searchable by another authenticated user.
- Public content retains contributor/source/date/hash provenance.
- Duplicate content is detected or safely identified before publication.
- A superseded public document is retained for provenance but does not silently
  become the current answer.
- Contradictory public sources remain visible to Phase 5C conflict reasoning.
- Uploaded prompt-injection text remains source data and cannot alter the
  generation instructions.
- Public writes are authenticated, rate-limited, quota-limited, and auditable.

### Auth and failure behavior

- Missing or expired auth fails closed for private/workspace reads and provider
  cost routes.
- Malformed workspace, collection, document, source, and chunk IDs fail without
  revealing whether another user's row exists.
- Anonymous public-demo behavior, if retained, is explicitly scoped to the
  published demo corpus and cannot access private/workspace content.

## 13. Recommended implementation sequence

```text
6A  security contract, threat audit, and acceptance tests       this document
6B  ownership/visibility schema and legacy-data migration       reviewed migration
6C  authentication and server request principal                 authenticated routes
6D  RLS policies, invoker RPCs, and service-role reduction      DB-enforced scope
6E  pre-retrieval isolation for vector/lexical/fusion paths     authorized candidates
6F  contribution, publication, provenance, and workspace UX    intentional sharing
6G  abuse/moderation/trust controls                             public safety
6H  adversarial security validation                             release gate
```

Do not start with Clerk/Auth/RLS changes scattered across the application. The
principal, scope vocabulary, parent relationships, and acceptance tests should
be reviewed first so authentication and database policy implement one boundary.

## 14. Decisions intentionally deferred

- Whether public contributions publish immediately or enter moderation.
- Whether a collection may contain mixed document visibility or must be split
  by scope.
- Whether anonymous demo access remains after authenticated public search is
  introduced.
- The exact `curated`/`verified` trust-state workflow and moderator role.
- Whether private user uploads use Postgres content storage, Supabase Storage,
  or a separate ingestion service.
- The exact Supabase Auth client/server integration and session revocation
  policy.

These choices must not be inferred during schema implementation. They should
be resolved as explicit 6B/6C decisions.

## 15. References and repository evidence

Repository evidence audited for this plan:

```text
supabase/migrations/20260809000100_tracework_pgvector.sql
supabase/migrations/20260811000100_tracework_knowledge_library.sql
server/traceworkApi.ts
vite.config.ts
src/lib/vectorDb.ts
src/lib/knowledgeLibrary.ts
scripts/seed-library.mjs
docs/phase6-permissions.md
```

Supabase references to carry into implementation review:

- [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Securing your data](https://supabase.com/docs/guides/database/secure-data)
- [Column-level privileges](https://supabase.com/docs/guides/database/postgres/column-level-security)

The current plan supersedes the earlier private/shared-only framing in
`docs/phase6-permissions.md` while preserving its warning that shared access
must be intentional rather than an accidental consequence of service-role
access.

Phase 6A stops here. No production behavior has been changed.
