-- Tracework Phase 6B2A/6B2C: ownership, scope, publication, and lineage
-- compatibility layer.
--
-- IMPORTANT:
--   This file is intentionally unapplied in the 6B2A review checkpoint.
--   It prepares schema and deterministic backfill state only.
--   It does not install end-user RLS policies, replace RPCs, switch routes,
--   regenerate embeddings, or rewrite source/chunk identities.
--
-- The migration runner supplies the transaction boundary for the ordinary
-- DDL/backfill operations in this file. The final constraints and route
-- cutover remain later checkpoints after read-only live inventory review.
--
-- 6B2C deliberately does not install extensions. pgcrypto is a hard
-- 6B2D catalog-preflight dependency because this migration uses its
-- schema-qualified digest and UUID functions. If the reviewed extension
-- placement is absent, the migration must stop before changing catalog data.

do $$
begin
  if not exists (
    select 1
    from pg_extension
    where extname = 'pgcrypto'
  )
  or not exists (
    select 1
    from pg_proc as functions
    join pg_namespace as namespaces on namespaces.oid = functions.pronamespace
    where namespaces.nspname = 'extensions'
      and functions.proname = 'digest'
  )
  or not exists (
    select 1
    from pg_proc as functions
    join pg_namespace as namespaces on namespaces.oid = functions.pronamespace
    where namespaces.nspname = 'extensions'
      and functions.proname = 'gen_random_uuid'
  ) then
    raise exception 'Tracework 6B2C stopped: pgcrypto in schema extensions is required; verify it in the 6B2D catalog preflight first';
  end if;
end;
$$;

-- New ownership tables are isolated from the existing shared-library rows.
-- Multiple active owners are intentional; final-owner protection is a later
-- transactional authorization rule, not a single-owner unique constraint.
create table if not exists public.workspaces (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null,
  created_by_user_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'member', 'viewer')),
  status text not null check (status in ('invited', 'active', 'suspended')),
  invited_by_user_id uuid references auth.users(id) on delete set null,
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index if not exists workspace_members_active_user
  on public.workspace_members (user_id, workspace_id)
  where status = 'active';

-- The tables are protected at the table boundary while final authenticated
-- policies are intentionally deferred to the later RLS phase.
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
revoke all on table public.workspaces, public.workspace_members from anon, authenticated;
grant all on table public.workspaces, public.workspace_members to service_role;

-- Collection scope remains the security boundary. These are compatibility
-- columns first; final foreign keys and NOT NULL enforcement wait for the
-- inventory/backfill validation checkpoint.
alter table public.tracework_collections
  add column if not exists visibility text default 'public',
  add column if not exists workspace_id uuid,
  add column if not exists owner_user_id uuid,
  add column if not exists created_by_user_id uuid,
  add column if not exists created_by_system_key text;

comment on column public.tracework_collections.slug is
  'Stable compatibility key. New user collections must use opaque generated values, never title-derived values.';
comment on column public.tracework_collections.visibility is
  'Collection security scope only: private, workspace, or public. Documents inherit this scope.';
comment on column public.tracework_collections.created_by_system_key is
  'Controlled system contributor such as system:bundled-library or system:legacy-import; never a fake auth.users row.';

-- Publication is deliberately document-level. A public collection can contain
-- published, pending, blocked, and superseded documents at the same time.
-- The future search predicate is authorized collection AND
-- document.publication_state = 'published'. Visibility = 'public' alone is
-- never search authorization.
alter table public.tracework_library_documents
  add column if not exists collection_id text,
  add column if not exists publication_state text default 'pending',
  add column if not exists content_hash text,
  add column if not exists source_url text,
  add column if not exists document_date date,
  add column if not exists source_last_updated_date date,
  add column if not exists created_by_user_id uuid,
  add column if not exists created_by_system_key text;

comment on column public.tracework_library_documents.collection_id is
  'Canonical collection parent. collection_slug remains during compatibility and must compare equal.';
comment on column public.tracework_library_documents.publication_state is
  'Retrieval eligibility: pending, published, blocked, or superseded. Published means eligible within an authorized scope if an index exists; it does not require a source or chunks. This is not visibility.';

-- A source is an indexing representation of one library document. Existing
-- source and chunk IDs remain untouched while the canonical parent is filled.
-- Existing chunk IDs and vector payloads are never written here. No
-- re-embedding is performed; each chunk's embedding and embedding_model are
-- preserved.
alter table public.tracework_sources
  add column if not exists document_id text,
  add column if not exists indexed_content_hash text,
  add column if not exists updated_at timestamptz;

