import type { DocumentRecord } from '../types.ts'
import {
  discoverFacets,
  type DiscoveredFacet,
  type FacetDiscoveryChunk,
  type FacetDiscoveryResult,
} from './facetDiscovery.ts'
import {
  bindRequirementWitnesses,
  deriveSynthesisRequirements,
  materializeSynthesisFacets,
  type PlannedSynthesisFacet,
  type SynthesisRequirementPlan,
} from './synthesisRequirements.ts'
import { classifyQueryScope, type QueryScopeDecision } from './synthesisScope.ts'
import {
  retrieveFacetEvidence,
  type FacetRetrievalOptions,
  type FacetRetrievalResult,
} from './facetRetrieval.ts'
import { reasonFacetEvidence, type FacetReasoningResult } from './facetReasoning.ts'
import {
  evaluateSynthesisCoverage,
  type FacetCoverageResult,
  type StructuredSynthesisPacket,
  type SynthesisCoverageResult,
} from './facetCoverage.ts'
import { readRequestedPeriods, type RequestedPeriodReading } from './temporalResolution.ts'

export type SynthesisRoute = 'focused' | 'synthesis'

export interface SynthesisPreparationOptions {
  /** The resolved UI reference date. Temporal code must not read the clock. */
  asOf: string
  requestedPeriod?: string | null
  retrieval?: FacetRetrievalOptions
}

export interface SynthesisPreparedFacet {
  facet: DiscoveredFacet
  requirements: PlannedSynthesisFacet['requirements']
  retrieval: FacetRetrievalResult
  reasoning: FacetReasoningResult
  coverage: FacetCoverageResult
}

export interface SynthesisFacetMetrics {
  facetId: string
  label: string
  discoverySignals: string[]
  requirementCount: number
  required: boolean
  critical: boolean
  retrievalQueryCount: number
  aliasQueryCount: number
  unionCandidateCount: number
  selectedCandidateCount: number
  reasoningContextCount: number
  restoredWitnesses: FacetReasoningResult['restoredWitnesses']
  coverageStatus: FacetCoverageResult['status']
}

export interface SynthesisQueryBudget {
  facets: number
  totalRetrievalQueries: number
  maxQueriesPerFacet: number
  aliasDerivedQueries: number
  uniqueRetrievedChunks: number
  totalUnionCandidates: number
  finalPacketClaims: number
  finalPacketChunks: number
}

export interface SynthesisPreparationResult {
  route: SynthesisRoute
  routeReason: string
  scope: QueryScopeDecision
  discovery: FacetDiscoveryResult | null
  requirements: SynthesisRequirementPlan | null
  requestedPeriod: string | null
  periodReading: RequestedPeriodReading
  asOf: string
  facets: SynthesisPreparedFacet[]
  facetMetrics: SynthesisFacetMetrics[]
  coverage: SynthesisCoverageResult | null
  packet: StructuredSynthesisPacket | null
  queryBudget: SynthesisQueryBudget
  providerCalled: false
}

export const toFacetDiscoveryChunks = (documents: readonly DocumentRecord[]): FacetDiscoveryChunk[] => documents.flatMap((document) => (
  document.chunks.map((chunk) => ({
    id: chunk.id,
    text: chunk.text,
    documentId: chunk.documentId,
    documentTitle: document.title,
  }))
))

const DEFAULT_SYNTHESIS_RETRIEVAL: FacetRetrievalOptions = {
  denseLimit: 14,
  lexicalLimit: 14,
  unionLimit: 18,
  maxSelected: 6,
}

const emptyBudget = (): SynthesisQueryBudget => ({
  facets: 0,
  totalRetrievalQueries: 0,
  maxQueriesPerFacet: 0,
  aliasDerivedQueries: 0,
  uniqueRetrievedChunks: 0,
  totalUnionCandidates: 0,
  finalPacketClaims: 0,
  finalPacketChunks: 0,
})

const packetStats = (packet: StructuredSynthesisPacket) => {
  const chunkIds = new Set(packet.facets.flatMap((facet) => facet.supportingChunkIds))
  const claimCount = packet.facets.reduce((total, facet) => total
    + facet.propositions.length
    + facet.applicableClaims.length
    + facet.excludedClaims.length, 0)
  return { claimCount, chunkCount: chunkIds.size }
}

const aliasQueryCount = (facet: DiscoveredFacet, retrieval: FacetRetrievalResult) => {
  const aliases = new Set((facet.lexicalAliases ?? []).map((alias) => alias.toLocaleLowerCase('en')))
  if (!aliases.size) return 0
  return retrieval.retrievalQueries
    .slice(2)
    .filter((query) => query
      .toLocaleLowerCase('en')
      .split(/\s+/)
      .some((term) => aliases.has(term)))
    .length
}

const focusedResult = (
  scope: QueryScopeDecision,
  discovery: FacetDiscoveryResult | null,
  asOf: string,
  periodReading: RequestedPeriodReading,
  routeReason: string,
): SynthesisPreparationResult => ({
  route: 'focused',
  routeReason,
  scope,
  discovery,
  requirements: null,
  requestedPeriod: periodReading.period,
  periodReading,
  asOf,
  facets: [],
  facetMetrics: [],
  coverage: null,
  packet: null,
  queryBudget: emptyBudget(),
  providerCalled: false,
})

