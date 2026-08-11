import type { DiscoveredFacet, FacetEvidenceObligation } from './facetDiscovery.ts'
import type { FacetReasoningResult } from './facetReasoning.ts'
import type { EvidenceConflict } from './adjudication.ts'
import type { TemporalClaimAssessment, TemporalBoundary } from './temporalResolution.ts'
import type { NormalizedClaim } from './temporalNormalization.ts'

export type PropositionCoverageStatus =
  | 'supported'
  | 'unsupported'
  | 'excluded'
  | 'conflicted'
  | 'missing-evidence'

export type FacetCoverageStatus =
  | 'covered'
  | 'partially-covered'
  | 'unsupported'
  | 'conflicted'

export type SynthesisDisposition =
  | 'answer'
  | 'partial-with-disclosure'
  | 'hold-for-conflict'
  | 'refuse-unsupported'

export interface PropositionCoverageResult {
  propositionId: string
  status: PropositionCoverageStatus
  supportingChunkIds: string[]
  reason: string
}

export interface FacetCoverageInput {
  facet: DiscoveredFacet
  reasoning: FacetReasoningResult
  /** Frozen fixture metadata stays evaluation-side; runtime facets default true. */
  required?: boolean
  /** Criticality controls overall disposition, not proposition support. */
  critical?: boolean
}

export interface FacetCoverageResult {
  facetId: string
  label: string
  required: boolean
  critical: boolean
  status: FacetCoverageStatus
  propositions: PropositionCoverageResult[]
  missingPropositions: string[]
  conflicts: string[]
  reason: string
}

export interface StructuredFacetSynthesisPacket {
  facetId: string
  label: string
  status: FacetCoverageStatus
  required: boolean
  critical: boolean
  propositions: PropositionCoverageResult[]
  applicableClaims: NormalizedClaim[]
  excludedClaims: TemporalClaimAssessment[]
  temporalBoundaries: TemporalBoundary[]
  conflicts: EvidenceConflict[]
  supportingChunkIds: string[]
  missingPropositions: string[]
  temporalNotice: string
  provenanceNotice: string
}

export interface StructuredSynthesisPacket {
  question: string
  disposition: SynthesisDisposition
  facets: StructuredFacetSynthesisPacket[]
}

export interface SynthesisCoverageInput {
  question: string
  facets: FacetCoverageInput[]
}

export interface SynthesisCoverageResult {
  facets: FacetCoverageResult[]
  disposition: SynthesisDisposition
  dispositionReason: string
  coveredFacetCount: number
  partialFacetCount: number
  unsupportedFacetCount: number
  conflictedFacetCount: number
  packet: StructuredSynthesisPacket
  providerCalled: false
}

const NEGATIVE_LANGUAGE = /\b(?:not|never|unapproved|rejected|obsolete|ended|future|proposed|mistaken|false|no longer|did not|does not|without|unlaunched|discussion[- ]only|pilot)\b/i
const SATISFIED_PROPOSITION_STATUSES = new Set<PropositionCoverageStatus>(['supported', 'excluded'])

const unique = (values: string[]) => [...new Set(values.filter(Boolean))]

const contextByChunkId = (reasoning: FacetReasoningResult) => new Map(
  reasoning.reasoningContext.map((result) => [result.chunk.id, result]),
)

const temporalExcludedChunkIds = (reasoning: FacetReasoningResult) => new Set(
  reasoning.temporal.excludedClaims.map((assessment) => assessment.claim.claim.result.chunk.id),
)

const conflictChunkIds = (reasoning: FacetReasoningResult) => new Set(
  reasoning.provenanceConflict.conflicts.flatMap((conflict) => conflict.claims.map((claim) => claim.chunkId)),
)

const temporalHoldChunkIds = (reasoning: FacetReasoningResult) => new Set([
  ...reasoning.temporal.applicableClaims.map((claim) => claim.claim.result.chunk.id),
  ...reasoning.temporal.excludedClaims.map((assessment) => assessment.claim.claim.result.chunk.id),
])

const affectsProposition = (declaredChunkIds: string[], affectedChunkIds: ReadonlySet<string>) => (
  !affectedChunkIds.size
  || !declaredChunkIds.length
  || declaredChunkIds.some((chunkId) => affectedChunkIds.has(chunkId))
)

