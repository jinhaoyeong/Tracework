/**
 * Phase 5E Step 10A — broad synthesis generation contract, offline only.
 *
 * Every generation in this suite goes through an injected mock adapter. No
 * network call is possible: `fetch` is replaced with a throwing spy before any
 * module runs a request, and the spy is asserted untouched at the end.
 *
 * This suite proves the generation BOUNDARY, not answer quality. Citation
 * validation here confirms that every marker resolves to supplied packet
 * evidence; it does not prove that the cited chunk entails the sentence citing
 * it. Nothing in this file asserts semantic correctness of generated text.
 */
import assert from 'node:assert/strict'
import { buildMeridianCorpus } from '../src/data/meridianCorpus.ts'
import { createDocument } from '../src/lib/rag.ts'
import { prepareSynthesis } from '../src/lib/synthesisOrchestrator.ts'
import { retrieveFacetEvidence } from '../src/lib/facetRetrieval.ts'
import { reasonFacetEvidence } from '../src/lib/facetReasoning.ts'
import { evaluateSynthesisCoverage } from '../src/lib/facetCoverage.ts'
import { MODEL_REFUSAL_SENTENCE } from '../src/lib/grounded.ts'
import {
  MAX_SYNTHESIS_CONTEXT_CHARACTERS,
  MAX_SYNTHESIS_EVIDENCE_CHARACTERS,
  buildSynthesisGenerationContext,
  generateSynthesisAnswer,
} from '../src/lib/synthesisGeneration.ts'
import { PHASE5E_FOCUSED_CONTROLS, PHASE5E_SYNTHESIS_CASES } from './fixtures/phase5e.mjs'
import { PHASE5C_CORPUS } from './fixtures/phase5c.mjs'
import { buildVariant } from './fixtures/phase5d.mjs'

/* ------------------------------------------------------- network prohibition */

let networkAttempts = 0
globalThis.fetch = (...args) => {
  networkAttempts += 1
  throw new Error(`Phase 5E Step 10A forbids network access, attempted: ${String(args[0])}`)
}

/* -------------------------------------------------------------- mock provider */

/**
 * Captures everything the boundary hands a provider so the tests can prove what
 * did and did not enter the request, and how many requests were made.
 */
const mockProvider = (respond) => {
  const calls = []
  return {
    calls,
    adapter: async (request) => {
      calls.push(request)
      return respond(request, calls.length)
    },
  }
}

const CITED_ANSWER = (request) => ({
  answer: `The packet supports this summary [${request.references[0].citation}].`,
  model: 'mock-broad-generator',
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
})

const meridianDocument = buildMeridianCorpus()[0]
const fixtureCase = (id) => PHASE5E_SYNTHESIS_CASES.find((item) => item.id === id)
const prepare = (spec) => prepareSynthesis(spec.question, [meridianDocument], { asOf: spec.asOf })

let totalGenerationRequests = 0
const generate = async (input, respond = CITED_ANSWER) => {
  const provider = mockProvider(respond)
  const result = await generateSynthesisAnswer(input, { adapter: provider.adapter })
  totalGenerationRequests += provider.calls.length
  assert.equal(result.generationRequests, provider.calls.length, 'reported request count must match observed adapter calls')
  assert.equal(result.providerCalled, provider.calls.length > 0, 'providerCalled must match observed adapter calls')
  return { result, calls: provider.calls }
}

/* ------------------------------------ 1. one request per answer-ready packet */

