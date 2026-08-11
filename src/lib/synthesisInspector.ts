import type { FacetCoverageStatus, PropositionCoverageStatus, SynthesisDisposition } from './facetCoverage.ts'
import type { SynthesisPreparationResult } from './synthesisOrchestrator.ts'

export interface SynthesisInspectorRequirement {
  id: string
  dimension: string | null
  kind: string
  evidenceKind: string
  required: boolean
  critical: boolean
  reason: string
}

export interface SynthesisInspectorFacet {
  facetId: string
  label: string
  kind: string
  parentId: string | null
  discoverySignals: string[]
  lexicalAliasCount: number
  requirements: SynthesisInspectorRequirement[]
  retrievalQueries: string[]
  retrievalQueryCount: number
  aliasQueryCount: number
  unionCandidateCount: number
  selectedCandidateCount: number
  reasoningContextCount: number
  restoredWitnesses: Array<{ chunkId: string; reason: string }>
  temporal: {
    status: string
    disposition: string
    applicableClaims: number
    excludedClaims: number
    notice: string
  }
  provenance: {
    status: string
    conflicts: string[]
    notice: string
  }
  propositions: Array<{
    id: string
    status: PropositionCoverageStatus
    supportingChunkIds: string[]
    reason: string
  }>
  coverageStatus: FacetCoverageStatus
  missingPropositions: string[]
}

export interface SynthesisInspectorModel {
  route: 'focused' | 'synthesis'
  routeReason: string
  initialMode: string
  classifierReason: string
  classifierSignals: string[]
  scopeRefinement: string
  asOf: string
  requestedPeriod: string | null
  discoveredFacetCount: number
  runtimeFacetCount: number
  rejectedCandidates: Array<{ id: string; label: string; reason: string | null; signals: string[] }>
  requirements: Array<{ id: string; facetId: string; dimension: string | null; kind: string; required: boolean; critical: boolean }>
  facets: SynthesisInspectorFacet[]
  disposition: SynthesisDisposition | 'not-run'
  dispositionReason: string
  coveredFacetCount: number
  partialFacetCount: number
  unsupportedFacetCount: number
  conflictedFacetCount: number
  queryBudget: SynthesisPreparationResult['queryBudget']
  packet: {
    claimCount: number
    chunkCount: number
    facetCount: number
  }
  providerCalled: false
}

/** Build a UI-safe, expandable summary. Raw chunk bodies are intentionally omitted. */
export const buildSynthesisInspector = (preparation: SynthesisPreparationResult): SynthesisInspectorModel => {
  const discovery = preparation.discovery
  const requirements = preparation.requirements?.requirements ?? []
  const coverage = preparation.coverage
  const coverageByFacet = new Map(coverage?.facets.map((facet) => [facet.facetId, facet]) ?? [])
  const facets = preparation.facets.map((prepared) => {
    const coverageFacet = coverageByFacet.get(prepared.facet.id)
    return {
      facetId: prepared.facet.id,
      label: prepared.facet.label,
      kind: prepared.facet.kind,
      parentId: prepared.facet.parentId,
      discoverySignals: prepared.facet.signals,
      lexicalAliasCount: prepared.facet.lexicalAliases.length,
      requirements: prepared.requirements.map((requirement) => ({
        id: requirement.id,
        dimension: requirement.dimension,
        kind: requirement.kind,
        evidenceKind: requirement.evidenceKind,
        required: requirement.required,
        critical: requirement.critical,
        reason: requirement.reason,
      })),
      retrievalQueries: prepared.retrieval.retrievalQueries,
      retrievalQueryCount: prepared.retrieval.retrievalQueries.length,
      aliasQueryCount: preparation.facetMetrics.find((metric) => metric.facetId === prepared.facet.id)?.aliasQueryCount ?? 0,
      unionCandidateCount: prepared.retrieval.unionCandidates.length,
      selectedCandidateCount: prepared.retrieval.selected.length,
      reasoningContextCount: prepared.reasoning.reasoningContext.length,
      restoredWitnesses: prepared.reasoning.restoredWitnesses,
      temporal: {
        status: prepared.reasoning.temporal.status,
        disposition: prepared.reasoning.temporal.disposition,
        applicableClaims: prepared.reasoning.temporal.applicableClaims.length,
        excludedClaims: prepared.reasoning.temporal.excludedClaims.length,
        notice: prepared.reasoning.temporal.notice,
      },
      provenance: {
        status: prepared.reasoning.provenanceConflict.status,
        conflicts: prepared.reasoning.provenanceConflict.conflicts.map((conflict) => conflict.summary),
        notice: prepared.reasoning.provenanceConflict.notice,
      },
      propositions: coverageFacet?.propositions.map((proposition) => ({
        id: proposition.propositionId,
        status: proposition.status,
        supportingChunkIds: proposition.supportingChunkIds,
        reason: proposition.reason,
      })) ?? [],
      coverageStatus: coverageFacet?.status ?? 'partially-covered',
      missingPropositions: coverageFacet?.missingPropositions ?? [],
    }
  })

  return {
    route: preparation.route,
    routeReason: preparation.routeReason,
    initialMode: preparation.scope.mode,
    classifierReason: preparation.scope.reason,
    classifierSignals: preparation.scope.signals,
    scopeRefinement: discovery?.scopeRefinement ?? 'not-run',
    asOf: preparation.asOf,
    requestedPeriod: preparation.requestedPeriod,
    discoveredFacetCount: discovery?.selected.length ?? 0,
    runtimeFacetCount: preparation.facets.length,
    rejectedCandidates: discovery?.rejected.map((candidate) => ({
      id: candidate.id,
      label: candidate.label,
      reason: candidate.rejectionReason,
      signals: candidate.signals,
    })) ?? [],
    requirements: requirements.map((requirement) => ({
      id: requirement.id,
      facetId: requirement.facetId,
      dimension: requirement.dimension,
      kind: requirement.kind,
      required: requirement.required,
      critical: requirement.critical,
    })),
    facets,
    disposition: coverage?.disposition ?? 'not-run',
    dispositionReason: coverage?.dispositionReason ?? 'The focused path did not enter broad synthesis.',
    coveredFacetCount: coverage?.coveredFacetCount ?? 0,
    partialFacetCount: coverage?.partialFacetCount ?? 0,
    unsupportedFacetCount: coverage?.unsupportedFacetCount ?? 0,
    conflictedFacetCount: coverage?.conflictedFacetCount ?? 0,
    queryBudget: preparation.queryBudget,
    packet: {
      claimCount: preparation.queryBudget.finalPacketClaims,
      chunkCount: preparation.queryBudget.finalPacketChunks,
      facetCount: preparation.packet?.facets.length ?? 0,
    },
    providerCalled: false,
  }
}
