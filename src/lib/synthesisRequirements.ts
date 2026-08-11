import type {
  DiscoveredFacet,
  FacetDiscoveryChunk,
  FacetDiscoveryResult,
  FacetEvidenceObligation,
  FacetObligationKind,
} from './facetDiscovery.ts'
import type { QueryScopeDecision } from './synthesisScope.ts'
import { readRequestedPeriods } from './temporalResolution.ts'
import type { SearchResult } from '../types.ts'
import type { UnionCandidate } from './reranker.ts'

export type SynthesisRequirementKind =
  | 'fact'
  | 'current-state'
  | 'comparison-cell'
  | 'history'
  | 'exception'
  | 'negative-status'
  | 'aggregate'

export interface SynthesisRequirement {
  id: string
  facetId: string
  subject: string
  dimension: string | null
  kind: SynthesisRequirementKind
  evidenceKind: FacetObligationKind
  /** Candidate witnesses derived from the discovered facet/corpus structure. */
  sourceChunkIds: string[]
  required: boolean
  critical: boolean
  reason: string
}

export interface SynthesisRequirementPlan {
  mode: 'state' | 'comparison' | 'chronology' | 'exception' | 'negative-status' | 'aggregate'
  signals: string[]
  requirements: SynthesisRequirement[]
}

export interface PlannedSynthesisFacet {
  facet: DiscoveredFacet
  requirements: SynthesisRequirement[]
  required: boolean
  critical: boolean
}

const DIMENSIONS: Array<{ id: string; pattern: RegExp }> = [
  { id: 'pricing', pattern: /\b(?:price|prices|pricing|cost|costs|fee|fees|rate|rates)\b/i },
  { id: 'member-count', pattern: /\b(?:member|membership|account|user)\s+(?:count|number)|\b(?:exact\s+)?(?:member|membership)\s+(?:count|number)|\bnumber\s+of\b.{0,40}\b(?:members?|memberships?|accounts?|users?)\b/i },
  { id: 'average-expenditure', pattern: /\b(?:average|mean)\b.{0,30}\b(?:expenditure|spend|spending|cost)\b/i },
  { id: 'eligibility', pattern: /\b(?:eligible|eligibility|qualify|qualifies|qualified)\b/i },
  { id: 'allowance', pattern: /\b(?:allowance|allowances|included|quota|entitlement)\b/i },
  { id: 'exception', pattern: /\b(?:exception|exceptions|limitation|limitations|special)\b/i },
  { id: 'threshold', pattern: /\bthresholds?\b/i },
]

const TYPE_LANGUAGE = /\b(?:membership|memberships|category|categories|product|products|plan|plans|tier|tiers|option|options)\b/i
// Unit-bearing product descriptions are not automatically named benefits.
// Benefits are structurally marked by benefit/policy/exception language.
const NON_TYPE_LANGUAGE = /\b(?:benefit|benefits|rule|rules|policy|policies|exception|exceptions|allowance|allowances)\b/i

const SOURCE_DIMENSION_PATTERNS: Record<string, RegExp> = {
  pricing: /\b(?:price|pricing|cost|costs|fee|fees|rate|rates|paid|subscription)\b/i,
  eligibility: /\b(?:launch|initial(?:ly)?|eligible|qualif(?:y|ied|ies)|available|apply|appl(?:y|ied|ies))\b/i,
  allowance: /\b(?:allowance|included|unlimited|quota|entitlement)\b/i,
  benefit: /\b(?:benefit|discount|discounted|reduction|reduced|rebate)\b/i,
  exception: /\b(?:except|exception|only|special|limitation)\b/i,
}

const CORPUS_COMPARISON_DIMENSIONS = Object.keys(SOURCE_DIMENSION_PATTERNS)

const unique = <T>(values: T[]) => [...new Set(values)]
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const relatedTextOf = (facet: DiscoveredFacet, chunks: readonly FacetDiscoveryChunk[]) => {
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk.text]))
  return facet.chunkIds.map((chunkId) => byId.get(chunkId) ?? '').join(' ')
}

const requestedDimensions = (question: string) => DIMENSIONS
  .filter(({ pattern }) => pattern.test(question))
  .map(({ id }) => id)

const expandYearRange = (question: string) => {
  const years = [...question.matchAll(/\b(19|20)(\d{2})\b/g)].map((match) => Number(`${match[1]}${match[2]}`))
  const distinct = unique(years).sort((left, right) => left - right)
  if (distinct.length < 2 || !/\b(?:from|between)\b/i.test(question)) return distinct.map(String)
  const output: number[] = []
  const firstYear = distinct[0] ?? 0
  const lastYear = distinct.at(-1) ?? firstYear
  for (let year = firstYear; year <= lastYear; year += 1) output.push(year)
  return output.map(String)
}

