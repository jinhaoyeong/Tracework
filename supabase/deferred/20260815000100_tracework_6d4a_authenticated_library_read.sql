-- Phase 6D4A - authenticated private/workspace library reads.
--
-- This migration activates the 6D3 policies for the two library tables and
-- corrects the one 6D3 predicate that is wrong for D4-b. It does NOT add
-- policies.
--
-- WHY NO NEW POLICY IS CREATED HERE
-- ---------------------------------
-- 6D3 (20260814045002) already authored six inert SELECT policies. PostgreSQL
-- combines multiple PERMISSIVE policies on one table with OR, so a second
-- policy can only ever WIDEN access - it can never narrow it. Adding a
-- 6D4A-named policy beside tracework_library_documents_select would therefore
-- have left the 6D3 predicate live and kept pending and blocked documents
-- readable by an active workspace member, defeating D4-b entirely while every
-- structural check still passed. The correction is to change the existing
-- predicate in place.
--
-- WHAT CHANGES, AND WHAT DOES NOT
-- -------------------------------
--   changed   tracework_library_documents_select   publication gate added
--   unchanged workspace_members_select             already own-membership only
--   unchanged tracework_collections_select         already private-owner or
--                                                  active-workspace, no public
--                                                  branch
--   unchanged workspaces_select, tracework_sources_select,
--             tracework_chunks_select              6D3 as merged; they stay
--                                                  inert because 6D4A grants
--                                                  nothing on those tables
--
-- The two unchanged policies already satisfy their 6D4A specification word for
-- word, so they are asserted rather than rewritten. Recreating them identically
-- would drop their 6D3 comments and produce a diff a reviewer would have to
-- re-verify for no behavioural gain. Section 1 fails the migration if either has
-- drifted from that baseline.
--
-- Still true, and still deliberate:
--   * nothing is granted to anon;
--   * no function and no view is created; nothing is SECURITY DEFINER;
--   * tracework_list_collections(), tracework_collection_documents(text), and
--     tracework_match_chunks(...) are untouched - bodies, signatures, owners,
--     ACLs;
--   * tracework_sources, tracework_chunks, and workspaces are not granted;
--   * no policy anywhere gains a visibility = 'public' branch.
--
-- WHY THERE IS NO PUBLIC BRANCH
-- -----------------------------
-- Suppressing "legacy-quarantine" (public, 26 documents, all blocked), public
-- collections whose documents are all pending, and public collections with no
-- documents requires the collections policy to read document state. The
-- documents policy must read collections to learn its scope, and the resulting
-- collections <-> documents cycle is what PostgreSQL reports as 42P17. 6D2A's
-- function-body containment uses an INNER JOIN, which a row policy has no
-- equivalent for. Public rows therefore stay on the unchanged 6D2A service_role
-- path and are composed in by the server.
--
-- POLICY DEPENDENCY GRAPH after 6D3 + 6D4A (acyclic; proof by rank)
-- -----------------------------------------------------------------
--   rank 0  workspace_members            -> (none)
--   rank 1  workspaces                   -> workspace_members
--   rank 1  tracework_collections        -> workspace_members
--   rank 2  tracework_library_documents  -> tracework_collections
--   rank 3  tracework_sources            -> tracework_library_documents
--   rank 4  tracework_chunks             -> tracework_sources
--
-- Every edge strictly decreases rank. A cycle must return to its starting rank,
-- which requires at least one edge that does not. The 6D4A predicate adds no new
-- edge: it reads tracework_collections, which rank 2 already read.
--
-- FAIL-CLOSED PROPERTIES
-- ----------------------
-- With no session auth.uid() is NULL, so owner_user_id = NULL evaluates to NULL
-- rather than TRUE and the membership EXISTS matches nothing. visibility is NOT
-- NULL with a validated CHECK over exactly {private, workspace, public} (6D2B),
-- so there is no fourth branch to fall through. collection_slug is NOT NULL with
-- a foreign key, so the EXISTS clauses cannot be satisfied vacuously.

-- 1. Fail-closed preconditions ------------------------------------------------
-- These assert the 6D3 baseline rather than trusting migration order. The
-- decisive one is the per-table policy count: this migration exists because a
-- second permissive policy silently ORs, so it must refuse to run on a table
-- that already carries more than one.
do $$
declare
  expected record;
  policy_predicate text;
