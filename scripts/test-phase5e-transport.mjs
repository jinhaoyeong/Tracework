/**
 * Phase 5E Step 10B — transport and routing boundary, offline only.
 *
 * The real OpenAI provider is never contacted. Two fakes stand in:
 *
 *   client side: `fetch` is replaced with a stub that answers /api/generate and
 *                counts every transport invocation.
 *   server side: server/traceworkApi.ts is loaded directly and its upstream
 *                `fetch` to api.openai.com is stubbed and counted, so the guards
 *                that must run BEFORE a provider call can be proven to do so.
 *
 * Any request to a host other than /api/generate fails the suite.
 */
import assert from 'node:assert/strict'
import { buildMeridianCorpus } from '../src/data/meridianCorpus.ts'
import { createDocument } from '../src/lib/rag.ts'
import { prepareSynthesis } from '../src/lib/synthesisOrchestrator.ts'
import { reasonFacetEvidence } from '../src/lib/facetReasoning.ts'
import { evaluateSynthesisCoverage } from '../src/lib/facetCoverage.ts'
import { planQueryExecution, resetPlanForQuerySurface } from '../src/lib/queryRoute.ts'
import { buildGroundedContext } from '../src/lib/grounded.ts'
import { requestGroundedAnswer, serverSynthesisAdapter } from '../src/lib/generation.ts'
import {
  MAX_SYNTHESIS_CONTEXT_CHARACTERS,
  buildSynthesisGenerationContext,
  generateSynthesisAnswer,
} from '../src/lib/synthesisGeneration.ts'
import {
  SERVER_GENERATION_CONTEXT_LIMIT,
  SYNTHESIS_CONTEXT_CHARACTER_LIMIT,
  FOCUSED_CONTEXT_CHARACTER_LIMIT,
  MODEL_REFUSAL_SENTENCE,
} from '../src/lib/generationContract.ts'
import * as serverApi from '../server/traceworkApi.ts'
import { PHASE5E_FOCUSED_CONTROLS, PHASE5E_SYNTHESIS_CASES } from './fixtures/phase5e.mjs'
import { PHASE5C_CORPUS } from './fixtures/phase5c.mjs'

/* ------------------------------------------ 0. server / client limit binding */

// server/traceworkApi.ts imports nothing so it stays trivially deployable, which
// means its limits are a second copy. This is the regression that keeps the two
// copies equal; without it a drift would only surface as an HTTP failure.
assert.equal(serverApi.SERVER_GENERATION_CONTEXT_LIMIT, SERVER_GENERATION_CONTEXT_LIMIT)
assert.equal(serverApi.SYNTHESIS_CONTEXT_CHARACTER_LIMIT, SYNTHESIS_CONTEXT_CHARACTER_LIMIT)
assert.equal(serverApi.FOCUSED_CONTEXT_CHARACTER_LIMIT, FOCUSED_CONTEXT_CHARACTER_LIMIT)
assert.equal(serverApi.MODEL_REFUSAL_SENTENCE, MODEL_REFUSAL_SENTENCE)

// The property that actually matters: the transport must accept anything Step
// 10A is willing to build.
assert.ok(
  SERVER_GENERATION_CONTEXT_LIMIT >= MAX_SYNTHESIS_CONTEXT_CHARACTERS,
  'the server ceiling must never be below the synthesis context ceiling',
)
assert.equal(serverApi.contextLimitForMode('synthesis'), SYNTHESIS_CONTEXT_CHARACTER_LIMIT)
assert.equal(serverApi.contextLimitForMode('focused'), FOCUSED_CONTEXT_CHARACTER_LIMIT)
assert.ok(
  FOCUSED_CONTEXT_CHARACTER_LIMIT < SYNTHESIS_CONTEXT_CHARACTER_LIMIT,
  'the focused budget must stay smaller than the synthesis budget',
)

/* --------------------------------------------------- client transport stub */

const transport = { calls: [], respond: () => ({ answer: 'The packet supports this [1].', model: 'mock-transport-model' }) }

