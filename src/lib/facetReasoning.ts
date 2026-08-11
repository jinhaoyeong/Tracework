import type { SearchResult } from '../types.ts'
import type { DiscoveredFacet, FacetEvidenceObligation, FacetObligationKind } from './facetDiscovery.ts'
import type { UnionCandidate } from './reranker.ts'
import { tokenize } from './rag.ts'
import { extractTemporalClaims } from './temporal.ts'
import { normalizeTemporalExtraction } from './temporalNormalization.ts'
import {
  parseRequestedPeriod,
  readRequestedPeriods,
  resolveTemporalNormalization,
} from './temporalResolution.ts'
import {
  assessQueryRelevance,
  planTemporalCoverage,
  temporalGate,
} from './temporalCoverage.ts'
import type {
  TemporalClaimAssessment,
  TemporalHoldReason,
  TemporalResolution,
  TemporalResolutionStatus,
  TemporalDisposition,
  TemporalBoundary,
} from './temporalResolution.ts'
import {
  adjudicateEvidence,
  ensureConflictCoverage,
} from './adjudication.ts'
import type {
  AdjudicationStatus,
  EvidenceAdjudication,
  EvidenceConflict,
} from './adjudication.ts'
import type { NormalizedClaim } from './temporalNormalization.ts'

export type FacetUnionInput = UnionCandidate[] | SearchResult[]

export interface FacetReasoningInput {
  facet: DiscoveredFacet
  originalQuestion: string
  asOf: string
  requestedPeriod?: string | null
  unionCandidates: FacetUnionInput
  selectedCandidates: SearchResult[]
}

export type RestoredWitnessReason = 'temporal-witness' | 'conflict-witness' | 'obligation-witness'

export interface RestoredWitness {
  chunkId: string
  reason: RestoredWitnessReason
}

export interface FacetTemporalReasoning {
  status: TemporalResolutionStatus
  disposition: TemporalDisposition
  holdReason: TemporalHoldReason | null
  requestedPeriod: string | null
  applicableClaims: NormalizedClaim[]
  excludedClaims: TemporalClaimAssessment[]
  boundaries: TemporalBoundary[]
  unassessedReasons: string[]
  coverage: {
    complete: boolean
    admitted: string[]
    omitted: Array<{ chunkId: string; source: string }>
  }
  notice: string
}

export interface FacetProvenanceReasoning {
  status: AdjudicationStatus
  conflicts: EvidenceConflict[]
  sources: EvidenceAdjudication['sources']
  notice: string
  restoredChunkIds: string[]
}

/**
 * Phase 5E Step 7 output. This is intentionally a reasoning-input record, not
 * a facet coverage verdict. Step 8 owns covered/partial/unsupported/conflicted
 * status and the overall answer disposition.
 */
export interface FacetReasoningResult {
  facetId: string
  originalSelected: SearchResult[]
  reasoningContext: SearchResult[]
  restoredWitnesses: RestoredWitness[]
  temporal: FacetTemporalReasoning
  provenanceConflict: FacetProvenanceReasoning
  providerCalled: false
}

const OBLIGATION_TERMS: Record<FacetObligationKind, string[]> = {
  definition: ['introduced', 'called', 'known', 'category', 'membership', 'product', 'benefit'],
  'current-state': ['current', 'effective', 'approved', 'permanent', 'remains', 'in-force'],
  applicability: ['applies', 'applicable', 'eligible', 'qualify', 'available', 'included', 'receives'],
  exception: ['exception', 'except', 'only', 'unlimited', 'special', 'differs', 'without'],
  'change-status': ['changed', 'introduced', 'proposed', 'future', 'ended', 'replaced', 'superseded', 'pilot', 'rejected', 'obsolete'],
}

const STOP_WORDS = new Set([
  'establish', 'evidence', 'from', 'corpus', 'the', 'and', 'with', 'named', 'policy', 'or',
  'rules', 'rule', 'state', 'status', 'current', 'historical', 'applicable', 'exception',
])

const uniqueResults = (results: SearchResult[]) => results.filter((result, index, all) => (
  all.findIndex((candidate) => candidate.chunk.id === result.chunk.id) === index
))

const resultsOf = (candidates: FacetUnionInput): SearchResult[] => candidates.map((candidate) => (
  'result' in candidate ? candidate.result : candidate
))

const unionRankOf = (candidates: FacetUnionInput) => {
  const ranks = new Map<string, number>()
  candidates.forEach((candidate, index) => {
    const result = 'result' in candidate ? candidate.result : candidate
    ranks.set(result.chunk.id, 'unionRank' in candidate ? candidate.unionRank : index + 1)
  })
  return ranks
}

const normalized = (value: string) => value.toLocaleLowerCase('en').replace(/\s+/g, ' ').trim()