const answerRuns = []
for (const id of ['S1', 'S2', 'S3', 'S4', 'S5']) {
  const spec = fixtureCase(id)
  const preparation = prepare(spec)
  assert.equal(preparation.route, 'synthesis', `${id} must stay on the broad route`)
  assert.equal(preparation.coverage.disposition, 'answer', `${id} baseline disposition must remain answer`)

  const { result, calls } = await generate(preparation)
  assert.equal(result.status, 'answered', `${id} must produce an answer: ${result.reason}`)
  assert.equal(calls.length, 1, `${id} must cost exactly one generation request`)
  assert.equal(result.generationRequests, 1)
  assert.equal(result.providerCalled, true)
  assert.ok(result.citations.length > 0, `${id} answer must carry resolved citations`)

  // The freeze that matters: request count is independent of facet count.
  assert.ok(preparation.facets.length > 1, `${id} must exercise a multi-facet packet`)
  assert.equal(calls.length, 1, `${id} must not scale requests with its ${preparation.facets.length} facets`)

  const context = buildSynthesisGenerationContext(preparation)
  answerRuns.push({ id, preparation, context, calls })
}

/* ------------------------------------------- 2. S6 makes zero model requests */

const s6Preparation = prepare(fixtureCase('S6'))
assert.equal(s6Preparation.coverage.disposition, 'refuse-unsupported', 'S6 baseline disposition must remain refuse-unsupported')
const s6 = await generate(s6Preparation)
assert.equal(s6.result.status, 'deterministic-refusal')
assert.equal(s6.result.disposition, 'refuse-unsupported')
assert.equal(s6.calls.length, 0, 'S6 must not reach a provider')
assert.equal(s6.result.generationRequests, 0)
assert.equal(s6.result.providerCalled, false)

// A model must not be able to talk the pipeline out of a refusal: even an
// adapter that would return a confident, well-cited answer is never consulted.
const s6Override = await generate(s6Preparation, () => ({ answer: 'Supported members spend 132 USD monthly [1].' }))
assert.equal(s6Override.result.status, 'deterministic-refusal')
assert.equal(s6Override.calls.length, 0)

/* ------------------------------- 3. a critical conflict makes zero requests */

const conflictResults = PHASE5C_CORPUS.slice(0, 2)
  .map((source) => createDocument(
    source.title,
    `synthetic / phase 5C / ${source.title}`,
    source.content,
    'sample',
    { id: `phase5c-${source.title}`, provenance: source.provenance },
  ))
  .flatMap((document) => document.chunks.map((chunk) => ({
    chunk,
    document,
    score: 1,
    semanticScore: 1,
    keywordScore: 1,
    matchedTerms: [],
    engine: 'hashed',
  })))

const conflictFacet = {
  id: 'tracework-origin',
  label: 'Tracework origin',
  kind: 'query-subject',
  normalizedSubject: 'tracework-origin',
  parentId: null,
  aliases: ['Tracework origin'],
  lexicalAliases: [],
  occurrenceCount: 1,
  chunkIds: [],
  signals: ['explicit_query_subject'],
  evidenceObligations: [{ id: 'origin-proposition', kind: 'definition', description: 'Tracework origin', chunkIds: [] }],
  confidence: 1,
  rejectionReason: null,
}
const conflictQuestion = 'Where was Tracework invented?'
const conflictReasoning = reasonFacetEvidence({
  facet: conflictFacet,
  originalQuestion: conflictQuestion,
  asOf: '2026-08-31T23:59:59Z',
  unionCandidates: conflictResults,
  selectedCandidates: conflictResults.slice(0, 1),
})
const conflictCoverage = evaluateSynthesisCoverage({
  question: conflictQuestion,
  facets: [{ facet: conflictFacet, reasoning: conflictReasoning, required: true, critical: true }],
})
assert.equal(conflictCoverage.disposition, 'hold-for-conflict')
const conflictHold = await generate({
  route: 'synthesis',
  coverage: conflictCoverage,
  packet: conflictCoverage.packet,
  facets: [{ facet: conflictFacet, requirements: [], retrieval: null, reasoning: conflictReasoning, coverage: conflictCoverage.facets[0] }],
  asOf: '2026-08-31T23:59:59Z',
  requestedPeriod: null,
})
assert.equal(conflictHold.result.status, 'deterministic-hold')
assert.equal(conflictHold.result.disposition, 'hold-for-conflict')
assert.equal(conflictHold.calls.length, 0, 'an unresolved critical conflict must not reach a provider')
assert.equal(conflictHold.result.generationRequests, 0)

