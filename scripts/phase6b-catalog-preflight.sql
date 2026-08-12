-- Tracework Phase 6B2D/6B2D.1 catalog preflight.
--
-- SELECT-only. This file is safe against both the current PRE_6B2C schema and
-- the future POST_6B2C schema. It never applies the migration, changes data,
-- changes grants/policies/functions, or installs extensions.
--
-- The migration-state queries use pg_catalog metadata and the post-migration
-- lineage checks read future fields through to_jsonb(row)->>'field'. That keeps
-- the SQL valid before those fields exist while still checking their values
-- after the migration.

-- COMMON: connection identity.
select
  current_database() as database_name,
  current_user as database_user,
  current_schema() as current_schema;

-- COMMON: extension inventory.
select
  extensions.extname,
  extensions.extversion,
  namespaces.nspname as extension_schema
from pg_extension as extensions
join pg_namespace as namespaces on namespaces.oid = extensions.extnamespace
where extensions.extname in ('pgcrypto', 'vector')
order by extensions.extname;

-- COMMON: exact extension function availability without invoking either
-- function. The text overload is the one used by extensions.digest(content,
-- 'sha256') in the unapplied migration.
with expected(function_name, lookup_name, required_by_migration) as (
  values
    ('digest(text,text)', 'extensions.digest(text,text)', true),
    ('digest(bytea,text)', 'extensions.digest(bytea,text)', false),
    ('gen_random_uuid()', 'extensions.gen_random_uuid()', true)
)
select
  expected.function_name,
  expected.lookup_name,
  expected.required_by_migration,
  to_regprocedure(expected.lookup_name)::text as resolved_signature,
  case
    when to_regprocedure(expected.lookup_name) is null then 'missing'
    else 'available'
  end as availability
from expected
order by expected.function_name;

-- COMMON/STATE: every object added by 6B2C. All expected objects present is
-- POST_6B2C; none present is valid PRE_6B2C; a mixed result is PARTIAL_6B2C.
with expected(object_name, object_kind, schema_name, relation_name, column_name) as (
  values
    ('public.workspaces table', 'table', 'public', 'workspaces', null),
    ('public.workspace_members table', 'table', 'public', 'workspace_members', null),
    ('tracework_collections.visibility', 'column', 'public', 'tracework_collections', 'visibility'),
    ('tracework_collections.workspace_id', 'column', 'public', 'tracework_collections', 'workspace_id'),
    ('tracework_collections.owner_user_id', 'column', 'public', 'tracework_collections', 'owner_user_id'),
    ('tracework_collections.created_by_user_id', 'column', 'public', 'tracework_collections', 'created_by_user_id'),
    ('tracework_collections.created_by_system_key', 'column', 'public', 'tracework_collections', 'created_by_system_key'),
    ('tracework_library_documents.collection_id', 'column', 'public', 'tracework_library_documents', 'collection_id'),
    ('tracework_library_documents.publication_state', 'column', 'public', 'tracework_library_documents', 'publication_state'),
    ('tracework_library_documents.content_hash', 'column', 'public', 'tracework_library_documents', 'content_hash'),
    ('tracework_library_documents.source_url', 'column', 'public', 'tracework_library_documents', 'source_url'),
    ('tracework_library_documents.document_date', 'column', 'public', 'tracework_library_documents', 'document_date'),
    ('tracework_library_documents.source_last_updated_date', 'column', 'public', 'tracework_library_documents', 'source_last_updated_date'),
    ('tracework_library_documents.created_by_user_id', 'column', 'public', 'tracework_library_documents', 'created_by_user_id'),
    ('tracework_library_documents.created_by_system_key', 'column', 'public', 'tracework_library_documents', 'created_by_system_key'),
    ('tracework_sources.document_id', 'column', 'public', 'tracework_sources', 'document_id'),
    ('tracework_sources.indexed_content_hash', 'column', 'public', 'tracework_sources', 'indexed_content_hash'),
    ('tracework_sources.updated_at', 'column', 'public', 'tracework_sources', 'updated_at')
), observed as (
  select
    expected.object_name,
    expected.object_kind,
    expected.schema_name,
    expected.relation_name,
    expected.column_name,
    relations.oid is not null as present
  from expected
  left join pg_class as relations
    on relations.relnamespace = to_regnamespace(expected.schema_name)
   and relations.relname = expected.relation_name
   and relations.relkind = 'r'
  where expected.object_kind = 'table'
  union all
  select
    expected.object_name,
    expected.object_kind,
    expected.schema_name,
    expected.relation_name,
    expected.column_name,
    attributes.attnum is not null as present
  from expected
  left join pg_class as relations
    on relations.relnamespace = to_regnamespace(expected.schema_name)
   and relations.relname = expected.relation_name
   and relations.relkind = 'r'
  left join pg_attribute as attributes
    on attributes.attrelid = relations.oid
   and attributes.attname = expected.column_name
   and attributes.attnum > 0
   and not attributes.attisdropped
  where expected.object_kind = 'column'
)
select
  case
    when bool_and(observed.present) then 'POST_6B2C'
    when not bool_or(observed.present) then 'PRE_6B2C'
    else 'PARTIAL_6B2C'
  end as migration_state,
  count(*) as expected_object_count,
  count(*) filter (where observed.present) as present_object_count,
  count(*) filter (where not observed.present) as missing_object_count,
  string_agg(observed.object_name, ', ' order by observed.object_name)
    filter (where not observed.present) as missing_objects
