/**
 * Phase 5D step 10: five-case live-provider validation.
 *
 * This is deliberately smaller than the retrieval/reranker/conflict
 * benchmarks. It runs only T1, T2, T6b, T7, and T9 through the same local
 * neural -> lexical union -> rerank -> prune -> temporal coverage -> temporal
 * gate -> generation order used by App.tsx. The embedding pass is shared over
 * the union of those frozen fixtures, and repeated query embeddings are cached.
 *
 * T9 is intentionally resolved locally after retrieval and must make zero
 * generation requests. T7 records whether the live ranker needed temporal
 * coverage (`rescued`) or already supplied the witness (`not-needed`). The
 * deterministic offline forcing test remains the direct 40 -> 55 rescue proof.
 *
 *   npm.cmd run dev
 *   npm.cmd run live:phase5d
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createDocument, searchDocuments } from '../src/lib/rag.ts'
import { buildLexicalIndex, searchLexical, toLexicalResults } from '../src/lib/lexical.ts'
import { buildCandidateUnion, pruneCandidates, rerank } from '../src/lib/reranker.ts'
import { adjudicateEvidence, ensureConflictCoverage } from '../src/lib/adjudication.ts'
import {
  buildGroundedContext,
  buildConflictAnswer,
  buildTemporalHoldAnswer,
  classifyGeneratedAnswer,
  evaluateEvidence,
} from '../src/lib/grounded.ts'
import { extractTemporalClaims } from '../src/lib/temporal.ts'
import { normalizeTemporalExtraction } from '../src/lib/temporalNormalization.ts'
import { assessQueryRelevance, planTemporalCoverage, temporalCoverageWitnessChunkIds, temporalGate } from '../src/lib/temporalCoverage.ts'
import { parseRequestedPeriod, resolveTemporalNormalization } from '../src/lib/temporalResolution.ts'
import { buildVariant, PHASE5D_CASES } from './fixtures/phase5d.mjs'
import { classifyRecordedPhase5dLive, classifyT7LiveOutcome } from './phase5d-live-report.mjs'
import { createUsageTracker } from './usage.mjs'

const BASE = process.env.TRACEWORK_BASE_URL ?? 'http://localhost:5173'
const AS_OF = '2026-08-10'
const CANDIDATE_LIMIT = 10
const DEFAULT_TOP_K = 4
const EMBEDDING_BATCH_SIZE = 32
const CASE_IDS = ['T1', 'T2', 'T6b', 'T7', 'T9']
const RECLASSIFY = process.argv.includes('--reclassify')
const OUTPUT = process.env.TRACEWORK_PHASE5D_LIVE_OUT
  ?? (RECLASSIFY ? 'docs/phase5d-live-classified.json' : 'docs/phase5d-live.json')
const RECLASSIFY_FROM = process.env.TRACEWORK_PHASE5D_LIVE_RECLASSIFY_FROM ?? 'docs/phase5d-live-success.json'
const OFFLINE_PROOF = process.env.TRACEWORK_PHASE5D_OFFLINE_PROOF ?? 'docs/phase5d-evaluation.json'

const usageTracker = createUsageTracker()
let generationCallCount = 0
const queryEmbeddingCache = new Map()
const queryEmbeddingCacheHits = []

const selectedCases = CASE_IDS.map((id) => PHASE5D_CASES.find((spec) => spec.id === id))
if (selectedCases.some((spec) => !spec)) throw new Error(`Missing frozen Phase 5D case: ${CASE_IDS.join(', ')}`)

const post = async (path, body) => {
  if (path === '/api/generate') generationCallCount += 1
  let response
  try {
    response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (error) {
    const failure = new Error(`${path} could not be reached: ${error instanceof Error ? error.message : String(error)}`)
    failure.code = 'transport_error'
    throw failure
  }

  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.error) {
    const failure = new Error(payload?.error?.message ?? `${path} failed with HTTP ${response.status}`)
    failure.code = payload?.error?.code ?? `http_${response.status}`
    failure.status = response.status
    throw failure
  }
  usageTracker.record(path, body, payload)
  return payload
}

const titlesOf = (results) => results.map((result) => result.document.title)
const unique = (values) => [...new Set(values)]
const rounded = (value, digits = 4) => typeof value === 'number' && Number.isFinite(value)
  ? Number(value.toFixed(digits))
  : value

const resultSummary = (result, rank) => ({
  rank,
  source: result.document.title,
  chunkId: result.chunk.id,
  score: rounded(result.score),
  semanticScore: rounded(result.semanticScore),
  keywordScore: rounded(result.keywordScore),
  matchedTerms: result.matchedTerms,
})

const candidateSummary = (candidate) => ({
  rank: candidate.rerankedRank,
  source: candidate.result.document.title,
  chunkId: candidate.result.chunk.id,
  unionRank: candidate.originalUnionRank,
  relevanceScore: rounded(candidate.relevanceScore),
  relevanceLabel: candidate.relevanceLabel,
  relevanceReason: candidate.relevanceReason,
  appearedIn: candidate.retrieval.appearedIn,
  denseRank: candidate.retrieval.denseRank ?? null,
  lexicalRank: candidate.retrieval.lexicalRank ?? null,
})

const pruningSummary = (pruning) => pruning.decisions.map((decision) => ({
  rank: decision.candidate.rerankedRank,
  source: decision.candidate.result.document.title,
  selected: decision.selected,
  reason: decision.reason,
}))

const claimSummary = (claim) => ({
  claimId: claim.claimId,
  source: claim.claim.source,
  chunkId: claim.claim.chunkId,
  sentence: claim.claim.sentence,
  value: claim.claim.value,
  subject: claim.subject,
  validFrom: claim.validFrom,
  validUntil: claim.claim.validUntil,
  historical: claim.historical,
  status: claim.status,
  reason: claim.reason,
  supersedes: claim.claim.supersedes
    ? {
        kind: claim.claim.supersedes.kind,
        target: claim.claim.supersedes.target,
        sentence: claim.claim.supersedes.sentence,
      }
    : null,
})

const relationSummary = (relation) => ({
  superseding: relation.supersedingSource,
  superseded: relation.supersededSource,
  supersedingValue: relation.supersedingValue,
  supersededValue: relation.supersededValue,
  triggerSentence: relation.triggerSentence,
  reason: relation.reason,
})

const resolutionSummary = (resolution) => ({
  asOf: resolution.asOf,
  requestedPeriod: resolution.requestedPeriod,
  reference: resolution.reference,
  status: resolution.status,
  subjectKey: resolution.subjectKey,
  resolvedValue: resolution.resolvedValue,
  disposition: resolution.disposition,
  holdReason: resolution.holdReason,
  notice: resolution.notice,
  applicableClaims: resolution.applicableClaims.map(claimSummary),
  resolvedClaims: resolution.resolvedClaims.map(claimSummary),
  assessments: resolution.assessments.map((assessment) => ({
    ...claimSummary(assessment.claim),
    state: assessment.state,
    assessmentReason: assessment.reason,
    effectiveUntil: assessment.effectiveUntil,
  })),
  boundaries: resolution.boundaries,
})

const normalizationSummary = (normalization) => ({
  claims: normalization.claims.map(claimSummary),
  relations: normalization.relations.map(relationSummary),
  unassessedReasons: normalization.unassessedReasons,
  unresolved: normalization.unresolved,
})

const answerCitations = (answer, context) => answer.validCitationNumbers.map((number, index) => ({
  marker: number,
  source: answer.citations[index]?.document.title ?? context.chunks[number - 1]?.result.document.title ?? 'out of range',
}))

const serializeAnswer = (answer, context, metadata = {}) => ({
  title: answer.title,
  body: answer.body,
  citations: answerCitations(answer, context),
  validCitationNumbers: answer.validCitationNumbers,
  invalidCitationNumbers: answer.invalidCitationNumbers,
  malformedCitationMarkers: answer.malformedCitationMarkers,
  model: answer.model ?? metadata.model ?? null,
  inputTokens: metadata.inputTokens ?? null,
  outputTokens: metadata.outputTokens ?? null,
  totalTokens: metadata.totalTokens ?? null,
})

const makeSourceMap = () => {
  const sourcesByTitle = new Map()
  for (const spec of selectedCases) {
    for (const source of buildVariant(spec.variant)) {
      const previous = sourcesByTitle.get(source.title)
      if (previous && (previous.content !== source.content || JSON.stringify(previous.provenance) !== JSON.stringify(source.provenance))) {
        throw new Error(`Frozen fixture title has conflicting definitions: ${source.title}`)
      }
      sourcesByTitle.set(source.title, source)
    }
  }
  return sourcesByTitle
}

const makeDocuments = (sourcesByTitle) => [...sourcesByTitle.values()].map((source) => createDocument(
  source.title,
  `synthetic / phase 5D / ${source.title}`,
  source.content,
  'sample',
  { id: `phase5d-step10-${source.title}`, provenance: source.provenance },
))

const documentsFor = (spec, documentsByTitle) => buildVariant(spec.variant).map((source) => {
  const document = documentsByTitle.get(source.title)
  if (!document) throw new Error(`Document was not prepared for ${spec.id}: ${source.title}`)
  return document
})

const embedRequiredChunks = async (documents) => {
  const chunks = documents.flatMap((document) => document.chunks)
  const metadata = { model: null, dimensions: null, requests: 0, texts: chunks.length }
  for (let offset = 0; offset < chunks.length; offset += EMBEDDING_BATCH_SIZE) {
    const batch = chunks.slice(offset, offset + EMBEDDING_BATCH_SIZE)
    const response = await post('/api/embed', { input: batch.map((chunk) => chunk.text) })
    if (!Array.isArray(response.embeddings) || response.embeddings.length !== batch.length) {
      throw new Error(`Embedding response returned ${response.embeddings?.length ?? 0} vectors for ${batch.length} chunks.`)
    }
    metadata.requests += 1
    metadata.model = response.model ?? metadata.model
    metadata.dimensions = response.dimensions ?? response.embeddings[0]?.length ?? metadata.dimensions
    batch.forEach((chunk, index) => {
      chunk.neuralEmbedding = {
        model: response.model,
        dimensions: response.dimensions,
        vector: response.embeddings[index],
        createdAt: '2026-08-11T00:00:00.000Z',
      }
    })
  }
  return metadata
}

const embedQuery = async (question) => {
  if (queryEmbeddingCache.has(question)) {
    queryEmbeddingCacheHits.push(question)
    return queryEmbeddingCache.get(question)
  }
  const response = await post('/api/embed', { input: [question] })
  const vector = response.embeddings?.[0]
  if (!Array.isArray(vector)) throw new Error(`Embedding response returned no query vector for ${question}`)
  const result = { vector, model: response.model ?? null, dimensions: response.dimensions ?? vector.length }
  queryEmbeddingCache.set(question, result)
  return result
}

const resolveFor = (question, results, spec, requestedPeriod = parseRequestedPeriod(question)) => (
  resolveTemporalNormalization(
    normalizeTemporalExtraction(extractTemporalClaims(question, results)),
    { asOf: spec.asOf ?? AS_OF, requestedPeriod },
  )
)

const expectedSourcesPresent = (results, sources) => sources.every((source) => titlesOf(results).includes(source))

const runCase = async (spec, documentsByTitle, embeddingMetadata) => {
  const documents = documentsFor(spec, documentsByTitle)
  const queryEmbedding = await embedQuery(spec.question)
  const dense = searchDocuments(documents, spec.question, {
    engine: 'neural',
    queryVector: queryEmbedding.vector,
    limit: CANDIDATE_LIMIT,
  })
  const lexicalIndex = buildLexicalIndex(documents)
  const lexical = toLexicalResults(searchLexical(lexicalIndex, spec.question, CANDIDATE_LIMIT), documents)
  const union = buildCandidateUnion({ dense, lexical, limit: CANDIDATE_LIMIT })
  const ranked = rerank(spec.question, union)
  const rankedResults = ranked.map((candidate) => candidate.result)
  const budget = spec.topK ?? DEFAULT_TOP_K
  const pruning = pruneCandidates(ranked, { maxChunks: budget })
  const prunedResults = pruning.selected.map((candidate) => candidate.result)

  // This is the same pre-pruning temporal analysis used by App.tsx. It is what
  // lets coverage know that a witness existed and was then dropped.
  const preNormalization = normalizeTemporalExtraction(extractTemporalClaims(spec.question, rankedResults))
  const temporalWitnessIds = temporalCoverageWitnessChunkIds(preNormalization)
  const coverage = planTemporalCoverage(preNormalization, prunedResults, budget)
  const preCoverageAdjudication = adjudicateEvidence(spec.question, rankedResults)
  const coveredResults = ensureConflictCoverage(
    preCoverageAdjudication,
    coverage.results,
    budget,
    temporalWitnessIds,
  )
  const resolution = resolveFor(spec.question, coveredResults, spec)
  const relevance = assessQueryRelevance(spec.question, resolution)
  const gate = temporalGate(resolution, coverage, relevance)
  const withoutCoverage = resolveFor(spec.question, prunedResults, spec)
  const contextAdjudication = adjudicateEvidence(spec.question, coveredResults)
  const evidenceAssessment = evaluateEvidence(spec.question, coveredResults)
  const context = buildGroundedContext(spec.question, coveredResults, {
    retrievalEngine: 'union-rerank',
    requestedTopK: budget,
    limit: coveredResults.length,
    adjudication: contextAdjudication,
  })

  const callsBefore = generationCallCount
  const record = {
    id: spec.id,
    name: spec.name,
    question: spec.question,
    asOf: spec.asOf,
    requestedPeriod: spec.requestedPeriod,
    variant: spec.variant,
    topK: budget,
    candidateLimit: CANDIDATE_LIMIT,
    embedding: {
      model: queryEmbedding.model ?? embeddingMetadata.model,
      dimensions: queryEmbedding.dimensions ?? embeddingMetadata.dimensions,
      queryEmbeddingCacheHit: queryEmbeddingCacheHits.includes(spec.question),
    },
    retrieval: {
      corpusSources: documents.length,
      corpusChunks: documents.reduce((total, document) => total + document.chunks.length, 0),
      dense: dense.map(resultSummary),
      lexical: lexical.map((result, index) => ({
        ...resultSummary(result, index + 1),
        lexicalScore: rounded(result.lexicalScore),
      })),
      union: union.map((candidate) => ({
        rank: candidate.unionRank,
        source: candidate.result.document.title,
        chunkId: candidate.result.chunk.id,
        appearedIn: candidate.retrieval.appearedIn,
        denseRank: candidate.retrieval.denseRank ?? null,
        lexicalRank: candidate.retrieval.lexicalRank ?? null,
      })),
      reranked: ranked.map(candidateSummary),
      beforePruning: titlesOf(rankedResults),
      pruning: pruningSummary(pruning),
      afterPruning: titlesOf(prunedResults),
      afterTemporalCoverage: titlesOf(coveredResults),
      restoredByTemporalCoverage: unique(titlesOf(coveredResults).filter((title) => !titlesOf(prunedResults).includes(title))),
    },
    temporal: {
      prePruning: normalizationSummary(preNormalization),
      coverage: {
        complete: coverage.complete,
        witnesses: unique(coverage.witnesses.map((witness) => witness.document.title)),
        admitted: coverage.admitted,
        omitted: coverage.omitted,
        contextBeforeCoverage: titlesOf(prunedResults),
        contextAfterCoverage: titlesOf(coveredResults),
      },
      withoutCoverage: resolutionSummary(withoutCoverage),
      resolution: resolutionSummary(resolution),
      relevance,
      gate,
    },
    phase5c: {
      preCoverageStatus: preCoverageAdjudication.status,
      finalStatus: contextAdjudication.status,
      conflictCount: contextAdjudication.conflicts.length,
    },
    evidence: {
      status: evidenceAssessment.status,
      bestScore: rounded(evidenceAssessment.bestScore),
      candidateChunksAboveFloor: evidenceAssessment.candidateChunksAboveFloor,
      distinctSourceCount: evidenceAssessment.distinctSourceCount,
      reason: evidenceAssessment.reason,
      contextSources: context.chunks.map((chunk) => ({ citation: chunk.citation, source: chunk.result.document.title, chunkId: chunk.result.chunk.id })),
    },
    context: {
      characters: context.characters,
      approximateTokens: context.approximateTokens,
      warnings: context.chunks.flatMap((chunk) => chunk.warnings.map((warning) => `${chunk.result.document.title}: ${warning}`)),
    },
    expected: {
      resolution: spec.expectedResolution,
      value: spec.expectedValue ?? null,
      disposition: spec.expectedDisposition,
      holdReason: spec.expectedHoldReason ?? null,
      citations: spec.expectedCitations ?? [],
      mustNotAnswer: spec.mustNotAnswer ?? null,
    },
  }

  // Match runGroundedGeneration's order exactly: evidence floor, temporal gate,
  // Phase 5C conflict hold, then the provider.
  if (evidenceAssessment.status === 'insufficient') {
    record.outcome = 'refused'
    record.providerCalled = false
    record.finalAnswer = {
      title: 'Not enough evidence',
      body: evidenceAssessment.reason,
      citations: [],
      validCitationNumbers: [],
      invalidCitationNumbers: [],
      malformedCitationMarkers: [],
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }
  } else if (gate.disposition === 'hold') {
    const held = buildTemporalHoldAnswer(resolution, gate.holdReason)
    record.outcome = 'temporal-hold'
    record.providerCalled = false
    record.finalAnswer = serializeAnswer(held, context)
  } else if (contextAdjudication.status === 'conflicted') {
    const held = buildConflictAnswer(contextAdjudication)
    record.outcome = 'conflict-hold'
    record.providerCalled = false
    record.finalAnswer = serializeAnswer(held, context)
  } else {
    try {
      const generated = await post('/api/generate', {
        question: context.question,
        context: context.text,
        retrievalEngine: context.retrievalEngine,
        requestedTopK: context.requestedTopK,
        chunks: context.chunks.map((chunk) => ({
          citation: chunk.citation,
          sourceId: chunk.result.document.id,
          chunkId: chunk.result.chunk.id,
        })),
      })
      const classified = classifyGeneratedAnswer(generated.answer, context, {
        model: generated.model,
        inputTokens: generated.inputTokens,
        outputTokens: generated.outputTokens,
        totalTokens: generated.totalTokens,
      })
      record.outcome = classified.outcome
      record.providerModel = generated.model
      record.finalAnswer = serializeAnswer(classified.answer, context, generated)
      record.generationUsage = {
        model: generated.model,
        inputTokens: generated.inputTokens ?? null,
        outputTokens: generated.outputTokens ?? null,
        totalTokens: generated.totalTokens ?? null,
      }
    } catch (error) {
      record.outcome = 'error'
      record.error = { code: error.code ?? 'provider_error', message: error.message }
      record.finalAnswer = null
    }
  }

  record.providerCalled = generationCallCount > callsBefore
  record.providerCallCount = generationCallCount - callsBefore
  record.providerCalledStatus = record.providerCalled ? 'yes' : 'no'

  // The future case gets one extra deterministic applicability check on the
  // same live-retrieved evidence. It proves the 2027 notice does not become the
  // current answer at the 2026 reference date without spending another call.
  if (spec.id === 'T6b') {
    const beforeApplicable = resolveFor(spec.question, coveredResults, spec, null)
    record.futureApplicabilityCheck = {
      beforeRequestedPeriod: resolutionSummary(beforeApplicable),
      expectedBeforeValue: '55',
      expectedBeforeMustNotContain: '65',
      providerCalled: false,
    }
  }

  const checks = []
  const check = (name, passed, detail) => checks.push({ name, passed, detail })
  const expectedSources = spec.expectedCitations ?? (spec.id === 'T7' ? ['t-pricing-2025.md'] : [])
  check('retrieval reaches expected temporal sources', expectedSources.length === 0 || expectedSources.every((source) => (
    titlesOf(rankedResults).includes(source)
  )), `expected ${expectedSources.join(', ') || 'no named sources'} in pre-pruning retrieval; got ${unique(titlesOf(rankedResults)).join(', ')}`)
  check('temporal resolution status', resolution.status === spec.expectedResolution,
    `expected ${spec.expectedResolution}, got ${resolution.status}`)
  check('temporal resolved value', spec.expectedValue
    ? Boolean(resolution.resolvedValue?.includes(spec.expectedValue))
    : resolution.resolvedValue === null,
  `expected ${spec.expectedValue ?? 'null'}, got ${JSON.stringify(resolution.resolvedValue)}`)
  check('temporal disposition', gate.disposition === spec.expectedDisposition,
    `expected ${spec.expectedDisposition}, got ${gate.disposition}`)
  check('temporal hold reason', (gate.holdReason ?? null) === (spec.expectedHoldReason ?? null),
    `expected ${spec.expectedHoldReason ?? 'null'}, got ${gate.holdReason ?? 'null'}`)
  check('provider-called status', record.providerCalled === (spec.expectedDisposition !== 'hold'),
    `expected providerCalled=${spec.expectedDisposition !== 'hold'}, got ${record.providerCalled}`)

  if (spec.id === 'T6b') {
    check('future price is not applicable before its start',
      record.futureApplicabilityCheck.beforeRequestedPeriod.resolvedValue?.includes('55')
        && !record.futureApplicabilityCheck.beforeRequestedPeriod.resolvedValue?.includes('65'),
      `before applicability resolved ${JSON.stringify(record.futureApplicabilityCheck.beforeRequestedPeriod.resolvedValue)}`)
  }

  const finalAnswer = record.finalAnswer
  if (spec.expectedDisposition === 'hold') {
    check('hold answer is deterministic and cited', record.outcome === 'temporal-hold'
      && expectedSources.every((source) => finalAnswer?.citations.some((citation) => citation.source === source)),
    `expected temporal-hold with citations ${expectedSources.join(', ')}, got outcome=${record.outcome} citations=${JSON.stringify(finalAnswer?.citations ?? [])}`)
  } else {
    const citedExpectedSource = expectedSources.length === 0 || expectedSources.some((source) => finalAnswer?.citations.some((citation) => citation.source === source))
    const bodyHasExpected = !spec.expectedValue || Boolean(finalAnswer?.body?.includes(spec.expectedValue))
    const bodyAvoidsForbidden = !spec.mustNotAnswer || !finalAnswer?.body?.includes(spec.mustNotAnswer)
    check('generated answer outcome', record.outcome === 'answered', `expected answered, got ${record.outcome}`)
    check('generated answer contains resolved value', bodyHasExpected, `expected answer body to contain ${spec.expectedValue}, got ${JSON.stringify(finalAnswer?.body)}`)
    check('generated answer has valid expected citation', citedExpectedSource, `expected citation from ${expectedSources.join(', ')}, got ${JSON.stringify(finalAnswer?.citations ?? [])}`)
    check('generated answer avoids forbidden value', bodyAvoidsForbidden, `forbidden ${spec.mustNotAnswer} appeared in ${JSON.stringify(finalAnswer?.body)}`)
  }

  const t7Classification = spec.id === 'T7'
    ? classifyT7LiveOutcome(record)
    : null
  t7Classification?.checks.forEach((entry) => checks.push(entry))

  record.checks = checks
  record.passed = checks.every((entry) => entry.passed)
  record.failureCategories = record.passed ? [] : unique([
    !checks.find((entry) => entry.name === 'retrieval reaches expected temporal sources')?.passed ? 'retrieval failure' : null,
    !checks.find((entry) => entry.name.startsWith('temporal '))?.passed ? 'temporal-resolution failure' : null,
    (spec.id === 'T7' && checks.some((entry) => entry.name.startsWith('T7 ') && !entry.passed)) ? 'coverage failure' : null,
    !checks.find((entry) => entry.name === 'temporal disposition' && entry.passed)?.passed
      || !checks.find((entry) => entry.name === 'provider-called status' && entry.passed)?.passed ? 'deterministic-gate failure' : null,
    checks.some((entry) => entry.name.startsWith('generated answer') || entry.name === 'hold answer is deterministic and cited') && checks.some((entry) => !entry.passed && (entry.name.startsWith('generated answer') || entry.name === 'hold answer is deterministic and cited'))
      ? 'generation/citation failure' : null,
  ].filter(Boolean))

  if (spec.id === 'T7') {
    record.t7 = {
      ...t7Classification,
      finalOutcome: record.passed ? 'PASS' : 'FAIL',
      temporalResolution: {
        status: resolution.status,
        value: resolution.resolvedValue,
        citations: resolution.resolvedClaims.map((claim) => claim.claim.source),
      },
      finalGeneratedAnswer: record.finalAnswer,
    }
  }

  return record
}

const writeOutput = (output) => writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`)

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

const readOfflineCoverageProof = () => {
  const artifact = readJson(OFFLINE_PROOF)
  const t7 = artifact.records?.find((record) => record.id === 'T7')
  const requiredChecks = [
    'superseder genuinely pruned',
    'coverage restores witness',
    'stale answer without coverage',
    'coverage changes the answer',
  ]
  const checks = t7?.checks ?? []
  const passed = artifact.passed === true
    && t7?.passed === true
    && requiredChecks.every((name) => checks.some((entry) => entry.name === name && entry.passed))
  return {
    passed,
    artifact: OFFLINE_PROOF,
    recordedAt: artifact.recordedAt ?? null,
    detail: passed
      ? 'offline T7 proves the forced 40 -> 55 coverage rescue.'
      : 'offline T7 coverage rescue proof was not present or did not pass.',
  }
}

const reclassifyRecordedRun = () => {
  const input = readJson(RECLASSIFY_FROM)
  const offlineProof = readOfflineCoverageProof()
  const output = classifyRecordedPhase5dLive(input, {
    offlineCoverageRescueProven: offlineProof.passed,
  })
  output.reclassifiedAt = new Date().toISOString()
  output.classification = {
    kind: 'recorded-live-reclassification',
    sourceArtifact: RECLASSIFY_FROM,
    providerCalls: 0,
    offlineCoverageRescueProven: offlineProof.passed,
    offlineMechanismProof: offlineProof,
  }
  output.notes = {
    ...output.notes,
    t7: 'T7 passes live when the superseder is either restored after pruning (rescued) or retained by normal pruning (not-needed). This run used the not-needed path; the deterministic offline artifact proves the rescued path separately.',
    classification: 'This report reclassifies an existing live artifact. It made zero embedding or generation requests and does not replace the raw provider evidence.',
  }
  return output
}

const main = async () => {
  if (RECLASSIFY) {
    const output = reclassifyRecordedRun()
    writeOutput(output)
    console.log(`Phase 5D step 10 classification of recorded live run / source=${RECLASSIFY_FROM}`)
    console.log(`provider calls during classification: 0 / raw run generation calls: ${output.generation?.calls ?? 0}`)
    for (const record of output.records) {
      const mode = record.id === 'T7' ? ` / coverageMode=${record.t7?.coverageMode}` : ''
      console.log(`${record.id} ${record.passed ? 'PASS' : 'FAIL'} / resolution=${record.temporal?.resolution?.status ?? 'n/a'} value=${record.temporal?.resolution?.resolvedValue ?? 'null'} / disposition=${record.temporal?.gate?.disposition ?? 'n/a'} / providerCalled=${record.providerCalled}${mode}`)
      if (!record.passed) console.log(`  failure categories: ${record.failureCategories?.join(', ') || 'unclassified'}`)
    }
    console.log(`\n${output.passed ? 'PASS' : 'FAIL'} / ${output.records.filter((record) => record.passed).length}/${output.records.length} authorized cases`)
    console.log(`written to ${OUTPUT}`)
    if (!output.passed) process.exitCode = 1
    return
  }

  const startedAt = Date.now()
  const sourcesByTitle = makeSourceMap()
  const documents = makeDocuments(sourcesByTitle)
  const documentsByTitle = new Map(documents.map((document) => [document.title, document]))
  console.log(`Phase 5D step 10 live validation against ${BASE}`)
  console.log(`authorized cases: ${CASE_IDS.join(', ')}`)
  console.log(`required fixture union: ${documents.length} sources / ${documents.reduce((total, document) => total + document.chunks.length, 0)} chunks`)

  const embeddingMetadata = await embedRequiredChunks(documents)
  console.log(`embeddings: ${embeddingMetadata.requests} requests / ${embeddingMetadata.texts} texts / ${embeddingMetadata.model} / ${embeddingMetadata.dimensions}d`)

  const records = []
  for (const spec of selectedCases) {
    const record = await runCase(spec, documentsByTitle, embeddingMetadata)
    records.push(record)
    console.log(`${record.id} ${record.passed ? 'PASS' : 'FAIL'} / resolution=${record.temporal.resolution.status} value=${record.temporal.resolution.resolvedValue ?? 'null'} / disposition=${record.temporal.gate.disposition} / providerCalled=${record.providerCalled}`)
    if (record.generationUsage) console.log(`  generation: ${record.generationUsage.inputTokens ?? '?'} in / ${record.generationUsage.outputTokens ?? '?'} out`)
    console.log(`  answer: ${(record.finalAnswer?.body ?? '').replace(/\s+/g, ' ').slice(0, 240)}`)
    if (!record.passed) console.log(`  failure categories: ${record.failureCategories.join(', ') || 'unclassified'}`)
  }

  const output = {
    recordedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    phase: '5D-live',
    step: 10,
    authorizationScope: CASE_IDS,
    asOf: AS_OF,
    retrieval: {
      path: 'local neural embeddings -> lexical BM25 -> candidate union -> deterministic rerank -> pruning -> temporal coverage',
      candidateLimit: CANDIDATE_LIMIT,
      defaultTopK: DEFAULT_TOP_K,
      embeddingCache: 'one shared required-fixture pass; repeated query text reused in-memory',
    },
    embedding: {
      model: embeddingMetadata.model,
      dimensions: embeddingMetadata.dimensions,
      fixtureSourcesEmbedded: documents.length,
      fixtureChunksEmbedded: embeddingMetadata.texts,
      documentRequests: embeddingMetadata.requests,
      uniqueQueryTexts: queryEmbeddingCache.size,
      queryCacheHits: queryEmbeddingCacheHits,
    },
    generation: {
      calls: generationCallCount,
      model: records.find((record) => record.providerModel)?.providerModel ?? null,
      inputTokens: records.reduce((total, record) => total + (record.generationUsage?.inputTokens ?? 0), 0),
      outputTokens: records.reduce((total, record) => total + (record.generationUsage?.outputTokens ?? 0), 0),
      totalTokens: records.reduce((total, record) => total + (record.generationUsage?.totalTokens ?? 0), 0),
    },
    usage: usageTracker.summary(),
    records,
    passed: records.length === CASE_IDS.length && records.every((record) => record.passed),
    notes: {
      futureCase: 'T6b receives one live generation call for the requested February 2027 period; its before-applicability 2026 check is deterministic on the same retrieved evidence and spends no extra provider call.',
      t9: 'T9 is expected to stop at temporalGate with unresolved + relevant + HOLD and zero generation calls.',
      noRetries: 'No retries were made by this harness; provider/API failures are preserved exactly.',
    },
  }
  writeOutput(output)
  console.log(`\n${output.passed ? 'PASS' : 'FAIL'} / ${records.filter((record) => record.passed).length}/${records.length} authorized cases`)
  console.log(usageTracker.line())
  console.log(`written to ${OUTPUT}`)
  if (!output.passed) process.exitCode = 1
}

main().catch((error) => {
  const failure = {
    recordedAt: new Date().toISOString(),
    phase: '5D-live',
    step: 10,
    authorizationScope: CASE_IDS,
    fatalError: { code: error.code ?? 'fatal_error', message: error.message },
    usage: usageTracker.summary(),
    passed: false,
  }
  writeOutput(failure)
  console.error(`\nrun aborted: ${failure.fatalError.code} — ${failure.fatalError.message}`)
  process.exitCode = 1
})