/* ------------------- 3b. a non-critical gap stays partial, not hold/refusal */

// Critical requirements covered, one non-critical required facet incomplete.
// Step 8 calls that partial-with-disclosure, and Step 10A must keep it distinct
// from both the conflict hold and the unsupported refusal.
const partialBase = answerRuns[0].preparation
const coveredFacet = partialBase.facets[0]
const degradedFacet = partialBase.facets
  .slice(1)
  .find((prepared) => prepared.facet.evidenceObligations.some((obligation) => obligation.chunkIds.length))
assert.ok(degradedFacet, 'S1 must expose a facet with a declared witness to degrade')
// Every declared witness for one obligation is removed. Dropping only the first
// leaves a multi-witness obligation still supported, which would make the case
// pass for the wrong reason.
const droppedWitnesses = new Set(degradedFacet.facet.evidenceObligations.find((obligation) => obligation.chunkIds.length).chunkIds)
const degradedReasoning = {
  ...degradedFacet.reasoning,
  reasoningContext: degradedFacet.reasoning.reasoningContext.filter((result) => !droppedWitnesses.has(result.chunk.id)),
}
const partialCoverage = evaluateSynthesisCoverage({
  question: partialBase.packet.question,
  facets: [
    { facet: coveredFacet.facet, reasoning: coveredFacet.reasoning, required: true, critical: true },
    { facet: degradedFacet.facet, reasoning: degradedReasoning, required: true, critical: false },
  ],
})
assert.equal(partialCoverage.facets[0].status, 'covered', 'the critical facet must stay covered')
assert.notEqual(partialCoverage.facets[1].status, 'covered')
assert.notEqual(partialCoverage.facets[1].status, 'conflicted', 'the gap must be missing evidence, not a conflict')
assert.equal(partialCoverage.disposition, 'partial-with-disclosure')

const partial = await generate({
  route: 'synthesis',
  coverage: partialCoverage,
  packet: partialCoverage.packet,
  facets: [
    coveredFacet,
    { ...degradedFacet, reasoning: degradedReasoning, coverage: partialCoverage.facets[1] },
  ],
  asOf: partialBase.asOf,
  requestedPeriod: partialBase.requestedPeriod,
})
assert.equal(partial.result.status, 'deterministic-partial')
assert.equal(partial.result.disposition, 'partial-with-disclosure')
assert.deepEqual(partial.result.missingFacetIds, [degradedFacet.facet.id])
assert.equal(partial.calls.length, 0, 'a partial disposition must not reach a provider in Step 10A')
assert.equal(partial.result.generationRequests, 0)
assert.equal(partial.result.providerCalled, false)

// The three withheld dispositions stay three different outcomes.
assert.equal(new Set([partial.result.status, conflictHold.result.status, s6.result.status]).size, 3)

/* --------------------------- 4. only packet evidence enters the context */