const requirementKindFor = (obligationKind: FacetObligationKind): SynthesisRequirementKind => {
  if (obligationKind === 'current-state') return 'current-state'
  if (obligationKind === 'exception') return 'exception'
  if (obligationKind === 'change-status') return 'negative-status'
  return 'fact'
}

const sourceKindForDimension = (dimension: string): { kind: SynthesisRequirementKind; evidenceKind: FacetObligationKind } => {
  if (dimension === 'exception') return { kind: 'exception', evidenceKind: 'exception' }
  if (dimension === 'member-count' || dimension === 'average-expenditure') return { kind: 'aggregate', evidenceKind: 'current-state' }
  if (dimension === 'pricing' || dimension === 'threshold') return { kind: 'comparison-cell', evidenceKind: 'current-state' }
  if (dimension === 'eligibility' || dimension === 'allowance' || dimension === 'benefit') return { kind: 'comparison-cell', evidenceKind: 'applicability' }
  return { kind: 'comparison-cell', evidenceKind: 'definition' }
}

const hasObligationKind = (facet: DiscoveredFacet, kind: FacetObligationKind) => facet.evidenceObligations.some((obligation) => obligation.kind === kind)

const makeRequirement = (
  facet: DiscoveredFacet,
  kind: SynthesisRequirementKind,
  dimension: string | null,
  evidenceKind: FacetObligationKind,
  reason: string,
  critical = true,
  options: { required?: boolean; sourceChunkIds?: string[] } = {},
): SynthesisRequirement => ({
  id: `${facet.id}:${kind}:${dimension ?? evidenceKind}`,
  facetId: facet.id,
  subject: facet.normalizedSubject,
  dimension,
  kind,
  evidenceKind,
  sourceChunkIds: unique(options.sourceChunkIds ?? []),
  required: options.required ?? true,
  critical,
  reason,
})

const sourceChunkIdsFor = (facet: DiscoveredFacet, evidenceKind: FacetObligationKind) => {
  const direct = unique(
    facet.evidenceObligations
      .filter((obligation) => obligation.kind === evidenceKind)
      .flatMap((obligation) => obligation.chunkIds),
  )
  // An explicit entity may have been discovered from corpus occurrences before
  // a sentence-level definition signal was attached. Its own discovered chunk
  // set is still a generic definition witness.
  return evidenceKind === 'definition' ? unique([...direct, ...facet.chunkIds]) : direct
}

const sourceChunkIdsForDimension = (
  facet: DiscoveredFacet,
  dimension: string,
  chunks: readonly FacetDiscoveryChunk[],
  evidenceKind: FacetObligationKind,
) => {
  const pattern = SOURCE_DIMENSION_PATTERNS[dimension]
  const textById = new Map(chunks.map((chunk) => [chunk.id, chunk.text]))
  let matched = pattern
    ? facet.chunkIds.filter((chunkId) => pattern.test(textById.get(chunkId) ?? ''))
    : []
  if (dimension === 'eligibility') {
    const launchPattern = /\b(?:launch|initial(?:ly)?|original announcement|at launch)\b/i
    const launchMatched = facet.chunkIds.filter((chunkId) => launchPattern.test(textById.get(chunkId) ?? ''))
    if (launchMatched.length) matched = launchMatched
  }
  const facetTerms = facet.label
    .toLocaleLowerCase('en')
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3 && !['the', 'and', 'with', 'for'].includes(term))
  const recencyScore = (text: string) => Math.max(...[...text.matchAll(/\b20\d{2}\b/g)].map((match) => Number(match[0])), 0)
  const currentScore = (text: string) => {
    if (/\b(?:proposed|unapproved|not\s+approved|never\s+approved|budget\s+scenario|pilot|discussion[- ]only)\b/i.test(text)) return -3
    return /\b(?:current|currently|approved|permanent|remains?|unchanged|revision|revised|by\s+August)\b/i.test(text) ? 2 : 0
  }
  const scored = matched
    .map((chunkId) => {
      const text = textById.get(chunkId) ?? ''
      const subjectScore = facetTerms.filter((term) => new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(text)).length
      const patternScore = pattern ? [...text.matchAll(new RegExp(pattern.source, 'gi'))].length : 0
      return { chunkId, score: subjectScore * 10 + patternScore * 3 + currentScore(text) + recencyScore(text) / 100000 }
    })
    .sort((left, right) => right.score - left.score || left.chunkId.localeCompare(right.chunkId))
  return scored.length ? [scored[0].chunkId] : sourceChunkIdsFor(facet, evidenceKind)
}

