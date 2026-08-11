import assert from 'node:assert/strict'
import { buildMeridianCorpus } from '../src/data/meridianCorpus.ts'
import { classifyQueryScope } from '../src/lib/synthesisScope.ts'
import { discoverFacets } from '../src/lib/facetDiscovery.ts'
import { deriveSynthesisRequirements, materializeSynthesisFacets, bindRequirementWitnesses } from '../src/lib/synthesisRequirements.ts'
import { retrieveFacetEvidence } from '../src/lib/facetRetrieval.ts'
import { reasonFacetEvidence } from '../src/lib/facetReasoning.ts'
import { evaluateSynthesisCoverage } from '../src/lib/facetCoverage.ts'
import {
  MERIDIAN_EVIDENCE_ANCHORS,
  PHASE5E_SYNTHESIS_CASES,
} from './fixtures/phase5e.mjs'

const meridianDocument = buildMeridianCorpus()[0]
const meridianCorpus = { documents: [meridianDocument] }
const meridianChunks = meridianDocument.chunks.map((chunk) => ({
  id: chunk.id,
  text: chunk.text,
  documentId: chunk.documentId,
  documentTitle: meridianDocument.title,
}))

const normalize = (value) => value
  .normalize('NFKC')
  .toLocaleLowerCase('en')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/\s+/g, ' ')
  .trim()

const fixtureCase = (id) => PHASE5E_SYNTHESIS_CASES.find((item) => item.id === id)

const anchorPresent = (results, anchor) => results.some((result) => {
  const text = normalize(result.chunk.text)
  return anchor.semanticSignatures.some((signature) => signature.allOf.every((needle) => text.includes(normalize(needle))))
})

const runRuntimePipeline = (spec) => {
  // The fixture is used only by the caller for post-run scoring. Nothing in
  // this runtime path reads expected facets, propositions, anchors, or answer
  // dispositions while constructing its inputs.
  const scope = classifyQueryScope(spec.question)
  const discovery = discoverFacets(spec.question, meridianChunks, scope)
  const plan = deriveSynthesisRequirements(spec.question, scope, discovery, meridianChunks)
  const plannedFacets = materializeSynthesisFacets(discovery, plan)
  const coverageInputs = []
  const reasoningResults = []
  const retrievalMetrics = []

  for (const planned of plannedFacets) {
    const retrieval = retrieveFacetEvidence(spec.question, planned.facet, meridianCorpus, {
      denseLimit: 14,
      lexicalLimit: 14,
      unionLimit: 18,
      maxSelected: 6,
    })
    const boundFacet = bindRequirementWitnesses(planned.facet, retrieval.unionCandidates, retrieval.selected)
    const reasoning = reasonFacetEvidence({
      facet: boundFacet,
      originalQuestion: spec.question,
      asOf: spec.asOf,
      unionCandidates: retrieval.unionCandidates,
      selectedCandidates: retrieval.selected,
    })
    assert.equal(reasoning.providerCalled, false)
    assert.ok(reasoning.reasoningContext.length <= retrieval.unionCandidates.length)
    retrievalMetrics.push({
      facetId: planned.facet.id,
      unionChunks: retrieval.unionCandidates.length,
      selectedChunks: retrieval.selected.length,
      reasoningChunks: reasoning.reasoningContext.length,
      restoredWitnesses: reasoning.restoredWitnesses.length,
    })
    coverageInputs.push({
      facet: boundFacet,
      reasoning,
      required: planned.required,
      critical: planned.critical,
    })
    reasoningResults.push(reasoning)
  }

  const coverage = evaluateSynthesisCoverage({ question: spec.question, facets: coverageInputs })
  return { scope, discovery, plan, plannedFacets, coverageInputs, reasoningResults, retrievalMetrics, coverage }
}

const scoreExpectedAnchors = (spec, reasoningResults) => {
  const allResults = reasoningResults.flatMap((reasoning) => reasoning.reasoningContext)
  const supported = spec.facets.flatMap((facet) => facet.requiredPropositions)
    .filter((proposition) => proposition.expectedSupport === 'supported')
  const covered = supported.filter((proposition) => proposition.anchorIds.some((anchorId) => (
    anchorPresent(allResults, MERIDIAN_EVIDENCE_ANCHORS[anchorId])
  )))
  return {
    covered: covered.length,
    total: supported.length,
    missing: supported
      .filter((proposition) => !proposition.anchorIds.some((anchorId) => anchorPresent(allResults, MERIDIAN_EVIDENCE_ANCHORS[anchorId])))
      .map((proposition) => ({ id: proposition.id, anchorIds: proposition.anchorIds })),
  }
}