globalThis.fetch = async (url, init) => {
  if (String(url) !== '/api/generate') {
    throw new Error(`Phase 5E Step 10B forbids requests to ${String(url)}`)
  }
  const body = JSON.parse(init.body)
  transport.calls.push(body)
  const outcome = transport.respond(body, transport.calls.length)
  if (outcome.httpError) {
    return {
      ok: false,
      status: outcome.httpError.status,
      json: async () => ({ error: { code: outcome.httpError.code, message: outcome.httpError.message } }),
    }
  }
  return { ok: true, status: 200, json: async () => outcome }
}

const withTransport = async (respond, run) => {
  const previous = transport.respond
  const start = transport.calls.length
  transport.respond = respond ?? previous
  try {
    const value = await run()
    return { value, calls: transport.calls.slice(start) }
  } finally {
    transport.respond = previous
  }
}

const meridianDocument = buildMeridianCorpus()[0]
const fixtureCase = (id) => PHASE5E_SYNTHESIS_CASES.find((item) => item.id === id)
const prepare = (spec) => prepareSynthesis(spec.question, [meridianDocument], { asOf: spec.asOf })

/**
 * The App's own decision, exercised through the extracted planner rather than a
 * copy of it, then the same call the component makes.
 */
const runQuestionSurface = async (preparation, answerMode) => {
  const plan = planQueryExecution(preparation.route, answerMode)
  if (!plan.runBroadGeneration) return { plan, result: null }
  const result = await generateSynthesisAnswer(preparation, { adapter: serverSynthesisAdapter })
  return { plan, result }
}

/* ------------------------- 1. an answer-ready packet costs one transport call */

const s1Preparation = prepare(fixtureCase('S1'))
assert.equal(s1Preparation.coverage.disposition, 'answer')
const s1 = await withTransport(null, () => runQuestionSurface(s1Preparation, 'grounded'))
assert.equal(s1.value.result.status, 'answered')
assert.equal(s1.calls.length, 1, 'S1 in grounded mode must make exactly one transport invocation')
assert.equal(s1.value.result.generationRequests, 1)
assert.equal(s1.value.result.providerCalled, true)
assert.equal(s1.value.result.metadata.model, 'mock-transport-model')
assert.ok(s1.value.result.citations.length > 0)

const s1Body = s1.calls[0]
assert.equal(s1Body.mode, 'synthesis', 'a broad request must declare its mode so the wider limit is never implicit')
assert.equal(s1Body.question, s1Preparation.packet.question)
assert.ok(Array.isArray(s1Body.references) && s1Body.references.length > 0)

/* ------------------------------------ 2-4. withheld dispositions never transport */

const s6Preparation = prepare(fixtureCase('S6'))
assert.equal(s6Preparation.coverage.disposition, 'refuse-unsupported')
const s6 = await withTransport(null, () => runQuestionSurface(s6Preparation, 'grounded'))
assert.equal(s6.value.result.status, 'deterministic-refusal')
assert.equal(s6.calls.length, 0, 'S6 must not reach the transport')