/**
 * Compose the deterministic broad-synthesis stages into one production
 * boundary. This function prepares evidence only: it never calls a model,
 * performs web research, or writes to the application state.
 */
export const prepareSynthesis = (
  question: string,
  documents: readonly DocumentRecord[],
  options: SynthesisPreparationOptions,
): SynthesisPreparationResult => {
  const scope = classifyQueryScope(question)
  const periodReading = readRequestedPeriods(question)
  if (scope.mode === 'focused') {
    return focusedResult(scope, null, options.asOf, periodReading, 'focused_query_scope')
  }

  const chunks = toFacetDiscoveryChunks(documents)
  const discovery = discoverFacets(question, chunks, scope)
  if (discovery.scopeRefinement === 'downgrade-to-focused') {
    return focusedResult(scope, discovery, options.asOf, periodReading, 'evidence_derived_narrow_subject')
  }

  const requirements = deriveSynthesisRequirements(question, scope, discovery, chunks)
  const plannedFacets = materializeSynthesisFacets(discovery, requirements)
  const corpus = { documents: [...documents] }
  const prepared: Array<Omit<SynthesisPreparedFacet, 'coverage'>> = []

  for (const planned of plannedFacets) {
    const retrieval = retrieveFacetEvidence(question, planned.facet, corpus, {
      ...DEFAULT_SYNTHESIS_RETRIEVAL,
      ...options.retrieval,
    })
    const boundFacet = bindRequirementWitnesses(planned.facet, retrieval.unionCandidates, retrieval.selected)
    const reasoning = reasonFacetEvidence({
      facet: boundFacet,
      originalQuestion: question,
      asOf: options.asOf,
      requestedPeriod: options.requestedPeriod ?? periodReading.period,
      unionCandidates: retrieval.unionCandidates,
      selectedCandidates: retrieval.selected,
    })
    prepared.push({
      facet: boundFacet,
      requirements: planned.requirements,
      retrieval,
      reasoning,
    })
  }

  const coverage = evaluateSynthesisCoverage({
    question,
    facets: prepared.map((item, index) => ({
      facet: item.facet,
      reasoning: item.reasoning,
      required: plannedFacets[index]?.required,
      critical: plannedFacets[index]?.critical,
    })),
  })
  const coverageByFacet = new Map(coverage.facets.map((item) => [item.facetId, item]))
  const preparedWithCoverage: SynthesisPreparedFacet[] = prepared.map((item) => ({
    ...item,
    coverage: coverageByFacet.get(item.facet.id) ?? (() => {
      throw new Error(`Phase 5E Step 9 missing coverage result for ${item.facet.id}`)
    })(),
  }))

  const facetMetrics = preparedWithCoverage.map((item) => ({
    facetId: item.facet.id,
    label: item.facet.label,
    discoverySignals: item.facet.signals,
    requirementCount: item.requirements.length,
    required: item.coverage.required,
    critical: item.coverage.critical,
    retrievalQueryCount: item.retrieval.retrievalQueries.length,
    aliasQueryCount: aliasQueryCount(item.facet, item.retrieval),
    unionCandidateCount: item.retrieval.unionCandidates.length,
    selectedCandidateCount: item.retrieval.selected.length,
    reasoningContextCount: item.reasoning.reasoningContext.length,
    restoredWitnesses: item.reasoning.restoredWitnesses,
    coverageStatus: item.coverage.status,
  }))
  const retrievedChunkIds = new Set(preparedWithCoverage.flatMap((item) => item.retrieval.unionCandidates.map((candidate) => candidate.result.chunk.id)))
  const packetSummary = packetStats(coverage.packet)
  const queryBudget: SynthesisQueryBudget = {
    facets: prepared.length,
    totalRetrievalQueries: facetMetrics.reduce((total, item) => total + item.retrievalQueryCount, 0),
    maxQueriesPerFacet: Math.max(...facetMetrics.map((item) => item.retrievalQueryCount), 0),
    aliasDerivedQueries: facetMetrics.reduce((total, item) => total + item.aliasQueryCount, 0),
    uniqueRetrievedChunks: retrievedChunkIds.size,
    totalUnionCandidates: facetMetrics.reduce((total, item) => total + item.unionCandidateCount, 0),
    finalPacketClaims: packetSummary.claimCount,
    finalPacketChunks: packetSummary.chunkCount,
  }

  return {
    route: 'synthesis',
    routeReason: 'evidence_derived_broad_scope',
    scope,
    discovery,
    requirements,
    requestedPeriod: options.requestedPeriod ?? periodReading.period,
    periodReading,
    asOf: options.asOf,
    facets: preparedWithCoverage,
    facetMetrics,
    coverage,
    packet: coverage.packet,
    queryBudget,
    providerCalled: false,
  }
}