comment on column public.tracework_sources.document_id is
  'Canonical library-document parent. Final foreign key and one-source-per-document uniqueness follow validation.';

-- M1 identity and embedding guards. Additional legacy rows are allowed and
-- are quarantined below, but a reviewed seed identity, vector shape, or
-- source/chunk relationship may not silently drift between inventory and
-- execution.
do $$
declare
  missing_collections text;
  invalid_documents text;
begin
  select string_agg(expected.slug, ', ' order by expected.slug)
  into missing_collections
  from (
    values
      ('workshop-notes'),
      ('meridian-access-programme'),
      ('phase-5c-conflict-set'),
      ('phase-5c-authority-record')
  ) as expected(slug)
  left join public.tracework_collections as actual on actual.slug = expected.slug
  where actual.slug is null;

  if missing_collections is not null then
    raise exception 'Tracework migration stopped: reviewed collection identities are missing: %', missing_collections;
  end if;

  select string_agg(expected.id || ' -> ' || expected.collection_slug, ', ' order by expected.id)
  into invalid_documents
  from (
    values
      ('library-workshop-market-identity', 'workshop-notes'),
      ('library-workshop-trip-intelligence', 'workshop-notes'),
      ('library-workshop-rag-lab-notes', 'workshop-notes'),
      ('library-meridian-access-programme', 'meridian-access-programme'),
      ('library-phase5c-changelog', 'phase-5c-conflict-set'),
      ('library-phase5c-project-history', 'phase-5c-conflict-set'),
      ('library-phase5c-authoritative-readme', 'phase-5c-authority-record')
  ) as expected(id, collection_slug)
  left join public.tracework_library_documents as actual on actual.id = expected.id
  where actual.id is null
     or actual.collection_slug is distinct from expected.collection_slug;

  if invalid_documents is not null then
    raise exception 'Tracework migration stopped: reviewed document identities or parents drifted: %', invalid_documents;
  end if;

  if exists (
    select 1
    from public.tracework_chunks as chunks
    left join public.tracework_sources as sources on sources.id = chunks.source_id
    where sources.id is null
  ) then
    raise exception 'Tracework migration stopped: orphan chunk has no source parent';
  end if;

  if exists (
    select 1
    from public.tracework_chunks
    where embedding_model is distinct from 'text-embedding-3-small'
  ) then
    raise exception 'Tracework migration stopped: embedding model drifted from text-embedding-3-small';
  end if;

  if exists (
    select 1
    from public.tracework_chunks
    where embedding is null
  ) then
    raise exception 'Tracework migration stopped: a chunk has a null embedding';
  end if;

  if not exists (
    select 1
    from pg_attribute as attributes
    join pg_class as relations on relations.oid = attributes.attrelid
    join pg_namespace as namespaces on namespaces.oid = relations.relnamespace
    where namespaces.nspname = 'public'
      and relations.relname = 'tracework_chunks'
      and attributes.attname = 'embedding'
      and attributes.atttypmod = 1536
      and format_type(attributes.atttypid, attributes.atttypmod) in (
        'extensions.vector(1536)',
        'vector(1536)'
      )
  ) then
    raise exception 'Tracework migration stopped: tracework_chunks.embedding is not extensions.vector(1536)';
  end if;
end;
$$;

-- Existing catalog rows were the shared public seed surface. Classify the four
-- known collection identities explicitly and quarantine all other legacy
-- collections under the controlled legacy contributor.
update public.tracework_collections
set
  visibility = coalesce(nullif(trim(visibility), ''), 'public'),
  created_by_system_key = case
    when slug in (
      'workshop-notes',
      'meridian-access-programme',
      'phase-5c-conflict-set',
      'phase-5c-authority-record'
    ) then 'system:bundled-library'
    else 'system:legacy-import'
  end,
  created_by_user_id = null,
  owner_user_id = null,
  workspace_id = null
where created_by_user_id is null
  and created_by_system_key is null;

-- Keep the existing collection_slug compatibility field and backfill the new
-- canonical name without removing or rewriting the old value.
update public.tracework_library_documents
set collection_id = collection_slug
where collection_id is null;

do $$
begin
  if exists (
    select 1
    from public.tracework_library_documents
    where collection_id is distinct from collection_slug
  ) then
    raise exception 'Tracework migration stopped: collection_id disagrees with collection_slug';
  end if;
end;
$$;