const requirementsFromExistingObligations = (
  facet: DiscoveredFacet,
  reason: string,
  required = true,
) => {
  const kinds = unique(facet.evidenceObligations.map((obligation) => obligation.kind))
  if (!kinds.length) {
    return [makeRequirement(facet, 'fact', null, 'definition', reason, required, {
      required,
      sourceChunkIds: sourceChunkIdsFor(facet, 'definition'),
    })]
  }
  return kinds.map((kind) => makeRequirement(
    facet,
    requirementKindFor(kind),
    kind,
    kind,
    reason,
    required,
    { required, sourceChunkIds: sourceChunkIdsFor(facet, kind) },
  ))
}

const membershipFacets = (discovery: FacetDiscoveryResult, chunks: readonly FacetDiscoveryChunk[]) => {
  const candidates = discovery.selected.filter((facet) => {
    if (facet.kind === 'category' || facet.kind === 'comparison-entity') return true
    if (facet.kind !== 'named-policy-or-benefit') return false
    const relatedText = relatedTextOf(facet, chunks)
    return TYPE_LANGUAGE.test(relatedText) && !NON_TYPE_LANGUAGE.test(relatedText.replace(/\b(?:product|products)\b/gi, ''))
  })
  if (candidates.length) return candidates
  return discovery.selected.filter((facet) => facet.kind === 'category' || facet.kind === 'comparison-entity')
}

const stateRequirements = (discovery: FacetDiscoveryResult) => discovery.selected.flatMap((facet) => (
  requirementsFromExistingObligations(facet, 'one obligation per discovered facet evidence dimension for broad state synthesis')
))

const comparisonSupportFacets = (discovery: FacetDiscoveryResult) => discovery.rejected.filter((facet) => (
  facet.rejectionReason === 'outside_explicit_comparison'
  && (
    facet.kind === 'named-policy-or-benefit'
    || facet.kind === 'scoped-exception'
    || facet.kind === 'recurring-policy-dimension'
    || facet.kind === 'exception-collection'
  )
))

const derivedComparisonDimensions = (
  facets: readonly DiscoveredFacet[],
  chunks: readonly FacetDiscoveryChunk[],
) => CORPUS_COMPARISON_DIMENSIONS.filter((dimension) => {
  const pattern = SOURCE_DIMENSION_PATTERNS[dimension]
  const occurrences = facets.filter((facet) => facet.chunkIds.some((chunkId) => {
    const chunk = chunks.find((candidate) => candidate.id === chunkId)
    return Boolean(chunk && pattern.test(chunk.text))
  })).length
  // A comparison dimension should be shared by more than one entity; this
  // avoids turning a one-off incidental phrase into a matrix column.
  return occurrences >= Math.min(2, facets.length)
})

const comparisonRequirements = (
  question: string,
  discovery: FacetDiscoveryResult,
  chunks: readonly FacetDiscoveryChunk[],
) => {
  const dimensions = requestedDimensions(question)
  const support = comparisonSupportFacets(discovery)
  const selectedIds = new Set(discovery.selected.map((facet) => facet.id))
  const comparisonFacets = [...discovery.selected, ...support]
  return comparisonFacets.flatMap((facet) => {
    const derivedDimensions = dimensions.length
      ? dimensions.filter((dimension) => !['member-count', 'average-expenditure'].includes(dimension))
      : derivedComparisonDimensions(discovery.selected, chunks)
    if (!derivedDimensions.length) {
      return requirementsFromExistingObligations(
        facet,
        'comparison dimensions derived from the discovered facet evidence obligations',
        selectedIds.has(facet.id),
      )
    }
    return derivedDimensions.map((dimension) => {
      const source = sourceKindForDimension(dimension)
      return makeRequirement(
        facet,
        source.kind,
        dimension,
        source.evidenceKind,
        dimensions.length
          ? 'comparison dimension derived from explicit query language'
          : 'comparison dimension derived from recurring corpus structure across entities',
        selectedIds.has(facet.id),
        {
          required: selectedIds.has(facet.id),
          sourceChunkIds: sourceChunkIdsForDimension(facet, dimension, chunks, source.evidenceKind),
        },
      )
    })
  })
}

