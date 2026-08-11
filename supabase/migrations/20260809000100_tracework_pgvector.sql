-- Tracework Phase 3: durable sources, chunks, and OpenAI-compatible 1536d vectors.
-- Apply this migration to the Tracework Supabase project before enabling pgvector in the UI.

create extension if not exists vector with schema extensions;

create table if not exists public.tracework_sources (
  id text primary key,
  title text not null,
  source_path text not null,
  kind text not null check (kind in ('note', 'file', 'sample')),
  content text not null,
  file_type text,
  created_at timestamptz not null default now()
);

create table if not exists public.tracework_chunks (
  id text primary key,
  source_id text not null references public.tracework_sources(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null,
  start_offset integer not null check (start_offset >= 0),
  end_offset integer not null check (end_offset >= start_offset),
  embedding extensions.vector(1536) not null,
  embedding_model text not null,
  created_at timestamptz not null default now(),
  unique (source_id, chunk_index)
);

-- The operator class is schema-qualified because the vector extension lives in
-- `extensions`. Unqualified, this resolves only when the running session happens
-- to have that schema on its search_path, which the SQL Editor does and the
-- Supabase CLI does not.
create index if not exists tracework_chunks_embedding_hnsw
  on public.tracework_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

alter table public.tracework_sources enable row level security;
alter table public.tracework_chunks enable row level security;

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
    created_at
  )
  values (
    source_id_value,
    coalesce(nullif(p_source->>'title', ''), 'Untitled source'),
    coalesce(nullif(p_source->>'sourcePath', ''), 'unknown source'),
    coalesce(nullif(p_source->>'kind', ''), 'note'),
    coalesce(p_source->>'content', ''),
    nullif(p_source->>'fileType', ''),
    coalesce(nullif(p_source->>'createdAt', '')::timestamptz, now())
  )
  on conflict (id) do update set
    title = excluded.title,
    source_path = excluded.source_path,
    kind = excluded.kind,
    content = excluded.content,
    file_type = excluded.file_type,
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

create or replace function public.tracework_delete_sources(p_source_ids text[])
returns integer
language plpgsql
set search_path = public
as $$
declare
  deleted_count integer;
begin
  delete from public.tracework_sources
  where id = any(coalesce(p_source_ids, '{}'::text[]));
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

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
    qualified.embedding_model,
    1536,
    qualified.distance,
    1 - qualified.distance,
    qualified.candidate_count
  from qualified
  order by qualified.distance asc
  limit least(greatest(coalesce(match_count, 5), 1), 20);
$$;

revoke all on table public.tracework_sources from anon, authenticated;
revoke all on table public.tracework_chunks from anon, authenticated;
grant all on table public.tracework_sources, public.tracework_chunks to service_role;
grant usage on schema extensions to service_role;

revoke execute on function public.tracework_replace_source(jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.tracework_delete_sources(text[]) from public, anon, authenticated;
revoke execute on function public.tracework_match_chunks(extensions.vector(1536), double precision, integer, text) from public, anon, authenticated;
grant execute on function public.tracework_replace_source(jsonb, jsonb) to service_role;
grant execute on function public.tracework_delete_sources(text[]) to service_role;
grant execute on function public.tracework_match_chunks(extensions.vector(1536), double precision, integer, text) to service_role;
