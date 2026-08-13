-- Phase 6D2A - emergency public-read containment.
--
-- The three anonymous knowledge routes reach the database through service_role,
-- which has BYPASSRLS. Row level security is enabled on every knowledge table but
-- carries no policies, so RLS provides no containment for these reads today and
-- cannot be relied on here. The predicates below are therefore written directly
-- into the read functions, which is the only layer that constrains a
-- service_role caller.
--
-- The invariant this migration enforces:
--
--   a descendant row may be returned to an anonymous reader only when
--     collection.visibility      = 'public'
--   AND document.publication_state = 'published'
--
-- visibility = 'public' alone is NOT sufficient. The live database contains a
-- public collection ("legacy-quarantine") whose 26 documents are all
-- publication_state = 'blocked', and 26 of 58 chunks are reachable only through
-- non-published documents. Before this migration every one of those rows was
-- returnable to an anonymous caller.
--
-- Both predicates are written as equality tests, so NULL visibility and NULL
-- publication_state fail closed rather than defaulting to visible. Lineage is
-- joined with INNER JOIN so a source with a NULL or dangling document_id
-- (the column is nullable and has no foreign key until 6D2B) cannot become a
-- candidate.
--
-- Deliberately NOT changed here: tables, columns, constraints, RLS enablement,
-- policies, grants, ownership data, and the service_role application path.
-- CREATE OR REPLACE preserves each function's owner and existing EXECUTE grants;
-- no GRANT or REVOKE is issued. Signatures, return shapes, ordering, limits, and
-- ranking are unchanged - only rows that are not public+published disappear.

-- 1. Collection catalogue -----------------------------------------------------
-- Non-public collections are no longer listed at all. The join to documents is
-- now an INNER JOIN restricted to published rows, which also means the reported
-- document_count and character_count describe only publicly visible material
-- instead of silently counting blocked documents.
create or replace function public.tracework_list_collections()
returns table (
  slug text,
  title text,
  description text,
  kind text,
  provenance jsonb,
  sort_order integer,
  document_count bigint,
  character_count bigint,
  updated_at timestamptz
)
language sql
stable
set search_path = public
as $$
  select
    collections.slug,
    collections.title,
    collections.description,
    collections.kind,
    collections.provenance,
    collections.sort_order,
    count(documents.id) as document_count,
    coalesce(sum(length(documents.content)), 0) as character_count,
    collections.updated_at
  from public.tracework_collections as collections
  join public.tracework_library_documents as documents
    on documents.collection_slug = collections.slug
   and documents.publication_state = 'published'
  where collections.visibility = 'public'
  group by collections.slug
  order by collections.sort_order asc, collections.title asc;
$$;

-- 2. Collection documents -----------------------------------------------------
-- The slug argument selects which collection to read; it never decides whether
-- the caller may read it. Authorization comes from the collection row and the
-- document's own publication_state.
create or replace function public.tracework_collection_documents(p_slug text)
returns table (
  id text,
  collection_slug text,
  title text,
  source_path text,
  kind text,
  content text,
  provenance jsonb,
  sort_order integer
)
language sql
stable
set search_path = public
as $$
  select
    documents.id,
    documents.collection_slug,
    documents.title,
    documents.source_path,
    documents.kind,
    documents.content,
    documents.provenance,
    documents.sort_order
  from public.tracework_library_documents as documents
  join public.tracework_collections as collections
    on collections.slug = documents.collection_slug
  where documents.collection_slug = p_slug
    and collections.visibility = 'public'
    and documents.publication_state = 'published'
  order by documents.sort_order asc, documents.id asc;
$$;

-- 3. Vector search candidate generation ---------------------------------------
-- The authorization predicate is applied during candidate generation, inside the
-- candidates CTE, not after ranking. A blocked or private chunk is never scored,
-- never counted in candidate_count, and never returned. Retrieval behaviour is
-- otherwise untouched: the distance expression, threshold arithmetic, ordering,
-- and limit are identical to the previous definition.
create or replace function public.tracework_match_chunks(
  query_embedding extensions.vector(1536),
  match_threshold double precision default 0.12,
  match_count integer default 5,
  filter_kind text default null
)
returns table (
  id text,
  source_id text,
  content text,
  source_content text,
  chunk_index integer,
  start_offset integer,
  end_offset integer,
  title text,
  source_path text,
  kind text,
  provenance jsonb,
  embedding_model text,
  embedding_dimensions integer,
  distance double precision,
  similarity double precision,
  candidate_count bigint
)
language sql
stable
set search_path = public, extensions
as $$
  with candidates as (
    select
      chunks.id,
      chunks.source_id,
      chunks.content,
      sources.content as source_content,
      chunks.chunk_index,
      chunks.start_offset,
      chunks.end_offset,
      sources.title,
      sources.source_path,
      sources.kind,
      sources.provenance,
      chunks.embedding_model,
      (chunks.embedding <=> query_embedding)::double precision as distance
    from public.tracework_chunks as chunks
    join public.tracework_sources as sources
      on sources.id = chunks.source_id
    join public.tracework_library_documents as documents
      on documents.id = sources.document_id
    join public.tracework_collections as collections
      on collections.slug = documents.collection_slug
    where (filter_kind is null or sources.kind = filter_kind)
      and collections.visibility = 'public'
      and documents.publication_state = 'published'
  ),
  qualified as (
    select
      candidates.*,
      count(*) over () as candidate_count
    from candidates
    where candidates.distance <= 1 - greatest(least(coalesce(match_threshold, 0.12), 1), -1)
  )
  select
    qualified.id,
    qualified.source_id,
    qualified.content,
    qualified.source_content,
    qualified.chunk_index,
    qualified.start_offset,
    qualified.end_offset,
    qualified.title,
    qualified.source_path,
    qualified.kind,
    qualified.provenance,
    qualified.embedding_model,
    1536,
    qualified.distance,
    1 - qualified.distance,
    qualified.candidate_count
  from qualified
  order by qualified.distance asc
  limit least(greatest(coalesce(match_count, 5), 1), 20);
$$;