update public.tracework_library_documents
set
  content_hash = encode(
    extensions.digest(coalesce(content, ''), 'sha256'),
    'hex'
  )
where content_hash is null;

-- Known bundled document IDs are the only existing rows that can be promoted
-- automatically. An unknown document inside a known public collection remains
-- blocked until its own ingestion/moderation workflow is reviewed.
--
-- The three Workshop documents are intentionally published catalog records
-- without synthetic sources, chunks, or embeddings. Publication means that a
-- document may participate in an authorized retrieval scope if an index exists;
-- it does not promise that an index already exists.
update public.tracework_library_documents
set
  publication_state = case
    when id in (
      'library-workshop-market-identity',
      'library-workshop-trip-intelligence',
      'library-workshop-rag-lab-notes',
      'library-meridian-access-programme',
      'library-phase5c-changelog',
      'library-phase5c-project-history',
      'library-phase5c-authoritative-readme'
    ) then 'published'
    else 'blocked'
  end,
  created_by_system_key = case
    when id in (
      'library-workshop-market-identity',
      'library-workshop-trip-intelligence',
      'library-workshop-rag-lab-notes',
      'library-meridian-access-programme',
      'library-phase5c-changelog',
      'library-phase5c-project-history',
      'library-phase5c-authoritative-readme'
    ) then 'system:bundled-library'
    else 'system:legacy-import'
  end,
  created_by_user_id = null
where created_by_user_id is null
  and created_by_system_key is null;

-- Current Tracework sync uses the stable document ID as source ID. This is the
-- only automatic source -> document mapping in 6B2C. No title, path, content,
-- provenance, or similarity inference is allowed to identify a parent.
with known_source_documents(source_id, document_id) as (
  values
    ('library-workshop-market-identity', 'library-workshop-market-identity'),
    ('library-workshop-trip-intelligence', 'library-workshop-trip-intelligence'),
    ('library-workshop-rag-lab-notes', 'library-workshop-rag-lab-notes'),
    ('library-meridian-access-programme', 'library-meridian-access-programme'),
    ('library-phase5c-changelog', 'library-phase5c-changelog'),
    ('library-phase5c-project-history', 'library-phase5c-project-history'),
    ('library-phase5c-authoritative-readme', 'library-phase5c-authoritative-readme')
)
update public.tracework_sources as sources
set
  document_id = known.document_id,
  updated_at = now()
from known_source_documents as known
where sources.id = known.source_id
  and sources.document_id is null;

do $$
begin
  if exists (
    select 1
    from public.tracework_sources as sources
    join (
      values
        ('library-workshop-market-identity', 'library-workshop-market-identity'),
        ('library-workshop-trip-intelligence', 'library-workshop-trip-intelligence'),
        ('library-workshop-rag-lab-notes', 'library-workshop-rag-lab-notes'),
        ('library-meridian-access-programme', 'library-meridian-access-programme'),
        ('library-phase5c-changelog', 'library-phase5c-changelog'),
        ('library-phase5c-project-history', 'library-phase5c-project-history'),
        ('library-phase5c-authoritative-readme', 'library-phase5c-authoritative-readme')
    ) as expected(source_id, document_id) on expected.source_id = sources.id
    where sources.document_id is distinct from expected.document_id
  ) then
    raise exception 'Tracework migration stopped: known source mapping is not the stable identity mapping';
  end if;

  if exists (
    select 1
    from public.tracework_sources as sources
    left join public.tracework_library_documents as documents
      on documents.id = sources.document_id
    where sources.document_id is not null
      and documents.id is null
  ) then
    raise exception 'Tracework migration stopped: a source points at a missing document parent';
  end if;

  -- An ambiguous exact path/content match is a structural stop condition, not
  -- a permission to choose one candidate. A unique match is still quarantined
  -- unless it is the stable identity mapping above.
  if exists (
    select sources.id
    from public.tracework_sources as sources
    join public.tracework_library_documents as documents
      on documents.source_path = sources.source_path
     and documents.content = sources.content
    where sources.document_id is null
    group by sources.id
    having count(distinct documents.id) > 1
  ) then
    raise exception 'Tracework migration stopped: ambiguous source parentage cannot be inferred';
  end if;
end;
$$;