const facetIdentityTerms = (facet: DiscoveredFacet) => tokenize([
  facet.label,
  facet.normalizedSubject,
  ...facet.aliases,
].join(' '))

const obligationTerms = (obligation: FacetEvidenceObligation) => [
  ...OBLIGATION_TERMS[obligation.kind],
  ...tokenize(obligation.description).filter((term) => !STOP_WORDS.has(term)),
]

const overlap = (terms: Set<string>, text: string) => {
  const textTerms = new Set(tokenize(text))
  return [...terms].filter((term) => textTerms.has(term)).length
}

const phraseHit = (phrase: string, text: string) => {
  const compact = normalized(phrase)
  return compact.length > 2 && normalized(text).includes(compact) ? 1 : 0
}

const candidateScore = (
  facet: DiscoveredFacet,
  obligation: FacetEvidenceObligation,
  result: SearchResult,
) => {
  const identity = new Set(facetIdentityTerms(facet))
  const obligationVocabulary = new Set(obligationTerms(obligation))
  const identityHits = overlap(identity, `${result.document.title} ${result.chunk.text}`)
  const obligationHits = overlap(obligationVocabulary, result.chunk.text)
  const labelHit = phraseHit(facet.label, result.chunk.text)
  return identityHits * 3 + obligationHits + labelHit * 2
}

const selectedHasObligationSignal = (
  facet: DiscoveredFacet,
  obligation: FacetEvidenceObligation,
  selected: SearchResult[],
) => {
  if (!selected.length) return false
  const scores = selected.map((result) => candidateScore(facet, obligation, result))
  return Math.max(...scores) >= 3
}

const addRestoration = (
  context: SearchResult[],
  restored: RestoredWitness[],
  result: SearchResult,
  reason: RestoredWitnessReason,
) => {
  if (context.some((candidate) => candidate.chunk.id === result.chunk.id)) return false
  context.push(result)
  if (!restored.some((witness) => witness.chunkId === result.chunk.id && witness.reason === reason)) {
    restored.push({ chunkId: result.chunk.id, reason })
  }
  return true
}

const periodForFacet = (question: string, facet: DiscoveredFacet, explicit: string | null | undefined) => {
  if (explicit?.trim()) return explicit.trim()
  const facetPeriod = readRequestedPeriods(facet.label)
  if (facetPeriod.reason === 'single') return facetPeriod.period
  return parseRequestedPeriod(question)
}

const facetScopeQuestion = (facet: DiscoveredFacet) => [
  facet.label,
  facet.normalizedSubject,
  ...facet.aliases,
].join(' ')

const restoreDeclaredObligationWitness = (
  facet: DiscoveredFacet,
  obligation: FacetEvidenceObligation,
  union: SearchResult[],
  unionRanks: Map<string, number>,
  context: SearchResult[],
  restored: RestoredWitness[],
) => {
  const unionIds = new Set(union.map((result) => result.chunk.id))
  const absent = obligation.chunkIds.filter((chunkId) => !unionIds.has(chunkId))
  if (absent.length) {
    throw new Error(
      `Phase 5E Step 6 invariant violation: ${facet.id}/${obligation.id} requires union witness ${absent.join(', ')}`,
    )
  }

  const declared = obligation.chunkIds
    .map((chunkId) => union.find((result) => result.chunk.id === chunkId))
    .filter((result): result is SearchResult => Boolean(result))
    .sort((left, right) => (unionRanks.get(left.chunk.id) ?? Infinity) - (unionRanks.get(right.chunk.id) ?? Infinity))

  if (declared.some((result) => context.some((candidate) => candidate.chunk.id === result.chunk.id))) return
  const witness = declared[0]
  if (witness) addRestoration(context, restored, witness, 'obligation-witness')
}

const restoreInferredObligationWitness = (
  facet: DiscoveredFacet,
  obligation: FacetEvidenceObligation,
  union: SearchResult[],
  unionRanks: Map<string, number>,
  context: SearchResult[],
  restored: RestoredWitness[],
) => {
  if (selectedHasObligationSignal(facet, obligation, context)) return
  const candidates = union
    .filter((result) => !context.some((candidate) => candidate.chunk.id === result.chunk.id))
    .map((result) => ({ result, score: candidateScore(facet, obligation, result) }))
    .filter((candidate) => candidate.score >= 3)
    .sort((left, right) => right.score - left.score || (unionRanks.get(left.result.chunk.id) ?? Infinity) - (unionRanks.get(right.result.chunk.id) ?? Infinity))
  if (candidates[0]) addRestoration(context, restored, candidates[0].result, 'obligation-witness')
}