from observed;

-- COMMON/STATE: explicit pre/post assertion for every 6B2C object. In the
-- current state each absent field is reported PRE-MIGRATION EXPECTED.
with expected(object_name, object_kind, schema_name, relation_name, column_name) as (
  values
    ('public.workspaces table', 'table', 'public', 'workspaces', null),
    ('public.workspace_members table', 'table', 'public', 'workspace_members', null),
    ('tracework_collections.visibility', 'column', 'public', 'tracework_collections', 'visibility'),
    ('tracework_collections.workspace_id', 'column', 'public', 'tracework_collections', 'workspace_id'),
    ('tracework_collections.owner_user_id', 'column', 'public', 'tracework_collections', 'owner_user_id'),
    ('tracework_collections.created_by_user_id', 'column', 'public', 'tracework_collections', 'created_by_user_id'),
    ('tracework_collections.created_by_system_key', 'column', 'public', 'tracework_collections', 'created_by_system_key'),
    ('tracework_library_documents.collection_id', 'column', 'public', 'tracework_library_documents', 'collection_id'),
    ('tracework_library_documents.publication_state', 'column', 'public', 'tracework_library_documents', 'publication_state'),
    ('tracework_library_documents.content_hash', 'column', 'public', 'tracework_library_documents', 'content_hash'),
    ('tracework_library_documents.source_url', 'column', 'public', 'tracework_library_documents', 'source_url'),
    ('tracework_library_documents.document_date', 'column', 'public', 'tracework_library_documents', 'document_date'),
    ('tracework_library_documents.source_last_updated_date', 'column', 'public', 'tracework_library_documents', 'source_last_updated_date'),
    ('tracework_library_documents.created_by_user_id', 'column', 'public', 'tracework_library_documents', 'created_by_user_id'),
    ('tracework_library_documents.created_by_system_key', 'column', 'public', 'tracework_library_documents', 'created_by_system_key'),
    ('tracework_sources.document_id', 'column', 'public', 'tracework_sources', 'document_id'),
    ('tracework_sources.indexed_content_hash', 'column', 'public', 'tracework_sources', 'indexed_content_hash'),
    ('tracework_sources.updated_at', 'column', 'public', 'tracework_sources', 'updated_at')
), observed as (
  select
    expected.object_name,
    expected.object_kind,
    expected.schema_name,
    expected.relation_name,
    expected.column_name,
    relations.oid is not null as present
  from expected
  left join pg_class as relations
    on relations.relnamespace = to_regnamespace(expected.schema_name)
   and relations.relname = expected.relation_name
   and relations.relkind = 'r'
  where expected.object_kind = 'table'
  union all
  select
    expected.object_name,
    expected.object_kind,
    expected.schema_name,
    expected.relation_name,
    expected.column_name,
    attributes.attnum is not null as present
  from expected
  left join pg_class as relations
    on relations.relnamespace = to_regnamespace(expected.schema_name)
   and relations.relname = expected.relation_name
   and relations.relkind = 'r'
  left join pg_attribute as attributes
    on attributes.attrelid = relations.oid
   and attributes.attname = expected.column_name
   and attributes.attnum > 0
   and not attributes.attisdropped
  where expected.object_kind = 'column'
), state as (
  select case
    when bool_and(observed.present) then 'POST_6B2C'
    when not bool_or(observed.present) then 'PRE_6B2C'
    else 'PARTIAL_6B2C'
  end as migration_state
  from observed
)
select
  state.migration_state,
  observed.object_name,
  observed.object_kind,
  observed.present,
  case
    when state.migration_state = 'PRE_6B2C' and not observed.present then 'PRE-MIGRATION EXPECTED'
    when state.migration_state = 'POST_6B2C' and observed.present then 'POST-MIGRATION PRESENT'
    when state.migration_state = 'PARTIAL_6B2C' then 'PARTIAL-STATE BLOCKER'
    else 'STATE INCONSISTENCY'
  end as assertion
