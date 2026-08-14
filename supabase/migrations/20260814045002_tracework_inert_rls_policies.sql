-- Phase 6D3 - inert RLS policy authoring (Option 3).
--
-- Anonymous catalogue, document, and retrieval access remain on the hardened
-- 6D2A RPC/server path (tracework_list_collections,
-- tracework_collection_documents, tracework_match_chunks). Those functions
-- continue to require collection visibility = 'public' AND document
-- publication_state = 'published'. Direct anon table grants must remain
-- absent. legacy-quarantine stays hidden because the 6D2A RPCs join only
-- published documents.
-- Later caller cutover must not grant anonymous direct table access
-- without a separately reviewed architecture. This file does not replace
-- those RPCs.
--
-- Table policies authorize authenticated private-owner and active-workspace
-- SELECT only. They remain inert until a later phase grants authenticated
-- table access. This file does not GRANT, REVOKE, replace functions, mutate
-- data, or change schema. RLS is already enabled; it is not toggled here.
--
-- Authentication is not authorization. Identity is auth.uid() only.
-- Client-supplied ownerId, userId, workspaceId, and created_by_system_key
-- are never consulted. auth.role() is not used. created_by_system_key is
-- not an access grant.
--
-- Acyclic dependency graph:
--   workspace_members -> (none)
--   workspaces -> workspace_members
--   tracework_collections -> workspace_members
--   tracework_library_documents -> tracework_collections
--   tracework_sources -> tracework_library_documents
--   tracework_chunks -> tracework_sources
--
-- Every outer-table column inside a lineage subquery is written table-
-- qualified (workspaces.id, tracework_library_documents.collection_slug,
-- tracework_sources.document_id, tracework_chunks.source_id). Unqualified,
-- PostgreSQL binds the innermost matching name, so a later migration adding
-- an `id` to workspace_members or a `document_id` to
-- tracework_library_documents would silently rebind the comparison to the
-- subquery's own row and collapse the predicate into an always-true exists.
-- That failure mode raises no error and changes no policy count. Authorization
-- must not depend on other tables never gaining a similarly named column.
--
-- Write policies are omitted: authenticated sync/delete remain
-- authorization_pending, and owner/member/viewer mutation rights are not yet
-- a closed product contract.

-- 1. Membership visibility: a principal may read their own membership row ----
create policy workspace_members_select
on public.workspace_members
for select
to authenticated
using (
  user_id = auth.uid()
);

comment on policy workspace_members_select on public.workspace_members is
  'Inert SELECT of the caller''s own membership row. Listing others and all writes omitted.';

-- 2. Workspace rows: active members may read the workspace -------------------
create policy workspaces_select
on public.workspaces
for select
to authenticated
using (
  exists (
    select 1
    from public.workspace_members as membership
    where membership.workspace_id = workspaces.id
      and membership.user_id = auth.uid()
      and membership.status = 'active'
  )
);

comment on policy workspaces_select on public.workspaces is
  'Inert SELECT for active members only. Invited/suspended cannot read the workspace. Writes omitted.';

-- 3. Collections: private owner or active workspace member -------------------
create policy tracework_collections_select
on public.tracework_collections
for select
to authenticated
using (
  (
    visibility = 'private'
    and owner_user_id = auth.uid()
  )
  or (
    visibility = 'workspace'
    and workspace_id is not null
    and exists (
      select 1
      from public.workspace_members as membership
      where membership.workspace_id = tracework_collections.workspace_id
        and membership.user_id = auth.uid()
        and membership.status = 'active'
    )
  )
);

comment on policy tracework_collections_select on public.tracework_collections is
  'Inert SELECT: authenticated private owner or active workspace member. Catalogue stays on 6D2A RPCs. Writes omitted.';

-- 4. Documents inherit collection authorization ------------------------------
create policy tracework_library_documents_select
on public.tracework_library_documents
for select
to authenticated
using (
  exists (
    select 1
    from public.tracework_collections as collections
    where collections.slug = tracework_library_documents.collection_slug
  )
);

comment on policy tracework_library_documents_select on public.tracework_library_documents is
  'Inert SELECT when the parent collection is visible through collection policy. Writes omitted.';

-- 5. Sources inherit document lineage ----------------------------------------
create policy tracework_sources_select
on public.tracework_sources
for select
to authenticated
using (
  exists (
    select 1
    from public.tracework_library_documents as documents
    where documents.id = tracework_sources.document_id
  )
);

comment on policy tracework_sources_select on public.tracework_sources is
  'Inert SELECT through an authorized parent document. No independent source authority. Writes omitted.';

-- 6. Chunks (and embeddings) inherit source lineage --------------------------
create policy tracework_chunks_select
on public.tracework_chunks
for select
to authenticated
using (
  exists (
    select 1
    from public.tracework_sources as sources
    where sources.id = tracework_chunks.source_id
  )
);

comment on policy tracework_chunks_select on public.tracework_chunks is
  'Inert SELECT through an authorized parent source; embeddings are columns on this table. Writes omitted.';
