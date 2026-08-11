import assert from 'node:assert/strict'
import { createDocument, searchDocuments } from '../src/lib/rag.ts'
import { adjudicateEvidence, ensureConflictCoverage } from '../src/lib/adjudication.ts'
import { buildCandidateUnion, pruneCandidates, rerank } from '../src/lib/reranker.ts'
import { buildLexicalIndex, searchLexical, toLexicalResults } from '../src/lib/lexical.ts'
import { extractTemporalClaims } from '../src/lib/temporal.ts'
import { normalizeTemporalExtraction } from '../src/lib/temporalNormalization.ts'
import { resolveTemporalNormalization } from '../src/lib/temporalResolution.ts'
import { buildTemporalHoldAnswer } from '../src/lib/grounded.ts'
import { assessQueryRelevance, ensureTemporalCoverage, planTemporalCoverage, temporalCoverageWitnessChunkIds, temporalCoverageWitnesses, temporalGate } from '../src/lib/temporalCoverage.ts'
import { buildVariant, PHASE5D_CASES } from './fixtures/phase5d.mjs'

const QUESTION = 'What is the current Team plan price?'
/**
 * The T7 budget comes from the fixture, not from this file, because it is part
 * of the experiment. With the duplicate baseline pricing documents excluded from
 * the Phase 5D variant, `t-pricing-2025.md` ranks third: only a budget of 2 drops
 * it, at 3+ nothing is pruned, and at 1 the witness pair cannot fit at all.
 */
const T7_SPEC = PHASE5D_CASES.find((spec) => spec.id === 'T7')
const TOP_K = T7_SPEC.topK
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

const t7 = T7_SPEC
assert.equal(titlesOf(prunedRows).includes(t7.expectedPrunedWithoutCoverage), false)

const withoutCoverage = resolveTemporalNormalization(
  normalizeResults(QUESTION, prunedRows),
  { asOf: t7.asOf, requestedPeriod: t7.requestedPeriod },
)
assert.ok(!withoutCoverage.resolvedClaims.some((claim) => claim.claim.source === 't-pricing-2025.md'),
  'without temporal coverage the designated superseding source is absent from the resolution input')
// The harm itself, not merely the absence of the witness. Asserting only the
// absence let this case pass while a duplicate in the padding supplied the
// right answer anyway.
assert.equal(withoutCoverage.resolvedValue, '40 usd per seat per month',
  'without coverage the resolver must answer the stale value from the surviving 2024 claim')

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
assert.notEqual(withoutCoverage.resolvedValue, withCoverage.resolvedValue,
  'coverage must change the answer from stale to current; if both arms agree, the corpus is leaking the superseding value')

// Evidence lineage, so a future implementation cannot reach 55 by an unrelated
// shortcut and still pass: present -> pruned -> restored, and nothing else added.
assert.ok(titlesOf(ranked.map((candidate) => candidate.result)).includes('t-pricing-2025.md'), 'lineage: present before pruning')
assert.ok(!titlesOf(prunedRows).includes('t-pricing-2025.md'), 'lineage: absent after pruning')
assert.ok(titlesOf(coveredRows).includes('t-pricing-2025.md'), 'lineage: present after coverage')
assert.deepEqual(
  [...new Set(titlesOf(coveredRows))].filter((title) => !titlesOf(prunedRows).includes(title)),
  ['t-pricing-2025.md'],
  'lineage: coverage added exactly the designated witness and nothing else',
)
assert.match(withCoverage.notice, /selects 55 usd per seat per month/i,
  'the resolved notice must attribute the answer to the supersession outcome')

/* ------------------------------------------------ topK=1 fail-closed ------ */

// A witness PAIR proves a supersession. When only one slot exists the relation
// cannot be represented, and the honest outcome is a recorded shortfall -- not a
// context holding half a relation that the resolver would answer from as though
// the whole relation were present. Recall must never be bought with evidentiary
// completeness.
const singleSlot = pruneCandidates(ranked, { maxChunks: 1 }).selected.map((candidate) => candidate.result)
const singleCoverage = planTemporalCoverage(prePruningNormalization, singleSlot, 1)

assert.equal(singleCoverage.results.length, 1, 'coverage must not exceed a budget of one')
assert.equal(singleCoverage.complete, false, 'a witness pair cannot fit one slot; the shortfall must be recorded')
assert.ok(singleCoverage.omitted.length > 0, 'the omitted witness must be named, not silently dropped')
assert.ok(singleCoverage.omitted.some((entry) => entry.source === 't-pricing-2025.md'),
  'the superseding witness is the one that could not fit')

const singleResolution = resolveTemporalNormalization(
  normalizeResults(QUESTION, singleCoverage.results),
  { asOf: t7.asOf, requestedPeriod: t7.requestedPeriod },
)
assert.notEqual(singleResolution.resolvedValue, '55 usd per seat per month',
  'the resolver must not claim the superseding value from half the required evidence')

const singleGate = temporalGate(singleResolution, singleCoverage)
assert.equal(singleGate.disposition, 'hold', 'an incomplete witness set must hold rather than answer')
assert.equal(singleGate.holdReason, 'incomplete_temporal_evidence')

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

/* -------------------------------------------- deterministic hold answers -- */