const historicalEvidenceKind = (facet: DiscoveredFacet): FacetObligationKind => (
  (['change-status', 'current-state', 'applicability', 'exception', 'definition'] as FacetObligationKind[])
    .find((kind) => hasObligationKind(facet, kind)) ?? 'definition'
)

const inactiveSupportFacets = (discovery: FacetDiscoveryResult) => discovery.rejected.filter((facet) => (
  facet.signals.includes('deprecation_or_replacement')
  || facet.rejectionReason === 'inactive_or_proposed_covered_by_composite'
))

const chronologyRequirements = (question: string, discovery: FacetDiscoveryResult) => {
  const periods = unique([
    ...readRequestedPeriods(question).found,
    ...expandYearRange(question),
  ])
  const periodLabels = periods.length ? periods : ['requested historical periods']
  const selectedIds = new Set(discovery.selected.map((facet) => facet.id))
  const facets = [...discovery.selected, ...inactiveSupportFacets(discovery)]
  return facets.flatMap((facet) => periodLabels.map((period) => {
    const evidenceKind = historicalEvidenceKind(facet)
    const required = selectedIds.has(facet.id)
    return makeRequirement(
    facet,
    'history',
    period,
    evidenceKind,
    'historical requirement derived from the question time range and discovered facet structure',
    required,
    { required, sourceChunkIds: sourceChunkIdsFor(facet, evidenceKind) },
  )
  }))
}

const exceptionRequirements = (discovery: FacetDiscoveryResult) => discovery.selected
  .filter((facet) => facet.kind === 'exception-collection' || facet.kind === 'scoped-exception' || hasObligationKind(facet, 'exception'))
  .map((facet) => makeRequirement(
    facet,
    'exception',
    'exception',
    'exception',
    'exception obligation derived from corpus exception/limitation structure',
  ))

const negativeRequirements = (discovery: FacetDiscoveryResult) => {
  const selectedIds = new Set(discovery.selected.map((facet) => facet.id))
  const facets = [...discovery.selected, ...inactiveSupportFacets(discovery)]
  return facets
  .filter((facet) => facet.kind === 'inactive-collection' || hasObligationKind(facet, 'change-status') || inactiveSupportFacets(discovery).some((candidate) => candidate.id === facet.id))
  .map((facet) => {
    const evidenceKind = historicalEvidenceKind(facet)
    const required = selectedIds.has(facet.id)
    return makeRequirement(
    facet,
    'negative-status',
    'current-status-exclusion',
    evidenceKind,
    'negative-status obligation derived from proposed, ended, or replacement structure',
    required,
    { required, sourceChunkIds: sourceChunkIdsFor(facet, evidenceKind) },
  )
  })
}

const aggregateRequirements = (question: string, discovery: FacetDiscoveryResult, chunks: readonly FacetDiscoveryChunk[]) => {
  const dimensions = requestedDimensions(question).filter((dimension) => dimension === 'member-count' || dimension === 'average-expenditure')
  const metrics = dimensions.length ? dimensions : ['member-count', 'average-expenditure']
  return membershipFacets(discovery, chunks).flatMap((facet) => metrics.map((dimension) => makeRequirement(
    facet,
    'aggregate',
    dimension,
    'current-state',
    'aggregate metric obligation derived from requested metric language and discovered membership-type structure',
  )))
}

const planModeFor = (question: string, scopeDecision: QueryScopeDecision): SynthesisRequirementPlan['mode'] => {
  if (scopeDecision.signals.some((signal) => signal.startsWith('narrow_dimension:count') || signal.startsWith('narrow_dimension:expenditure'))) return 'aggregate'
  if (scopeDecision.reason === 'multi_entity_comparison') return 'comparison'
  if (scopeDecision.reason === 'broad_chronology') return 'chronology'
  if (/\b(?:important|major|main)\s+exceptions?\b|\bwhat\s+exceptions\b/i.test(question)) return 'exception'
  if (/\b(?:proposed|mistaken|discussed|rejected|obsolete|not current)\b/i.test(question) && !/\bsummari[sz]e\b/i.test(question)) return 'negative-status'
  return 'state'
}

/**
 * Derive answer obligations from query shape and evidence-derived facets.
 * Evaluation fixtures and expected propositions are deliberately outside this
 * module: this is the runtime contract that tells coverage what the question
 * asks Tracework to establish.
 */
