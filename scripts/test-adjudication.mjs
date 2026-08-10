import assert from 'node:assert/strict'
import { adjudicateEvidence, ensureConflictCoverage } from '../src/lib/adjudication.ts'
import { createDocument, searchDocuments } from '../src/lib/rag.ts'
import { PHASE5C_CORPUS } from './fixtures/phase5c.mjs'

const makeDocuments = (includeAuthority) => PHASE5C_CORPUS
  .filter((_source, index) => includeAuthority || index < 2)
  .map((source) => createDocument(source.title, `synthetic / phase 5C / ${source.title}`, source.content, 'sample', { provenance: source.provenance }))

const question = 'Where was Tracework invented?'
const unresolvedResults = searchDocuments(makeDocuments(false), question, { engine: 'hashed', limit: 5 })
const unresolved = adjudicateEvidence(question, unresolvedResults)
assert.equal(unresolved.status, 'conflicted')
assert.equal(unresolved.conflicts.length, 1)
assert.equal(new Set(unresolved.conflicts[0].claims.map((claim) => claim.value)).size, 2)
assert.match(unresolved.notice, /No supplied provenance establishes a winner/)
assert.ok(unresolved.sources.every((source) => source.provenance.authority === 'unknown'))

const covered = ensureConflictCoverage(unresolved, [unresolvedResults[0]], 2)
assert.equal(covered.length, 2)
assert.deepEqual(new Set(covered.map((result) => result.document.title)), new Set(['changelog.md', 'project-history.md']))

const authorityResults = searchDocuments(makeDocuments(true), question, { engine: 'hashed', limit: 5 })
const authority = adjudicateEvidence(question, authorityResults)
assert.equal(authority.status, 'authority-supported')
assert.ok(authority.sources.some((source) => source.title === 'README.md' && source.state === 'authoritative'))
assert.match(authority.notice, /explicit provenance marks one claim as authoritative/)

const sameClaim = createDocument(
  'history-copy.md',
  'synthetic / phase 5C / duplicate claim',
  'Tracework was created in Malaysia in 2026.',
  'sample',
  { provenance: { origin: 'synthetic-fixture', authority: 'unknown', basis: 'Duplicate claim fixture.' } },
)
const sameClaimResult = searchDocuments([sameClaim], question, { engine: 'hashed', limit: 5 })
const clear = adjudicateEvidence(question, sameClaimResult)
assert.equal(clear.status, 'clear')
assert.equal(clear.conflicts.length, 0)

const elasticArchitecture = createDocument(
  'architecture.md',
  'synthetic / phase 5C / architecture',
  'Tracework does not use Elasticsearch, and never has.',
  'sample',
)
const elasticProposal = createDocument(
  'meeting-notes.md',
  'synthetic / phase 5C / meeting notes',
  'The team proposed moving to Elasticsearch, but the proposal was rejected.',
  'sample',
)
const elasticResults = searchDocuments([elasticArchitecture, elasticProposal], 'Does Tracework use Elasticsearch?', { engine: 'hashed', limit: 5 })
const elastic = adjudicateEvidence('Does Tracework use Elasticsearch?', elasticResults)
assert.equal(elastic.status, 'clear')
assert.equal(elastic.conflicts.length, 0)

// Authority resolves a disagreement only when it actually points at one value.
// Two authoritative sources contradicting each other establish no winner, and a
// second conflict carrying no authority at all must not be reported as resolved
// just because the totals happen to match.
const authorityA = createDocument('official-a.md', 'synthetic / phase 5C / official a', 'Tracework was invented in Japan in 2019.', 'sample',
  { provenance: { origin: 'indexed-file', authority: 'authoritative', basis: 'Declared authoritative fixture.' } })
const authorityB = createDocument('official-b.md', 'synthetic / phase 5C / official b', 'Tracework was invented in Finland in 2019.', 'sample',
  { provenance: { origin: 'indexed-file', authority: 'authoritative', basis: 'Declared authoritative fixture.' } })
const unownedA = createDocument('notes-c.md', 'synthetic / phase 5C / notes c', 'Tracework uses Elasticsearch.', 'sample')
const unownedB = createDocument('notes-d.md', 'synthetic / phase 5C / notes d', 'Tracework does not use Elasticsearch.', 'sample')

const duelQuestion = 'Where was Tracework invented and does it use Elasticsearch?'
const duel = adjudicateEvidence(duelQuestion, searchDocuments([authorityA, authorityB, unownedA, unownedB], duelQuestion, { engine: 'hashed', limit: 8 }))
assert.equal(duel.conflicts.length, 2, 'both the origin and the Elasticsearch disagreement should be detected')
assert.equal(duel.status, 'conflicted', 'contradicting authorities do not establish a winner')
assert.match(duel.notice, /No supplied provenance establishes a winner/)

// One conflict resolved by authority does not resolve a second that has none.
const partialAuthority = adjudicateEvidence(duelQuestion, searchDocuments([authorityA, unownedA, unownedB], duelQuestion, { engine: 'hashed', limit: 8 }))
assert.equal(partialAuthority.status, 'conflicted', 'an unowned conflict keeps the whole answer on hold')

console.log('Phase 5C adjudication tests passed')