// The app path turns a hold into a local cited answer and never calls the
// provider. The two reasons must not collapse into one message: "several
// versions apply and none wins" is a different failure from "a change is
// visible but its date is not established".
const ambiguousResolution = resolveTemporalNormalization(
  normalizeResults(QUESTION, resultsFrom(makeDocuments('ambiguous'))),
  { asOf: t7.asOf, requestedPeriod: null },
)
assert.equal(ambiguousResolution.disposition, 'hold')
assert.equal(ambiguousResolution.holdReason, 'multiple_applicable_propositions')

const awkwardResolution = resolveTemporalNormalization(
  normalizeResults(QUESTION, resultsFrom(makeDocuments('awkward'))),
  { asOf: t7.asOf, requestedPeriod: null },
)
assert.equal(awkwardResolution.disposition, 'hold')
assert.equal(awkwardResolution.holdReason, 'temporal_evidence_insufficient')

const multipleAnswer = buildTemporalHoldAnswer(ambiguousResolution, ambiguousResolution.holdReason)
const insufficientAnswer = buildTemporalHoldAnswer(awkwardResolution, awkwardResolution.holdReason)

assert.equal(multipleAnswer.model, null, 'a temporal hold is local; no generation model produced it')
assert.ok(multipleAnswer.citations.length > 0, 'a hold must still cite the versions it is disclosing')
assert.deepEqual(multipleAnswer.invalidCitationNumbers, [])
assert.notEqual(multipleAnswer.body, insufficientAnswer.body,
  'the two hold reasons must keep distinct explanations')
assert.match(multipleAnswer.body, /no source establishes which one supersedes/i)
assert.match(insufficientAnswer.body, /does not establish when the change applied/i)

// A question with no temporal material must not be held. Gating on status alone
// would refuse every ordinary non-temporal question.
const nonTemporal = resolveTemporalNormalization(
  normalizeResults('Where was Tracework invented?', conflictResults),
  { asOf: t7.asOf, requestedPeriod: null },
)
assert.equal(nonTemporal.status, 'unassessed')
assert.equal(nonTemporal.disposition, 'proceed', 'no temporal claims means no temporal risk')
assert.equal(nonTemporal.holdReason, null)

/* ------------------------------------------------ query subject relevance -- */

/**
 * Temporal uncertainty may only authorise a hold when it concerns the subject
 * being asked about. Found by visual inspection in step 9: an unresolved 55-vs-60
 * pricing conflict in retrieved context refused "Where was Tracework invented?".
 *
 * These two assertions must be read as a pair. The first alone could be passed by
 * simply disabling temporal holds; the second proves the fix narrows scope rather
 * than removing the safety property.
 */
const mixedContext = resultsFrom([
  createDocument('project-origin.md', 'synthetic / origin', 'Tracework was created in Malaysia in 2026.', 'sample', { id: 'origin' }),
  ...makeDocuments('duellingAuthority'),
])

const originQuestion = 'Where was Tracework invented?'
const originResolution = resolveTemporalNormalization(
  normalizeResults(originQuestion, mixedContext),
  { asOf: t7.asOf, requestedPeriod: null },
)
const originRelevance = assessQueryRelevance(originQuestion, originResolution)
const originGate = temporalGate(originResolution, { complete: true }, originRelevance)

// The conflict is still detected. It is simply not this question's business.
assert.equal(originResolution.status, 'unresolved', 'the pricing conflict must still be seen, not hidden')
assert.equal(originResolution.disposition, 'hold', 'the resolver still reports its own uncertainty')
assert.equal(originRelevance.relevant, false, 'no temporal subject matches an origin question')
assert.ok(originRelevance.unmatchedSubjectKeys.length > 0, 'the unrelated subject must be named for inspection')
assert.equal(originGate.disposition, 'proceed', 'an unrelated pricing conflict must not refuse this question')
assert.equal(originGate.proceedReason, 'temporal_subject_not_relevant')
assert.equal(originGate.holdReason, null)

// Same context, same conflict, but now the question IS about that subject.
const priceQuestion = 'What is the current Team plan price?'
const priceResolution = resolveTemporalNormalization(
  normalizeResults(priceQuestion, mixedContext),
  { asOf: t7.asOf, requestedPeriod: null },
)
const priceRelevance = assessQueryRelevance(priceQuestion, priceResolution)
const priceGate = temporalGate(priceResolution, { complete: true }, priceRelevance)

assert.equal(priceRelevance.relevant, true, 'a Team pricing question matches the Team pricing subject')
assert.equal(priceResolution.status, 'unresolved')
assert.equal(priceGate.disposition, 'hold', 'relevance must not weaken the hold it was scoped to')
assert.equal(priceGate.holdReason, 'multiple_applicable_propositions')

// Relevance keys off the subject, not the literal word "price".
const costRelevance = assessQueryRelevance(
  'What does the Team plan cost?',
  resolveTemporalNormalization(normalizeResults('What does the Team plan cost?', mixedContext), { asOf: t7.asOf, requestedPeriod: null }),
)
assert.equal(costRelevance.relevant, true, 'relevance must not require the word "price"')

console.log('Phase 5D temporal coverage tests passed / T7 rescue + fail-closed + hold answers + subject relevance')