const conflictResults = PHASE5C_CORPUS.slice(0, 2)
  .map((source) => createDocument(source.title, `synthetic / phase 5C / ${source.title}`, source.content, 'sample', {
    id: `phase5c-${source.title}`,
    provenance: source.provenance,
  }))
  .flatMap((document) => document.chunks.map((chunk) => ({
    chunk, document, score: 1, semanticScore: 1, keywordScore: 1, matchedTerms: [], engine: 'hashed',
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
const conflictReasoning = reasonFacetEvidence({
  facet: conflictFacet,
  originalQuestion: 'Where was Tracework invented?',
  asOf: '2026-08-31T23:59:59Z',
  unionCandidates: conflictResults,
  selectedCandidates: conflictResults.slice(0, 1),
})
const conflictCoverage = evaluateSynthesisCoverage({
  question: 'Where was Tracework invented?',
  facets: [{ facet: conflictFacet, reasoning: conflictReasoning, required: true, critical: true }],
})
assert.equal(conflictCoverage.disposition, 'hold-for-conflict')
const conflictPreparation = {
  route: 'synthesis',
  coverage: conflictCoverage,
  packet: conflictCoverage.packet,
  facets: [{ facet: conflictFacet, requirements: [], retrieval: null, reasoning: conflictReasoning, coverage: conflictCoverage.facets[0] }],
  asOf: '2026-08-31T23:59:59Z',
  requestedPeriod: null,
}
const conflict = await withTransport(null, () => runQuestionSurface(conflictPreparation, 'grounded'))
assert.equal(conflict.value.result.status, 'deterministic-hold')
assert.equal(conflict.calls.length, 0, 'a critical conflict must not reach the transport')

const coveredFacet = s1Preparation.facets[0]
const degradedFacet = s1Preparation.facets.slice(1).find((prepared) => prepared.facet.evidenceObligations.some((obligation) => obligation.chunkIds.length))
const droppedWitnesses = new Set(degradedFacet.facet.evidenceObligations.find((obligation) => obligation.chunkIds.length).chunkIds)
const degradedReasoning = {
  ...degradedFacet.reasoning,
  reasoningContext: degradedFacet.reasoning.reasoningContext.filter((result) => !droppedWitnesses.has(result.chunk.id)),
}
const partialCoverage = evaluateSynthesisCoverage({
  question: s1Preparation.packet.question,
  facets: [
    { facet: coveredFacet.facet, reasoning: coveredFacet.reasoning, required: true, critical: true },
    { facet: degradedFacet.facet, reasoning: degradedReasoning, required: true, critical: false },
  ],
})
assert.equal(partialCoverage.disposition, 'partial-with-disclosure')
const partial = await withTransport(null, () => runQuestionSurface({
  route: 'synthesis',
  coverage: partialCoverage,
  packet: partialCoverage.packet,
  facets: [coveredFacet, { ...degradedFacet, reasoning: degradedReasoning, coverage: partialCoverage.facets[1] }],
  asOf: s1Preparation.asOf,
  requestedPeriod: s1Preparation.requestedPeriod,
}, 'grounded'))
assert.equal(partial.value.result.status, 'deterministic-partial')
assert.equal(partial.calls.length, 0, 'a partial disposition must not reach the transport')

/* ---------------------------------- 5. an oversized packet never transports */

const wideTemplate = s1Preparation.facets[0].reasoning.reasoningContext[0]
const wideResults = Array.from({ length: 320 }, (_value, index) => ({
  ...wideTemplate,
  chunk: {
    ...wideTemplate.chunk,
    id: `oversized-transport-chunk-${index}`,
    text: `Clause ${index} records an allowance of ${index} units. ${'Supporting detail. '.repeat(20)}`,
  },
}))
const wideFacet = {
  ...s1Preparation.facets[0].facet,
  id: 'oversized-transport',
  label: 'Oversized transport packet',
  evidenceObligations: wideResults.map((result, index) => ({
    id: `oversized-obligation-${index}`,
    kind: 'definition',
    description: `Establish clause ${index}`,
    chunkIds: [result.chunk.id],
  })),
}
const wideReasoning = { ...s1Preparation.facets[0].reasoning, facetId: 'oversized-transport', reasoningContext: wideResults }
const wideCoverage = evaluateSynthesisCoverage({
  question: 'Summarise every recorded clause.',
  facets: [{ facet: wideFacet, reasoning: wideReasoning, required: true, critical: true }],
})
assert.equal(wideCoverage.disposition, 'answer')
const oversized = await withTransport(null, () => runQuestionSurface({
  route: 'synthesis',
  coverage: wideCoverage,
  packet: wideCoverage.packet,
  facets: [{ facet: wideFacet, requirements: [], retrieval: null, reasoning: wideReasoning, coverage: wideCoverage.facets[0] }],
  asOf: '2026-08-31T23:59:59Z',
  requestedPeriod: null,
}, 'grounded'))
assert.equal(oversized.value.result.status, 'context-too-large')
assert.equal(oversized.calls.length, 0, 'an oversized packet must fail closed before the transport')

/* ------------------------------ 6. retrieval-only never enters broad generation */

const retrievalOnly = await withTransport(null, () => runQuestionSurface(s1Preparation, 'retrieval'))
assert.equal(retrievalOnly.value.result, null)
assert.equal(retrievalOnly.value.plan.runBroadGeneration, false)
assert.equal(retrievalOnly.calls.length, 0, 'retrieval-only mode must not reach the transport')
assert.match(retrievalOnly.value.plan.reason, /Retrieval-only/)

// The same rule for every synthesis baseline, answerable or not.
for (const spec of PHASE5E_SYNTHESIS_CASES) {
  const preparation = prepare(spec)
  const run = await withTransport(null, () => runQuestionSurface(preparation, 'retrieval'))
  assert.equal(run.calls.length, 0, `${spec.id} in retrieval-only mode must not transport`)
}

/* --------------------------------- 7. the focused path is untouched */

for (const control of PHASE5E_FOCUSED_CONTROLS) {
  const preparation = prepareSynthesis(control.question, [meridianDocument], { asOf: '2026-08-31T23:59:59Z' })
  assert.equal(preparation.route, 'focused')
  const plan = planQueryExecution(preparation.route, 'grounded')
  assert.equal(plan.runBroadGeneration, false, `${control.id} must never enter broad generation`)
  assert.equal(plan.runFocusedRetrieval, true)
  assert.equal(plan.runFocusedGeneration, true)
  const broad = await withTransport(null, () => runQuestionSurface(preparation, 'grounded'))
  assert.equal(broad.calls.length, 0, `${control.id} must not make a broad transport call`)
}

// The focused request body must not have acquired a mode field or otherwise
// changed shape, or the server would apply a different limit to it.
const focusedContext = buildGroundedContext('What was the Standard price in August 2026?', meridianDocument.chunks.slice(0, 3).map((chunk) => ({
  chunk, document: meridianDocument, score: 0.9, semanticScore: 0.9, keywordScore: 0.5, matchedTerms: [], engine: 'hashed',
})))
const focusedCall = await withTransport(
  () => ({ answer: 'Standard costs 55 [1].', model: 'mock-transport-model' }),
  () => requestGroundedAnswer(focusedContext),
)
assert.equal(focusedCall.calls.length, 1)
assert.equal(focusedCall.calls[0].mode, undefined, 'the focused request must stay mode-free so the server default applies')
assert.deepEqual(
  Object.keys(focusedCall.calls[0]).toSorted(),
  ['chunks', 'context', 'question', 'requestedTopK', 'retrievalEngine'],
  'the focused request body shape must not change',
)

/* ----------------------- 8. every synthesis request fits the frozen budget */

for (const id of ['S1', 'S2', 'S3', 'S4', 'S5']) {
  const preparation = prepare(fixtureCase(id))
  const context = buildSynthesisGenerationContext(preparation)
  const run = await withTransport(null, () => runQuestionSurface(preparation, 'grounded'))
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].context.length, context.characters)
  assert.ok(
    run.calls[0].context.length <= MAX_SYNTHESIS_CONTEXT_CHARACTERS,
    `${id} transported ${run.calls[0].context.length} characters, over the synthesis budget`,
  )
  assert.ok(run.calls[0].context.length <= SERVER_GENERATION_CONTEXT_LIMIT)
}

/* ------------------------------------ 9-10. server guards run before the provider */

const upstream = { calls: 0, respond: () => ({ ok: true, status: 200, json: async () => ({ output_text: 'Answer [1].', model: 'mock-upstream' }) }) }
const clientFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target === '/api/generate') return clientFetch(url, init)
  if (target.startsWith('https://api.openai.com/')) {
    upstream.calls += 1
    return upstream.respond()
  }
  throw new Error(`Phase 5E Step 10B forbids requests to ${target}`)
}