from state
cross join observed
order by observed.object_name;

-- COMMON: current table/RLS shape.
select
  namespaces.nspname as schema_name,
  relations.relname as table_name,
  relations.relkind,
  relations.relrowsecurity,
  relations.relforcerowsecurity
from pg_class as relations
join pg_namespace as namespaces on namespaces.oid = relations.relnamespace
where namespaces.nspname in ('public', 'auth')
  and relations.relname in (
    'tracework_collections',
    'tracework_library_documents',
    'tracework_sources',
    'tracework_chunks',
    'workspaces',
    'workspace_members'
  )
order by schema_name, table_name;

-- COMMON: actual columns, defaults, and nullability.
select
  namespaces.nspname as schema_name,
  relations.relname as table_name,
  attributes.attname as column_name,
  format_type(attributes.atttypid, attributes.atttypmod) as data_type,
  attributes.attnotnull,
  attributes.attidentity,
  attributes.atthasdef,
  pg_get_expr(defaults.adbin, defaults.adrelid) as default_expression
from pg_attribute as attributes
join pg_class as relations on relations.oid = attributes.attrelid
join pg_namespace as namespaces on namespaces.oid = relations.relnamespace
left join pg_attrdef as defaults
  on defaults.adrelid = attributes.attrelid
 and defaults.adnum = attributes.attnum
where namespaces.nspname = 'public'
  and relations.relname in (
    'tracework_collections',
    'tracework_library_documents',
    'tracework_sources',
    'tracework_chunks',
    'workspaces',
    'workspace_members'
  )
  and attributes.attnum > 0
  and not attributes.attisdropped
order by table_name, attributes.attnum;

-- COMMON: primary keys, foreign keys, unique and check constraints.
select
  namespaces.nspname as schema_name,
  relations.relname as table_name,
  constraints.conname as constraint_name,
  constraints.contype,
  constraints.convalidated,
  pg_get_constraintdef(constraints.oid, true) as definition
from pg_constraint as constraints
join pg_class as relations on relations.oid = constraints.conrelid
join pg_namespace as namespaces on namespaces.oid = relations.relnamespace
where namespaces.nspname = 'public'
  and relations.relname in (
    'tracework_collections',
    'tracework_library_documents',
    'tracework_sources',
    'tracework_chunks',
    'workspaces',
    'workspace_members'
  )
order by table_name, constraint_name;

-- COMMON: indexes.
select
  schemaname,
  tablename,
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in (
    'tracework_collections',
    'tracework_library_documents',
    'tracework_sources',
    'tracework_chunks',
    'workspaces',
    'workspace_members'
  )
order by tablename, indexname;

-- COMMON: RLS and policies.
select
  namespaces.nspname as schema_name,
  relations.relname as table_name,
  relations.relrowsecurity,
  relations.relforcerowsecurity,
  policies.polname as policy_name,
  policies.polcmd,
  policies.polpermissive,
  pg_get_expr(policies.polqual, policies.polrelid) as using_expression,
  pg_get_expr(policies.polwithcheck, policies.polrelid) as check_expression
from pg_class as relations
join pg_namespace as namespaces on namespaces.oid = relations.relnamespace
left join pg_policy as policies on policies.polrelid = relations.oid
where namespaces.nspname = 'public'
  and relations.relname in (
    'tracework_collections',
    'tracework_library_documents',
    'tracework_sources',
    'tracework_chunks',
    'workspaces',
    'workspace_members'
  )