for (const { id, preparation, context, calls } of answerRuns) {
  const packetChunkIds = new Set(preparation.packet.facets.flatMap((facet) => [
    ...facet.supportingChunkIds,
    ...facet.applicableClaims.map((claim) => claim.claim.result.chunk.id),
    ...facet.excludedClaims.map((assessment) => assessment.claim.claim.result.chunk.id),
    ...facet.conflicts.flatMap((conflict) => conflict.claims.map((claim) => claim.chunkId)),
  ]))
  const referenceIds = new Set(context.references.map((reference) => reference.chunkId))
  assert.deepEqual([...referenceIds].toSorted(), [...packetChunkIds].toSorted(), `${id} reference table must equal the packet evidence set`)

  // Every evidence block names its chunk. Reading those headers back proves
  // what the rendered prompt actually carries, not merely what the reference
  // objects claim. Ids are compared exactly: `chunk-1` is a prefix of
  // `chunk-10`, so a substring search here would pass for the wrong reason.
  const renderedIds = new Set([...context.text.matchAll(/^chunk id: (.+)$/gm)].map((match) => match[1]))
  assert.deepEqual([...renderedIds].toSorted(), [...packetChunkIds].toSorted(), `${id} rendered evidence must equal the packet evidence set`)

  // Non-vacuous: retrieval genuinely saw chunks the packet did not admit, and
  // the whole corpus is larger still. Neither may appear.
  const unionIds = new Set(preparation.facets.flatMap((facet) => facet.retrieval.unionCandidates.map((candidate) => candidate.result.chunk.id)))
  const withheld = [...unionIds].filter((chunkId) => !packetChunkIds.has(chunkId))
  assert.ok(withheld.length > 0, `${id} must actually withhold some retrieved evidence`)
  for (const chunkId of withheld) {
    assert.ok(!renderedIds.has(chunkId), `${id} leaked non-packet chunk ${chunkId} into the generation context`)
  }
  for (const chunk of meridianDocument.chunks) {
    if (packetChunkIds.has(chunk.id)) continue
    assert.ok(!renderedIds.has(chunk.id), `${id} leaked corpus chunk ${chunk.id} into the generation context`)
    assert.ok(!context.text.includes(chunk.text), `${id} leaked the body of corpus chunk ${chunk.id} into the generation context`)
  }

  // Nothing fixture-side may reach a provider.
  const request = calls[0]
  assert.equal(request.context, context.text, `${id} must send the built context verbatim`)
  assert.equal(request.question, preparation.packet.question)
  assert.ok(!/expectedSupport|anchorIds|semanticSignatures|expectedDisposition/.test(request.context), `${id} must not carry fixture metadata`)
  assert.deepEqual(
    request.references.map((reference) => reference.chunkId),
    context.references.map((reference) => reference.chunkId),
  )
}

/* ------------------------------------------- 5. shared chunks are deduplicated */

let sharedEvidenceCases = 0
for (const { id, context } of answerRuns) {
  const chunkIds = context.references.map((reference) => reference.chunkId)
  assert.equal(new Set(chunkIds).size, chunkIds.length, `${id} reference table must not repeat a chunk`)
  const citations = context.references.map((reference) => reference.citation)
  assert.deepEqual(citations, citations.map((_value, index) => index + 1), `${id} citation numbers must be stable and contiguous`)

  const perFacetTotal = context.facets.reduce((total, facet) => total + facet.citations.length, 0)
  assert.ok(perFacetTotal >= context.references.length)
  if (perFacetTotal > context.references.length) {
    sharedEvidenceCases += 1
    const shared = context.references.filter((reference) => reference.facetIds.length > 1)
    assert.ok(shared.length > 0, `${id} must attribute a shared chunk to every facet that admitted it`)
  }
}
assert.ok(sharedEvidenceCases > 0, 'at least one baseline case must exercise cross-facet evidence sharing')

// Rebuilding the same preparation must produce the same table.
const s1Repeat = buildSynthesisGenerationContext(answerRuns[0].preparation)
assert.deepEqual(
  s1Repeat.references.map((reference) => [reference.citation, reference.chunkId]),
  answerRuns[0].context.references.map((reference) => [reference.citation, reference.chunkId]),
)

/* ------------------- 6. historical / proposed evidence cannot read as current */

