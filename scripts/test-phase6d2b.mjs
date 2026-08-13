/**
 * Phase 6D2B - authorization schema readiness.
 *
 * Asserts the real migration SQL. Relational fixtures evaluate the CHECK /
 * NOT NULL / FK invariants that the SQL is first required to contain, so a
 * weakened migration fails even if the JavaScript model would still pass.
 *
 * Intentionally omitted after live audit (and therefore not asserted as new
 * 6D2B objects): exclusive public ownership, exclusive workspace-vs-owner
 * principals, collection owner/workspace FKs, workspace-membership DDL,
 * policy-join indexes, RLS policies, grants, and data backfill.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const readSql = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const migration = readSql('../supabase/migrations/20260814000200_tracework_authorization_schema_readiness.sql')
const containment = readSql('../supabase/migrations/20260814000100_tracework_public_read_containment.sql')
const compatibility = readSql('../supabase/migrations/20260812000100_tracework_phase6b_ownership_compatibility.sql')

const executableSql = migration.replace(/--[^\n]*/g, '')

const requireSql = (label, snippet) => {
  assert.ok(executableSql.toLowerCase().includes(snippet.toLowerCase()), label)
}

const forbidSql = (label, pattern) => {
  assert.equal(pattern.test(executableSql), false, label)
}

/* ------------------------------------------------------- 1. structural */

requireSql(
  'visibility domain CHECK is validated, not duplicated',
  'validate constraint tracework_collections_visibility_check',
)
requireSql(
  'publication-state domain CHECK is validated, not duplicated',
  'validate constraint tracework_library_documents_publication_state_check',
)
forbidSql(
  'must not drop the visibility domain CHECK',
  /drop\s+constraint\s+tracework_collections_visibility_check/i,
)
forbidSql(
  'must not drop the publication-state domain CHECK',
  /drop\s+constraint\s+tracework_library_documents_publication_state_check/i,
)

assert.ok(
  /visibility is null or visibility in \('private', 'workspace', 'public'\)/i.test(compatibility),
  'compatibility migration still defines the visibility domain',
)
assert.ok(
  /publication_state in \('pending', 'published', 'blocked', 'superseded'\)/i.test(compatibility),
  'compatibility migration still defines the publication-state domain',
)

requireSql('visibility NOT NULL intended', 'alter column visibility set not null')
requireSql('publication_state NOT NULL intended', 'alter column publication_state set not null')
requireSql('source.document_id NOT NULL intended', 'alter column document_id set not null')
forbidSql('must not change visibility default', /alter\s+column\s+visibility\s+set\s+default/i)
forbidSql('must not change publication_state default', /alter\s+column\s+publication_state\s+set\s+default/i)

requireSql(
  'source.document_id foreign key',
  'add constraint tracework_sources_document_id_fkey',
)
requireSql(
  'source.document_id references documents.id',
  'foreign key (document_id)\n  references public.tracework_library_documents(id)',
)
requireSql('source FK ON DELETE NO ACTION', 'on delete no action')
requireSql('source FK added NOT VALID', 'on delete no action\n  not valid')
requireSql(
  'source FK then validated',
  'validate constraint tracework_sources_document_id_fkey',
)

const AUTHORITY_CHECK = `check (
    owner_user_id is not null
    or workspace_id is not null
    or created_by_system_key is not null
  )`
requireSql('collection authority CHECK', `add constraint tracework_collections_authority_present_check\n  ${AUTHORITY_CHECK}`)
requireSql(
  'authority CHECK validated',
  'validate constraint tracework_collections_authority_present_check',
)

const PRIVATE_OWNER_CHECK = `check (
    visibility <> 'private'
    or owner_user_id is not null
  )`
requireSql('private requires owner CHECK', `add constraint tracework_collections_private_requires_owner_check\n  ${PRIVATE_OWNER_CHECK}`)

const WORKSPACE_ID_CHECK = `check (
    visibility <> 'workspace'
    or workspace_id is not null
  )`
requireSql(
  'workspace requires workspace_id CHECK',
  `add constraint tracework_collections_workspace_requires_workspace_id_check\n  ${WORKSPACE_ID_CHECK}`,
)