order by table_name, policy_name;

-- COMMON: table grants.
select
  grantee,
  table_schema,
  table_name,
  privilege_type,
  is_grantable
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in (
    'tracework_collections',
    'tracework_library_documents',
    'tracework_sources',
    'tracework_chunks',
    'workspaces',
    'workspace_members'
  )
order by grantee, table_name, privilege_type;

-- COMMON: RPC definitions, owners, security mode, return shape, and
-- search_path/proconfig. No function is invoked.
select
  namespaces.nspname as schema_name,
  routines.proname as function_name,
  pg_get_function_identity_arguments(routines.oid) as identity_arguments,
  pg_get_function_result(routines.oid) as result_type,
  pg_get_userbyid(routines.proowner) as owner,
  routines.prosecdef as security_definer,
  routines.provolatile as volatility,
  routines.proconfig as configuration,
  pg_get_functiondef(routines.oid) as definition
from pg_proc as routines
join pg_namespace as namespaces on namespaces.oid = routines.pronamespace
where namespaces.nspname = 'public'
  and routines.proname in (
    'tracework_list_collections',
    'tracework_upsert_collection',
    'tracework_collection_documents',
    'tracework_replace_source',
    'tracework_delete_sources',
    'tracework_match_chunks'
  )
order by function_name, identity_arguments;

-- COMMON: RPC execute grants.
select
  grantee,
  routine_schema,
  routine_name,
  specific_name,
  privilege_type,
  is_grantable
from information_schema.role_routine_grants
where routine_schema = 'public'
  and routine_name in (
    'tracework_list_collections',
    'tracework_upsert_collection',
    'tracework_collection_documents',
    'tracework_replace_source',
    'tracework_delete_sources',
    'tracework_match_chunks'
  )
order by grantee, routine_name, specific_name, privilege_type;

-- COMMON: explicit overload count for each expected RPC.
with expected(function_name) as (
  values
    ('tracework_list_collections'),
    ('tracework_upsert_collection'),
    ('tracework_collection_documents'),
    ('tracework_replace_source'),
    ('tracework_delete_sources'),
    ('tracework_match_chunks')
)
select
  expected.function_name,
  count(routines.oid) as overload_count
from expected
left join pg_proc as routines
  on routines.pronamespace = 'public'::regnamespace
 and routines.proname = expected.function_name
group by expected.function_name
order by expected.function_name;

-- COMMON: known collection identities.
with expected(slug) as (
  values
    ('workshop-notes'),
    ('meridian-access-programme'),
    ('phase-5c-conflict-set'),
    ('phase-5c-authority-record')
)
select
  expected.slug,
  collections.slug is not null as present
from expected
left join public.tracework_collections as collections on collections.slug = expected.slug
order by expected.slug;

-- COMMON: known document identities and legacy parent matches.
with expected(id, collection_slug) as (
  values
    ('library-workshop-market-identity', 'workshop-notes'),
    ('library-workshop-trip-intelligence', 'workshop-notes'),
    ('library-workshop-rag-lab-notes', 'workshop-notes'),
    ('library-meridian-access-programme', 'meridian-access-programme'),
    ('library-phase5c-changelog', 'phase-5c-conflict-set'),
    ('library-phase5c-project-history', 'phase-5c-conflict-set'),
    ('library-phase5c-authoritative-readme', 'phase-5c-authority-record')
)
select
  expected.id,
  expected.collection_slug,
  documents.id is not null as present,
  documents.collection_slug = expected.collection_slug as parent_matches
from expected
left join public.tracework_library_documents as documents on documents.id = expected.id
order by expected.id;

-- COMMON: existing chunk/source integrity.
select
  count(*) as orphan_chunk_count
from public.tracework_chunks as chunks
left join public.tracework_sources as sources on sources.id = chunks.source_id
where sources.id is null;