-- Unmatched source rows retain their source/chunk IDs and content, but receive
-- one deterministic blocked document parent per source. The holding collection
-- is public only as scope metadata; blocked documents cannot qualify for
-- retrieval. The SHA-256 namespace is retry-stable and deliberately distinct
-- from ordinary document IDs; a pre-existing collision stops the migration.
insert into public.tracework_collections (
  slug,
  title,
  description,
  kind,
  provenance,
  sort_order,
  visibility,
  created_by_system_key
)
select
  'legacy-quarantine',
  'Legacy quarantine',
  'Unresolved legacy rows retained for review; no document is retrieval-eligible by default.',
  'sample',
  jsonb_build_object(
    'origin', 'legacy-migration',
    'reason', 'unresolved-parentage'
  ),
  2147483647,
  'public',
  'system:legacy-import'
where not exists (
  select 1
  from public.tracework_collections
  where slug = 'legacy-quarantine'
);

do $$
begin
  if exists (
    select 1
    from public.tracework_collections
    where slug = 'legacy-quarantine'
      and not (
        visibility = 'public'
        and created_by_system_key = 'system:legacy-import'
        and owner_user_id is null
        and workspace_id is null
      )
  ) then
    raise exception 'Legacy quarantine slug is already owned by a non-quarantine collection';
  end if;

  if exists (
    select 1
    from public.tracework_sources as sources
    join public.tracework_library_documents as documents
      on documents.id = 'legacy-quarantine-source-' || encode(extensions.digest(sources.id, 'sha256'), 'hex')
    where sources.document_id is null
      and (
        coalesce(documents.collection_id, '') <> 'legacy-quarantine'
        or documents.provenance->>'legacySourceId' <> sources.id
        or documents.provenance->>'migrationBatch' <> '20260812000100'
        or documents.publication_state <> 'blocked'
        or documents.content is distinct from sources.content
        or documents.source_path is distinct from sources.source_path
      )
  ) then
    raise exception 'A deterministic legacy source document ID already belongs to another document';
  end if;

  if exists (
    select 1
    from (
      select
        'legacy-quarantine-source-' || encode(extensions.digest(sources.id, 'sha256'), 'hex') as document_id,
        count(*) as source_count
      from public.tracework_sources as sources
      where sources.document_id is null
      group by 1
      having count(*) > 1
    ) as collisions
  ) then
    raise exception 'Tracework migration stopped: deterministic quarantine document ID collision';
  end if;
end;
$$;

insert into public.tracework_library_documents (
  id,
  collection_id,
  collection_slug,
  title,
  source_path,
  kind,
  content,
  provenance,
  sort_order,
  publication_state,
  content_hash,
  created_by_system_key
)
select
  'legacy-quarantine-source-' || encode(extensions.digest(sources.id, 'sha256'), 'hex'),
  'legacy-quarantine',
  'legacy-quarantine',
  coalesce(nullif(sources.title, ''), 'Quarantined legacy source'),
  coalesce(nullif(sources.source_path, ''), 'legacy source'),
  sources.kind,
  sources.content,
  coalesce(sources.provenance, '{}'::jsonb) || jsonb_build_object(
    'legacySourceId', sources.id,
    'quarantineReason', 'unresolved-parentage',
    'migrationBatch', '20260812000100'
  ),
  2147483647,
  'blocked',
  encode(extensions.digest(coalesce(sources.content, ''), 'sha256'), 'hex'),
  'system:legacy-import'
from public.tracework_sources as sources
where sources.document_id is null
  and not exists (
    select 1
    from public.tracework_library_documents as documents
    where documents.id = 'legacy-quarantine-source-' || encode(extensions.digest(sources.id, 'sha256'), 'hex')
  );

update public.tracework_sources as sources
set
  document_id = 'legacy-quarantine-source-' || encode(extensions.digest(sources.id, 'sha256'), 'hex'),
  updated_at = now()
where sources.document_id is null
  and exists (
    select 1
    from public.tracework_library_documents as documents
    where documents.id = 'legacy-quarantine-source-' || encode(extensions.digest(sources.id, 'sha256'), 'hex')
      and documents.collection_id = 'legacy-quarantine'
  );

-- An orphan chunk has no safe parent to quarantine. Stop before final lineage
-- constraints rather than fabricating a source relationship or discarding data.
do $$
begin
  if exists (
    select 1
    from public.tracework_chunks as chunks
    left join public.tracework_sources as sources on sources.id = chunks.source_id
    where sources.id is null
  ) then
    raise exception 'Tracework migration stopped: orphan chunk has no source parent';
  end if;
end;
$$;