begin
  -- 1a. 6D2B invariants. Constraints are matched on conrelid AND conname:
  -- conname alone is not unique across a schema.
  for expected in
    select *
    from (values
      ('public.tracework_collections',       'tracework_collections_visibility_check'),
      ('public.tracework_collections',       'tracework_collections_private_requires_owner_check'),
      ('public.tracework_collections',       'tracework_collections_workspace_requires_workspace_id_check'),
      ('public.tracework_library_documents', 'tracework_library_documents_publication_state_check')
    ) as required(relation, constraint_name)
  loop
    if not exists (
      select 1
      from pg_constraint
      where conname  = expected.constraint_name
        and conrelid = expected.relation::regclass
        and convalidated
    ) then
      raise exception 'Tracework 6D4A stopped: % on % is missing or NOT VALID',
        expected.constraint_name, expected.relation;
    end if;
  end loop;

  if (
    select count(*) from pg_attribute
    where attrelid = 'public.tracework_collections'::regclass
      and attname = 'visibility' and attnotnull
  ) <> 1 then
    raise exception 'Tracework 6D4A stopped: tracework_collections.visibility is not NOT NULL; apply 6D2B first';
  end if;

  if (
    select count(*) from pg_attribute
    where attrelid = 'public.tracework_library_documents'::regclass
      and attname = 'publication_state' and attnotnull
  ) <> 1 then
    raise exception 'Tracework 6D4A stopped: tracework_library_documents.publication_state is not NOT NULL; apply 6D2B first';
  end if;

  -- 1b. The 6D3 policies must all be present, and each table must carry exactly
  -- one policy. A second permissive policy would OR with the one below and could
  -- only widen it, which is the defect this migration exists to correct.
  for expected in
    select *
    from (values
      ('public.workspace_members',           'workspace_members_select'),
      ('public.workspaces',                  'workspaces_select'),
      ('public.tracework_collections',       'tracework_collections_select'),
      ('public.tracework_library_documents', 'tracework_library_documents_select'),
      ('public.tracework_sources',           'tracework_sources_select'),
      ('public.tracework_chunks',            'tracework_chunks_select')
    ) as required(relation, policy_name)
  loop
    if not exists (
      select 1 from pg_policy
      where polrelid = expected.relation::regclass
        and polname  = expected.policy_name
    ) then
      raise exception 'Tracework 6D4A stopped: expected 6D3 policy % on % is missing; apply 20260814045002 first',
        expected.policy_name, expected.relation;
    end if;

    if (select count(*) from pg_policy where polrelid = expected.relation::regclass) <> 1 then
      raise exception 'Tracework 6D4A stopped: % carries more than one policy; permissive policies combine with OR and cannot narrow each other',
        expected.relation;
    end if;

    if not exists (
      select 1 from pg_class
      where oid = expected.relation::regclass and relrowsecurity
    ) then
      raise exception 'Tracework 6D4A stopped: row level security is not enabled on %', expected.relation;
    end if;
  end loop;

  -- 1c. The two policies 6D4A leaves alone must still match their 6D3 baseline.
  -- Structural assertions rather than exact text, because the deparsed form of a
  -- policy expression is not byte-stable across versions.
  select pg_get_expr(polqual, polrelid) into policy_predicate
  from pg_policy
  where polrelid = 'public.tracework_collections'::regclass
    and polname = 'tracework_collections_select';

  if policy_predicate like '%''public''%' then
    raise exception 'Tracework 6D4A stopped: tracework_collections_select has gained a public branch';
  end if;
  if policy_predicate not like '%''active''%' or policy_predicate not like '%''private''%' then
    raise exception 'Tracework 6D4A stopped: tracework_collections_select is not the 6D3 private-owner/active-workspace predicate';
  end if;

  select pg_get_expr(polqual, polrelid) into policy_predicate
  from pg_policy
  where polrelid = 'public.workspace_members'::regclass
    and polname = 'workspace_members_select';

  if policy_predicate not like '%uid()%' or policy_predicate like '%tracework%' then
    raise exception 'Tracework 6D4A stopped: workspace_members_select is not the 6D3 own-membership predicate';
  end if;

  -- 1d. The documents policy must still be the 6D3 baseline, so this migration
  -- cannot run twice or on top of a differently corrected predicate.
  select pg_get_expr(polqual, polrelid) into policy_predicate
  from pg_policy
  where polrelid = 'public.tracework_library_documents'::regclass
    and polname = 'tracework_library_documents_select';

  if policy_predicate like '%publication_state%' then
    raise exception 'Tracework 6D4A stopped: tracework_library_documents_select already gates on publication_state; the 6D3 baseline is not what is installed';
  end if;

  -- 1e. anon and authenticated must hold nothing today, at table or column
  -- level, on any of the six knowledge tables. has_table_privilege alone would
  -- miss a pre-existing column grant, so both are checked.
  for expected in
    select unnest(array[
      'tracework_collections',
      'tracework_library_documents',
      'tracework_sources',
      'tracework_chunks',
      'workspaces',
      'workspace_members'
    ]) as relation
  loop
    if has_table_privilege('anon', 'public.' || expected.relation, 'SELECT')
       or has_any_column_privilege('anon', 'public.' || expected.relation, 'SELECT') then
      raise exception 'Tracework 6D4A stopped: anon already holds SELECT on public.%; 6D4A grants anon nothing', expected.relation;
    end if;

    if has_table_privilege('authenticated', 'public.' || expected.relation, 'SELECT')
       or has_any_column_privilege('authenticated', 'public.' || expected.relation, 'SELECT') then
      raise exception 'Tracework 6D4A stopped: authenticated already holds SELECT on public.%; the starting ACL is not what 6D4A assumes', expected.relation;
    end if;
  end loop;

  -- 1f. The 6D2A functions must exist, must still be SECURITY INVOKER, and must
  -- still be reachable by service_role only. 6D4A changes none of them.
  for expected in
    select unnest(array[
      'public.tracework_list_collections()',
      'public.tracework_collection_documents(text)',
      'public.tracework_match_chunks(extensions.vector(1536), double precision, integer, text)'
    ]) as signature
  loop
    if to_regprocedure(expected.signature) is null then
      raise exception 'Tracework 6D4A stopped: expected 6D2A function % is missing', expected.signature;
    end if;
    if exists (select 1 from pg_proc where oid = to_regprocedure(expected.signature) and prosecdef) then
      raise exception 'Tracework 6D4A stopped: 6D2A function % is SECURITY DEFINER', expected.signature;
    end if;
    if has_function_privilege('anon', to_regprocedure(expected.signature), 'EXECUTE')
       or has_function_privilege('authenticated', to_regprocedure(expected.signature), 'EXECUTE') then
      raise exception 'Tracework 6D4A stopped: 6D2A function % is already executable by anon or authenticated', expected.signature;
    end if;
  end loop;