-- POST_6B2C: source-parent checks are safe before migration because the future
-- fields are read from the row's JSON representation rather than referenced as
-- SQL columns. Values are intentionally NULL while PRE_6B2C.
with expected(object_name, object_kind, schema_name, relation_name, column_name) as (
  values
    ('public.workspaces table', 'table', 'public', 'workspaces', null),
    ('public.workspace_members table', 'table', 'public', 'workspace_members', null),
    ('tracework_collections.visibility', 'column', 'public', 'tracework_collections', 'visibility'),
    ('tracework_collections.workspace_id', 'column', 'public', 'tracework_collections', 'workspace_id'),
    ('tracework_collections.owner_user_id', 'column', 'public', 'tracework_collections', 'owner_user_id'),
    ('tracework_collections.created_by_user_id', 'column', 'public', 'tracework_collections', 'created_by_user_id'),
    ('tracework_collections.created_by_system_key', 'column', 'public', 'tracework_collections', 'created_by_system_key'),
    ('tracework_library_documents.collection_id', 'column', 'public', 'tracework_library_documents', 'collection_id'),
    ('tracework_library_documents.publication_state', 'column', 'public', 'tracework_library_documents', 'publication_state'),
    ('tracework_library_documents.content_hash', 'column', 'public', 'tracework_library_documents', 'content_hash'),
    ('tracework_library_documents.source_url', 'column', 'public', 'tracework_library_documents', 'source_url'),
    ('tracework_library_documents.document_date', 'column', 'public', 'tracework_library_documents', 'document_date'),
    ('tracework_library_documents.source_last_updated_date', 'column', 'public', 'tracework_library_documents', 'source_last_updated_date'),
    ('tracework_library_documents.created_by_user_id', 'column', 'public', 'tracework_library_documents', 'created_by_user_id'),
    ('tracework_library_documents.created_by_system_key', 'column', 'public', 'tracework_library_documents', 'created_by_system_key'),
    ('tracework_sources.document_id', 'column', 'public', 'tracework_sources', 'document_id'),
    ('tracework_sources.indexed_content_hash', 'column', 'public', 'tracework_sources', 'indexed_content_hash'),
    ('tracework_sources.updated_at', 'column', 'public', 'tracework_sources', 'updated_at')
), observed as (
  select expected.object_name, expected.object_kind, relations.oid is not null as present
  from expected
  left join pg_class as relations
    on relations.relnamespace = to_regnamespace(expected.schema_name)
   and relations.relname = expected.relation_name
   and relations.relkind = 'r'
  where expected.object_kind = 'table'
  union all
  select expected.object_name, expected.object_kind, attributes.attnum is not null as present
  from expected
  left join pg_class as relations
    on relations.relnamespace = to_regnamespace(expected.schema_name)
   and relations.relname = expected.relation_name
   and relations.relkind = 'r'
  left join pg_attribute as attributes
    on attributes.attrelid = relations.oid
   and attributes.attname = expected.column_name
   and attributes.attnum > 0
   and not attributes.attisdropped
  where expected.object_kind = 'column'
), state as (
  select case
    when bool_and(observed.present) then 'POST_6B2C'
    when not bool_or(observed.present) then 'PRE_6B2C'
    else 'PARTIAL_6B2C'
  end as migration_state
  from observed
)
select
  state.migration_state,
  case when state.migration_state = 'POST_6B2C'
    then count(*) filter (where to_jsonb(sources)->>'document_id' is null)
    else null end as source_without_document_count,
  case when state.migration_state = 'POST_6B2C'
    then count(*) filter (
      where to_jsonb(sources)->>'document_id' is not null
        and documents.id is null
    )
    else null end as source_with_missing_document_count
from state
cross join public.tracework_sources as sources
left join public.tracework_library_documents as documents
  on documents.id = to_jsonb(sources)->>'document_id'
group by state.migration_state;

