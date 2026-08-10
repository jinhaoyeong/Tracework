import type { TemporalClaim, TemporalExtraction } from './temporal.ts'

/**
 * Phase 5D step 5: normalisation and class-relation expansion.
 *
 * A separate boundary from extraction on purpose. Extraction answers "what does
 * this passage explicitly state?"; normalisation answers "what structured
 * relationship does that imply, and is it safe to assert?". Extraction success
 * does not imply expansion success: a recognised "supersedes" trigger still has
 * to prove its target shares a subject before it may invalidate anything.
 *
 * This module does not resolve applicability, does not read a clock, and does
 * not decide which claim answers a question. That is step 6.
 */

/**
 * The frozen subject dimensions. Two prices are the same subject only when all
 * four agree — being prices is not enough. Collapsing them would let a sentence
 * about a monthly subscription invalidate a one-time fee.
 */
export interface NormalizedSubject {
  plan: string
  currency: string
  unit: string
  scope: string
  key: string
}

export interface NormalizedClaim {
  claimId: string
  claim: TemporalClaim
  subject: NormalizedSubject | null
  amount: number | null
  validFrom: string | null
  /** Sortable form of validFrom; null when undated. */
  validFromKey: number | null
  historical: boolean
  status: 'normalized' | 'unresolved'
  reason: string | null
}

export interface ExpandedRelation {
  supersedingClaimId: string
  supersededClaimId: string
  subjectKey: string
  triggerSentence: string
  supersedingSource: string
  supersededSource: string
  supersedingValue: string
  supersededValue: string
  reason: string
  derivedFromText: true
}

export interface TemporalNormalization {
  question: string
  claims: NormalizedClaim[]
  relations: ExpandedRelation[]
  unresolved: Array<{ claimId: string; source: string; reason: string }>
}

const UNIT_PER_SEAT_MONTH = 'per-seat-per-month'
const UNIT_PER_MONTH = 'per-month'
const SCOPE_SUBSCRIPTION = 'subscription'
const SCOPE_ONE_TIME = 'one-time'

const unitOf = (claim: TemporalClaim): string | null => {
  if (/per seat per month/.test(claim.value)) return UNIT_PER_SEAT_MONTH
  if (/\bper\s+seat\s+per\s+month\b/i.test(claim.sentence)) return UNIT_PER_SEAT_MONTH
  if (/\bper\s+month\b|\bmonthly\b/i.test(claim.sentence)) return UNIT_PER_MONTH
  return null
}

const scopeOf = (claim: TemporalClaim): string => (
  /\b(?:one[- ]time|installation|setup|onboarding)\s+fee\b/i.test(claim.sentence) ? SCOPE_ONE_TIME : SCOPE_SUBSCRIPTION
)

const planOf = (claim: TemporalClaim): string | null => (
  claim.subject === 'team-plan-price' ? 'team' : null
)

const currencyOf = (claim: TemporalClaim): string | null => (/\busd\b/i.test(claim.value) ? 'usd' : null)

const amountOf = (claim: TemporalClaim): number | null => {
  const match = claim.value.match(/^(\d+(?:\.\d+)?)\b/)
  return match ? Number(match[1]) : null
}

/**
 * Sortable key. A year-only date is treated as the start of that year, which is
 * a declared convention rather than an inference: "in 2024" sorts before
 * "March 2024" and both sort before "January 2025".
 */
export const temporalKey = (validFrom: string | null): number | null => {
  if (!validFrom) return null
  const match = validFrom.match(/^(\d{4})(?:-(\d{2}))?$/)
  if (!match) return null
  return Number(match[1]) * 100 + Number(match[2] ?? '00')
}