const negativeProposition = (obligation: FacetEvidenceObligation) => (
  obligation.kind === 'change-status'
  || NEGATIVE_LANGUAGE.test(obligation.description)
)

const propositionCoverage = (
  obligation: FacetEvidenceObligation,
  reasoning: FacetReasoningResult,
): PropositionCoverageResult => {
  const context = contextByChunkId(reasoning)
  const declaredChunkIds = unique(obligation.chunkIds)
  const supportingChunkIds = declaredChunkIds.filter((chunkId) => context.has(chunkId))
  const supportingText = supportingChunkIds
    .map((chunkId) => context.get(chunkId)?.chunk.text ?? '')
    .join(' ')
  const provenanceConflictAffects = reasoning.provenanceConflict.status === 'conflicted'
    && affectsProposition(declaredChunkIds, conflictChunkIds(reasoning))
  const temporalHoldAffects = reasoning.temporal.disposition === 'hold'
    && affectsProposition(declaredChunkIds, temporalHoldChunkIds(reasoning))

  if (provenanceConflictAffects) {
    return {
      propositionId: obligation.id,
      status: 'conflicted',
      supportingChunkIds,
      reason: `Relevant provenance conflict remains unresolved for this proposition: ${reasoning.provenanceConflict.notice}`,
    }
  }

  if (temporalHoldAffects) {
    return {
      propositionId: obligation.id,
      status: 'conflicted',
      supportingChunkIds,
      reason: `Temporal reasoning is not safe to assert for this proposition: ${reasoning.temporal.notice}`,
    }
  }

  if (!declaredChunkIds.length) {
    return {
      propositionId: obligation.id,
      status: 'unsupported',
      supportingChunkIds: [],
      reason: 'No evidence witness was declared for this obligation.',
    }
  }

  if (!supportingChunkIds.length) {
    return {
      propositionId: obligation.id,
      status: 'missing-evidence',
      supportingChunkIds: [],
      reason: 'Declared evidence witnesses are not present in the Step 7 reasoning context.',
    }
  }

  const excludedIds = temporalExcludedChunkIds(reasoning)
  const negative = negativeProposition(obligation)
  const hasExcludedEvidence = supportingChunkIds.some((chunkId) => excludedIds.has(chunkId))

  if (negative && (hasExcludedEvidence || NEGATIVE_LANGUAGE.test(supportingText))) {
    return {
      propositionId: obligation.id,
      status: 'excluded',
      supportingChunkIds,
      reason: 'The evidence supports the proposition by establishing that the described rule is excluded, obsolete, proposed, or otherwise not current.',
    }
  }

  return {
    propositionId: obligation.id,
    status: 'supported',
    supportingChunkIds,
    reason: 'A declared evidence witness is present and no unresolved temporal or provenance hold applies.',
  }
}

const facetStatus = (propositions: PropositionCoverageResult[], required: boolean): FacetCoverageStatus => {
  if (propositions.some((proposition) => proposition.status === 'conflicted')) return 'conflicted'
  if (!propositions.length || propositions.every((proposition) => proposition.status === 'unsupported')) {
    return required ? 'unsupported' : 'partially-covered'
  }
  if (propositions.every((proposition) => SATISFIED_PROPOSITION_STATUSES.has(proposition.status))) return 'covered'
  return 'partially-covered'
}

const facetReason = (status: FacetCoverageStatus, propositions: PropositionCoverageResult[]) => {
  const counts = propositions.reduce<Record<string, number>>((all, proposition) => ({
    ...all,
    [proposition.status]: (all[proposition.status] ?? 0) + 1,
  }), {})
  const detail = Object.entries(counts).map(([key, count]) => `${count} ${key}`).join(', ')
  if (status === 'covered') return `All evidence obligations are satisfied (${detail}).`
  if (status === 'conflicted') return `At least one required proposition remains conflicted (${detail}).`
  if (status === 'unsupported') return `No evidence obligation has a declared witness (${detail}).`
  return `Some evidence obligations remain unsatisfied (${detail}).`
}

