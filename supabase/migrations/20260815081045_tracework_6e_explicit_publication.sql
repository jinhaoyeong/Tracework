-- Phase 6E: explicit publication for shared knowledge.
--
-- The gap this closes. Before 6E there was no code path that could make a
-- document readable by a second person:
--
--   1. handleVectorSync wrote tracework_sources with document_id left NULL, and
--      tracework_match_chunks INNER JOINs sources -> documents, so synced chunks
--      were eliminated before ranking no matter what state they carried.
--   2. publication_state defaults to 'pending' (20260812000100:103) and NOTHING
--      in the application or in any migration ever wrote it. Every write of that
--      column in the repository was a test fixture.
--
-- 6E adds the missing writer. It deliberately does NOT touch the read path: the
-- three 6D2A functions are not redefined here, so their bodies stay byte
-- identical and the public+published containment they enforce is unchanged.
--
-- ACL SHAPE. Every function below is SECURITY INVOKER and is granted to
-- service_role only, then revoked from public/anon/authenticated, matching
-- 20260811000100:346-349. 6E adds NO table grant and NO policy, so it is
-- independent of 6D4A and correct whether or not 6D4A is ever applied.
--
-- WHERE AUTHORIZATION LIVES. Two halves, deliberately split:
--   * in this file  - the publication state machine, and creator-only re-ingest
--   * in the server - the TRACEWORK_PUBLISHERS allowlist, because the database
--                     has no notion of that env value. These functions are
--                     reachable only with the service role, so the handler is
--                     the real boundary and this file is defence in depth.

-- 1. Fail-closed preconditions ------------------------------------------------
do $$
declare
  expected record;
  body text;
begin
  -- The four publication states 6E's state machine moves between must exist.
  if not exists (
    select 1 from pg_constraint
    where conname  = 'tracework_library_documents_publication_state_check'
      and conrelid = 'public.tracework_library_documents'::regclass
      and convalidated
  ) then
    raise exception 'Tracework 6E stopped: the validated publication_state CHECK is missing; apply 6D2B first';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname  = 'tracework_collections_visibility_check'
      and conrelid = 'public.tracework_collections'::regclass
      and convalidated
  ) then
    raise exception 'Tracework 6E stopped: the validated visibility CHECK is missing; apply 6D2B first';
  end if;

  -- The 6D2A read path must still be the containment path. If a function has
  -- lost its published/public predicate, 6E must not add a writer that assumes
  -- containment it can no longer rely on.
  for expected in
    select *
    from (values
      ('tracework_list_collections'),
      ('tracework_collection_documents'),
      ('tracework_match_chunks')
    ) as required(proname)
  loop
    select pg_get_functiondef(pro.oid) into body
    from pg_proc pro
    join pg_namespace nsp on nsp.oid = pro.pronamespace
    where nsp.nspname = 'public' and pro.proname = expected.proname
    limit 1;

    if body is null then
      raise exception 'Tracework 6E stopped: expected 6D2A function % is missing', expected.proname;
    end if;
    if position('publication_state = ''published''' in body) = 0 then
      raise exception 'Tracework 6E stopped: % no longer filters on published; containment is not what 6E assumes', expected.proname;
    end if;
    if position('visibility = ''public''' in body) = 0 then
      raise exception 'Tracework 6E stopped: % no longer filters on public visibility', expected.proname;
    end if;
  end loop;
end;
$$;

-- 2. Ingest -------------------------------------------------------------------
-- Atomic: document row, source lineage, and chunks in one transaction. A
-- document is created as 'pending' by omitting publication_state and letting the
-- column default apply, so a new document is invisible to the 6D2A path from the
-- moment it exists. There is no argument that lets a caller ingest straight to
-- 'published': promotion is a separate, separately authorized call.
create or replace function public.tracework_ingest_document(
  p_document jsonb,
  p_source jsonb,
  p_chunks jsonb,
  p_actor uuid
)
returns jsonb
language plpgsql
set search_path = public, extensions
as $$
declare
  v_document_id     text := nullif(trim(p_document->>'id'), '');
  v_collection_slug text := nullif(trim(p_document->>'collectionSlug'), '');
  v_source_id       text := nullif(trim(p_source->>'id'), '');
  v_content         text := coalesce(p_document->>'content', '');
  v_content_hash    text;
  v_prior_state     text;
  v_prior_hash      text;
  v_prior_creator   uuid;
  v_state           text;
  v_withdrawn       boolean := false;
  v_source_linked   boolean := false;
  v_source_hash     text;
  v_source_document text;
  v_chunk_count     integer := 0;
  v_visibility      text;
  v_owner           uuid;
  v_workspace       uuid;
  v_system_key      text;
  v_may_write       boolean := false;