const temporalDocuments = buildVariant('future').map((source) => createDocument(
  source.title,
  `synthetic / phase 5D / ${source.title}`,
  source.content,
  'sample',
  { id: `phase5d-${source.title}`, provenance: source.provenance },
))
const temporalQuestion = 'What does the Team plan cost?'
const temporalAsOf = '2026-06-01T00:00:00Z'
const temporalFacet = {
  id: 'team-plan',
  label: 'Team plan',
  kind: 'named-policy-or-benefit',
  normalizedSubject: 'team-plan',
  parentId: null,
  aliases: ['Team plan'],
  lexicalAliases: [],
  occurrenceCount: 3,
  chunkIds: [],
  signals: ['explicit_query_subject'],
  evidenceObligations: [{ id: 'team-price', kind: 'current-state', description: 'Establish the current Team plan price', chunkIds: [] }],
  confidence: 1,
  rejectionReason: null,
}
const temporalRetrieval = retrieveFacetEvidence(temporalQuestion, temporalFacet, { documents: temporalDocuments }, {
  denseLimit: 14,
  lexicalLimit: 14,
  unionLimit: 18,
  maxSelected: 6,
})
const probe = reasonFacetEvidence({
  facet: temporalFacet,
  originalQuestion: temporalQuestion,
  asOf: temporalAsOf,
  requestedPeriod: null,
  unionCandidates: temporalRetrieval.unionCandidates,
  selectedCandidates: temporalRetrieval.selected,
})
const boundTemporalFacet = {
  ...temporalFacet,
  evidenceObligations: [{
    ...temporalFacet.evidenceObligations[0],
    chunkIds: [probe.temporal.applicableClaims[0].claim.result.chunk.id],
  }],
}
const temporalReasoning = reasonFacetEvidence({
  facet: boundTemporalFacet,
  originalQuestion: temporalQuestion,
  asOf: temporalAsOf,
  requestedPeriod: null,
  unionCandidates: temporalRetrieval.unionCandidates,
  selectedCandidates: temporalRetrieval.selected,
})
const temporalCoverage = evaluateSynthesisCoverage({
  question: temporalQuestion,
  facets: [{ facet: boundTemporalFacet, reasoning: temporalReasoning, required: true, critical: true }],
})
assert.equal(temporalCoverage.disposition, 'answer')
const temporalInput = {
  route: 'synthesis',
  coverage: temporalCoverage,
  packet: temporalCoverage.packet,
  facets: [{ facet: boundTemporalFacet, requirements: [], retrieval: temporalRetrieval, reasoning: temporalReasoning, coverage: temporalCoverage.facets[0] }],
  asOf: temporalAsOf,
  requestedPeriod: null,
}
const temporalContext = buildSynthesisGenerationContext(temporalInput)
const teamFacet = temporalContext.facets[0]

assert.equal(teamFacet.applicableClaims.length, 1)
assert.match(teamFacet.applicableClaims[0].value, /55/)
assert.deepEqual(teamFacet.excludedClaims.map((claim) => claim.state).toSorted(), ['future', 'superseded'])
assert.ok(teamFacet.excludedClaims.some((claim) => /65/.test(claim.value) && claim.state === 'future'))
assert.ok(teamFacet.excludedClaims.some((claim) => /40/.test(claim.value) && claim.state === 'superseded'))

// No excluded claim may also appear in the applicable list.
const applicableIds = new Set(teamFacet.applicableClaims.map((claim) => claim.claimId))
assert.ok(teamFacet.excludedClaims.every((claim) => !applicableIds.has(claim.claimId)))

// The rendered context must separate the two blocks, and every superseded,
// future, or historical value must appear under the NOT CURRENT heading only.
const teamSection = temporalContext.text.split('FACET: Team plan')[1].split('\nEVIDENCE\n')[0]
const currentBlock = teamSection.split('current / applicable claims:')[1].split('NOT CURRENT')[0]
const notCurrentBlock = teamSection.split('NOT CURRENT')[1]
assert.match(currentBlock, /55/)
assert.ok(!/\b65\b/.test(currentBlock), 'a future price must never render inside the current block')
assert.ok(!/\b40\b/.test(currentBlock), 'a superseded price must never render inside the current block')
assert.match(notCurrentBlock, /state: future/)
assert.match(notCurrentBlock, /state: superseded/)
assert.match(notCurrentBlock, /never state these as current/)

const temporalRun = await generate(temporalInput)
assert.equal(temporalRun.result.status, 'answered')
assert.equal(temporalRun.calls.length, 1)

/* ------------------------------------------------- 7. valid citations resolve */

