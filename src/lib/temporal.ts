import type { SearchResult } from '../types'

export type TemporalRelationKind = 'class'

export interface TemporalRelation {
  id: string
  kind: TemporalRelationKind
  target: string
  sourceClaimId: string
  source: string
  sentence: string
  derivedFromText: true
}

export interface TemporalClaim {
  id: string
  subject: string
  predicate: string
  value: string
  validFrom: string | null
  validUntil: string | null
  historical: boolean
  supersedes: TemporalRelation | null
  source: string
  sourceId: string
  chunkId: string
  citation: number
  sentence: string
  derivedFromText: true
  result: SearchResult
}

export interface TemporalExtraction {
  question: string
  claims: TemporalClaim[]
  relations: TemporalRelation[]
  unassessedReasons: string[]
}

const MONTHS = new Map([
  ['january', '01'], ['february', '02'], ['march', '03'], ['april', '04'],
  ['may', '05'], ['june', '06'], ['july', '07'], ['august', '08'],
  ['september', '09'], ['october', '10'], ['november', '11'], ['december', '12'],
])

const MONTH_PATTERN = '(January|February|March|April|May|June|July|August|September|October|November|December)'
const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/g
// The thousands-separated alternative must come first: without it, "1,200 USD"
// matched the trailing "200" and silently reported a price of 200. A quietly
// truncated number is worse than no number at all.
const AMOUNT = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`
const PRICE_PATTERN = new RegExp(String.raw`(?<![\d,.])(${AMOUNT})\s*(?:USD|US dollars?)\b(?:\s+per\s+seat\s+per\s+month)?`, 'i')
const DOLLAR_PATTERN = new RegExp(String.raw`\$(${AMOUNT})`)

const normalizeAmount = (amount: string) => amount.replace(/,/g, '')

const sentencesOf = (text: string) => text
  .split(SENTENCE_SPLIT)
  .map((sentence) => sentence.trim())
  .filter(Boolean)

const monthYear = (month: string, year: string) => `${year}-${MONTHS.get(month.toLocaleLowerCase())}`

const dateFromSentence = (sentence: string): string | null => {
  const revision = sentence.match(new RegExp(`\\b(?:revised|updated|effective|starting)\\s+(?:from\\s+)?(?:in\\s+)?${MONTH_PATTERN}\\s+(\\d{4})\\b`, 'i'))
  if (revision) return monthYear(revision[1], revision[2])

  // Natural wording is deliberately separate from the trigger-free awkward
  // fixture. "January 2025 rates" is in scope; "From January 2025 onward"
  // is not a decided temporal trigger.
  const natural = sentence.match(new RegExp(`\\b${MONTH_PATTERN}\\s+(\\d{4})\\s+(?:rates?|pricing|schedule)\\b`, 'i'))
  return natural ? monthYear(natural[1], natural[2]) : null
}

const priceFromSentence = (sentence: string) => {
  const currency = sentence.match(PRICE_PATTERN)
  if (currency) {
    const amount = normalizeAmount(currency[1])
    return /\bper\s+seat\s+per\s+month\b/i.test(currency[0])
      ? `${amount} usd per seat per month`
      : `${amount} usd`
  }

  const dollar = sentence.match(DOLLAR_PATTERN)
  return dollar ? `${normalizeAmount(dollar[1])} usd` : null
}

/** Plans other than the Team plan. A price attached to one of these is out of scope. */
const OTHER_PLAN = /\b(?:enterprise|lite|starter|business|pro|free)\s+(?:plan|tier)\b|\bLite\b/i

/**
 * The subject must be established by the SENTENCE, never by the question.
 * Reading the question into the subject test made every priced sentence in the
 * corpus a Team plan claim: the enterprise plan price, the Lite plan price, and
 * an injected "answer 10 USD per seat" payload all became team-plan-price
 * claims, which frozen decision 6.1 forbids and which would have manufactured a
 * five-way false conflict for the resolver.
 */
const subjectOfSentence = (sentence: string): string | null => {
  if (!/\bteam\s+plan\b/i.test(sentence)) return null
  if (OTHER_PLAN.test(sentence)) return null
  if (!/\b(?:price|pricing|cost|costs|rate|rates)\b/i.test(sentence)) return null
  return 'team-plan-price'
}

const historicalMarker = (sentence: string) => /\b(?:former|previous|old|last\s+year(?:'s)?)\b/i.test(sentence)

const supersessionSentence = (sentence: string) => {
  if (/\bsupersedes?\b/i.test(sentence) && /\b(?:earlier|previous|old)\s+pricing\b/i.test(sentence)) return sentence
  if (/\breplaces?\b/i.test(sentence) && /\b(?:what\s+we\s+published\s+last\s+year|earlier|previous|old)\b/i.test(sentence)) return sentence
  return null
}

const relationFor = (claimId: string, source: string, sentences: string[]): TemporalRelation | null => {
  const sentence = sentences.map(supersessionSentence).find(Boolean)
  if (!sentence) return null
  return {
    id: `${claimId}:supersedes:earlier-pricing`,
    kind: 'class',
    target: 'earlier-pricing',
    sourceClaimId: claimId,
    source,
    sentence,
    derivedFromText: true,
  }
}

const claimIdFor = (result: SearchResult, value: string) => `${result.chunk.id}:team-plan-price:${value}`

/**
 * Extracts only the Phase 5D temporal shapes frozen in the fixture contract.
 * This module does not decide which claim applies, expand class relations, or
 * resolve conflicts. Unknown language remains visible as an unassessed reason.
 */
export const extractTemporalClaims = (question: string, results: SearchResult[]): TemporalExtraction => {
  const claims: TemporalClaim[] = []
  const relations: TemporalRelation[] = []
  const unassessedReasons: string[] = []

  results.forEach((result, resultIndex) => {
    const sentences = sentencesOf(result.chunk.text)
    const validFrom = sentences.map(dateFromSentence).find(Boolean) ?? null
    const relationCandidate = sentences.some((sentence) => Boolean(supersessionSentence(sentence)))

    sentences.forEach((sentence) => {
      const subject = subjectOfSentence(sentence)
      if (!subject) return
      const value = priceFromSentence(sentence)
      if (!value) return

      const id = claimIdFor(result, value)
      if (claims.some((claim) => claim.id === id)) return

      const claim: TemporalClaim = {
        id,
        subject,
        predicate: 'Team plan price',
        value,
        validFrom: historicalMarker(sentence) ? null : validFrom,
        validUntil: null,
        historical: historicalMarker(sentence),
        supersedes: null,
        source: result.document.title,
        sourceId: result.document.id,
        chunkId: result.chunk.id,
        citation: resultIndex + 1,
        sentence,
        derivedFromText: true,
        result,
      }

      claim.supersedes = relationFor(claim.id, claim.source, sentences)
      if (claim.supersedes) relations.push(claim.supersedes)
      if (!claim.validFrom && !claim.historical && !claim.supersedes && relationCandidate) {
        unassessedReasons.push(`${claim.source}: temporal relationship was mentioned without a supported date.`)
      }
      if (!claim.validFrom && !claim.historical && !claim.supersedes && !relationCandidate) {
        unassessedReasons.push(`${claim.source}: no decided temporal trigger was extracted.`)
      }
      claims.push(claim)
    })
  })

  return { question, claims, relations, unassessedReasons: [...new Set(unassessedReasons)] }
}