globalThis.process.env.OPENAI_API_KEY = 'test-key-not-a-real-credential'

const callServer = async (body) => {
  const captured = { status: 0, payload: null }
  const response = {
    status(code) { captured.status = code; return this },
    json(payload) { captured.payload = payload },
  }
  await serverApi.handleGeneration({ method: 'POST', body }, response)
  return captured
}

// 9. A valid synthesis context just under the ceiling is accepted and reaches
// the (stubbed) provider.
const nearCeiling = 'x'.repeat(SYNTHESIS_CONTEXT_CHARACTER_LIMIT - 100)
const upstreamBefore = upstream.calls
const accepted = await callServer({ mode: 'synthesis', question: 'Summarise Meridian.', context: nearCeiling })
assert.equal(accepted.status, 200, `a near-ceiling synthesis context must be accepted: ${JSON.stringify(accepted.payload)}`)
assert.equal(upstream.calls, upstreamBefore + 1, 'the accepted request must reach the provider exactly once')

// 10. Above the ceiling the guard runs first: the provider is never invoked.
const overCeiling = 'x'.repeat(SERVER_GENERATION_CONTEXT_LIMIT + 1)
const upstreamBeforeReject = upstream.calls
const rejected = await callServer({ mode: 'synthesis', question: 'Summarise Meridian.', context: overCeiling })
assert.equal(rejected.status, 400)
assert.equal(rejected.payload.error.code, 'context_too_large')
assert.equal(upstream.calls, upstreamBeforeReject, 'an oversized context must be rejected before the provider is called')

