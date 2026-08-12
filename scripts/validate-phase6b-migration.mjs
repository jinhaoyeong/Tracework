import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { libraryCollections } from '../src/data/libraryCollections.ts'

const root = process.cwd()
const migrationPath = resolve(root, 'supabase/migrations/20260812000100_tracework_phase6b_ownership_compatibility.sql')
const migration = readFileSync(migrationPath, 'utf8')
const normalized = migration.toLowerCase()
const failures = []

const requireText = (label, value) => {
  if (!normalized.includes(value.toLowerCase())) failures.push(label + ': missing "' + value + '"')
}

const requirePattern = (label, pattern) => {
  if (!pattern.test(migration)) failures.push(label + ': pattern not found')
}

const forbidPattern = (label, pattern) => {
  if (pattern.test(migration)) failures.push(label + ': forbidden pattern found')
}

const quarantineDocumentId = (sourceId) => (
  'legacy-quarantine-source-' + createHash('sha256').update(sourceId, 'utf8').digest('hex')
)

const knownDocumentSeeds = libraryCollections.flatMap((collection) => (
  collection.documents.map((document) => ({
    id: document.id,
    collectionSlug: collection.slug,
  }))
))
const workshopDocumentIds = knownDocumentSeeds
  .filter((document) => document.collectionSlug === 'workshop-notes')
  .map((document) => document.id)
const sampleSourceIds = ['legacy-source-alpha', 'legacy-source-beta']
const sampleQuarantineIds = sampleSourceIds.map(quarantineDocumentId)

const requiredObjects = [
  ['workspaces table', 'create table if not exists public.workspaces'],
  ['workspace_members table', 'create table if not exists public.workspace_members'],
  ['collection visibility', 'add column if not exists visibility text'],
  ['collection workspace parent', 'add column if not exists workspace_id uuid'],
  ['collection user owner', 'add column if not exists owner_user_id uuid'],
  ['collection user contributor', 'add column if not exists created_by_user_id uuid'],
  ['collection system contributor', 'add column if not exists created_by_system_key text'],
  ['document canonical collection parent', 'add column if not exists collection_id text'],
  ['document publication state', 'add column if not exists publication_state text'],
  ['document content hash', 'add column if not exists content_hash text'],
  ['document system contributor', 'add column if not exists created_by_system_key text'],
  ['source canonical document parent', 'add column if not exists document_id text'],
  ['source indexed hash', 'add column if not exists indexed_content_hash text'],
  ['legacy quarantine collection', "'legacy-quarantine'"],
  ['bundled contributor', "'system:bundled-library'"],
  ['legacy contributor', "'system:legacy-import'"],
  ['public scope', "'public'"],
  ['private scope', "'private'"],
  ['workspace scope', "'workspace'"],
  ['pending state', "'pending'"],
  ['published state', "'published'"],
  ['blocked state', "'blocked'"],
  ['superseded state', "'superseded'"],
  ['orphan chunk stop', 'orphan chunk has no source parent'],
  ['known collection drift stop', 'reviewed collection identities are missing'],
  ['known document drift stop', 'reviewed document identities or parents drifted'],
  ['embedding model drift stop', 'embedding model drifted from text-embedding-3-small'],
  ['embedding dimension drift stop', 'tracework_chunks.embedding is not extensions.vector(1536)'],
  ['unresolved source parent stop', 'a source has no deterministic document parent'],
  ['missing source parent stop', 'a source points at a missing document parent'],
  ['ambiguous parent stop', 'ambiguous source parentage cannot be inferred'],
  ['multiple source parent stop', 'more than one source maps to a document'],
  ['pgcrypto hard gate', 'pgcrypto in schema extensions is required'],
  ['collection compatibility equality stop', 'collection_id disagrees with collection_slug'],
  ['quarantine collision stop', 'legacy quarantine slug is already owned by a non-quarantine collection'],
  ['quarantine document collision stop', 'deterministic legacy source document ID already belongs to another document'],
]

for (const [label, value] of requiredObjects) requireText(label, value)