const s1Run = answerRuns[0]
const s1References = s1Run.context.references
const validCitation = await generate(s1Run.preparation, () => ({
  answer: `The first facet is supported [1] and the second is corroborated [2, 3].`,
  model: 'mock-broad-generator',
}))
assert.equal(validCitation.result.status, 'answered')
assert.deepEqual(validCitation.result.citationNumbers.toSorted((a, b) => a - b), [1, 2, 3])
assert.deepEqual(
  validCitation.result.citations.map((citation) => citation.chunkId),
  [s1References[0].chunkId, s1References[1].chunkId, s1References[2].chunkId],
)
assert.ok(validCitation.result.citations.every((citation) => citation.documentId && citation.documentTitle))

/* ------------------------------ 8. unknown citation numbers make it unusable */

const unknownCitation = await generate(s1Run.preparation, () => ({ answer: 'Meridian charges a fee [99].' }))
assert.equal(unknownCitation.result.status, 'unusable')
assert.deepEqual(unknownCitation.result.invalidCitationNumbers, [99])
assert.equal(unknownCitation.calls.length, 1)
assert.match(unknownCitation.result.reason, /outside the supplied packet/)

const zeroCitation = await generate(s1Run.preparation, () => ({ answer: 'Meridian charges a fee [0].' }))
assert.equal(zeroCitation.result.status, 'unusable')
assert.deepEqual(zeroCitation.result.invalidCitationNumbers, [0])

const uncited = await generate(s1Run.preparation, () => ({ answer: 'Meridian costs 55 per seat per month.' }))
assert.equal(uncited.result.status, 'unusable')
assert.match(uncited.result.reason, /without citing any supplied evidence/)

/* ---------------------------- 9. malformed markers make the answer unusable */

const malformed = await generate(s1Run.preparation, () => ({ answer: 'Meridian charges a fee [01].' }))
assert.equal(malformed.result.status, 'unusable')
assert.deepEqual(malformed.result.malformedCitationMarkers, ['01'])
assert.match(malformed.result.reason, /malformed citation markers/)

/* ------------------- 10. model refusal stays distinct from provider failure */

const refusal = await generate(s1Run.preparation, () => ({ answer: MODEL_REFUSAL_SENTENCE, model: 'mock-broad-generator' }))
assert.equal(refusal.result.status, 'model-refusal')
assert.equal(refusal.result.generationRequests, 1)
assert.equal(refusal.result.providerCalled, true)
assert.equal(refusal.result.body, MODEL_REFUSAL_SENTENCE)

const paraphrasedRefusal = await generate(s1Run.preparation, () => ({
  answer: 'The supplied evidence does not state the requested figure.',
}))
assert.equal(paraphrasedRefusal.result.status, 'model-refusal', 'a paraphrased refusal must not be reported as a generation failure')

const providerFailure = await generate(s1Run.preparation, () => {
  const error = new Error('upstream timed out')
  error.code = 'provider_timeout'
  throw error
})
assert.equal(providerFailure.result.status, 'generation-failure')
assert.equal(providerFailure.result.code, 'provider_timeout')
assert.equal(providerFailure.result.generationRequests, 1)
assert.equal(providerFailure.result.providerCalled, true)

const emptyAnswer = await generate(s1Run.preparation, () => ({ answer: '   ' }))
assert.equal(emptyAnswer.result.status, 'generation-failure')
assert.equal(emptyAnswer.result.code, 'malformed_response')

assert.notEqual(refusal.result.status, providerFailure.result.status)
assert.notEqual(refusal.result.status, malformed.result.status)
assert.notEqual(providerFailure.result.status, malformed.result.status)

/* ------------------- 10b. the context budget is checked before the adapter */

for (const { id, context } of answerRuns) {
  assert.ok(
    context.characters <= MAX_SYNTHESIS_CONTEXT_CHARACTERS,
    `${id} must fit the frozen synthesis budget (${context.characters} > ${MAX_SYNTHESIS_CONTEXT_CHARACTERS})`,
  )
  // The evidence share stays bounded independently of the packet share, so a
  // wide packet cannot buy itself more quotable source text.
  const evidenceCharacters = context.references.reduce((total, reference) => total + reference.formatted.length, 0)
  assert.ok(evidenceCharacters <= MAX_SYNTHESIS_EVIDENCE_CHARACTERS, `${id} evidence share must stay within its own budget`)
}

