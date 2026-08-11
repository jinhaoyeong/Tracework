import assert from 'node:assert/strict'
import { createDocument, searchDocuments } from '../src/lib/rag.ts'
import { adjudicateEvidence, ensureConflictCoverage } from '../src/lib/adjudication.ts'
import { buildCandidateUnion, pruneCandidates, rerank } from '../src/lib/reranker.ts'
import { buildLexicalIndex, searchLexical, toLexicalResults } from '../src/lib/lexical.ts'
import { extractTemporalClaims } from '../src/lib/temporal.ts'
import { normalizeTemporalExtraction } from '../src/lib/temporalNormalization.ts'
import { resolveTemporalNormalization } from '../src/lib/temporalResolution.ts'
import { ensureTemporalCoverage, temporalCoverageWitnessChunkIds, temporalCoverageWitnesses } from '../src/lib/temporalCoverage.ts'
import { buildVariant, PHASE5D_CASES } from './fixtures/phase5d.mjs'

const QUESTION = 'What is the current Team plan price?'
// The frozen padded corpus also contains the older Phase 4 pricing fixtures.
// Four slots are enough to reproduce the designated T7 source being pruned by
// the deterministic offline reranker while retaining real corpus competition.
const TOP_K = 4
const CANDIDATE_LIMIT = 10

const makeDocuments = (variantName) => buildVariant(variantName).map((source) => createDocument(
  source.title,
  `synthetic / phase 5D / ${source.title}`,
  source.content,
  'sample',
  { id: `phase5d-${source.title}`, provenance: source.provenance },
))

const resultsFrom = (documents) => documents.flatMap((document) => document.chunks.map((chunk) => ({
  chunk,
  document,
  score: 1,
  semanticScore: 1,
  keywordScore: 1,
  matchedTerms: [],
  engine: 'hashed',
})))

const normalizeResults = (question, results) => normalizeTemporalExtraction(
  extractTemporalClaims(question, results),
)

const titlesOf = (results) => results.map((result) => result.document.title)

/* -------------------------------------------------------------- T7 flagship */

const documents = makeDocuments('prunedSuperseder')
const lexicalIndex = buildLexicalIndex(documents)
const dense = searchDocuments(documents, QUESTION, { engine: 'hashed', limit: CANDIDATE_LIMIT })
const lexical = toLexicalResults(searchLexical(lexicalIndex, QUESTION, CANDIDATE_LIMIT), documents)
const union = buildCandidateUnion({ dense, lexical, limit: CANDIDATE_LIMIT })
const ranked = rerank(QUESTION, union)
const pruning = pruneCandidates(ranked, { maxChunks: TOP_K })
const prunedRows = pruning.selected.map((candidate) => candidate.result)
const prePruningNormalization = normalizeResults(QUESTION, ranked.map((candidate) => candidate.result))
const temporalWitnesses = temporalCoverageWitnesses(prePruningNormalization)

assert.ok(temporalWitnesses.length, 'T7 must expose a supersession witness pair before pruning')
assert.ok(!titlesOf(prunedRows).includes('t-pricing-2025.md'),
  `T7 must genuinely prune the superseding source; context was ${titlesOf(prunedRows).join(', ')}`)

const t7 = PHASE5D_CASES.find((spec) => spec.id === 'T7')
assert.equal(titlesOf(prunedRows).includes(t7.expectedPrunedWithoutCoverage), false)

const withoutCoverage = resolveTemporalNormalization(
  normalizeResults(QUESTION, prunedRows),
  { asOf: t7.asOf, requestedPeriod: t7.requestedPeriod },
)
assert.ok(!withoutCoverage.resolvedClaims.some((claim) => claim.claim.source === 't-pricing-2025.md'),
  'without temporal coverage the designated superseding source is absent from the resolution input')

const coveredRows = ensureTemporalCoverage(prePruningNormalization, prunedRows, TOP_K)
assert.ok(titlesOf(coveredRows).includes(t7.expectedCoverageRestores),
  `temporal coverage should restore ${t7.expectedCoverageRestores}`)
assert.equal(coveredRows.length, TOP_K, 'coverage must respect the existing topK cap')

const withCoverage = resolveTemporalNormalization(
  normalizeResults(QUESTION, coveredRows),
  { asOf: t7.asOf, requestedPeriod: t7.requestedPeriod },
)
assert.equal(withCoverage.status, 'resolved')
assert.equal(withCoverage.resolvedValue, '55 usd per seat per month',
  'restored supersession evidence must prevent the stale answer')
assert.ok(withCoverage.resolvedClaims.some((claim) => claim.claim.source === 't-pricing-2025.md'),
  'the restored superseder must remain among the selected resolution claims')

const witnessIds = temporalCoverageWitnessChunkIds(prePruningNormalization)
assert.ok([...witnessIds].every((id) => temporalWitnesses.some((result) => result.chunk.id === id)))

/* -------------------------------------------------- no relation, no mutation */

const ambiguousNormalization = normalizeResults(QUESTION, resultsFrom(makeDocuments('ambiguous')))
const ambiguousSelected = resultsFrom(makeDocuments('ambiguous')).slice(0, 1)
assert.equal(ambiguousNormalization.relations.length, 0)
assert.strictEqual(
  ensureTemporalCoverage(ambiguousNormalization, ambiguousSelected, TOP_K),
  ambiguousSelected,
  'without a derived relation, temporal coverage must not invent a witness or reorder context',
)

/* -------------------------------- composition with conflict coverage */

const conflictSources = [
  ['conflict-a.md', 'Tracework was invented in Japan.'],
  ['conflict-b.md', 'Tracework was invented in Malaysia.'],
].map(([title, content]) => createDocument(title, `synthetic / coverage / ${title}`, content, 'sample'))
const conflictResults = searchDocuments(conflictSources, 'Where was Tracework invented?', { engine: 'hashed', limit: 5 })
const conflict = adjudicateEvidence('Where was Tracework invented?', conflictResults)
assert.equal(conflict.status, 'conflicted')

const temporalWitness = temporalWitnesses[0]
const conflictFiller = conflictResults[0]
const conflictMissing = conflictResults.find((result) => result.chunk.id !== conflictFiller.chunk.id)
assert.ok(conflictMissing)
const unrelatedFiller = resultsFrom([
  createDocument('unrelated.md', 'synthetic / coverage / unrelated', 'Tracework retrieval metadata and chunk evidence.', 'sample'),
])[0]

const composed = ensureConflictCoverage(
  conflict,
  [temporalWitness, conflictFiller, unrelatedFiller],
  3,
  new Set([temporalWitness.chunk.id]),
)
assert.ok(composed.some((result) => result.chunk.id === temporalWitness.chunk.id),
  'conflict coverage must not evict a temporal witness restored by the first pass')
assert.ok(composed.some((result) => result.chunk.id === conflictMissing.chunk.id),
  'conflict coverage must still restore its own missing disagreement witness')
assert.equal(composed.length, 3)

// If all available slots are protected, the second pass stays fail-closed and
// does not evict a witness merely to satisfy its own cap.
const protectedOverflow = ensureConflictCoverage(
  conflict,
  [temporalWitness, conflictFiller],
  2,
  new Set([temporalWitness.chunk.id, conflictFiller.chunk.id]),
)
assert.deepEqual(titlesOf(protectedOverflow), titlesOf([temporalWitness, conflictFiller]))

console.log('Phase 5D temporal coverage tests passed / T7 pruning rescue + composition')