end;
$$;

-- 2. Correct the one 6D3 predicate that is wrong for D4-b ---------------------
--
-- 6D3 authorized a document whenever its parent collection was visible, with no
-- publication gate. Under that predicate an active workspace member reads
-- pending, blocked, and superseded documents. D4-b:
--
--   private, owned by the caller -> every publication_state, drafts included
--   workspace, caller active     -> publication_state = 'published' only
--   public                       -> unreachable here; 6D2A service_role path only
--
-- The scope test is not repeated: tracework_collections_select has already
-- reduced the visible collection set to private-owned and workspace-active rows,
-- so "collections.visibility = 'private'" here means "a private collection this
-- caller owns". Ownership stays defined in exactly one place.
--
-- ALTER rather than DROP + CREATE: it preserves the policy's identity, its role
-- list, its command, and its 6D3 comment, and it cannot leave the table
-- momentarily unprotected.
--
-- Outer-table columns inside the subqueries are table-qualified, following the
-- rule 6D3 records in its header: unqualified, a later migration adding a
-- similarly named column to tracework_collections would silently rebind the
-- comparison to the subquery's own row and collapse the predicate into an
-- always-true exists, with no error and no change in policy count.
alter policy tracework_library_documents_select
on public.tracework_library_documents
using (
  exists (
    select 1
    from public.tracework_collections as collections
    where collections.slug = tracework_library_documents.collection_slug
      and collections.visibility = 'private'
  )
  or (
    tracework_library_documents.publication_state = 'published'
    and exists (
      select 1
      from public.tracework_collections as collections
      where collections.slug = tracework_library_documents.collection_slug
        and collections.visibility = 'workspace'
    )
  )
);