// A budget the real context cannot meet: the adapter must never be reached.
const tightBudget = await (async () => {
  const provider = mockProvider(CITED_ANSWER)
  const result = await generateSynthesisAnswer(answerRuns[0].preparation, {
    adapter: provider.adapter,
    maxContextCharacters: 500,
  })
  totalGenerationRequests += provider.calls.length
  return { result, calls: provider.calls }
})()
assert.equal(tightBudget.result.status, 'context-too-large')
assert.equal(tightBudget.result.code, 'context_too_large')
assert.equal(tightBudget.result.budget, 500)
assert.equal(tightBudget.result.characters, answerRuns[0].context.characters)
assert.equal(tightBudget.calls.length, 0, 'an oversized context must not spend a generation request')
assert.equal(tightBudget.result.generationRequests, 0)
assert.equal(tightBudget.result.providerCalled, false)

/**
 * A genuinely oversized packet, rejected at the frozen production budget with
 * no override. Per-chunk trimming has a 200-character floor, so a packet wide
 * enough in distinct chunks exceeds any fixed total however hard each block is
 * trimmed. That is the case Step 10A must fail closed on rather than dropping
 * evidence Step 8 already counted.
 */
const wideTemplate = answerRuns[0].preparation.facets[0].reasoning.reasoningContext[0]
const wideResults = Array.from({ length: 320 }, (_value, index) => ({
  ...wideTemplate,
  chunk: {
    ...wideTemplate.chunk,
    id: `oversized-packet-chunk-${index}`,
    text: `Clause ${index} records that cohort ${index} receives an allowance of ${index} units under the standing schedule. ${'Supporting detail. '.repeat(20)}`,
  },
}))
const wideFacet = {
  ...answerRuns[0].preparation.facets[0].facet,
  id: 'oversized-packet',
  label: 'Oversized packet',
  evidenceObligations: wideResults.map((result, index) => ({
    id: `oversized-obligation-${index}`,
    kind: 'definition',
    description: `Establish clause ${index}`,
    chunkIds: [result.chunk.id],
  })),
}
const wideReasoning = {
  ...answerRuns[0].preparation.facets[0].reasoning,
  facetId: 'oversized-packet',
  reasoningContext: wideResults,
}
const wideCoverage = evaluateSynthesisCoverage({
  question: 'Summarise every recorded clause.',
  facets: [{ facet: wideFacet, reasoning: wideReasoning, required: true, critical: true }],
})
assert.equal(wideCoverage.disposition, 'answer', 'the oversized packet must be answer-ready, so size is the only thing rejecting it')

const oversized = await generate({
  route: 'synthesis',
  coverage: wideCoverage,
  packet: wideCoverage.packet,
  facets: [{ facet: wideFacet, requirements: [], retrieval: null, reasoning: wideReasoning, coverage: wideCoverage.facets[0] }],
  asOf: '2026-08-31T23:59:59Z',
  requestedPeriod: null,
})
assert.equal(oversized.result.status, 'context-too-large')
assert.equal(oversized.result.budget, MAX_SYNTHESIS_CONTEXT_CHARACTERS)
assert.ok(oversized.result.characters > MAX_SYNTHESIS_CONTEXT_CHARACTERS)
assert.equal(oversized.calls.length, 0, 'a genuinely oversized packet must not reach a provider')
assert.equal(oversized.result.generationRequests, 0)
assert.equal(oversized.result.providerCalled, false)

// Nothing was trimmed to make it fit: the packet still carries every chunk.
const oversizedContext = buildSynthesisGenerationContext({
  route: 'synthesis',
  coverage: wideCoverage,
  packet: wideCoverage.packet,
  facets: [{ facet: wideFacet, requirements: [], retrieval: null, reasoning: wideReasoning, coverage: wideCoverage.facets[0] }],
  asOf: '2026-08-31T23:59:59Z',
  requestedPeriod: null,
})
assert.equal(oversizedContext.references.length, wideResults.length, 'the builder must not silently drop packet evidence to fit a budget')

