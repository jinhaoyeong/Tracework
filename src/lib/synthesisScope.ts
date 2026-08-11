export type QueryScopeMode = 'focused' | 'synthesis'

export type QueryScopeReason =
  | 'explicit_broad_summary'
  | 'multi_entity_comparison'
  | 'broad_chronology'
  | 'broad_inventory'
  | 'focused_single_subject'
  | 'focused_narrow_comparison'
  | 'focused_fact_question'

export interface QueryScopeDecision {
  mode: QueryScopeMode
  reason: QueryScopeReason
  signals: string[]
}

interface ComparisonShape {
  entityCount: number
  dimensionCount: number
}

const NARROW_DIMENSIONS: Array<{ id: string; pattern: RegExp }> = [
  { id: 'price', pattern: /\b(?:price|prices|pricing|cost|costs|fee|fees|rate|rates)\b/i },
  { id: 'threshold', pattern: /\bthresholds?\b/i },
  { id: 'eligibility', pattern: /\b(?:eligible|eligibility|qualify|qualifies|qualified)\b/i },
  { id: 'count', pattern: /\b(?:exact\s+)?(?:number|count)\b/i },
  { id: 'expenditure', pattern: /\b(?:average\s+)?(?:monthly\s+)?(?:expenditure|spend|spending)\b/i },
  { id: 'allowance', pattern: /\ballowances?\b/i },
]

const TRAILING_COMPARISON_DIMENSION = /\s+(?:price|prices|pricing|cost|costs|fee|fees|rate|rates|threshold|thresholds|eligibility|allowance|allowances|benefit|benefits)\s*$/i

const normalize = (question: string) => question
  .normalize('NFKC')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/\s+/g, ' ')
  .trim()

const listItemCount = (value: string) => value
  .split(/\s*,\s*|\s+and\s+|\s+versus\s+|\s+vs\.?\s+/i)
  .map((item) => item.trim())
  .filter(Boolean)
  .length

const extractComparisonShape = (question: string): ComparisonShape | null => {
  if (!/\bcompare\b/i.test(question)) return null

  const subjectMatch = question.match(/\bcompare\s+(.+?)(?=\s+(?:as\s+of|across|on|by|with\s+respect\s+to)\b|[?.!]|$)/i)
  if (!subjectMatch) return { entityCount: 0, dimensionCount: 0 }

  let subjectText = subjectMatch[1].trim()
  let dimensionCount = 0

  if (TRAILING_COMPARISON_DIMENSION.test(subjectText)) {
    subjectText = subjectText.replace(TRAILING_COMPARISON_DIMENSION, '').trim()
    dimensionCount = 1
  }

  const dimensionMatch = question.match(/\b(?:across|on|by|with\s+respect\s+to)\s+(.+?)(?=\s+as\s+of\b|[?.!]|$)/i)
  if (dimensionMatch) dimensionCount = Math.max(1, listItemCount(dimensionMatch[1]))

  return {
    entityCount: listItemCount(subjectText),
    dimensionCount,
  }
}

const detectNarrowDimensions = (question: string) => NARROW_DIMENSIONS
  .filter(({ pattern }) => pattern.test(question))
  .map(({ id }) => id)

const detectSummarySignal = (question: string) => {
  if (/\bsummari[sz]e\b/i.test(question)) return 'summary_language:summarise'
  if (/\boverview\b/i.test(question)) return 'summary_language:overview'
  if (/\bcurrent\s+state\s+of\b/i.test(question)) return 'summary_language:current_state'
  if (/\beverything\s+we\s+know\s+about\b/i.test(question)) return 'summary_language:everything_known'
  return null
}

const hasBroadChronology = (question: string) => {
  const changeLanguage = /\b(?:major|main)\b.{0,60}\b(?:policy\s+)?changes\b|\b(?:history|evolution)\s+of\b/i.test(question)
  const timeRange = /\b(?:from|between)\s+(?:19|20)\d{2}\b.{0,100}\b(?:through|to|and)\s+(?:[a-z]+\s+)?(?:19|20)\d{2}\b/i.test(question)
  return changeLanguage || timeRange
}

const detectBroadInventorySignal = (question: string) => {
  if (/\beverything\s+we\s+know\s+about\b/i.test(question)) return 'broad_inventory:everything_known'
  if (/\b(?:every|all)\b.{0,40}\b(?:membership\s+)?(?:type|types|plan|plans|policy|policies|rule|rules|benefit|benefits)\b/i.test(question)) return 'broad_inventory:all_items'
  if (/\b(?:important|major|main)\s+(?:exceptions|policies|rules|changes|features|benefits|plans)\b/i.test(question)) return 'broad_inventory:qualified_plural'
  if (/\b(?:what|which)\b.{0,60}\b(?:exceptions|rules|policies|membership\s+types)\b/i.test(question)) return 'broad_inventory:requested_plural'
  if (/\bgeneral\s+description\b/i.test(question)) return 'broad_inventory:general_description'
  return null
}

const decision = (mode: QueryScopeMode, reason: QueryScopeReason, signals: string[]): QueryScopeDecision => ({
  mode,
  reason,
  signals: [...new Set(signals)],
})

/**
 * Deterministic, provider-free classification of query breadth.
 *
 * This decides only whether a question should use focused QA or broad
 * synthesis. It does not discover facets, retrieve evidence, or determine
 * answerability. Broad wording is a signal rather than an absolute trigger:
 * one narrow dimension remains focused, and a two-entity/one-dimension
 * comparison remains focused.
 *
 * A dimensionless `summarise <named subject>` request initially routes to
 * synthesis because query text alone cannot establish whether the name denotes
 * a corpus-level topic or a narrow feature. Later evidence-derived discovery
 * may downgrade it. This initial classifier deliberately has no domain-specific
 * name list for making that semantic judgment.
 */
export const classifyQueryScope = (question: string): QueryScopeDecision => {
  const normalized = normalize(question)
  const signals: string[] = []
  const narrowDimensions = detectNarrowDimensions(normalized)
  narrowDimensions.forEach((item) => signals.push(`narrow_dimension:${item}`))

  const comparison = extractComparisonShape(normalized)
  if (comparison) {
    signals.push(`comparison_entities:${comparison.entityCount}`)
    signals.push(`comparison_dimensions:${comparison.dimensionCount}`)
    if (comparison.entityCount >= 3 || comparison.dimensionCount >= 2) {
      return decision('synthesis', 'multi_entity_comparison', signals)
    }
    return decision('focused', 'focused_narrow_comparison', signals)
  }

  if (hasBroadChronology(normalized)) {
    signals.push('chronology:major_changes_or_range')
    return decision('synthesis', 'broad_chronology', signals)
  }

  const broadInventorySignal = detectBroadInventorySignal(normalized)
  if (broadInventorySignal) {
    signals.push(broadInventorySignal)
    return decision('synthesis', 'broad_inventory', signals)
  }

  const summarySignal = detectSummarySignal(normalized)
  if (summarySignal) {
    signals.push(summarySignal)
    if (narrowDimensions.length === 1) {
      return decision('focused', 'focused_single_subject', signals)
    }
    return decision('synthesis', 'explicit_broad_summary', signals)
  }

  if (/\bmain\s+reasons?\b/i.test(normalized)) {
    signals.push('focused_language:main_reasons')
    return decision('focused', 'focused_single_subject', signals)
  }

  signals.push('question_shape:focused_fact')
  return decision('focused', 'focused_fact_question', signals)
}
