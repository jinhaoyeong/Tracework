// Coverage-engine unit tests. The end-to-end runtime contract is tested by
// test-phase5e-runtime-coverage.mjs, which never constructs facets from the
// frozen expected proposition list.
import assert from 'node:assert/strict'
import { buildMeridianCorpus } from '../src/data/meridianCorpus.ts'
import { createDocument } from '../src/lib/rag.ts'
import { retrieveFacetEvidence } from '../src/lib/facetRetrieval.ts'
import { reasonFacetEvidence } from '../src/lib/facetReasoning.ts'
import { evaluateSynthesisCoverage } from '../src/lib/facetCoverage.ts'
import {
  MERIDIAN_EVIDENCE_ANCHORS,
  PHASE5E_SYNTHESIS_CASES,
} from './fixtures/phase5e.mjs'
import { PHASE5C_CORPUS } from './fixtures/phase5c.mjs'

const meridianDocument = buildMeridianCorpus()[0]
const meridianCorpus = { documents: [meridianDocument] }

const normalize = (value) => value
  .normalize('NFKC')
  .toLocaleLowerCase('en')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/\s+/g, ' ')
  .trim()

const slugify = (value) => normalize(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const fixtureCase = (id) => PHASE5E_SYNTHESIS_CASES.find((item) => item.id === id)

const propositionKind = (description) => {
  const text = description.toLocaleLowerCase('en')
  if (/exception|misleading|unlimited|assistant|not universal|false/.test(text)) return 'exception'
  if (/proposed|obsolete|rejected|unapproved|future|ended|not current|not approved/.test(text)) return 'change-status'
  if (/current|august|price|cost|threshold|allowance|state/.test(text)) return 'current-state'
  return 'definition'
}

const retrievalLabel = (label) => label.replace(/\s+(?:plan|comparison row)$/i, '').trim()
const retrievalKind = (label) => {
  if (/\b(?:exception|exceptions|exclusion|exclusions)\b/i.test(label)) return 'exception-collection'
  if (/\binactive\b|\bproposed rules\b/i.test(label)) return 'inactive-collection'
  return 'named-policy-or-benefit'
}

const baseFacet = (spec) => {
  const label = retrievalLabel(spec.label)
  return {
    id: spec.id,
    label,
    kind: retrievalKind(spec.label),
    normalizedSubject: slugify(label),
    parentId: null,
    aliases: [label],
    occurrenceCount: 0,
    chunkIds: [],
    signals: ['explicit_query_subject'],
    evidenceObligations: spec.requiredPropositions.map((item) => ({
      id: item.id,
      kind: propositionKind(item.description),
      description: item.description,
      chunkIds: [],
    })),
    confidence: 1,
    rejectionReason: null,
  }
}

const anchorPresent = (results, anchor) => results.some((result) => {
  const text = normalize(result.chunk.text)
  return anchor.semanticSignatures.some((signature) => signature.allOf.every((needle) => text.includes(normalize(needle))))
})

const anchorChunkIds = (anchorId) => {
  const anchor = MERIDIAN_EVIDENCE_ANCHORS[anchorId]
  return meridianDocument.chunks
    .filter((chunk) => anchor.semanticSignatures.some((signature) => signature.allOf.every((needle) => normalize(chunk.text).includes(normalize(needle)))))
    .map((chunk) => chunk.id)
}

const hydrateFacetWitnesses = (facet, spec, retrieval) => {
  const union = retrieval.unionCandidates.map((candidate) => candidate.result)
  const selectedIds = new Set(retrieval.selected.map((result) => result.chunk.id))
  const unionIds = new Set(union.map((result) => result.chunk.id))
  return {
    ...facet,
    evidenceObligations: facet.evidenceObligations.map((obligation, index) => {
      const proposition = spec.requiredPropositions[index]
      if (proposition.expectedSupport === 'unsupported') return obligation
      const available = proposition.anchorIds
        .flatMap((anchorId) => anchorChunkIds(anchorId))
        .filter((chunkId, position, all) => all.indexOf(chunkId) === position)
      assert.ok(available.some((chunkId) => unionIds.has(chunkId)), `${spec.id}/${proposition.id} has no witness in Step 6 union`)
      const preferred = available.find((chunkId) => selectedIds.has(chunkId) && unionIds.has(chunkId))
        ?? available.find((chunkId) => unionIds.has(chunkId))
      return { ...obligation, chunkIds: [preferred] }
    }),
  }
}

const buildCaseInputs = (spec) => spec.facets.map((facetSpec) => {
  const facet = baseFacet(facetSpec)
  const retrieval = retrieveFacetEvidence(spec.question, facet, meridianCorpus, {
    denseLimit: 14,
    lexicalLimit: 14,
    unionLimit: 18,
    maxSelected: 6,
  })
  const hydratedFacet = hydrateFacetWitnesses(facet, facetSpec, retrieval)
  const reasoning = reasonFacetEvidence({
    facet: hydratedFacet,
    originalQuestion: spec.question,
    asOf: spec.asOf,
    unionCandidates: retrieval.unionCandidates,
    selectedCandidates: retrieval.selected,
  })
  return {
    facet: hydratedFacet,
    reasoning,
    required: facetSpec.required,
    critical: facetSpec.critical,
  }
})

const runCase = (id) => {
  const spec = fixtureCase(id)
  const result = evaluateSynthesisCoverage({
    question: spec.question,
    facets: buildCaseInputs(spec),
  })
  assert.equal(result.providerCalled, false)
  assert.equal(result.packet.question, spec.question)
  return { spec, result, inputs: buildCaseInputs(spec) }
}

const baselineRuns = ['S1', 'S2', 'S3', 'S4', 'S5'].map(runCase)
for (const { spec, result } of baselineRuns) {
  assert.equal(result.disposition, 'answer', `${spec.id} should be answerable`)
  assert.ok(result.facets.every((facet) => facet.status === 'covered'), `${spec.id} has uncovered facets`)
  assert.equal(result.packet.facets.length, spec.facets.length)
  assert.ok(result.packet.facets.every((facet) => Array.isArray(facet.propositions)))
  assert.ok(result.packet.facets.every((facet) => !('reasoningContext' in facet)), 'packet must contain reasoned data, not raw context')
}

const s1Run = baselineRuns.find((run) => run.spec.id === 'S1')
const s1Inactive = s1Run.result.facets.find((facet) => facet.facetId === 'inactive-or-proposed')
assert.ok(s1Inactive.propositions.some((proposition) => proposition.status === 'excluded'), 'negative S1 evidence should be represented as excluded')
assert.equal(s1Inactive.status, 'covered')
const s1Dayline = s1Run.result.facets.find((facet) => facet.facetId === 'dayline')
assert.equal(s1Dayline.propositions.find((proposition) => proposition.propositionId === 'dayline-pricing').status, 'supported')

const s5Run = baselineRuns.find((run) => run.spec.id === 'S5')
assert.ok(s5Run.result.facets.some((facet) => facet.propositions.some((proposition) => proposition.status === 'excluded')), 'S5 negative propositions must be satisfied by excluded evidence')

/* --------------------------------------------- proposition mutation gates */

const exceptionInput = s1Run.inputs.find((input) => input.facet.id === 'important-exceptions')
const daylineException = exceptionInput.facet.evidenceObligations.find((obligation) => obligation.id === 'dayline-display-exception')
const daylineWitness = daylineException.chunkIds[0]
const mutatedExceptionReasoning = {
  ...exceptionInput.reasoning,
  reasoningContext: exceptionInput.reasoning.reasoningContext.filter((result) => result.chunk.id !== daylineWitness),
}
const mutatedException = evaluateSynthesisCoverage({
  question: s1Run.spec.question,
  facets: [{ ...exceptionInput, reasoning: mutatedExceptionReasoning }],
})
assert.equal(mutatedException.facets[0].status, 'partially-covered')
assert.ok(mutatedException.facets[0].missingPropositions.includes('dayline-display-exception'))
assert.equal(mutatedException.disposition, 'partial-with-disclosure')

const continuityInput = s1Run.inputs.find((input) => input.facet.id === 'continuity-credit')
const continuityWitness = continuityInput.facet.evidenceObligations[0].chunkIds[0]
const topicOnlyResult = {
  ...continuityInput.reasoning.reasoningContext[0],
  chunk: {
    ...continuityInput.reasoning.reasoningContext[0].chunk,
    id: 'topic-only-continuity-credit',
    text: 'Continuity Credit is mentioned as a named benefit.',
  },
}
const topicOnlyReasoning = {
  ...continuityInput.reasoning,
  reasoningContext: continuityInput.reasoning.reasoningContext
    .filter((result) => result.chunk.id !== continuityWitness)
    .concat(topicOnlyResult),
}
const topicOnly = evaluateSynthesisCoverage({
  question: s1Run.spec.question,
  facets: [{ ...continuityInput, reasoning: topicOnlyReasoning }],
})
assert.notEqual(topicOnly.facets[0].status, 'covered', 'entity presence alone must not satisfy obligations')
assert.ok(topicOnly.facets[0].propositions.every((proposition) => proposition.status === 'missing-evidence'))

/* ------------------------------------------------------ S6 unsupported gate */

const s6 = fixtureCase('S6')
const s6Run = runCase('S6')
assert.equal(s6Run.result.disposition, 'refuse-unsupported')
assert.equal(s6Run.result.unsupportedFacetCount, 8)
assert.equal(s6Run.result.facets.length, 8)
assert.ok(s6Run.result.facets.every((facet) => facet.status === 'unsupported'))
assert.ok(s6Run.result.facets.flatMap((facet) => facet.propositions).every((proposition) => (
  proposition.status === 'unsupported' && proposition.supportingChunkIds.length === 0
)))
assert.deepEqual(
  s6Run.result.facets.map((facet) => facet.facetId).sort(),
  s6.expectedUnsupportedMetricCells.toSorted(),
)

/* ----------------------------------------------- relevant conflict gate */

const makePhase5cResults = (sources) => sources.map((source) => createDocument(
  source.title,
  `synthetic / phase 5C / ${source.title}`,
  source.content,
  'sample',
  { id: `phase5c-${source.title}`, provenance: source.provenance },
)).flatMap((document) => document.chunks.map((chunk) => ({
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
  occurrenceCount: 1,
  chunkIds: [],
  signals: ['explicit_query_subject'],
  evidenceObligations: [{
    id: 'origin-proposition',
    kind: 'definition',
    description: 'Tracework origin',
    chunkIds: [],
  }],
  confidence: 1,
  rejectionReason: null,
}
const conflictResults = makePhase5cResults(PHASE5C_CORPUS.slice(0, 2))
const conflictReasoning = reasonFacetEvidence({
  facet: conflictFacet,
  originalQuestion: 'Where was Tracework invented?',
  asOf: '2026-08-31T23:59:59Z',
  unionCandidates: conflictResults,
  selectedCandidates: conflictResults.slice(0, 1),
})
const criticalConflict = evaluateSynthesisCoverage({
  question: 'Where was Tracework invented?',
  facets: [{ facet: conflictFacet, reasoning: conflictReasoning, required: true, critical: true }],
})
assert.equal(criticalConflict.facets[0].status, 'conflicted')
assert.equal(criticalConflict.disposition, 'hold-for-conflict')

const conflictClaimIds = new Set(conflictReasoning.provenanceConflict.conflicts
  .flatMap((conflict) => conflict.claims.map((claim) => claim.chunkId)))
const isolatedReasoning = {
  ...conflictReasoning,
  facetId: 'tracework-origin-with-safe-detail',
  reasoningContext: [...conflictReasoning.reasoningContext, {
    ...conflictReasoning.reasoningContext[0],
    chunk: {
      ...conflictReasoning.reasoningContext[0].chunk,
      id: 'unrelated-safe-detail',
      text: 'A separate detail is supported by this uncontested passage.',
    },
  }],
}
const isolatedConflictFacet = {
  ...conflictFacet,
  id: 'tracework-origin-with-safe-detail',
  evidenceObligations: [
    {
      id: 'origin-proposition',
      kind: 'definition',
      description: 'Tracework origin',
      chunkIds: [conflictClaimIds.values().next().value],
    },
    {
      id: 'safe-detail-proposition',
      kind: 'definition',
      description: 'A separate uncontested detail',
      chunkIds: ['unrelated-safe-detail'],
    },
  ],
}
const isolatedConflict = evaluateSynthesisCoverage({
  question: 'Summarise the origin and a separate detail.',
  facets: [{ facet: isolatedConflictFacet, reasoning: isolatedReasoning, required: true, critical: true }],
})
assert.equal(isolatedConflict.facets[0].propositions.find((proposition) => proposition.propositionId === 'origin-proposition').status, 'conflicted')
assert.equal(isolatedConflict.facets[0].propositions.find((proposition) => proposition.propositionId === 'safe-detail-proposition').status, 'supported')
assert.equal(isolatedConflict.facets[0].status, 'conflicted')

const optionalConflict = evaluateSynthesisCoverage({
  question: 'Summarise a broader topic.',
  facets: [{ facet: conflictFacet, reasoning: conflictReasoning, required: false, critical: false }],
})
assert.equal(optionalConflict.facets[0].status, 'conflicted')
assert.equal(optionalConflict.disposition, 'answer', 'unrelated optional conflict must not hold synthesis')

console.log(JSON.stringify({
  baseline: baselineRuns.map(({ spec, result }) => ({
    caseId: spec.id,
    disposition: result.disposition,
    covered: result.coveredFacetCount,
    partial: result.partialFacetCount,
    unsupported: result.unsupportedFacetCount,
    conflicted: result.conflictedFacetCount,
  })),
  s6: {
    disposition: s6Run.result.disposition,
    unsupportedFacets: s6Run.result.unsupportedFacetCount,
  },
  mutations: {
    removedException: mutatedException.facets[0].status,
    topicOnlyEntity: topicOnly.facets[0].status,
    criticalConflict: criticalConflict.disposition,
    withinFacetConflict: isolatedConflict.facets[0].propositions.map((proposition) => ({
      id: proposition.propositionId,
      status: proposition.status,
    })),
    optionalConflict: optionalConflict.disposition,
  },
  providerCalls: 0,
}, null, 2))
console.log(`Phase 5E coverage tests passed / S1-S6 disposition gates + proposition, exception, entity-presence, conflict, and packet mutations`)