export const normalizeTemporalClaims = (extraction: TemporalExtraction): NormalizedClaim[] => (
  extraction.claims.map((claim) => {
    const plan = planOf(claim)
    const currency = currencyOf(claim)
    const unit = unitOf(claim)
    const scope = scopeOf(claim)

    // Any missing dimension leaves the subject unestablished. An unestablished
    // subject may neither supersede nor be superseded; guessing here is exactly
    // what frozen decision 6.1 forbids.
    const missing = [
      plan ? null : 'plan',
      currency ? null : 'currency',
      unit ? null : 'amount unit',
    ].filter(Boolean)

    const subject = missing.length ? null : {
      plan: plan as string,
      currency: currency as string,
      unit: unit as string,
      scope,
      key: `${plan}|${currency}|${unit}|${scope}`,
    }

    return {
      claimId: claim.id,
      claim,
      subject,
      amount: amountOf(claim),
      validFrom: claim.validFrom,
      validFromKey: temporalKey(claim.validFrom),
      historical: claim.historical,
      status: subject ? 'normalized' : 'unresolved',
      reason: subject ? null : `Subject could not be established safely: missing ${missing.join(', ')}.`,
    } satisfies NormalizedClaim
  })
)

/**
 * Expands a class trigger such as "supersedes all earlier pricing" into concrete
 * claim-to-claim relations. `earlier-pricing` is never a wildcard: an older
 * price qualifies only when it shares the normalised subject and is strictly
 * earlier. Every expansion carries the original sentence and the reason the
 * target qualified, so the inspector can show the reach of one sentence.
 */
export const expandTemporalRelations = (claims: NormalizedClaim[]) => {
  const relations: ExpandedRelation[] = []
  const unresolved: TemporalNormalization['unresolved'] = []

  for (const candidate of claims) {
    const trigger = candidate.claim.supersedes
    if (!trigger) continue

    if (!candidate.subject) {
      unresolved.push({
        claimId: candidate.claimId,
        source: candidate.claim.source,
        reason: `Supersession language was found, but the superseding claim's subject is unestablished. ${candidate.reason ?? ''}`.trim(),
      })
      continue
    }

    if (candidate.validFromKey === null) {
      unresolved.push({
        claimId: candidate.claimId,
        source: candidate.claim.source,
        reason: 'Supersession language was found, but the superseding claim has no validity date to compare against.',
      })
      continue
    }

    const targets = claims.filter((other) => (
      other.claimId !== candidate.claimId
      && other.status === 'normalized'
      && other.subject?.key === candidate.subject?.key
      && other.validFromKey !== null
      && other.validFromKey < (candidate.validFromKey as number)
    ))

    if (!targets.length) {
      unresolved.push({
        claimId: candidate.claimId,
        source: candidate.claim.source,
        reason: `No earlier claim shares the normalized subject ${candidate.subject.key}, so "${trigger.target}" expands to nothing.`,
      })
      continue
    }

    for (const target of targets) {
      relations.push({
        supersedingClaimId: candidate.claimId,
        supersededClaimId: target.claimId,
        subjectKey: candidate.subject.key,
        triggerSentence: trigger.sentence,
        supersedingSource: candidate.claim.source,
        supersededSource: target.claim.source,
        supersedingValue: candidate.claim.value,
        supersededValue: target.claim.value,
        reason: `same normalized subject (${candidate.subject.key}) and strictly earlier validity (${target.validFrom} < ${candidate.validFrom})`,
        derivedFromText: true,
      })
    }
  }

  return { relations, unresolved }
}

export const normalizeTemporalExtraction = (extraction: TemporalExtraction): TemporalNormalization => {
  const claims = normalizeTemporalClaims(extraction)
  const { relations, unresolved } = expandTemporalRelations(claims)
  const subjectUnresolved = claims
    .filter((claim) => claim.status === 'unresolved')
    .map((claim) => ({ claimId: claim.claimId, source: claim.claim.source, reason: claim.reason as string }))

  return {
    question: extraction.question,
    claims,
    relations,
    unresolved: [...subjectUnresolved, ...unresolved],
  }
}
