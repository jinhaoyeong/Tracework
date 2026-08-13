/**
 * Phase 6D2A - public-read containment.
 *
 * The invariant under test:
 *
 *   an anonymous knowledge read may return a descendant row only when
 *     collection.visibility      = 'public'
 *   AND document.publication_state = 'published'
 *
 * This suite has two halves that are deliberately coupled:
 *
 *   1. STRUCTURAL - assertions against the real migration SQL. These prove the
 *      predicates exist in the shipped function bodies, that lineage is joined
 *      with INNER JOIN, that the search predicate sits inside candidate
 *      generation rather than after ranking, and that the migration changes no
 *      grant, policy, constraint, or table.
 *
 *   2. RELATIONAL - fixture evaluation over the same predicates.
 *
 * LIMITATION, stated explicitly: no Postgres is available in this environment
 * (the Supabase CLI's local stack needs Docker, which is not installed), so the
 * relational half evaluates a JavaScript model of the migration's joins rather
 * than executing the SQL. The model is not free-standing: every predicate it
 * applies is asserted to be present verbatim in the migration text first, so
 * weakening the SQL fails the structural half even if the model still passes.
 * Executing these functions against a real database belongs to the publication
 * checkpoint, not to this offline suite.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration = readFileSync(
  new URL('../supabase/migrations/20260814000100_tracework_public_read_containment.sql', import.meta.url),
  'utf8',
)

const VISIBILITY_PREDICATE = "collections.visibility = 'public'"
const PUBLICATION_PREDICATE = "documents.publication_state = 'published'"

/* ------------------------------------------------------- 1. structural */

const functionBody = (name) => {
  const start = migration.indexOf(`create or replace function public.${name}`)
  assert.notEqual(start, -1, `${name} must be redefined by the containment migration`)
  const end = migration.indexOf('$$;', start)
  assert.notEqual(end, -1, `${name} body must terminate`)
  return migration.slice(start, end)
}

const CONTAINED_FUNCTIONS = [
  'tracework_list_collections',
  'tracework_collection_documents',
  'tracework_match_chunks',
]

for (const name of CONTAINED_FUNCTIONS) {
  const body = functionBody(name)
  assert.ok(body.includes(VISIBILITY_PREDICATE), `${name} must require ${VISIBILITY_PREDICATE}`)
  assert.ok(body.includes(PUBLICATION_PREDICATE), `${name} must require ${PUBLICATION_PREDICATE}`)
  /* Security characteristics must survive the replacement. */
  assert.equal(/security\s+definer/i.test(body), false, `${name} must not become SECURITY DEFINER`)
  assert.ok(/set search_path = public/.test(body), `${name} must keep a pinned search_path`)
  assert.ok(/\bstable\b/.test(body), `${name} must remain stable`)
  /* Authorization must never come from a caller-supplied value. */
  for (const caller of ['p_visibility', 'p_publication_state', 'p_user', 'p_owner', 'p_workspace']) {
    assert.equal(body.includes(caller), false, `${name} must not accept caller-supplied ${caller}`)
  }
}

/* Lineage must be INNER JOIN so NULL/dangling document_id fails closed. */
const searchBody = functionBody('tracework_match_chunks')
assert.ok(
  /join public\.tracework_library_documents as documents\s+on documents\.id = sources\.document_id/.test(searchBody),
  'search must join documents through sources.document_id',
)
assert.ok(
  /join public\.tracework_collections as collections\s+on collections\.slug = documents\.collection_slug/.test(searchBody),
  'search must join collections through the document',
)
assert.equal(/left\s+join/i.test(searchBody), false, 'search lineage must not use LEFT JOIN')