export const evaluateFacetCoverage = (input: FacetCoverageInput): FacetCoverageResult => {
  if (input.facet.id !== input.reasoning.facetId) {
    throw new Error(`Phase 5E Step 8 facet mismatch: ${input.facet.id} != ${input.reasoning.facetId}`)
  }

  const required = input.required ?? true
  const critical = input.critical ?? true
  const propositions = input.facet.evidenceObligations.map((obligation) => propositionCoverage(obligation, input.reasoning))
  const status = facetStatus(propositions, required)
  const conflicts = [
    ...input.reasoning.provenanceConflict.conflicts.map((conflict) => conflict.summary),
    ...(input.reasoning.temporal.disposition === 'hold' ? [input.reasoning.temporal.notice] : []),
  ]
  const missingPropositions = propositions
    .filter((proposition) => !SATISFIED_PROPOSITION_STATUSES.has(proposition.status))
    .map((proposition) => proposition.propositionId)

  return {
    facetId: input.facet.id,
    label: input.facet.label,
    required,
    critical,
    status,
    propositions,
    missingPropositions,
    conflicts,
    reason: facetReason(status, propositions),
  }
}

const dispositionFor = (facets: FacetCoverageResult[]) => {
  const required = facets.filter((facet) => facet.required)
  const criticalConflicts = required.filter((facet) => facet.critical && facet.status === 'conflicted')
  if (criticalConflicts.length) {
    return {
      disposition: 'hold-for-conflict' as const,
      reason: `Critical facet conflict remains unresolved: ${criticalConflicts.map((facet) => facet.facetId).join(', ')}.`,
    }
  }

  const criticalUnsupported = required.filter((facet) => facet.critical && facet.status === 'unsupported')
  if (criticalUnsupported.length) {
    return {
      disposition: 'refuse-unsupported' as const,
      reason: `Critical requested evidence is unsupported: ${criticalUnsupported.map((facet) => facet.facetId).join(', ')}.`,
    }
  }

  const unsatisfiedRequired = required.filter((facet) => facet.status !== 'covered')
  if (unsatisfiedRequired.length) {
    return {
      disposition: 'partial-with-disclosure' as const,
      reason: `The bounded answer has unsatisfied required facets: ${unsatisfiedRequired.map((facet) => facet.facetId).join(', ')}.`,
    }
  }

  return {
    disposition: 'answer' as const,
    reason: 'All required facets and their evidence obligations are covered without an unresolved critical conflict.',
  }
}

const packetFacet = (
  input: FacetCoverageInput,
  coverage: FacetCoverageResult,
): StructuredFacetSynthesisPacket => ({
  facetId: coverage.facetId,
  label: coverage.label,
  status: coverage.status,
  required: coverage.required,
  critical: coverage.critical,
  propositions: coverage.propositions,
  applicableClaims: input.reasoning.temporal.applicableClaims,
  excludedClaims: input.reasoning.temporal.excludedClaims,
  temporalBoundaries: input.reasoning.temporal.boundaries,
  conflicts: input.reasoning.provenanceConflict.conflicts,
  supportingChunkIds: unique(coverage.propositions.flatMap((proposition) => proposition.supportingChunkIds)),
  missingPropositions: coverage.missingPropositions,
  temporalNotice: input.reasoning.temporal.notice,
  provenanceNotice: input.reasoning.provenanceConflict.notice,
})

/**
 * Phase 5E Step 8: decide evidence coverage from Step 7 output only.
 *
 * This function performs no retrieval, extraction, temporal resolution,
 * provenance adjudication, or generation. In particular, a chunk's presence
 * is not enough: the facet must carry a declared witness for every obligation.
 */
export const evaluateSynthesisCoverage = (input: SynthesisCoverageInput): SynthesisCoverageResult => {
  const ids = input.facets.map(({ facet }) => facet.id)
  if (new Set(ids).size !== ids.length) throw new Error('Phase 5E Step 8 requires unique facet ids')

  const facets = input.facets.map(evaluateFacetCoverage)
  const { disposition, reason: dispositionReason } = dispositionFor(facets)
  const packet: StructuredSynthesisPacket = {
    question: input.question,
    disposition,
    facets: input.facets.map((facetInput, index) => packetFacet(facetInput, facets[index])),
  }

  return {
    facets,
    disposition,
    dispositionReason,
    coveredFacetCount: facets.filter((facet) => facet.status === 'covered').length,
    partialFacetCount: facets.filter((facet) => facet.status === 'partially-covered').length,
    unsupportedFacetCount: facets.filter((facet) => facet.status === 'unsupported').length,
    conflictedFacetCount: facets.filter((facet) => facet.status === 'conflicted').length,
    packet,
    providerCalled: false,
  }
}