-- Once this compatibility backfill completes, every existing source has one
-- canonical document parent, while a document may still have zero sources.
-- The latter is intentional for the three unindexed Workshop documents.
do $$
begin
  if exists (
    select 1
    from public.tracework_sources
    where document_id is null
  ) then
    raise exception 'Tracework migration stopped: a source has no deterministic document parent';
  end if;

  if exists (
    select 1
    from public.tracework_sources as sources
    left join public.tracework_library_documents as documents
      on documents.id = sources.document_id
    where documents.id is null
  ) then
    raise exception 'Tracework migration stopped: a source points at a missing document parent';
  end if;

  if exists (
    select document_id
    from public.tracework_sources
    where document_id is not null
    group by document_id
    having count(*) > 1
  ) then
    raise exception 'Tracework migration stopped: more than one source maps to a document';
  end if;
end;
$$;

-- Hashes and lineage are now available for read-only inventory. The partial
-- unique index enforces document -> source zero-or-one while compatibility
-- writers may still create a not-yet-parented source with a null document_id.
-- Final NOT NULL, foreign-key, unique-content, and publication/ownership
-- validation remain explicit later checkpoints.
update public.tracework_sources
set
  indexed_content_hash = encode(
    extensions.digest(coalesce(content, ''), 'sha256'),
    'hex'
  ),
  updated_at = coalesce(updated_at, now())
where indexed_content_hash is null;

-- During the compatibility window the old service-role RPCs remain active and
-- omit creator/publication fields. They are not safe end-user surfaces and are
-- not switched by 6B2A. The exact creator XOR and writer-specific publication
-- defaults must be installed together with the replacement writer functions
-- before authenticated or public retrieval uses the new fields.

create index if not exists tracework_collections_visibility
  on public.tracework_collections (visibility);

create index if not exists tracework_collections_owner
  on public.tracework_collections (owner_user_id);

create index if not exists tracework_collections_workspace
  on public.tracework_collections (workspace_id);

create index if not exists tracework_library_documents_collection_state
  on public.tracework_library_documents (collection_id, publication_state, sort_order, id);

create index if not exists tracework_library_documents_collection_hash
  on public.tracework_library_documents (collection_id, content_hash);

create index if not exists tracework_sources_document
  on public.tracework_sources (document_id)
  where document_id is not null;

create unique index if not exists tracework_sources_document_unique
  on public.tracework_sources (document_id)
  where document_id is not null;

-- These checks protect new values while allowing the compatibility validation
-- checkpoint to report any pre-existing nulls before final NOT NULL enforcement.
alter table public.tracework_collections
  add constraint tracework_collections_visibility_check
  check (visibility is null or visibility in ('private', 'workspace', 'public'))
  not valid;

alter table public.tracework_collections
  add constraint tracework_collections_scope_shape_check
  check (
    visibility is null
    or (
      (visibility = 'private' and owner_user_id is not null and workspace_id is null)
      or (visibility = 'workspace' and workspace_id is not null and owner_user_id is null)
      or (visibility = 'public' and owner_user_id is null and workspace_id is null)
    )
  )
  not valid;

alter table public.tracework_library_documents
  add constraint tracework_library_documents_publication_state_check
  check (
    publication_state is null
    or publication_state in ('pending', 'published', 'blocked', 'superseded')
  )
  not valid;

alter table public.tracework_collections
  add constraint tracework_collections_creator_exclusive_check
  check (
    not (created_by_user_id is not null and created_by_system_key is not null)
  )
  not valid;

alter table public.tracework_library_documents
  add constraint tracework_library_documents_creator_exclusive_check
  check (
    not (created_by_user_id is not null and created_by_system_key is not null)
  )
  not valid;

alter table public.tracework_collections
  add constraint tracework_collections_system_scope_check
  check (
    created_by_system_key is null
    or (
      created_by_system_key like 'system:%'
      and visibility = 'public'
      and owner_user_id is null
      and workspace_id is null
    )
  )
  not valid;

alter table public.tracework_library_documents
  add constraint tracework_library_documents_system_creator_check
  check (
    created_by_system_key is null
    or created_by_system_key like 'system:%'
  )
  not valid;

-- The exact user-creator XOR system-creator rule is intentionally deferred:
-- the still-active legacy service-role RPCs do not send creator fields.
-- After new writers are installed, a later checkpoint must backfill any
-- remaining null creator pair and enforce exactly one creator.
--
-- Final foreign keys, NOT NULL constraints, unique one-source enforcement,
-- exact creator XOR validation, RLS policies, authenticated RPCs, and route
-- cutover are intentionally later checkpoints. This file does not redefine or
-- grant any existing RPC.