export const deriveSynthesisRequirements = (
  question: string,
  scopeDecision: QueryScopeDecision,
  discovery: FacetDiscoveryResult,
  chunks: readonly FacetDiscoveryChunk[] = [],
): SynthesisRequirementPlan => {
  const mode = planModeFor(question, scopeDecision)
  const requirements = mode === 'aggregate'
    ? aggregateRequirements(question, discovery, chunks)
    : mode === 'comparison'
      ? comparisonRequirements(question, discovery, chunks)
      : mode === 'chronology'
        ? chronologyRequirements(question, discovery)
        : mode === 'exception'
          ? exceptionRequirements(discovery)
          : mode === 'negative-status'
            ? negativeRequirements(discovery)
            : stateRequirements(discovery)

  return {
    mode,
    signals: [...scopeDecision.signals, `requirement_mode:${mode}`, `requirement_count:${requirements.length}`],
    requirements,
  }
}

const comparisonContextTerms = (discovery: FacetDiscoveryResult) => unique(
  discovery.rejected
    .filter((facet) => (
      facet.rejectionReason === 'outside_explicit_comparison'
      && (facet.kind === 'named-policy-or-benefit' || facet.kind === 'scoped-exception' || facet.kind === 'recurring-policy-dimension')
    ))
    .map((facet) => facet.label),
)

/** Convert planner requirements into the evidence-obligation shape consumed by retrieval/reasoning. */
export const materializeSynthesisFacets = (
  discovery: FacetDiscoveryResult,
  plan: SynthesisRequirementPlan,
): PlannedSynthesisFacet[] => {
  const requirementsByFacet = new Map<string, SynthesisRequirement[]>()
  plan.requirements.forEach((requirement) => requirementsByFacet.set(requirement.facetId, [
    ...(requirementsByFacet.get(requirement.facetId) ?? []),
    requirement,
  ]))

  const runtimeFacets = [...discovery.selected, ...discovery.rejected.filter((facet) => requirementsByFacet.has(facet.id))]
    .filter((facet, index, all) => all.findIndex((candidate) => candidate.id === facet.id) === index)

  return runtimeFacets.flatMap((facet) => {
    const requirements = requirementsByFacet.get(facet.id) ?? []
    if (!requirements.length) return []
    const sharedComparisonTerms = plan.mode === 'comparison' ? comparisonContextTerms(discovery) : []
    const evidenceObligations: FacetEvidenceObligation[] = requirements.map((requirement) => ({
      id: requirement.id,
      kind: requirement.evidenceKind,
      description: `${facet.label}: ${plan.mode === 'negative-status' ? 'establish that the requested status is not current' : requirement.dimension ?? requirement.kind}`,
      // Aggregate metrics deliberately begin without a witness. Other kinds
      // inherit generic evidence pointers from discovery, then the runtime
      // binds them to the Step 6 union after per-facet retrieval.
      chunkIds: requirement.kind === 'aggregate'
        ? []
        : unique([
          ...requirement.sourceChunkIds,
          ...sourceChunkIdsFor(facet, requirement.evidenceKind),
        ]),
    }))
    return [{
      facet: {
        ...facet,
        aliases: unique([...facet.aliases, ...sharedComparisonTerms]),
        evidenceObligations,
      },
      requirements,
      required: requirements.some((requirement) => requirement.required),
      critical: requirements.some((requirement) => requirement.critical),
    }]
  })
}

const resultsOf = (candidates: UnionCandidate[] | SearchResult[]) => candidates.map((candidate) => (
  'result' in candidate ? candidate.result : candidate
))

/** Keep only declared witnesses that the actual Step 6 union found. */
export const bindRequirementWitnesses = (
  facet: DiscoveredFacet,
  candidates: UnionCandidate[] | SearchResult[],
  selectedCandidates: SearchResult[] = [],
): DiscoveredFacet => {
  const unionIds = new Set(resultsOf(candidates).map((result) => result.chunk.id))
  const selectedIds = new Set(selectedCandidates.map((result) => result.chunk.id))
  return {
    ...facet,
    evidenceObligations: facet.evidenceObligations.map((obligation) => {
      const available = obligation.chunkIds.filter((chunkId) => unionIds.has(chunkId))
      if (!selectedIds.size) return { ...obligation, chunkIds: available }
      const unselected = available.filter((chunkId) => !selectedIds.has(chunkId))
      return {
        ...obligation,
        // Prefer a small set of declared witnesses that coverage/pruning did
        // not already select. Step 7 can then restore targeted union evidence
        // without inspecting the answer key or replacing context with the
        // whole union. Two witnesses preserve minority evidence when one
        // obligation spans both a general rule and an exception.
        chunkIds: (unselected.length ? unselected : available).slice(0, 2),
      }
    }),
  }
}