// The focused budget is preserved: a context legal for synthesis is still too
// large for a focused request, whether the mode is stated or defaulted.
const focusedOversized = 'x'.repeat(FOCUSED_CONTEXT_CHARACTER_LIMIT + 1000)
for (const body of [
  { mode: 'focused', question: 'Q', context: focusedOversized },
  { question: 'Q', context: focusedOversized },
]) {
  const upstreamBeforeFocused = upstream.calls
  const focusedRejected = await callServer(body)
  assert.equal(focusedRejected.status, 400, 'broad synthesis must not raise the focused evidence budget')
  assert.equal(focusedRejected.payload.error.code, 'context_too_large')
  assert.equal(upstream.calls, upstreamBeforeFocused)
}

const badMode = await callServer({ mode: 'broad', question: 'Q', context: 'evidence' })
assert.equal(badMode.status, 400)
assert.equal(badMode.payload.error.code, 'invalid_mode')

/* ------------ 11. bad citations are unusable; HTTP failure is not a refusal */

const unknownMarker = await withTransport(
  () => ({ answer: 'Meridian charges a fee [99].', model: 'mock-transport-model' }),
  () => runQuestionSurface(s1Preparation, 'grounded'),
)
assert.equal(unknownMarker.value.result.status, 'unusable')
assert.deepEqual(unknownMarker.value.result.invalidCitationNumbers, [99])
assert.equal(unknownMarker.calls.length, 1)

const malformedMarker = await withTransport(
  () => ({ answer: 'Meridian charges a fee [01].', model: 'mock-transport-model' }),
  () => runQuestionSurface(s1Preparation, 'grounded'),
)
assert.equal(malformedMarker.value.result.status, 'unusable')
assert.deepEqual(malformedMarker.value.result.malformedCitationMarkers, ['01'])

const modelRefusal = await withTransport(
  () => ({ answer: MODEL_REFUSAL_SENTENCE, model: 'mock-transport-model' }),
  () => runQuestionSurface(s1Preparation, 'grounded'),
)
assert.equal(modelRefusal.value.result.status, 'model-refusal')

// An HTTP failure must never be classified as the model declining to answer.
const httpFailure = await withTransport(
  () => ({ httpError: { status: 502, code: 'generation_provider_error', message: 'The generation provider rejected the request.' } }),
  () => runQuestionSurface(s1Preparation, 'grounded'),
)
assert.equal(httpFailure.value.result.status, 'generation-failure')
assert.equal(httpFailure.value.result.code, 'generation_provider_error')
assert.notEqual(httpFailure.value.result.status, modelRefusal.value.result.status)

