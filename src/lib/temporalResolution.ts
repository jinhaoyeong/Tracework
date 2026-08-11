import type { NormalizedClaim, TemporalNormalization } from './temporalNormalization.ts'

/**
 * Phase 5D step 6: resolve temporal claims at an injected reference period.
 *
 * This is deliberately separate from extraction, normalization, and Phase 5C
 * adjudication. It may remove an older claim from the set applicable at a
 * requested time when the corpus carries an explicit temporal boundary, but it
 * never deletes that claim from the derived evidence.
 */

export type TemporalResolutionStatus = 'resolved' | 'unresolved' | 'unassessed'

export interface TemporalResolutionOptions {
  /** Immutable call-site input. This function never reads the wall clock. */
  asOf: string
  /** A question-scoped period such as `2024` or `2027-02`. */
  requestedPeriod?: string | null
}

export interface TemporalReference {
  input: string
  key: number
  precision: 'year' | 'month' | 'day'
}

export interface TemporalBoundary {
  supersedingClaimId: string
  supersededClaimId: string
  startsAt: string
  startsAtKey: number
  sentence: string
  kind: 'supersession' | 'explicit-start'
  reason: string
}

export interface TemporalClaimAssessment {
  claim: NormalizedClaim
  state: 'applicable' | 'future' | 'historical' | 'undated' | 'superseded' | 'outside-period'
  reason: string
  effectiveUntil: string | null
}

export interface TemporalResolution {
  question: string
  asOf: string
  requestedPeriod: string | null
  reference: TemporalReference | null
  status: TemporalResolutionStatus
  subjectKey: string | null
  assessments: TemporalClaimAssessment[]
  applicableClaims: NormalizedClaim[]
  resolvedClaims: NormalizedClaim[]
  resolvedValue: string | null
  boundaries: TemporalBoundary[]
  phase5cRequired: boolean
  notice: string
}

const YEAR_PATTERN = /^(\d{4})$/
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/

const validMonth = (month: number) => month >= 1 && month <= 12
const validDay = (day: number) => day >= 1 && day <= 31

const periodKey = (year: number, month: number) => year * 100 + month

/**
 * Parse only the stable ISO-like periods used by the fixture contract. A
 * reference year is expanded to the end of that year because a question such
 * as "in 2024" asks for the version in force during that named period, not at
 * the first instant of January.
 */
export const parseTemporalReference = (value: string, yearAsEnd = false): TemporalReference | null => {
  const input = value.trim()
  const year = input.match(YEAR_PATTERN)
  if (year) {
    const numericYear = Number(year[1])
    return {
      input,
      key: periodKey(numericYear, yearAsEnd ? 12 : 1),
      precision: 'year',
    }
  }

  const month = input.match(MONTH_PATTERN)
  if (month) {
    const numericMonth = Number(month[2])
    if (!validMonth(numericMonth)) return null
    return { input, key: periodKey(Number(month[1]), numericMonth), precision: 'month' }
  }

  const day = input.match(DAY_PATTERN)
  if (!day) return null
  const numericMonth = Number(day[2])
  const numericDay = Number(day[3])
  if (!validMonth(numericMonth) || !validDay(numericDay)) return null
  return { input, key: periodKey(Number(day[1]), numericMonth), precision: 'day' }
}

const referenceFor = (options: TemporalResolutionOptions): { reference: TemporalReference | null; requestedPeriod: string | null } => {
  const requestedPeriod = options.requestedPeriod?.trim() || null
  const reference = requestedPeriod
    ? parseTemporalReference(requestedPeriod, true)
    : parseTemporalReference(options.asOf)
  return { reference, requestedPeriod }
}

const claimStart = (claim: NormalizedClaim) => claim.validFromKey

const claimEnd = (claim: NormalizedClaim) => {
  if (!claim.claim.validUntil) return null
  const parsed = parseTemporalReference(claim.claim.validUntil, true)
  return parsed?.key ?? null
}

const hasExplicitStartBoundary = (claim: NormalizedClaim) =>
  /\b(?:starting|effective)\b/i.test(claim.claim.sentence)

const uniqueByClaimId = (claims: NormalizedClaim[]) => claims.filter((claim, index, all) => (
  all.findIndex((candidate) => candidate.claimId === claim.claimId) === index
))

const valuesOf = (claims: NormalizedClaim[]) => new Set(claims.map((claim) => claim.claim.value))