const restoreObligationWitnesses = (
  facet: DiscoveredFacet,
  union: SearchResult[],
  unionRanks: Map<string, number>,
  context: SearchResult[],
  restored: RestoredWitness[],
) => {
  facet.evidenceObligations.forEach((obligation) => {
    if (obligation.chunkIds.length) {
      restoreDeclaredObligationWitness(facet, obligation, union, unionRanks, context, restored)
    } else {
      restoreInferredObligationWitness(facet, obligation, union, unionRanks, context, restored)
    }
  })
}

const temporalReasoning = (
  question: string,
  facet: DiscoveredFacet,
  asOf: string,
  requestedPeriod: string | null,
  context: SearchResult[],
  coverage: ReturnType<typeof planTemporalCoverage>,
): FacetTemporalReasoning => {
  const temporalQuestion = `${question} ${facetScopeQuestion(facet)}`.trim()
  const extraction = extractTemporalClaims(temporalQuestion, context)
  const normalization = normalizeTemporalExtraction(extraction)
  const resolution: TemporalResolution = resolveTemporalNormalization(normalization, {
    asOf,
    requestedPeriod,
  })
  const relevance = assessQueryRelevance(temporalQuestion, resolution)
  const gate = temporalGate(resolution, coverage, relevance)

  return {
    status: resolution.status,
    disposition: gate.disposition,
    holdReason: gate.holdReason,
    requestedPeriod: resolution.requestedPeriod,
    applicableClaims: resolution.applicableClaims,
    excludedClaims: resolution.assessments.filter((assessment) => assessment.state !== 'applicable'),
    boundaries: resolution.boundaries,
    unassessedReasons: [
      ...normalization.unassessedReasons,
      ...normalization.unresolved.map((item) => item.reason),
    ],
    coverage: {
      complete: coverage.complete,
      admitted: coverage.admitted,
      omitted: coverage.omitted,
    },
    notice: resolution.notice,
  }
}

/**
 * Run temporal and provenance reasoning for one facet without deciding its
 * final evidence coverage. Step 6's union is the only reservoir; this adapter
 * never performs another retrieval and never calls a provider.
 */
export const reasonFacetEvidence = (input: FacetReasoningInput): FacetReasoningResult => {
  const union = uniqueResults(resultsOf(input.unionCandidates))
  const unionRanks = unionRankOf(input.unionCandidates)
  const originalSelected = uniqueResults(input.selectedCandidates)
  const context = [...originalSelected]
  const restoredWitnesses: RestoredWitness[] = []

  const temporalQuestion = `${input.originalQuestion} ${facetScopeQuestion(input.facet)}`.trim()
  const unionNormalization = normalizeTemporalExtraction(extractTemporalClaims(temporalQuestion, union))
  const temporalCoverage = planTemporalCoverage(unionNormalization, context)
  temporalCoverage.witnesses.forEach((witness) => {
    if (!union.some((candidate) => candidate.chunk.id === witness.chunk.id)) {
      throw new Error(`Phase 5E Step 6 invariant violation: temporal witness ${witness.chunk.id} is absent from the union`)
    }
    addRestoration(context, restoredWitnesses, witness, 'temporal-witness')
  })

  const provenanceScope = facetScopeQuestion(input.facet)
  const unionAdjudication = adjudicateEvidence(provenanceScope, union)
  const conflictContext = ensureConflictCoverage(
    unionAdjudication,
    context,
    undefined,
    new Set(temporalCoverage.admitted),
  )
  conflictContext.forEach((result) => {
    if (!context.some((candidate) => candidate.chunk.id === result.chunk.id)) {
      const reason = unionAdjudication.conflicts.some((conflict) => conflict.claims.some((claim) => claim.chunkId === result.chunk.id))
        ? 'conflict-witness'
        : null
      if (reason) addRestoration(context, restoredWitnesses, result, reason)
    }
  })

  restoreObligationWitnesses(input.facet, union, unionRanks, context, restoredWitnesses)

  const finalTemporal = temporalReasoning(
    input.originalQuestion,
    input.facet,
    input.asOf,
    periodForFacet(input.originalQuestion, input.facet, input.requestedPeriod),
    context,
    temporalCoverage,
  )
  const finalAdjudication = adjudicateEvidence(provenanceScope, context)

  return {
    facetId: input.facet.id,
    originalSelected,
    reasoningContext: uniqueResults(context),
    restoredWitnesses,
    temporal: finalTemporal,
    provenanceConflict: {
      status: finalAdjudication.status,
      conflicts: finalAdjudication.conflicts,
      sources: finalAdjudication.sources,
      notice: finalAdjudication.notice,
      restoredChunkIds: restoredWitnesses
        .filter((witness) => witness.reason === 'conflict-witness')
        .map((witness) => witness.chunkId),
    },
    providerCalled: false,
  }
}
