-- Phase 6D2B - authorization schema readiness.
--
-- This migration makes policy-critical lineage structurally trustworthy. It does
-- not install RLS policies, grant anon/authenticated access, rewrite RPCs, or
-- change application privilege paths. Fail-fast: invalid live rows abort the
-- transaction. There is no data backfill.
--
-- Collection authority is a separate dimension from visibility. Public remains a
-- visibility state; a public collection may be user-owned, workspace-associated,
-- or system-created. The 6B2C compatibility CHECK
-- tracework_collections_scope_shape_check encoded premature exclusivity
-- (public => no owner and no workspace) and is dropped rather than validated.
-- The replacement is the minimum secure structure:
--   * some authority principal must exist
--   * private => owner_user_id
--   * workspace => workspace_id
-- System collections stay valid through the existing
-- tracework_collections_system_scope_check, which constrains system-keyed rows
-- only and does not mean "public implies system-owned".
--
-- Workspace membership is already structurally ready (NOT NULL, VALID domain
-- CHECKs, PK uniqueness, FKs). Policy-join indexes already exist. Neither is
-- duplicated here.
--
-- Do not apply this file in 6D2B. Publication is a later checkpoint.

-- 1. Fail-fast catalog + data preflight ---------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tracework_collections_visibility_check'
      and conrelid = 'public.tracework_collections'::regclass
      and not convalidated
  ) then
    raise exception 'Tracework 6D2B stopped: expected NOT VALID visibility CHECK is missing';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'tracework_library_documents_publication_state_check'
      and conrelid = 'public.tracework_library_documents'::regclass
      and not convalidated
  ) then
    raise exception 'Tracework 6D2B stopped: expected NOT VALID publication_state CHECK is missing';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'tracework_collections_scope_shape_check'
      and conrelid = 'public.tracework_collections'::regclass
  ) then
    raise exception 'Tracework 6D2B stopped: expected premature scope_shape CHECK is missing';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'tracework_collections_system_scope_check'
      and conrelid = 'public.tracework_collections'::regclass
      and not convalidated
  ) then
    raise exception 'Tracework 6D2B stopped: expected NOT VALID system_scope CHECK is missing';
  end if;

  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.tracework_sources'::regclass
      and contype = 'f'
      and pg_get_constraintdef(oid) ilike '%document_id%'
  ) then
    raise exception 'Tracework 6D2B stopped: sources.document_id foreign key already exists';
  end if;

  if exists (
    select 1
    from public.tracework_collections
    where visibility is null
       or visibility not in ('private', 'workspace', 'public')
  ) then
    raise exception 'Tracework 6D2B stopped: collections.visibility is null or outside {private,workspace,public}';
  end if;

  if exists (
    select 1
    from public.tracework_library_documents
    where publication_state is null
       or publication_state not in ('pending', 'published', 'blocked', 'superseded')
  ) then
    raise exception 'Tracework 6D2B stopped: documents.publication_state is null or outside {pending,published,blocked,superseded}';
  end if;

  if exists (
    select 1
    from public.tracework_sources as sources
    left join public.tracework_library_documents as documents
      on documents.id = sources.document_id
    where sources.document_id is null
       or documents.id is null
  ) then
    raise exception 'Tracework 6D2B stopped: sources.document_id is null or dangling';
  end if;

  if exists (
    select 1
    from public.tracework_collections
    where owner_user_id is null
      and workspace_id is null
      and created_by_system_key is null
  ) then
    raise exception 'Tracework 6D2B stopped: a collection has no authority principal';
  end if;

  if exists (
    select 1
    from public.tracework_collections
    where visibility = 'private'
      and owner_user_id is null
  ) then
    raise exception 'Tracework 6D2B stopped: a private collection has no owner_user_id';
  end if;

  if exists (
    select 1
    from public.tracework_collections
    where visibility = 'workspace'
      and workspace_id is null
  ) then
    raise exception 'Tracework 6D2B stopped: a workspace collection has no workspace_id';
  end if;
end;
$$;

-- 2. Validate existing domain CHECKs, then NOT NULL ---------------------------
-- The existing expressions already encode the allowed values (plus a NULL
-- allowance that SET NOT NULL removes). Validate rather than duplicating them.
-- Defaults stay visibility = 'public' and publication_state = 'pending'.
alter table public.tracework_collections
  validate constraint tracework_collections_visibility_check;

alter table public.tracework_library_documents
  validate constraint tracework_library_documents_publication_state_check;

alter table public.tracework_collections
  validate constraint tracework_collections_system_scope_check;

alter table public.tracework_collections
  alter column visibility set not null;

alter table public.tracework_library_documents
  alter column publication_state set not null;

-- 3. Minimum collection authority (not exclusive public ownership) ------------
alter table public.tracework_collections
  drop constraint tracework_collections_scope_shape_check;

alter table public.tracework_collections
  add constraint tracework_collections_authority_present_check
  check (
    owner_user_id is not null
    or workspace_id is not null
    or created_by_system_key is not null
  )
  not valid;