const serverRejection = await withTransport(
  () => ({ httpError: { status: 400, code: 'context_too_large', message: 'too large' } }),
  () => runQuestionSurface(s1Preparation, 'grounded'),
)
assert.equal(serverRejection.value.result.status, 'generation-failure')
assert.equal(serverRejection.value.result.code, 'context_too_large')

/* --------------------- 12. route switching clears the right surfaces */

const emptyFocused = { neural: false, pgvector: false, grounded: false }
const applyReset = (state, route) => {
  const plan = resetPlanForQuerySurface(route)
  return {
    focused: plan.clearFocusedRetrieval ? { ...emptyFocused } : { ...state.focused },
    // The App clears the packet and any answer generated from it together.
    synthesis: plan.clearSynthesisPreparation ? null : state.synthesis,
    synthesisGeneration: plan.clearSynthesisPreparation ? null : state.synthesisGeneration,
  }
}

let uiState = { focused: { neural: true, pgvector: true, grounded: true }, synthesis: null, synthesisGeneration: null }
uiState = applyReset(uiState, 'synthesis')
assert.deepEqual(uiState.focused, emptyFocused)
uiState = { ...uiState, synthesis: { route: 'synthesis' }, synthesisGeneration: { status: 'answered', requests: 1 } }
uiState = applyReset(uiState, 'focused')
assert.equal(uiState.synthesis, null, 'a focused question must not inherit the previous packet')
assert.equal(uiState.synthesisGeneration, null, 'a focused question must not inherit the previous broad answer')
uiState = { ...uiState, focused: { neural: true, pgvector: false, grounded: true } }
uiState = applyReset(uiState, 'synthesis')
assert.deepEqual(uiState.focused, emptyFocused, 'a synthesis question must not inherit focused surfaces')
assert.equal(uiState.synthesisGeneration, null)

/* ------------------------------------------------------------------ summary */

const broadCalls = transport.calls.filter((call) => call.mode === 'synthesis')
assert.equal(
  broadCalls.length,
  transport.calls.length - 1,
  'every transport call except the focused control must be a declared synthesis request',
)

console.log(JSON.stringify({
  limits: {
    focused: FOCUSED_CONTEXT_CHARACTER_LIMIT,
    synthesis: SYNTHESIS_CONTEXT_CHARACTER_LIMIT,
    serverCeiling: SERVER_GENERATION_CONTEXT_LIMIT,
    serverCopyMatches: true,
  },
  routing: {
    s1Grounded: { status: s1.value.result.status, transportCalls: s1.calls.length },
    s6: { status: s6.value.result.status, transportCalls: s6.calls.length },
    conflict: { status: conflict.value.result.status, transportCalls: conflict.calls.length },
    partial: { status: partial.value.result.status, transportCalls: partial.calls.length },
    oversized: { status: oversized.value.result.status, transportCalls: oversized.calls.length },
    retrievalOnly: { transportCalls: retrievalOnly.calls.length },
    focusedControls: PHASE5E_FOCUSED_CONTROLS.length,
  },
  serverGuards: {
    nearCeilingAccepted: accepted.status,
    overCeilingRejected: rejected.payload.error.code,
    focusedBudgetPreserved: true,
    providerInvocations: upstream.calls,
  },
  outcomes: {
    unknownMarker: unknownMarker.value.result.status,
    malformedMarker: malformedMarker.value.result.status,
    modelRefusal: modelRefusal.value.result.status,
    httpFailure: httpFailure.value.result.status,
  },
  transportCalls: transport.calls.length,
  liveProviderCalls: 0,
}, null, 2))
console.log('Phase 5E Step 10B transport tests passed / mode-aware limits, one request per broad answer, and every withheld disposition stopping before the transport')