/* The predicate must sit inside candidate generation, before ranking. */
const candidatesStart = searchBody.indexOf('with candidates as (')
const qualifiedStart = searchBody.indexOf('qualified as (')
assert.ok(candidatesStart !== -1 && qualifiedStart > candidatesStart, 'candidates CTE must precede qualified')
const candidatesCte = searchBody.slice(candidatesStart, qualifiedStart)
assert.ok(candidatesCte.includes(VISIBILITY_PREDICATE), 'visibility must be enforced during candidate generation')
assert.ok(candidatesCte.includes(PUBLICATION_PREDICATE), 'publication must be enforced during candidate generation')

/* Document read must not authorize on the slug argument alone. */
const documentsBody = functionBody('tracework_collection_documents')
assert.ok(documentsBody.includes('join public.tracework_collections as collections'), 'document read must join its collection')
assert.equal(/left\s+join/i.test(documentsBody), false, 'document lineage must not use LEFT JOIN')

/* Signatures and return shapes are preserved. */
assert.ok(searchBody.includes('query_embedding extensions.vector(1536)'), 'search signature preserved')
assert.ok(searchBody.includes('candidate_count bigint'), 'search return shape preserved')
assert.ok(documentsBody.includes('tracework_collection_documents(p_slug text)'), 'documents signature preserved')

/*
 * The migration must not touch anything outside these function bodies. Only
 * executable SQL is scanned: prose in `--` comments legitimately mentions words
 * like "grants" while granting nothing, exactly as source-map metadata may name
 * a .ts file without importing one.
 */
const executableSql = migration.replace(/--[^\n]*/g, '')
for (const forbidden of [
  /\bgrant\b/i, /\brevoke\b/i, /\bcreate\s+policy\b/i, /\bdrop\s+policy\b/i,
  /\balter\s+table\b/i, /\bcreate\s+table\b/i, /\bdrop\s+table\b/i, /\btruncate\b/i,
  /\binsert\s+into\b/i, /\bupdate\s+\w+\s+set\b/i, /\bdelete\s+from\b/i,
  /row\s+level\s+security/i, /\bdrop\s+function\b/i,
]) {
  assert.equal(forbidden.test(executableSql), false, `containment migration must not contain ${forbidden}`)
}

/* ------------------------------------------------------- 2. relational */

/*
 * The model below mirrors the joins asserted above. Guard first: if the SQL ever
 * stops expressing these predicates the structural half has already failed, so
 * the model can never silently diverge into testing something the SQL does not do.
 */
const collections = [
  { slug: 'public-published', visibility: 'public' },
  { slug: 'public-pending', visibility: 'public' },
  { slug: 'legacy-quarantine', visibility: 'public' },
  { slug: 'public-superseded', visibility: 'public' },
  { slug: 'private-col', visibility: 'private' },
  { slug: 'workspace-col', visibility: 'workspace' },
  { slug: 'null-visibility', visibility: null },
]
const documents = [
  { id: 'd-pub', collection_slug: 'public-published', publication_state: 'published' },
  { id: 'd-pending', collection_slug: 'public-pending', publication_state: 'pending' },
  { id: 'd-blocked', collection_slug: 'legacy-quarantine', publication_state: 'blocked' },
  { id: 'd-superseded', collection_slug: 'public-superseded', publication_state: 'superseded' },
  { id: 'd-private', collection_slug: 'private-col', publication_state: 'published' },
  { id: 'd-workspace', collection_slug: 'workspace-col', publication_state: 'published' },
  { id: 'd-nullvis', collection_slug: 'null-visibility', publication_state: 'published' },
  { id: 'd-nullstate', collection_slug: 'public-published', publication_state: null },
]
const sources = [
  { id: 's-pub', document_id: 'd-pub' },
  { id: 's-blocked', document_id: 'd-blocked' },
  { id: 's-private', document_id: 'd-private' },
  { id: 's-workspace', document_id: 'd-workspace' },
  { id: 's-orphan-null', document_id: null },
  { id: 's-orphan-dangling', document_id: 'no-such-document' },
]
const chunks = sources.map((s, i) => ({ id: `c-${i}`, source_id: s.id }))