alter table public.tracework_collections
  validate constraint tracework_collections_authority_present_check;

alter table public.tracework_collections
  add constraint tracework_collections_private_requires_owner_check
  check (
    visibility <> 'private'
    or owner_user_id is not null
  )
  not valid;

alter table public.tracework_collections
  validate constraint tracework_collections_private_requires_owner_check;

alter table public.tracework_collections
  add constraint tracework_collections_workspace_requires_workspace_id_check
  check (
    visibility <> 'workspace'
    or workspace_id is not null
  )
  not valid;

alter table public.tracework_collections
  validate constraint tracework_collections_workspace_requires_workspace_id_check;

-- 4. Enforce source → document lineage ----------------------------------------
-- ON DELETE NO ACTION is the Postgres default. Deletion semantics for sources
-- are not established (authenticated delete remains authorization_pending).
alter table public.tracework_sources
  add constraint tracework_sources_document_id_fkey
  foreign key (document_id)
  references public.tracework_library_documents(id)
  on delete no action
  not valid;

alter table public.tracework_sources
  validate constraint tracework_sources_document_id_fkey;

alter table public.tracework_sources
  alter column document_id set not null;

-- 5. Workspace membership: already structurally ready -------------------------
-- Live audit (6D2B): workspaces = 0, workspace_members = 0.
-- workspace_id, user_id, role, status are already NOT NULL.
-- workspace_members_role_check is VALID: role in (owner, member, viewer).
-- workspace_members_status_check is VALID: status in (invited, active, suspended).
-- UNIQUE(workspace_id, user_id) is already PRIMARY KEY workspace_members_pkey.
-- FKs (preserve delete actions):
--   workspace_id → workspaces(id) ON DELETE CASCADE
--   user_id → auth.users(id) ON DELETE CASCADE
--   invited_by_user_id → auth.users(id) ON DELETE SET NULL
-- No 6D2B change.

-- 6. Policy-join indexes: already present -------------------------------------
-- chunks.source_id          UNIQUE (source_id, chunk_index)
-- sources.document_id       tracework_sources_document_unique (partial unique)
-- documents.collection_slug tracework_library_documents_collection (collection_slug, sort_order)
-- workspace_members         PRIMARY KEY (workspace_id, user_id)
-- No 6D2B index added.

-- ROLLBACK (review only; do not execute in 6D2B)
-- Live captured definitions before this file:
--   collections.visibility              nullable, default 'public'::text
--   collections_visibility_check        NOT VALID
--     CHECK (visibility IS NULL OR visibility IN ('private','workspace','public'))
--   collections_scope_shape_check       NOT VALID (premature exclusivity)
--   collections_system_scope_check      NOT VALID
--   documents.publication_state         nullable, default 'pending'::text
--   documents_publication_state_check   NOT VALID
--     CHECK (publication_state IS NULL OR publication_state IN ('pending','published','blocked','superseded'))
--   sources.document_id                 nullable, no FK
-- Validation is not a reversible flag. Restoring NOT VALID requires DROP +
-- recreate of the original CHECK.
--
-- alter table public.tracework_sources
--   alter column document_id drop not null;
-- alter table public.tracework_sources
--   drop constraint tracework_sources_document_id_fkey;
-- alter table public.tracework_collections
--   drop constraint tracework_collections_workspace_requires_workspace_id_check;
-- alter table public.tracework_collections
--   drop constraint tracework_collections_private_requires_owner_check;
-- alter table public.tracework_collections
--   drop constraint tracework_collections_authority_present_check;
-- alter table public.tracework_collections
--   add constraint tracework_collections_scope_shape_check
--   check (
--     visibility is null
--     or (
--       (visibility = 'private' and owner_user_id is not null and workspace_id is null)
--       or (visibility = 'workspace' and workspace_id is not null and owner_user_id is null)
--       or (visibility = 'public' and owner_user_id is null and workspace_id is null)
--     )
--   )
--   not valid;
-- alter table public.tracework_library_documents
--   alter column publication_state drop not null;
-- alter table public.tracework_collections
--   alter column visibility drop not null;
-- alter table public.tracework_collections
--   drop constraint tracework_collections_visibility_check;
-- alter table public.tracework_collections
--   add constraint tracework_collections_visibility_check
--   check (visibility is null or visibility in ('private', 'workspace', 'public'))
--   not valid;
-- alter table public.tracework_library_documents
--   drop constraint tracework_library_documents_publication_state_check;
-- alter table public.tracework_library_documents
--   add constraint tracework_library_documents_publication_state_check
--   check (
--     publication_state is null
--     or publication_state in ('pending', 'published', 'blocked', 'superseded')
--   )
--   not valid;
-- alter table public.tracework_collections
--   drop constraint tracework_collections_system_scope_check;
-- alter table public.tracework_collections
--   add constraint tracework_collections_system_scope_check
--   check (
--     created_by_system_key is null
--     or (
--       created_by_system_key like 'system:%'
--       and visibility = 'public'
--       and owner_user_id is null
--       and workspace_id is null
--     )
--   )
--   not valid;