begin
  if p_actor is null then
    raise exception 'Tracework ingest stopped: a verified principal is required' using errcode = '42501';
  end if;
  if v_document_id is null or v_collection_slug is null or v_source_id is null then
    raise exception 'Tracework ingest stopped: document id, collectionSlug and source id are all required'
      using errcode = '22023';
  end if;

  v_content_hash := md5(v_content);

  -- Collection write authorization. Three disjoint routes in:
  --
  --   CONTRIBUTOR  any verified principal may submit to a public collection that
  --                is NOT system-scoped. This is what makes the shared-knowledge
  --                workflow usable without a workspace system: the submission is
  --                'pending', invisible to every reader, and only an allowlisted
  --                publisher can ever make it visible. Contribution is not
  --                publication.
  --   OWNER        the collection's owner, for private collections.
  --   MEMBER       an ACTIVE member of the collection's workspace.
  --
  -- System collections are excluded by created_by_system_key, not by slug. The
  -- quarantine collection is the case that motivated this, but naming it here
  -- would leave the next system collection unprotected;
  -- tracework_collections_system_scope_check already guarantees a system row is
  -- public with no owner and no workspace, so the marker is the reliable test.
  --
  -- Creating collections stays with tracework_upsert_collection. Ingest never
  -- invents one, because inventing it means choosing a visibility, and
  -- visibility is an authorization decision rather than an indexing side effect.
  --
  -- "Not found" and "not permitted" share one message on purpose. A distinct
  -- "exists but forbidden" reply is an existence oracle over collection slugs,
  -- which is exactly what the 6D2A/6D4A read path refuses to provide.
  select visibility, owner_user_id, workspace_id, created_by_system_key
    into v_visibility, v_owner, v_workspace, v_system_key
    from public.tracework_collections
   where slug = v_collection_slug;

  v_may_write := v_visibility is not null and (
    (v_visibility = 'public' and v_system_key is null)
    or (v_owner is not null and v_owner = p_actor)
    or (v_workspace is not null and exists (
      select 1 from public.workspace_members as membership
      where membership.workspace_id = v_workspace
        and membership.user_id = p_actor
        and membership.status = 'active'
    ))
  );

  if not v_may_write then
    raise exception 'Tracework ingest stopped: no writable collection matched the request'
      using errcode = '42501';
  end if;

  select publication_state, content_hash, created_by_user_id
    into v_prior_state, v_prior_hash, v_prior_creator
    from public.tracework_library_documents
   where id = v_document_id;

  if v_prior_state is not null and v_prior_creator is distinct from p_actor then
    raise exception 'Tracework ingest stopped: document % was created by another principal', v_document_id
      using errcode = '42501';
  end if;

  select document_id, indexed_content_hash
    into v_source_document, v_source_hash
    from public.tracework_sources
   where id = v_source_id;

  -- SOURCE LINEAGE GUARD.
  --
  -- Without this, a caller could pass a source id that already belongs to
  -- someone else's document. The upsert below would re-point that source, and
  -- the chunk DELETE would destroy the original document's retrievability while
  -- leaving it 'published' - a document that still looks fine in the catalog and
  -- returns nothing from search. The document-level creator check above does not
  -- catch it, because the attacker's own document is new and legitimately theirs.
  --
  -- A NULL document_id is a pre-6E source that no document has claimed; adopting
  -- one is the lineage repair 6E exists to perform, so it is permitted.
  --
  -- The message names no id: whether a given source id exists is not something
  -- an unrelated caller should be able to probe.
  if v_source_document is not null and v_source_document is distinct from v_document_id then
    raise exception 'Tracework ingest stopped: that source id is already claimed by another document'
      using errcode = '42501';
  end if;

  v_source_linked := v_source_document is not distinct from v_document_id;

  -- Idempotency. Identical content, already linked, already indexed: change
  -- nothing at all. Re-indexing must never disturb a published document, and
  -- must not churn chunk rows for no reason.
  if v_prior_state is not null
     and v_prior_hash is not distinct from v_content_hash
     and coalesce(v_source_linked, false)
     and v_source_hash is not distinct from v_content_hash
  then
    return jsonb_build_object(
      'documentId',       v_document_id,
      'publicationState', v_prior_state,
      'withdrawn',        false,
      'chunkCount',       (select count(*) from public.tracework_chunks where source_id = v_source_id),
      'unchanged',        true
    );
  end if;

  if v_prior_state is null then
    -- publication_state omitted on purpose: the 'pending' column default is the
    -- only way a document acquires its first state.
    insert into public.tracework_library_documents (
      id, collection_slug, title, source_path, kind, content,
      provenance, sort_order, content_hash, created_by_user_id
    ) values (
      v_document_id,
      v_collection_slug,
      coalesce(nullif(p_document->>'title', ''), 'Untitled document'),
      coalesce(nullif(p_document->>'sourcePath', ''), 'unknown source'),
      coalesce(nullif(p_document->>'kind', ''), 'note'),
      v_content,
      coalesce(p_document->'provenance', '{}'::jsonb),
      coalesce((p_document->>'sortOrder')::integer, 0),
      v_content_hash,
      p_actor
    );
    select publication_state into v_state
      from public.tracework_library_documents where id = v_document_id;
  else
    -- D1: edited content on a published document is withdrawn back to pending.
    -- User B must not receive an unreviewed edit just because the first version
    -- passed review. 'blocked' and 'superseded' are NOT reopened by an edit;
    -- only tracework_set_publication_state moves out of those.
    v_withdrawn := (v_prior_state = 'published');
    v_state := case when v_prior_state = 'published' then 'pending' else v_prior_state end;

    update public.tracework_library_documents set
      collection_slug   = v_collection_slug,
      title             = coalesce(nullif(p_document->>'title', ''), title),
      source_path       = coalesce(nullif(p_document->>'sourcePath', ''), source_path),
      kind              = coalesce(nullif(p_document->>'kind', ''), kind),
      content           = v_content,
      content_hash      = v_content_hash,
      publication_state = v_state
    where id = v_document_id;
  end if;

  -- Source lineage. document_id is the whole point: without it the INNER JOIN in
  -- tracework_match_chunks drops every chunk this source owns.
  insert into public.tracework_sources (
    id, document_id, title, source_path, kind, content,
    file_type, indexed_content_hash, created_at, updated_at
  ) values (
    v_source_id,
    v_document_id,
    coalesce(nullif(p_source->>'title', ''), 'Untitled source'),
    coalesce(nullif(p_source->>'sourcePath', ''), 'unknown source'),
    coalesce(nullif(p_source->>'kind', ''), 'note'),
    coalesce(p_source->>'content', ''),
    nullif(p_source->>'fileType', ''),
    v_content_hash,
    coalesce(nullif(p_source->>'createdAt', '')::timestamptz, now()),
    now()
  )
  on conflict (id) do update set
    document_id          = excluded.document_id,
    title                = excluded.title,
    source_path          = excluded.source_path,
    kind                 = excluded.kind,
    content              = excluded.content,
    file_type            = excluded.file_type,
    indexed_content_hash = excluded.indexed_content_hash,
    updated_at           = now();

  delete from public.tracework_chunks where source_id = v_source_id;

  insert into public.tracework_chunks (
    id, source_id, chunk_index, content, start_offset, end_offset,
    embedding, embedding_model, created_at
  )
  select
    chunk_item->>'id',
    v_source_id,
    (chunk_item->>'index')::integer,
    chunk_item->>'text',
    (chunk_item->>'start')::integer,
    (chunk_item->>'end')::integer,
    (chunk_item->'neuralEmbedding'->>'vector')::extensions.vector(1536),
    coalesce(nullif(chunk_item->'neuralEmbedding'->>'model', ''), 'unknown-model'),
    coalesce(nullif(chunk_item->'neuralEmbedding'->>'createdAt', '')::timestamptz, now())
  from jsonb_array_elements(coalesce(p_chunks, '[]'::jsonb)) as chunk_rows(chunk_item);

  get diagnostics v_chunk_count = row_count;

  return jsonb_build_object(
    'documentId',       v_document_id,
    'publicationState', v_state,
    'withdrawn',        v_withdrawn,
    'chunkCount',       v_chunk_count,
    'unchanged',        false
  );