const collectionBySlug = (slug) => collections.find((c) => c.slug === slug)
const documentById = (id) => documents.find((d) => d.id === id)

/* Mirrors the WHERE of tracework_collection_documents. */
const readDocuments = (slug) => documents.filter((d) => {
  const c = collectionBySlug(d.collection_slug)          // INNER JOIN
  return Boolean(c) && d.collection_slug === slug
    && c.visibility === 'public' && d.publication_state === 'published'
})

/* Mirrors the candidates CTE of tracework_match_chunks. */
const searchCandidates = () => chunks.filter((chunk) => {
  const s = sources.find((x) => x.id === chunk.source_id)        // INNER JOIN
  if (!s) return false
  const d = documentById(s.document_id)                          // INNER JOIN, NULL fails
  if (!d) return false
  const c = collectionBySlug(d.collection_slug)                  // INNER JOIN
  if (!c) return false
  return c.visibility === 'public' && d.publication_state === 'published'
})

/* Mirrors tracework_list_collections. */
const listCollections = () => collections
  .filter((c) => c.visibility === 'public')
  .map((c) => ({ slug: c.slug, document_count: documents.filter((d) => d.collection_slug === c.slug && d.publication_state === 'published').length }))
  .filter((row) => row.document_count > 0)

const cases = [
  ['public + published', () => readDocuments('public-published').map((d) => d.id), ['d-pub']],
  ['public + pending', () => readDocuments('public-pending'), []],
  ['public + blocked (legacy-quarantine)', () => readDocuments('legacy-quarantine'), []],
  ['public + superseded', () => readDocuments('public-superseded'), []],
  ['private + published', () => readDocuments('private-col'), []],
  ['workspace + published', () => readDocuments('workspace-col'), []],
  ['NULL visibility + published', () => readDocuments('null-visibility'), []],
  ['public + NULL publication_state', () => readDocuments('public-published').map((d) => d.id).filter((id) => id === 'd-nullstate'), []],
]

console.log('=== document read containment ===')
for (const [label, run, expected] of cases) {
  const actual = run()
  assert.deepEqual(actual, expected, `${label} must return ${JSON.stringify(expected)}`)
  console.log(`  ${label.padEnd(38)} -> ${JSON.stringify(actual)}`)
}

console.log('\n=== search candidate containment ===')
const candidates = searchCandidates().map((c) => c.source_id)
assert.deepEqual(candidates, ['s-pub'], 'only the public+published lineage may generate candidates')
for (const forbidden of ['s-blocked', 's-private', 's-workspace', 's-orphan-null', 's-orphan-dangling']) {
  assert.equal(candidates.includes(forbidden), false, `${forbidden} must never become a candidate`)
}
console.log(`  candidates: ${JSON.stringify(candidates)}`)
console.log('  blocked / private / workspace / NULL document_id / dangling document_id: all excluded')

console.log('\n=== legacy-quarantine regression ===')
assert.deepEqual(readDocuments('legacy-quarantine'), [], 'quarantined documents must not be readable')
assert.equal(
  searchCandidates().some((c) => {
    const s = sources.find((x) => x.id === c.source_id)
    return documentById(s?.document_id)?.collection_slug === 'legacy-quarantine'
  }),
  false,
  'quarantined chunks must not become candidates',
)
console.log('  anonymous documents = 0, anonymous chunk candidates = 0')

console.log('\n=== collection catalogue ===')
const listed = listCollections().map((r) => r.slug)
assert.deepEqual(listed, ['public-published'], 'only public collections with published documents are listed')
assert.equal(listed.includes('legacy-quarantine'), false, 'a fully blocked collection must not be advertised')
console.log(`  listed: ${JSON.stringify(listed)}`)

console.log('\nPhase 6D2A containment tests passed.')
console.log('LIMITATION: relational half models the migration SQL; no Postgres available offline.')