const makeBoundary = (
  superseding: NormalizedClaim,
  superseded: NormalizedClaim,
  kind: TemporalBoundary['kind'],
  reason: string,
): TemporalBoundary | null => {
  const startsAtKey = claimStart(superseding)
  if (startsAtKey === null || !superseding.validFrom) return null
  return {
    supersedingClaimId: superseding.claimId,
    supersededClaimId: superseded.claimId,
    startsAt: superseding.validFrom,
    startsAtKey,
    sentence: superseding.claim.sentence,
    kind,
    reason,
  }
}

/**
 * Build only evidence-backed boundaries. A class supersession is already
 * subject-scoped by normalization. An explicit "Starting ..." sentence is a
 * temporal start boundary for the same normalized subject; it is not a hidden
 * recency score and does not resolve two claims that start in the same period.
 */
const buildBoundaries = (normalization: TemporalNormalization): TemporalBoundary[] => {
  const boundaries: TemporalBoundary[] = []
  const byId = new Map(normalization.claims.map((claim) => [claim.claimId, claim]))

  normalization.relations.forEach((relation) => {
    const superseding = byId.get(relation.supersedingClaimId)
    const superseded = byId.get(relation.supersededClaimId)
    if (!superseding || !superseded) return
    const boundary = makeBoundary(
      superseding,
      superseded,
      'supersession',
      `explicit supersession: ${relation.triggerSentence}`,
    )
    if (boundary) boundaries.push(boundary)
  })

  normalization.claims
    .filter((claim) => claim.status === 'normalized' && hasExplicitStartBoundary(claim))
    .forEach((superseding) => {
      normalization.claims
        .filter((superseded) => (
          superseded.claimId !== superseding.claimId
          && superseded.status === 'normalized'
          && superseded.subject?.key === superseding.subject?.key
          && superseded.validFromKey !== null
          && superseding.validFromKey !== null
          && superseded.validFromKey < superseding.validFromKey
        ))
        .forEach((superseded) => {
          const boundary = makeBoundary(
            superseding,
            superseded,
            'explicit-start',
            `explicit effective-date boundary in: ${superseding.claim.sentence}`,
          )
          if (boundary) boundaries.push(boundary)
        })
    })

  return boundaries.filter((boundary, index, all) => (
    all.findIndex((candidate) => (
      candidate.supersedingClaimId === boundary.supersedingClaimId
      && candidate.supersededClaimId === boundary.supersededClaimId
      && candidate.startsAtKey === boundary.startsAtKey
    )) === index
  ))
}

const effectiveUntilFor = (claim: NormalizedClaim, boundaries: TemporalBoundary[]) => {
  const closing = boundaries
    .filter((boundary) => boundary.supersededClaimId === claim.claimId)
    .sort((left, right) => left.startsAtKey - right.startsAtKey)[0]
  return closing?.startsAt ?? claim.claim.validUntil
}

const assessClaim = (
  claim: NormalizedClaim,
  reference: TemporalReference,
  boundaries: TemporalBoundary[],
): TemporalClaimAssessment => {
  const start = claimStart(claim)
  const explicitEnd = claimEnd(claim)
  const effectiveEnd = effectiveUntilFor(claim, boundaries)
  const closingBoundary = boundaries
    .filter((boundary) => boundary.supersededClaimId === claim.claimId)
    .sort((left, right) => left.startsAtKey - right.startsAtKey)[0]

  if (claim.historical) {
    return {
      claim,
      state: 'historical',
      reason: 'The claim is explicitly marked former, previous, or old and is not treated as current evidence.',
      effectiveUntil: effectiveEnd,
    }
  }

  if (start === null || !claim.validFrom) {
    return {
      claim,
      state: 'undated',
      reason: 'No parseable validity start was derived; this claim is never assumed current.',
      effectiveUntil: effectiveEnd,
    }
  }

  if (start > reference.key) {
    return {
      claim,
      state: 'future',
      reason: `The claim starts at ${claim.validFrom}, after the requested reference period ${reference.input}.`,
      effectiveUntil: effectiveEnd,
    }
  }

  if (explicitEnd !== null && reference.key > explicitEnd) {
    return {
      claim,
      state: 'outside-period',
      reason: `The reference period ${reference.input} is after the claim's explicit validity end ${claim.claim.validUntil}.`,
      effectiveUntil: effectiveEnd,
    }
  }

  if (closingBoundary && reference.key >= closingBoundary.startsAtKey) {
    return {
      claim,
      state: 'superseded',
      reason: `${closingBoundary.kind === 'supersession' ? 'Supersession' : 'An explicit effective-date boundary'} starts at ${closingBoundary.startsAt}.`,
      effectiveUntil: effectiveEnd,
    }
  }

  return {
    claim,
    state: 'applicable',
    reason: `The claim starts at ${claim.validFrom} and remains applicable at ${reference.input}.`,
    effectiveUntil: effectiveEnd,
  }
}