/* ------------------------------- 11. F1-F5 focused controls stay unaffected */

assert.equal(PHASE5E_FOCUSED_CONTROLS.length, 5)
const focusedRows = []
for (const control of PHASE5E_FOCUSED_CONTROLS) {
  const preparation = prepareSynthesis(control.question, [meridianDocument], { asOf: '2026-08-31T23:59:59Z' })
  assert.equal(preparation.route, 'focused', `${control.id} must stay on the focused route`)
  assert.equal(preparation.packet, null)
  const { result, calls } = await generate(preparation)
  assert.equal(result.status, 'deterministic-refusal', `${control.id} must not enter broad generation`)
  assert.equal(calls.length, 0, `${control.id} must not reach the broad provider`)
  assert.equal(result.generationRequests, 0)
  focusedRows.push({ id: control.id, route: preparation.route, broadRequests: calls.length })
}

/* ------------------------------------- 12. no provider call left the process */

assert.equal(networkAttempts, 0, 'the suite must not attempt any network access')

// Five answer-ready baselines plus ten single-request behaviour probes: the
// temporal case, valid citations, unknown marker, zero marker, uncited claim,
// malformed marker, exact refusal, paraphrased refusal, provider failure, and
// empty response. Every withheld case contributes zero — S6, the critical
// conflict, the non-critical partial, both oversized-context rejections, and
// F1-F5. A drift in this number means some path started spending requests it
// did not before.
assert.equal(totalGenerationRequests, 15, 'observed mocked requests must match the frozen expectation')

console.log(JSON.stringify({
  answerReadyCases: answerRuns.map(({ id, preparation, context, calls }) => ({
    id,
    disposition: preparation.coverage.disposition,
    facets: context.facets.length,
    references: context.references.length,
    perFacetCitations: context.facets.reduce((total, facet) => total + facet.citations.length, 0),
    sharedReferences: context.references.filter((reference) => reference.facetIds.length > 1).length,
    contextCharacters: context.characters,
    generationRequests: calls.length,
  })),
  deterministic: {
    s6: { status: s6.result.status, requests: s6.calls.length },
    criticalConflict: { status: conflictHold.result.status, requests: conflictHold.calls.length },
    nonCriticalGap: {
      disposition: partialCoverage.disposition,
      status: partial.result.status,
      missingFacetIds: partial.result.missingFacetIds,
      requests: partial.calls.length,
    },
    focusedControls: focusedRows,
  },
  contextBudget: {
    evidenceBudget: MAX_SYNTHESIS_EVIDENCE_CHARACTERS,
    totalBudget: MAX_SYNTHESIS_CONTEXT_CHARACTERS,
    widestBaseline: Math.max(...answerRuns.map(({ context }) => context.characters)),
    tightBudgetRejection: { status: tightBudget.result.status, requests: tightBudget.calls.length },
    oversizedPacket: {
      status: oversized.result.status,
      characters: oversized.result.characters,
      references: oversizedContext.references.length,
      requests: oversized.calls.length,
    },
  },
  temporalLabelling: {
    applicable: teamFacet.applicableClaims.map((claim) => claim.value),
    notCurrent: teamFacet.excludedClaims.map((claim) => ({ state: claim.state, value: claim.value })),
  },
  citationOutcomes: {
    valid: validCitation.result.status,
    unknownMarker: unknownCitation.result.status,
    malformedMarker: malformed.result.status,
    uncitedClaim: uncited.result.status,
    modelRefusal: refusal.result.status,
    providerFailure: providerFailure.result.status,
  },
  mockedGenerationRequests: totalGenerationRequests,
  liveProviderCalls: 0,
  networkAttempts,
}, null, 2))
console.log('Phase 5E Step 10A generation tests passed / packet -> one mocked request -> citation validation, with deterministic holds and refusals never reaching a provider')
