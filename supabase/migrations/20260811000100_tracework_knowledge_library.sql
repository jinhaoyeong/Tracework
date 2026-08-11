-- Tracework: the shared knowledge library.
--
-- Until now the bundled corpora lived in TypeScript modules and were pushed into
-- one browser's localStorage by a "load" button, so a source added on a laptop
-- was invisible to a phone and to every other reader. This migration moves the
-- catalog into Postgres: collections and their documents are rows, the app reads
-- the catalog from the database, and indexing a collection is a read of shared
-- state rather than a replay of client-side fixtures.
--
-- Library documents are stored WITHOUT embeddings on purpose. The catalog has to
-- be listable before any embedding provider is configured, and chunking still
-- happens client-side before a source is synced into tracework_chunks.

create table if not exists public.tracework_collections (
  slug text primary key,
  title text not null,
  description text not null default '',
  kind text not null check (kind in ('note', 'file', 'sample')),
  provenance jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tracework_library_documents (
  id text primary key,
  collection_slug text not null references public.tracework_collections(slug) on delete cascade,
  title text not null,
  source_path text not null,
  kind text not null check (kind in ('note', 'file', 'sample')),
  content text not null,
  provenance jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists tracework_library_documents_collection
  on public.tracework_library_documents (collection_slug, sort_order);

-- Provenance was previously client-only state, which meant a source synced by one
-- reader reached the next reader without the authority record that Phase 5C
-- adjudication depends on. A shared library has to carry it in the database.
alter table public.tracework_sources
  add column if not exists provenance jsonb;

alter table public.tracework_collections enable row level security;
alter table public.tracework_library_documents enable row level security;

create or replace function public.tracework_upsert_collection(
  p_collection jsonb,
  p_documents jsonb
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  collection_slug_value text := nullif(trim(p_collection->>'slug'), '');
  document_count integer := 0;
begin
  if collection_slug_value is null then
    raise exception 'Tracework collection slug is required' using errcode = '22023';
  end if;

  insert into public.tracework_collections (slug, title, description, kind, provenance, sort_order, updated_at)
  values (
    collection_slug_value,
    coalesce(nullif(p_collection->>'title', ''), collection_slug_value),
    coalesce(p_collection->>'description', ''),
    coalesce(nullif(p_collection->>'kind', ''), 'sample'),
    coalesce(p_collection->'provenance', '{}'::jsonb),
    coalesce((p_collection->>'sortOrder')::integer, 0),
    now()
  )
  on conflict (slug) do update set
    title = excluded.title,
    description = excluded.description,
    kind = excluded.kind,
    provenance = excluded.provenance,
    sort_order = excluded.sort_order,
    updated_at = now();

  -- Reseeding is a replace, not an append: a document dropped from the seed set
  -- must disappear from the library instead of lingering as an orphan.
  delete from public.tracework_library_documents
  where collection_slug = collection_slug_value;

  insert into public.tracework_library_documents (
    id,
    collection_slug,
    title,
    source_path,
    kind,
    content,
    provenance,
    sort_order
  )
  select
    document_item->>'id',
    collection_slug_value,
    coalesce(nullif(document_item->>'title', ''), 'Untitled source'),
    coalesce(nullif(document_item->>'sourcePath', ''), 'shared library'),
    coalesce(nullif(document_item->>'kind', ''), 'sample'),
    coalesce(document_item->>'content', ''),
    coalesce(document_item->'provenance', '{}'::jsonb),
    coalesce((document_item->>'sortOrder')::integer, 0)
  from jsonb_array_elements(coalesce(p_documents, '[]'::jsonb)) as document_rows(document_item);

  get diagnostics document_count = row_count;

  return jsonb_build_object(
    'slug', collection_slug_value,
    'document_count', document_count
  );
end;
$$;

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
  left join public.tracework_library_documents as documents
    on documents.collection_slug = collections.slug
  group by collections.slug
  order by collections.sort_order asc, collections.title asc;
$$;

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
  where documents.collection_slug = p_slug
  order by documents.sort_order asc, documents.id asc;
$$;

-- tracework_replace_source and tracework_match_chunks are redefined so a synced
-- source carries its provenance into the database and back out of a search.
create or replace function public.tracework_replace_source(
  p_source jsonb,
  p_chunks jsonb
)
returns jsonb
language plpgsql
set search_path = public, extensions
as $$
declare
  source_id_value text := nullif(trim(p_source->>'id'), '');
  chunk_count integer := 0;
begin
  if source_id_value is null then
    raise exception 'Tracework source id is required' using errcode = '22023';
  end if;

  insert into public.tracework_sources (
    id,
    title,
    source_path,
    kind,
    content,
    file_type,
    provenance,
    created_at
  )
  values (
    source_id_value,
    coalesce(nullif(p_source->>'title', ''), 'Untitled source'),
    coalesce(nullif(p_source->>'sourcePath', ''), 'unknown source'),
    coalesce(nullif(p_source->>'kind', ''), 'note'),
    coalesce(p_source->>'content', ''),
    nullif(p_source->>'fileType', ''),
    p_source->'provenance',
    coalesce(nullif(p_source->>'createdAt', '')::timestamptz, now())
  )
  on conflict (id) do update set
    title = excluded.title,
    source_path = excluded.source_path,
    kind = excluded.kind,
    content = excluded.content,
    file_type = excluded.file_type,
    provenance = excluded.provenance,
    created_at = excluded.created_at;

  delete from public.tracework_chunks
  where source_id = source_id_value;

  insert into public.tracework_chunks (
    id,
    source_id,
    chunk_index,
    content,
    start_offset,
    end_offset,
    embedding,
    embedding_model,
    created_at
  )
  select
    chunk_item->>'id',
    source_id_value,
    (chunk_item->>'index')::integer,
    chunk_item->>'text',
    (chunk_item->>'start')::integer,
    (chunk_item->>'end')::integer,
    (chunk_item->'neuralEmbedding'->>'vector')::extensions.vector(1536),
    coalesce(nullif(chunk_item->'neuralEmbedding'->>'model', ''), 'unknown-model'),
    coalesce(nullif(chunk_item->'neuralEmbedding'->>'createdAt', '')::timestamptz, now())
  from jsonb_array_elements(coalesce(p_chunks, '[]'::jsonb)) as chunk_rows(chunk_item);

  get diagnostics chunk_count = row_count;

  return jsonb_build_object(
    'source_id', source_id_value,
    'chunk_count', chunk_count
  );
end;
$$;

-- The return signature gains a provenance column, so the old function has to go
-- before the new one can be created.
drop function if exists public.tracework_match_chunks(extensions.vector(1536), double precision, integer, text);

create function public.tracework_match_chunks(
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
    join public.tracework_sources as sources on sources.id = chunks.source_id
    where filter_kind is null or sources.kind = filter_kind
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

revoke all on table public.tracework_collections from anon, authenticated;
revoke all on table public.tracework_library_documents from anon, authenticated;
grant all on table public.tracework_collections, public.tracework_library_documents to service_role;

revoke execute on function public.tracework_upsert_collection(jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.tracework_list_collections() from public, anon, authenticated;
revoke execute on function public.tracework_collection_documents(text) from public, anon, authenticated;
revoke execute on function public.tracework_match_chunks(extensions.vector(1536), double precision, integer, text) from public, anon, authenticated;
grant execute on function public.tracework_upsert_collection(jsonb, jsonb) to service_role;
grant execute on function public.tracework_list_collections() to service_role;
grant execute on function public.tracework_collection_documents(text) to service_role;
grant execute on function public.tracework_match_chunks(extensions.vector(1536), double precision, integer, text) to service_role;