const invalidReferenceResult = (
  normalization: TemporalNormalization,
  options: TemporalResolutionOptions,
  requestedPeriod: string | null,
): TemporalResolution => ({
  question: normalization.question,
  asOf: options.asOf,
  requestedPeriod,
  reference: null,
  status: 'unassessed',
  subjectKey: null,
  assessments: [],
  applicableClaims: [],
  resolvedClaims: [],
  resolvedValue: null,
  boundaries: [],
  phase5cRequired: true,
  notice: `Temporal resolution requires a parseable ${requestedPeriod ? 'requested period' : 'asOf'}; no wall-clock fallback was used.`,
})

/**
 * Resolve one normalized extraction. This function intentionally does not
 * inspect provenance authority: authority is Phase 5C's separate tie-break
 * boundary, and two authoritative claims in the same period remain a hold.
 */
export const resolveTemporalNormalization = (
  normalization: TemporalNormalization,
  options: TemporalResolutionOptions,
): TemporalResolution => {
  const { reference, requestedPeriod } = referenceFor(options)
  if (!reference) return invalidReferenceResult(normalization, options, requestedPeriod)

  const boundaries = buildBoundaries(normalization)
  const assessments = normalization.claims.map((claim) => assessClaim(claim, reference, boundaries))
  const applicableClaims = uniqueByClaimId(assessments
    .filter((assessment) => assessment.state === 'applicable')
    .map((assessment) => assessment.claim))
  const undatedClaims = assessments
    .filter((assessment) => assessment.state === 'undated')
    .map((assessment) => assessment.claim)
  const unresolvedClaims = normalization.claims.filter((claim) => claim.status === 'unresolved' && !claim.historical)
  const subjectKeys = [...new Set(normalization.claims
    .filter((claim) => claim.status === 'normalized')
    .map((claim) => claim.subject?.key)
    .filter((key): key is string => Boolean(key)))]
  const subjectKey = subjectKeys.length === 1 ? subjectKeys[0] : null
  const applicableValues = valuesOf(applicableClaims)
  const undatedValues = valuesOf(undatedClaims)
  const relevantUndatedConflict = undatedClaims.length > 0
    && [...undatedValues].some((value) => !applicableValues.has(value))

  if (!applicableClaims.length || unresolvedClaims.length > 0) {
    const undatedMessage = undatedClaims.length
      ? 'Only undated claims remain; they are visible but cannot establish an applicable version.'
      : unresolvedClaims.length
        ? 'At least one extracted claim has an unestablished subject; temporal resolution will not guess which pricing scope it belongs to.'
        : 'No dated claim applies at the requested reference period.'
    return {
      question: normalization.question,
      asOf: options.asOf,
      requestedPeriod,
      reference,
      status: 'unassessed',
      subjectKey,
      assessments,
      applicableClaims,
      resolvedClaims: [],
      resolvedValue: null,
      boundaries,
      phase5cRequired: true,
      notice: undatedMessage,
    }
  }

  if (relevantUndatedConflict || normalization.unassessedReasons.length > 0 && undatedClaims.length > 0) {
    return {
      question: normalization.question,
      asOf: options.asOf,
      requestedPeriod,
      reference,
      status: 'unassessed',
      subjectKey,
      assessments,
      applicableClaims,
      resolvedClaims: [],
      resolvedValue: null,
      boundaries,
      phase5cRequired: true,
      notice: 'Temporal evidence includes a competing undated claim. Tracework will not assume it is current or silently discard it.',
    }
  }

  if (applicableValues.size > 1) {
    const values = [...applicableValues].join(' and ')
    return {
      question: normalization.question,
      asOf: options.asOf,
      requestedPeriod,
      reference,
      status: 'unresolved',
      subjectKey,
      assessments,
      applicableClaims,
      resolvedClaims: [],
      resolvedValue: null,
      boundaries,
      phase5cRequired: true,
      notice: `Multiple claims remain applicable at ${reference.input} (${values}); temporal evidence does not establish which value is correct, so Phase 5C must handle the disagreement.`,
    }
  }

  const resolvedValue = applicableClaims[0].claim.value
  const resolvedClaims = applicableClaims.filter((claim) => claim.claim.value === resolvedValue)
  return {
    question: normalization.question,
    asOf: options.asOf,
    requestedPeriod,
    reference,
    status: 'resolved',
    subjectKey,
    assessments,
    applicableClaims,
    resolvedClaims,
    resolvedValue,
    boundaries,
    phase5cRequired: false,
    notice: `Temporal evidence selects ${resolvedValue} at ${reference.input}; older claims remain in the evidence record for their own periods.`,
  }
}