-- POST_6B2C: one source per document when the parent field exists.
with expected(object_name, object_kind, schema_name, relation_name, column_name) as (
  values
    ('public.workspaces table', 'table', 'public', 'workspaces', null),
    ('public.workspace_members table', 'table', 'public', 'workspace_members', null),
    ('tracework_collections.visibility', 'column', 'public', 'tracework_collections', 'visibility'),
    ('tracework_collections.workspace_id', 'column', 'public', 'tracework_collections', 'workspace_id'),
    ('tracework_collections.owner_user_id', 'column', 'public', 'tracework_collections', 'owner_user_id'),
    ('tracework_collections.created_by_user_id', 'column', 'public', 'tracework_collections', 'created_by_user_id'),
    ('tracework_collections.created_by_system_key', 'column', 'public', 'tracework_collections', 'created_by_system_key'),
    ('tracework_library_documents.collection_id', 'column', 'public', 'tracework_library_documents', 'collection_id'),
    ('tracework_library_documents.publication_state', 'column', 'public', 'tracework_library_documents', 'publication_state'),
    ('tracework_library_documents.content_hash', 'column', 'public', 'tracework_library_documents', 'content_hash'),
    ('tracework_library_documents.source_url', 'column', 'public', 'tracework_library_documents', 'source_url'),
    ('tracework_library_documents.document_date', 'column', 'public', 'tracework_library_documents', 'document_date'),
    ('tracework_library_documents.source_last_updated_date', 'column', 'public', 'tracework_library_documents', 'source_last_updated_date'),
    ('tracework_library_documents.created_by_user_id', 'column', 'public', 'tracework_library_documents', 'created_by_user_id'),
    ('tracework_library_documents.created_by_system_key', 'column', 'public', 'tracework_library_documents', 'created_by_system_key'),
    ('tracework_sources.document_id', 'column', 'public', 'tracework_sources', 'document_id'),
    ('tracework_sources.indexed_content_hash', 'column', 'public', 'tracework_sources', 'indexed_content_hash'),
    ('tracework_sources.updated_at', 'column', 'public', 'tracework_sources', 'updated_at')
), observed as (
  select expected.object_name, expected.object_kind, relations.oid is not null as present
  from expected
  left join pg_class as relations
    on relations.relnamespace = to_regnamespace(expected.schema_name)
   and relations.relname = expected.relation_name
   and relations.relkind = 'r'
  where expected.object_kind = 'table'
  union all
  select expected.object_name, expected.object_kind, attributes.attnum is not null as present
  from expected
  left join pg_class as relations
    on relations.relnamespace = to_regnamespace(expected.schema_name)
   and relations.relname = expected.relation_name
   and relations.relkind = 'r'
  left join pg_attribute as attributes
    on attributes.attrelid = relations.oid
   and attributes.attname = expected.column_name
   and attributes.attnum > 0
   and not attributes.attisdropped
  where expected.object_kind = 'column'
), state as (
  select case
    when bool_and(observed.present) then 'POST_6B2C'
    when not bool_or(observed.present) then 'PRE_6B2C'
    else 'PARTIAL_6B2C'
  end as migration_state
  from observed
), duplicates as (
  select to_jsonb(sources)->>'document_id' as document_id
  from public.tracework_sources as sources
  where to_jsonb(sources)->>'document_id' is not null
  group by to_jsonb(sources)->>'document_id'
  having count(*) > 1
)
select
  state.migration_state,
  case when state.migration_state = 'POST_6B2C'
    then count(duplicates.document_id)
    else null end as duplicate_document_parent_count
from state
left join duplicates on true
group by state.migration_state;

-- COMMON: embedding model counts.
select
  embedding_model,
  count(*) as chunk_count
from public.tracework_chunks
group by embedding_model
order by embedding_model;

-- COMMON: vector dimensions and null count.
select
  count(*) filter (where embedding is null) as null_embedding_count,
  min(extensions.vector_dims(embedding)) filter (where embedding is not null) as minimum_embedding_dimension,
  max(extensions.vector_dims(embedding)) filter (where embedding is not null) as maximum_embedding_dimension
from public.tracework_chunks;

-- COMMON/POST_6B2C: stable identity source mappings. The future parent value
-- is extracted safely before the column exists and becomes a real comparison
-- after migration.
with expected_source_ids(source_id) as (
  values
    ('library-meridian-access-programme'),
    ('library-phase5c-changelog'),
    ('library-phase5c-project-history'),
    ('library-phase5c-authoritative-readme')
)
select
  sources.id as source_id,
  documents.id as expected_document_id,
  to_jsonb(sources)->>'document_id' as stored_document_id,
  case
    when to_jsonb(sources)->>'document_id' is null then null
    else to_jsonb(sources)->>'document_id' = documents.id
  end as stable_identity_match
from expected_source_ids as expected
join public.tracework_sources as sources on sources.id = expected.source_id
left join public.tracework_library_documents as documents on documents.id = sources.id
order by sources.id;