comment on policy tracework_library_documents_select on public.tracework_library_documents is
  'SELECT through an authorized parent collection. Private owner reads every publication_state; workspace member reads published only. Public documents stay on the 6D2A RPC path. Writes omitted.';

-- 3. Grants -------------------------------------------------------------------
-- The complete ACL delta. Until this point every 6D3 policy was inert, because
-- authenticated held no table privilege at all.
--
-- workspace_members is granted at COLUMN level. The four columns are exactly
-- what tracework_collections_select reads plus what a membership UI needs.
-- invited_by_user_id is withheld deliberately - it is the only column on this
-- table carrying another user's identifier, and no policy needs it. joined_at
-- and the timestamps are withheld for the same reason.
--
-- This grant is required whether or not the two table grants are kept: the
-- collections policy's EXISTS is evaluated with the invoker's privileges.
grant select (workspace_id, user_id, role, status)
  on table public.workspace_members to authenticated;

grant select on table public.tracework_collections to authenticated;
grant select on table public.tracework_library_documents to authenticated;

-- Deliberately NOT granted, which is what keeps the remaining 6D3 policies
-- inert. Adding any of these is a separate, separately reviewed decision:
--   public.tracework_sources    -> 6D4B (scoped vector search)
--   public.tracework_chunks     -> 6D4B; carries the embedding column
--   public.workspaces           -> workspaces_select stays inert
--   anything at all to anon     -> the anonymous path stays on service_role

-- 4. Post-apply verification (review only; run manually, do not execute here) --
--
-- Expected effective policy set, one per table:
--   workspace_members            workspace_members_select            6D3, unchanged
--   workspaces                   workspaces_select                   6D3, unchanged, inert
--   tracework_collections        tracework_collections_select        6D3, unchanged
--   tracework_library_documents  tracework_library_documents_select  6D4A predicate
--   tracework_sources            tracework_sources_select            6D3, unchanged, inert
--   tracework_chunks             tracework_chunks_select             6D3, unchanged, inert
--
-- select polrelid::regclass as relation, count(*) as policies
--   from pg_policy group by 1 having count(*) <> 1;   -- must return zero rows
--
-- select polrelid::regclass, polname, polpermissive, polcmd,
--        pg_get_expr(polqual, polrelid)
--   from pg_policy order by 1, 2;
--
-- select grantee, table_name, privilege_type
--   from information_schema.role_table_grants
--  where table_schema = 'public' and grantee in ('anon', 'authenticated') order by 1, 2, 3;
--
-- select grantee, table_name, column_name, privilege_type
--   from information_schema.column_privileges
--  where table_schema = 'public' and grantee in ('anon', 'authenticated') order by 1, 2, 3;
--
-- select p.proname, pg_get_function_identity_arguments(p.oid), p.proacl
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname like 'tracework%' order by 1;

-- ROLLBACK (review only; do not execute as part of this migration)
-- Restores the 6D3 baseline exactly: the original predicate, the original
-- comment, and the pre-6D4A ACL. No data is written and no schema object is
-- altered, so the reversal is complete. Reverting this migration does NOT revert
-- route code deployed against it; ship the code after the migration and revert
-- it before.
--
-- alter policy tracework_library_documents_select
-- on public.tracework_library_documents
-- using (
--   exists (
--     select 1
--     from public.tracework_collections as collections
--     where collections.slug = tracework_library_documents.collection_slug
--   )
-- );
--
-- comment on policy tracework_library_documents_select on public.tracework_library_documents is
--   'Inert SELECT when the parent collection is visible through collection policy. Writes omitted.';
--
-- revoke select on table public.tracework_library_documents from authenticated;
-- revoke select on table public.tracework_collections from authenticated;
-- revoke select (workspace_id, user_id, role, status)
--   on table public.workspace_members from authenticated;