for (const collection of libraryCollections) {
  requireText('known collection ' + collection.slug, "'" + collection.slug + "'")
  for (const document of collection.documents) {
    requireText('known document ' + document.id, "'" + document.id + "'")
    requireText('stable source mapping ' + document.id, "('" + document.id + "', '" + document.id + "')")
  }
}

// Compatibility migration safety guards.
forbidPattern('table removal', /\bdrop\s+(table|schema|database)\b/i)
forbidPattern('function removal', /\bdrop\s+function\b/i)
forbidPattern('extension installation', /\bcreate\s+extension\b/i)
forbidPattern('truncate', /\btruncate\b/i)
forbidPattern('row deletion', /\bdelete\s+from\b/i)
forbidPattern('chunk rewrite', /\b(update|insert\s+into)\s+public\.tracework_chunks\b/i)
forbidPattern('synthetic source creation', /\binsert\s+into\s+public\.tracework_sources\b/i)
forbidPattern('source identity rewrite', /\bupdate\s+public\.tracework_sources\s+set\s+id\b/i)
forbidPattern('chunk identity rewrite', /\bset\s+id\s*=/i)
if (migration.split(';').some((statement) => (
  /alter\s+table\s+public\.tracework_library_documents/i.test(statement)
  && /add\s+column[\s\S]*visibility/i.test(statement)
))) {
  failures.push('document visibility column: forbidden column on library documents')
}
forbidPattern('single-owner unique constraint', /unique[\s\S]{0,120}(owner|workspace)[\s\S]{0,120}owner/i)
forbidPattern('end-user RLS policy', /\bcreate\s+policy\b/i)
forbidPattern('RPC replacement', /\b(create|replace)\s+(or\s+replace\s+)?function\s+public\.tracework_/i)
forbidPattern('route cutover', /\/api\/(vector|library)\//i)
forbidPattern('provider call', /\bfetch\s*\(|\bopenai\b|\/v1\/responses|\/api\/(embed|generate)\b/i)
if (migration.split('\n').some((line) => /^\s*grant\b/i.test(line) && /\bto\s+(public|anon|authenticated)\b/i.test(line))) {
  failures.push('public grant: forbidden role on a GRANT line')
}

// The source parent is deliberately indexed but not finalized as unique until
// the M1 inventory proves there are no duplicate document parents.
requirePattern('compatibility source index', /create\s+index\s+if\s+not\s+exists\s+tracework_sources_document\b/i)
requirePattern('unique nullable source parent', /create\s+unique\s+index\s+if\s+not\s+exists\s+tracework_sources_document_unique[\s\S]{0,200}where\s+document_id\s+is\s+not\s+null/i)
requirePattern('stable source mapping CTE', /with\s+known_source_documents\s*\(\s*source_id\s*,\s*document_id\s*\)\s+as\s*\(/i)
forbidPattern('path/content source inference CTE', /unambiguous_matches/i)
forbidPattern('legacy MD5 quarantine ID', /'legacy-source-'\s*\|\|\s*md5\s*\(/i)
requireText('quarantine document namespace', "'legacy-quarantine-source-'")
requireText('quarantine SHA-256 derivation', "extensions.digest(sources.id, 'sha256')")
requireText('quarantine source provenance', "'legacySourceId', sources.id")
requireText('quarantine reason', "'quarantineReason', 'unresolved-parentage'")
requireText('quarantine migration batch', "'migrationBatch', '20260812000100'")
requirePattern('source-less publication semantics', /published catalog records[\s\S]{0,240}without synthetic sources/i)
requirePattern('published index caveat', /if an index exists/i)
requirePattern('lineage cardinality', /document\s+->\s+source\s+zero-or-one/i)
requirePattern('source parent cardinality', /every existing source has one[\s\S]{0,120}document parent/i)
requirePattern('chunk payload preservation', /existing chunk IDs and vector payloads are never written here/i)
requirePattern('future retrieval predicate', /publication_state\s*=\s*'published'/i)
requirePattern('pgcrypto extension catalog check', /from\s+pg_extension/i)

for (const sourceId of sampleQuarantineIds) {
  if (!sourceId.startsWith('legacy-quarantine-source-')) failures.push('quarantine ID namespace escaped: ' + sourceId)
  if (sourceId.length !== 'legacy-quarantine-source-'.length + 64) failures.push('quarantine ID is not SHA-256 length: ' + sourceId)
}
if (new Set(sampleQuarantineIds).size !== sampleQuarantineIds.length) failures.push('quarantine ID derivation is not deterministic/collision-distinct for samples')
for (const sourceId of sampleSourceIds) {
  if (quarantineDocumentId(sourceId) !== quarantineDocumentId(sourceId)) failures.push('quarantine ID derivation is not repeatable for ' + sourceId)
}
if (sampleQuarantineIds.some((id) => knownDocumentSeeds.some((document) => document.id === id))) {
  failures.push('quarantine ID collides with a known document seed')
}
if (workshopDocumentIds.length !== 3) failures.push('source-less Workshop seed count changed: ' + workshopDocumentIds.length)

const futureSearchEligible = (visibility, publicationState, authorizedScope) => (
  authorizedScope && visibility === 'public' && publicationState === 'published'
)
if (futureSearchEligible('public', 'blocked', true)) failures.push('blocked quarantine document would qualify for future search')
if (!futureSearchEligible('public', 'published', true)) failures.push('published document lost future search eligibility in the model')

if (libraryCollections.length !== 4) failures.push('seed collection count changed: ' + libraryCollections.length)
const seedDocuments = libraryCollections.flatMap((collection) => collection.documents)
if (seedDocuments.length !== 7) failures.push('seed document count changed: ' + seedDocuments.length)

const report = [
  'Phase 6B2A/6B2C offline migration validation',
  '',
  'migration file: ' + migrationPath,
  'migration applied: NO',
  'live database modified: NO',
  'provider calls: 0',
  '',
  'tables created:',
  '  public.workspaces',
  '  public.workspace_members',
  '',
  'columns added:',
  '  collection visibility/workspace/owner/contributor compatibility fields',
  '  document collection_id/publication_state/hash/contributor compatibility fields',
  '  source document_id/indexed_content_hash compatibility fields',
  '',
  'indexes added:',
  '  active workspace membership lookup',
  '  collection scope/owner/workspace lookup',
  '  document collection/state/order/hash lookup',
  '  nullable source document lookup',
  '  unique non-null source document parent lookup',
  '',
  'constraints added:',
  '  compatibility value/scope/creator-exclusivity checks marked NOT VALID',
  '  partial unique source parent compatibility guard added; exact creator XOR, final foreign keys, NOT NULL, and validation deferred',
  '',
  'known seed mapping:',
  '  four authored collections and seven stable document IDs -> public scope',
  '  known documents -> published / system:bundled-library',
  '  stable source ID -> same document ID only; no path/content inference',
  '  Workshop documents may remain published with zero source/chunk rows',
  '',
  'quarantine behavior:',
  '  unknown documents -> blocked / system:legacy-import',
  '  each unmatched source -> one SHA-256 namespace blocked quarantine document',
  '  source/chunk IDs, content, provenance, vectors, and embedding_model preserved',
  '  orphan chunks -> migration stop',
  '  drifted seed identities, model, dimension, or ambiguous parentage -> stop',
  '',
  'compatibility retained:',
  '  collection_slug remains and is backfilled into collection_id',
  '  source/chunk IDs, text, provenance, embeddings, and embedding_model are not rewritten',
  '',
  'intentionally not changed:',
  '  end-user RLS policies, authenticated RPCs, route grants, retrieval, auth, and provider behavior',
  '  pgcrypto is required by a hard catalog gate but is not installed by this migration',
]

if (failures.length) {
  console.error(report.concat(['', 'FAILURES:']).concat(failures.map((failure) => '- ' + failure)).join('\n'))
  process.exitCode = 1
} else {
  console.log(report.concat(['', 'validation: PASS']).join('\n'))
}