requireSql(
  'premature exclusive scope CHECK is dropped',
  'drop constraint tracework_collections_scope_shape_check',
)
forbidSql(
  'must not recreate exclusive public ownership',
  /add\s+constraint[\s\S]{0,80}scope_shape/i,
)
forbidSql(
  'must not require owner_user_id IS NULL for workspace collections',
  /add\s+constraint[\s\S]{0,400}visibility\s*=\s*'workspace'[\s\S]{0,120}owner_user_id\s+is\s+null/i,
)
forbidSql(
  'must not require workspace_id IS NULL for public collections',
  /add\s+constraint[\s\S]{0,400}visibility\s*=\s*'public'[\s\S]{0,120}workspace_id\s+is\s+null/i,
)

requireSql(
  'system-scope CHECK validated (system collections stay public/unowned)',
  'validate constraint tracework_collections_system_scope_check',
)
assert.ok(
  /created_by_system_key like 'system:%'[\s\S]{0,80}visibility = 'public'[\s\S]{0,80}owner_user_id is null[\s\S]{0,80}workspace_id is null/i.test(compatibility),
  'system-scope CHECK remains the 6B2C definition, not a new public-means-system rule',
)

assert.ok(
  /primary key \(workspace_id, user_id\)/i.test(compatibility),
  'workspace membership uniqueness already exists',
)
assert.ok(
  /role in \('owner', 'member', 'viewer'\)/i.test(compatibility),
  'workspace membership role domain already exists',
)
assert.ok(
  /status in \('invited', 'active', 'suspended'\)/i.test(compatibility),
  'workspace membership status domain already exists',
)
forbidSql('must not alter workspace_members', /alter\s+table\s+public\.workspace_members\b/i)
forbidSql('must not drop membership uniqueness', /drop\s+constraint\s+workspace_members_pkey/i)
forbidSql('must not drop membership role CHECK', /drop\s+constraint\s+workspace_members_role_check/i)
forbidSql('must not drop membership status CHECK', /drop\s+constraint\s+workspace_members_status_check/i)

forbidSql('no CREATE INDEX (existing policy-join indexes are sufficient)', /\bcreate\s+index\b/i)
forbidSql('no CREATE POLICY', /\bcreate\s+policy\b/i)
forbidSql('no ALTER POLICY', /\balter\s+policy\b/i)
forbidSql('no DROP POLICY', /\bdrop\s+policy\b/i)
forbidSql('no GRANT', /\bgrant\b/i)
forbidSql('no REVOKE', /\brevoke\b/i)
forbidSql('no SECURITY DEFINER', /security\s+definer/i)
forbidSql('no data UPDATE', /\bupdate\s+\w+\s+set\b/i)
forbidSql('no data DELETE', /\bdelete\s+from\b/i)
forbidSql('no data INSERT', /\binsert\s+into\b/i)

forbidSql(
  'must not redefine 6D2A RPCs',
  /create\s+or\s+replace\s+function\s+public\.tracework_(list_collections|collection_documents|match_chunks)/i,
)
assert.ok(
  containment.includes("collections.visibility = 'public'"),
  '6D2A visibility predicate preserved',
)
assert.ok(
  containment.includes("documents.publication_state = 'published'"),
  '6D2A publication predicate preserved',
)
for (const name of ['tracework_list_collections', 'tracework_collection_documents', 'tracework_match_chunks']) {
  const start = containment.indexOf(`create or replace function public.${name}`)
  assert.notEqual(start, -1, `${name} remains in the 6D2A containment migration`)
  const body = containment.slice(start, containment.indexOf('$$;', start))
  assert.ok(body.includes("collections.visibility = 'public'"), `${name} still requires public visibility`)
  assert.ok(body.includes("documents.publication_state = 'published'"), `${name} still requires published`)
}

/* ------------------------------------------------------- 2. adversarial fixtures */

const visibilityDomain = new Set(['private', 'workspace', 'public'])
const publicationDomain = new Set(['pending', 'published', 'blocked', 'superseded'])
const roleDomain = new Set(['owner', 'member', 'viewer'])
const statusDomain = new Set(['invited', 'active', 'suspended'])

const visibilityOk = (value) => value != null && visibilityDomain.has(value)
const publicationOk = (value) => value != null && publicationDomain.has(value)
const authorityPresent = (row) => (
  row.owner_user_id != null || row.workspace_id != null || row.created_by_system_key != null
)
const privateRequiresOwner = (row) => row.visibility !== 'private' || row.owner_user_id != null
const workspaceRequiresId = (row) => row.visibility !== 'workspace' || row.workspace_id != null
const systemScopeOk = (row) => (
  row.created_by_system_key == null
  || (
    String(row.created_by_system_key).startsWith('system:')
    && row.visibility === 'public'
    && row.owner_user_id == null
    && row.workspace_id == null
  )
)
const collectionValid = (row) => (
  visibilityOk(row.visibility)
  && authorityPresent(row)
  && privateRequiresOwner(row)
  && workspaceRequiresId(row)
  && systemScopeOk(row)
)
const sourceLineageValid = (source, documentIds) => (
  source.document_id != null && documentIds.has(source.document_id)
)
const membershipUnique = (rows) => {
  const seen = new Set()
  for (const row of rows) {
    const key = `${row.workspace_id}\0${row.user_id}`
    if (seen.has(key)) return false
    seen.add(key)
  }
  return true
}