const runs = ['S1', 'S2', 'S3', 'S4', 'S5'].map((id) => {
  const spec = fixtureCase(id)
  const runtime = runRuntimePipeline(spec)
  const anchorScore = scoreExpectedAnchors(spec, runtime.reasoningResults)
  assert.equal(runtime.coverage.providerCalled, false)
  assert.equal(runtime.coverage.disposition, 'answer', `${id} runtime disposition must be answer: ${JSON.stringify({ plan: runtime.plan, facets: runtime.coverage.facets })}`)
  assert.equal(anchorScore.covered, anchorScore.total, `${id} runtime reasoning missed expected semantic evidence: ${JSON.stringify({ missing: anchorScore.missing, contexts: runtime.reasoningResults.map((reasoning) => reasoning.reasoningContext.map((result) => result.chunk.id)) })}`)
  assert.ok(runtime.discovery.selected.length > 0, `${id} must consume discovered facets`)
  assert.ok(runtime.plan.requirements.length > 0, `${id} must derive runtime requirements`)
  if (id === 'S1') {
    const runtimeFacetIds = runtime.plannedFacets.map((planned) => planned.facet.id)
    assert.ok(runtimeFacetIds.includes('standard'), 'S1 must consume the neutral discovered Standard facet')
    assert.ok(!runtimeFacetIds.includes('standard-plan'), 'runtime must not manufacture fixture facet ids')
    assert.ok(runtimeFacetIds.includes('continuity-credit'), 'S1 singleton salient facet must reach runtime planning')
  }
  return {
    id,
    scope: runtime.scope.reason,
    discoveredFacets: runtime.discovery.selected.length,
    plannedRequirements: runtime.plan.requirements.length,
    coveredFacets: runtime.coverage.coveredFacetCount,
    anchorScore,
    retrievalMetrics: runtime.retrievalMetrics,
    restoredWitnesses: runtime.retrievalMetrics.reduce((sum, metric) => sum + metric.restoredWitnesses, 0),
  }
})

/* ---------------------------------------------------------- S6 runtime gate */

const s6 = fixtureCase('S6')
const s6Runtime = runRuntimePipeline(s6)
const aggregateRequirements = s6Runtime.plan.requirements.filter((requirement) => requirement.kind === 'aggregate')
assert.equal(s6Runtime.plan.mode, 'aggregate')
assert.equal(aggregateRequirements.length, 8, 'S6 must derive four types x two metrics at runtime')
assert.equal(new Set(aggregateRequirements.map((requirement) => requirement.facetId)).size, 4)
assert.equal(new Set(aggregateRequirements.map((requirement) => requirement.dimension)).size, 2)
assert.ok(aggregateRequirements.some((requirement) => /dayline/i.test(requirement.subject)), 'S6 must derive Dayline as a current membership type')
assert.ok(aggregateRequirements.every((requirement) => requirement.sourceChunkIds.length === 0), 'S6 aggregate obligations must begin without fabricated witnesses')
assert.equal(s6Runtime.coverage.disposition, 'refuse-unsupported')
assert.equal(s6Runtime.coverage.unsupportedFacetCount, 4)
assert.equal(
  s6Runtime.coverage.facets.flatMap((facet) => facet.propositions).filter((proposition) => proposition.status === 'unsupported').length,
  8,
)
assert.ok(s6Runtime.coverage.facets.flatMap((facet) => facet.propositions).every((proposition) => proposition.supportingChunkIds.length === 0))
assert.ok(s6Runtime.coverage.packet.facets.flatMap((facet) => facet.propositions).every((proposition) => proposition.supportingChunkIds.length === 0))

/* ------------------------------------------ runtime-boundary invariants */

for (const runtime of [
  ...runs.map((run) => run),
  { id: 'S6', scope: s6Runtime.scope.reason, discoveredFacets: s6Runtime.discovery.selected.length, plannedRequirements: s6Runtime.plan.requirements.length, coveredFacets: s6Runtime.coverage.coveredFacetCount, anchorScore: null },
]) {
  assert.ok(runtime.discoveredFacets > 0)
  assert.ok(runtime.plannedRequirements > 0)
}

console.log(JSON.stringify({
  runtimeCases: runs,
  s6: {
    scope: s6Runtime.scope.reason,
    discoveredFacets: s6Runtime.discovery.selected.length,
    runtimeRequirementCount: aggregateRequirements.length,
    runtimeRequirementKinds: [...new Set(aggregateRequirements.map((requirement) => requirement.kind))],
    metricsPerType: [...new Set(aggregateRequirements.map((requirement) => requirement.dimension))],
    disposition: s6Runtime.coverage.disposition,
    unsupportedPropositions: s6Runtime.coverage.facets.flatMap((facet) => facet.propositions).filter((proposition) => proposition.status === 'unsupported').length,
  },
  reasoning: {
    totalRestoredWitnesses: runs.reduce((sum, run) => sum + run.restoredWitnesses, 0),
    maxContextExpansion: Math.max(...runs.flatMap((run) => run.retrievalMetrics ?? []).map((metric) => metric.reasoningChunks - metric.selectedChunks), 0),
  },
  providerCalls: 0,
}, null, 2))
console.log(`Phase 5E runtime coverage tests passed / production scope -> discovery -> requirements -> retrieval -> reasoning -> coverage for S1-S6`)