end;
$$;

-- 3. Publication state machine ------------------------------------------------
-- The ONLY writer of publication_state outside the column default. Transitions:
--
--     pending    -> published | blocked
--     published  -> superseded | blocked
--     blocked    -> pending
--     superseded -> (terminal)
--
-- superseded is terminal so that a withdrawn historical version can never be
-- resurrected into the public catalog by a state change alone; a replacement
-- must be ingested as its own document.
create or replace function public.tracework_set_publication_state(
  p_document_id text,
  p_next_state text,
  p_actor uuid
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_current text;
  v_allowed boolean;
begin
  if p_actor is null then
    raise exception 'Tracework publication stopped: a verified principal is required' using errcode = '42501';
  end if;
  if p_document_id is null or p_next_state is null then
    raise exception 'Tracework publication stopped: document id and next state are required' using errcode = '22023';
  end if;
  if p_next_state not in ('pending', 'published', 'blocked', 'superseded') then
    raise exception 'Tracework publication stopped: % is not a publication state', p_next_state
      using errcode = '22023';
  end if;

  select publication_state into v_current
    from public.tracework_library_documents
   where id = p_document_id
   for update;

  if v_current is null then
    raise exception 'Tracework publication stopped: document % does not exist', p_document_id
      using errcode = '23503';
  end if;

  v_allowed := case
    when v_current = 'pending'   and p_next_state in ('published', 'blocked')   then true
    when v_current = 'published' and p_next_state in ('superseded', 'blocked')  then true
    when v_current = 'blocked'   and p_next_state = 'pending'                   then true
    else false
  end;

  if not v_allowed then
    raise exception 'Tracework publication stopped: % -> % is not a permitted transition',
      v_current, p_next_state using errcode = '22023';
  end if;

  update public.tracework_library_documents
     set publication_state = p_next_state
   where id = p_document_id;

  return jsonb_build_object(
    'documentId',    p_document_id,
    'previousState', v_current,
    'currentState',  p_next_state,
    'actor',         p_actor
  );
end;
$$;

-- 4. Status read-back ---------------------------------------------------------
-- Lets the review UI show pending items, which the 6D2A catalog deliberately
-- cannot: that path returns published rows only, and must keep doing so.
create or replace function public.tracework_document_status(p_collection_slug text default null)
returns table (
  id text,
  collection_slug text,
  title text,
  publication_state text,
  content_hash text,
  created_by_user_id uuid,
  chunk_count bigint
)
language sql
stable
set search_path = public
as $$
  select
    documents.id,
    documents.collection_slug,
    documents.title,
    documents.publication_state,
    documents.content_hash,
    documents.created_by_user_id,
    count(chunks.id) as chunk_count
  from public.tracework_library_documents as documents
  left join public.tracework_sources as sources
    on sources.document_id = documents.id
  left join public.tracework_chunks as chunks
    on chunks.source_id = sources.id
  where p_collection_slug is null or documents.collection_slug = p_collection_slug
  group by documents.id, documents.collection_slug, documents.title,
           documents.publication_state, documents.content_hash, documents.created_by_user_id
  order by documents.collection_slug asc, documents.id asc;
$$;

-- 5. Grants -------------------------------------------------------------------
-- service_role only. 6E grants nothing to anon or authenticated and creates no
-- policy, so the 6D3 inert-policy posture and the 6D4A decision are both
-- untouched by this migration.
revoke execute on function public.tracework_ingest_document(jsonb, jsonb, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.tracework_set_publication_state(text, text, uuid) from public, anon, authenticated;
revoke execute on function public.tracework_document_status(text) from public, anon, authenticated;

grant execute on function public.tracework_ingest_document(jsonb, jsonb, jsonb, uuid) to service_role;
grant execute on function public.tracework_set_publication_state(text, text, uuid) to service_role;
grant execute on function public.tracework_document_status(text) to service_role;

-- 6. ROLLBACK (review only; do not execute as part of this migration) ----------
--
-- drop function if exists public.tracework_document_status(text);
-- drop function if exists public.tracework_set_publication_state(text, text, uuid);
-- drop function if exists public.tracework_ingest_document(jsonb, jsonb, jsonb, uuid);
--
-- Dropping these removes the only writer of publication_state. Existing rows keep
-- whatever state they hold; nothing in the 6D2A read path depends on these
-- functions existing.