const collectionCases = [
  ['private + owner', { visibility: 'private', owner_user_id: 'user-1', workspace_id: null, created_by_system_key: null }, true],
  ['private + no authority', { visibility: 'private', owner_user_id: null, workspace_id: null, created_by_system_key: null }, false],
  ['workspace + workspace_id', { visibility: 'workspace', owner_user_id: null, workspace_id: 'ws-1', created_by_system_key: null }, true],
  ['workspace + no workspace_id', { visibility: 'workspace', owner_user_id: null, workspace_id: null, created_by_system_key: null }, false],
  ['public + system key', { visibility: 'public', owner_user_id: null, workspace_id: null, created_by_system_key: 'system:bundled-library' }, true],
  ['public + owner', { visibility: 'public', owner_user_id: 'user-1', workspace_id: null, created_by_system_key: null }, true],
  ['public + workspace', { visibility: 'public', owner_user_id: null, workspace_id: 'ws-1', created_by_system_key: null }, true],
  ['collection with no authority fields', { visibility: 'public', owner_user_id: null, workspace_id: null, created_by_system_key: null }, false],
  ['NULL visibility', { visibility: null, owner_user_id: 'user-1', workspace_id: null, created_by_system_key: null }, false],
  ['system public remains valid', { visibility: 'public', owner_user_id: null, workspace_id: null, created_by_system_key: 'system:legacy-import' }, true],
  ['system key cannot take a user owner', { visibility: 'public', owner_user_id: 'user-1', workspace_id: null, created_by_system_key: 'system:bundled-library' }, false],
]

console.log('=== collection authority fixtures ===')
for (const [label, row, expected] of collectionCases) {
  const actual = collectionValid(row)
  assert.equal(actual, expected, `${label} expected ${expected}`)
  console.log(`  ${label.padEnd(42)} -> ${actual ? 'VALID' : 'INVALID'}`)
}

const documentIds = new Set(['doc-1'])
const sourceCases = [
  ['valid source→document', { document_id: 'doc-1' }, true],
  ['NULL source.document_id', { document_id: null }, false],
  ['dangling source.document_id', { document_id: 'missing-doc' }, false],
]

console.log('\n=== source lineage fixtures ===')
for (const [label, source, expected] of sourceCases) {
  const actual = sourceLineageValid(source, documentIds)
  assert.equal(actual, expected, `${label} expected ${expected}`)
  console.log(`  ${label.padEnd(42)} -> ${actual ? 'VALID' : 'INVALID'}`)
}

assert.equal(publicationOk('pending'), true)
assert.equal(publicationOk('published'), true)
assert.equal(publicationOk('blocked'), true)
assert.equal(publicationOk('superseded'), true)
assert.equal(publicationOk(null), false)
assert.equal(publicationOk('draft'), false)

console.log('\n=== workspace membership fixtures ===')
assert.equal(membershipUnique([{ workspace_id: 'ws-1', user_id: 'user-1' }]), true)
assert.equal(
  membershipUnique([
    { workspace_id: 'ws-1', user_id: 'user-1' },
    { workspace_id: 'ws-1', user_id: 'user-1' },
  ]),
  false,
  'duplicate (workspace_id, user_id) is INVALID because uniqueness is already adopted',
)
assert.equal(roleDomain.has('owner') && roleDomain.has('member') && roleDomain.has('viewer'), true)
assert.equal(statusDomain.has('invited') && statusDomain.has('active') && statusDomain.has('suspended'), true)
assert.equal(roleDomain.has('admin'), false)
assert.equal(statusDomain.has('deleted'), false)
console.log('  unique membership                         -> VALID')
console.log('  duplicate membership                      -> INVALID')
console.log('  role/status domains preserved')

console.log('\nPhase 6D2B schema-readiness tests passed.')
console.log('LIMITATION: fixtures evaluate the migration SQL invariants offline; the migration is not applied.')
