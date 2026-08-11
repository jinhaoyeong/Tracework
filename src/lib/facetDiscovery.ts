import type { QueryScopeDecision } from './synthesisScope'

export type FacetDiscoverySignal =
  | 'explicit_query_subject'
  | 'explicit_comparison_entity'
  | 'recurring_named_subject'
  | 'named_policy_or_benefit'
  | 'explicit_introduction'
  | 'exception_or_limitation'
  | 'state_change'
  | 'deprecation_or_replacement'
  | 'quantified_inventory'
  | 'recurring_policy_dimension'

export type FacetObligationKind = 'definition' | 'current-state' | 'applicability' | 'exception' | 'change-status'

export type FacetCandidateKind =
  | 'query-subject'
  | 'comparison-entity'
  | 'category'
  | 'named-policy-or-benefit'
  | 'recurring-policy-dimension'
  | 'scoped-exception'
  | 'exception-collection'
  | 'inactive-collection'

export interface FacetDiscoveryChunk {
  id: string
  text: string
  documentId?: string
  documentTitle: string
}

export interface FacetEvidenceObligation {
  id: string
  kind: FacetObligationKind
  description: string
  chunkIds: string[]
}

export interface DiscoveredFacetCandidate {
  id: string
  label: string
  kind: FacetCandidateKind
  normalizedSubject: string
  parentId: string | null
  aliases: string[]
  occurrenceCount: number
  chunkIds: string[]
  signals: FacetDiscoverySignal[]
  evidenceObligations: FacetEvidenceObligation[]
  confidence: number
  rejectionReason: string | null
}

export type DiscoveredFacet = DiscoveredFacetCandidate

export interface FacetDiscoveryResult {
  candidates: DiscoveredFacetCandidate[]
  selected: DiscoveredFacet[]
  rejected: DiscoveredFacetCandidate[]
  scopeRefinement: 'keep-focused' | 'keep-synthesis' | 'downgrade-to-focused'
}

interface CandidateAccumulator {
  id: string
  label: string
  kind: FacetCandidateKind
  normalizedSubject: string
  parentId: string | null
  aliases: Set<string>
  chunkIds: Set<string>
  signals: Set<FacetDiscoverySignal>
  obligationChunks: Map<FacetObligationKind, Set<string>>
  forceRejected: boolean
}

const DESCRIPTORS = /\s+(?:product|plan|programme|program|policy|rule|benefit|feature|membership|subscription|category)$/i
const INACTIVE_LANGUAGE = /\b(?:ended|replaced|not launched|never approved|discussion only|experimental|pilot|future proposal)\b/i
const CURRENT_LANGUAGE = /\b(?:current|currently|newly approved|available|remains|remained|in force|became permanent)\b/i
const EXCEPTION_LANGUAGE = /\b(?:except|exception|only|not literally universal|did not apply|did not qualify|unlimited|special arrangement|rather than)\b/i
const CHANGE_LANGUAGE = /\b(?:changed?|increased?|decreased?|introduced|ended|replaced?|superseded?|proposed?|approved|renewed|became permanent|from .+ onward)\b/i
const APPLICABILITY_LANGUAGE = /\b(?:appl(?:y|ied|ies|icable)|eligible|available|qualif(?:y|ied|ies)|included|receive[ds]?)\b/i

const normalizeText = (value: string) => value
  .normalize('NFKC')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/\s+/g, ' ')
  .trim()

const slugify = (value: string) => normalizeText(value)
  .toLocaleLowerCase('en')
  .replace(/['’]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const titleCase = (value: string) => value
  .split(/\s+/)
  .filter(Boolean)
  .map((word) => `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`)
  .join(' ')

const cleanLabel = (rawLabel: string, rootSubject: string | null) => {
  let label = normalizeText(rawLabel)
    .replace(/^(?:the|a|an|and)\s+/i, '')
    .replace(/[.,;:]+$/g, '')
    .replace(DESCRIPTORS, '')
    .trim()

  if (rootSubject) {
    const rootPattern = new RegExp(`^${rootSubject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i')
    if (rootPattern.test(label)) label = label.replace(rootPattern, '').trim()
  }
  return label
}

const sentenceList = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).map((item) => item.trim()).filter(Boolean)

const extractSummaryTarget = (question: string) => {
  const normalized = normalizeText(question)
  const match = normalized.match(/\b(?:summari[sz]e|overview\s+of|current\s+state\s+of|everything\s+we\s+know\s+about)\s+(.+?)(?=\s+as\s+(?:of|it\b)|\s+in\s+(?:19|20)\d{2}\b|[?.!]|$)/i)
  if (!match) return null
  return match[1].replace(/^(?:the|a|an)\s+/i, '').trim()
}

const extractComparisonEntities = (question: string) => {
  const match = normalizeText(question).match(/\bcompare\s+(.+?)(?=\s+(?:as\s+of|across|on|by|with\s+respect\s+to)\b|[?.!]|$)/i)
  if (!match) return []
  const subjectText = match[1]
    .replace(/\s+(?:price|prices|pricing|cost|costs|fee|fees|rate|rates|threshold|thresholds|eligibility|allowance|allowances|benefit|benefits)\s*$/i, '')
  return subjectText
    .split(/\s*,\s*|\s+and\s+|\s+versus\s+|\s+vs\.?\s+/i)
    .map((item) => item.trim())
    .filter(Boolean)
}

const splitInventory = (value: string) => value
  .split(/\s*,\s*|\s+and\s+/i)
  .map((item) => item.replace(/^(?:and|the|a|an)\s+/i, '').trim())
  .filter(Boolean)

const extractInventoryItems = (sentence: string) => {
  const colonList = sentence.match(/\b(?:categories|plans|products|types)\s*:\s*([^.;]+)/i)
  if (colonList) return splitInventory(colonList[1])
  const offeredList = sentence.match(/\b(?:offers?|provides?|includes?)\s+(.+?)\s+(?:memberships|plans|products|categories)\b/i)
  return offeredList ? splitInventory(offeredList[1]) : []
}

const NUMBER_WORD = '(?:\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|unlimited)'
const DIMENSION_STOP_WORDS = new Set(['a', 'an', 'the', 'local', 'monthly', 'active', 'normal', 'ordinary', 'additional'])
const QUANTITY_WORDS = new Set(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'])

const normalizeDimensionSubject = (value: string) => {
  const rawTokens = value.toLocaleLowerCase('en').split(/[-\s]+/).filter(Boolean)
  if (rawTokens.some((token) => QUANTITY_WORDS.has(token) || /^\d/.test(token))) return ''
  const tokens = rawTokens.filter((token) => !DIMENSION_STOP_WORDS.has(token))
  return tokens.at(-1) ?? ''
}

const extractPolicyDimensions = (text: string) => {
  const dimensions: string[] = []
  const quantifiedPattern = new RegExp(`\\b(?:includes?|included|receives?|received|allows?|allowed|provides?|provided)\\s+(?:(?:up to|at least|more than)\\s+)?${NUMBER_WORD}\\s+(?:included\\s+)?([a-z][a-z-]+)\\s+([a-z][a-z-]+)\\b`, 'gi')
  for (const match of text.matchAll(quantifiedPattern)) dimensions.push(normalizeDimensionSubject(match[1]))
  for (const match of text.matchAll(/\bunlimited\s+([a-z][a-z-]+)\s+([a-z][a-z-]+)\b/gi)) dimensions.push(normalizeDimensionSubject(match[1]))
  for (const match of text.matchAll(/\b([a-z][a-z-]+)\s+(?:allowance|quota|entitlement)\b/gi)) dimensions.push(normalizeDimensionSubject(match[1]))
  return dimensions.filter((item) => item.length >= 3)
}

const SCOPED_MODIFIER_STOP_WORDS = new Set([
  'all', 'and', 'any', 'because', 'current', 'eligible', 'fixed', 'for', 'march', 'most', 'normal',
  'ordinary', 'other', 'registered', 'the', 'under', 'unused', 'while',
])
const modifierKey = (value: string) => value
  .toLocaleLowerCase('en')
  .split(/[-\s]+/)
  .filter(Boolean)
  .map((token) => token.slice(0, 5))
  .join('-')

const documentTarget = (target: string | null, chunks: readonly FacetDiscoveryChunk[]) => {
  if (!target) return false
  const targetSlug = slugify(target)
  return chunks.some((chunk) => {
    const titleSlug = slugify(chunk.documentTitle.replace(/\.[a-z0-9]+$/i, ''))
    return titleSlug.includes(targetSlug) || targetSlug.includes(titleSlug)
  })
}

const candidateConfidence = (candidate: CandidateAccumulator) => {
  let score = 0.2
  if (candidate.signals.has('explicit_query_subject') || candidate.signals.has('explicit_comparison_entity')) score += 0.35
  if (candidate.signals.has('named_policy_or_benefit')) score += 0.25
  if (candidate.signals.has('explicit_introduction')) score += 0.15
  if (candidate.signals.has('quantified_inventory')) score += 0.25
  if (candidate.signals.has('recurring_named_subject') || candidate.signals.has('recurring_policy_dimension')) score += 0.15
  if (candidate.signals.has('exception_or_limitation') || candidate.signals.has('deprecation_or_replacement')) score += 0.1
  return Number(Math.min(1, score).toFixed(2))
}

export const discoverFacets = (
  question: string,
  chunks: readonly FacetDiscoveryChunk[],
  scopeDecision: QueryScopeDecision,
): FacetDiscoveryResult => {
  const rootTarget = extractSummaryTarget(question)
  const isDocumentTarget = documentTarget(rootTarget, chunks)
  const comparisonEntities = extractComparisonEntities(question)
  const normalizedTarget = rootTarget ? cleanLabel(rootTarget, null) : null
  const relevantChunks = normalizedTarget && !isDocumentTarget
    ? chunks.filter((chunk) => normalizeText(chunk.text).toLocaleLowerCase('en').includes(normalizedTarget.toLocaleLowerCase('en')))
    : [...chunks]
  const analysisChunks = relevantChunks.length ? relevantChunks : [...chunks]
  const candidates = new Map<string, CandidateAccumulator>()

  const ensureCandidate = (
    rawLabel: string,
    options: {
      kind: FacetCandidateKind
      id?: string
      normalizedSubject?: string
      parentId?: string | null
      signal: FacetDiscoverySignal
      chunkId?: string
      obligation?: FacetObligationKind
    },
  ) => {
    const cleaned = cleanLabel(rawLabel, isDocumentTarget ? rootTarget : null)
    if (!cleaned || /^\d+(?:\.\d+)?$/.test(cleaned)) return null
    const id = options.id ?? slugify(cleaned)
    if (!id) return null
    const existing = candidates.get(id) ?? {
      id,
      label: cleaned,
      kind: options.kind,
      normalizedSubject: options.normalizedSubject ?? slugify(cleaned),
      parentId: options.parentId ?? null,
      aliases: new Set<string>(),
      chunkIds: new Set<string>(),
      signals: new Set<FacetDiscoverySignal>(),
      obligationChunks: new Map<FacetObligationKind, Set<string>>(),
      forceRejected: false,
    }
    existing.aliases.add(cleaned)
    existing.signals.add(options.signal)
    if (options.chunkId) existing.chunkIds.add(options.chunkId)
    if (options.obligation) {
      const obligationChunks = existing.obligationChunks.get(options.obligation) ?? new Set<string>()
      if (options.chunkId) obligationChunks.add(options.chunkId)
      existing.obligationChunks.set(options.obligation, obligationChunks)
    }
    candidates.set(id, existing)
    return existing
  }

  for (const entity of comparisonEntities) {
    ensureCandidate(entity, { kind: 'comparison-entity', signal: 'explicit_comparison_entity', obligation: 'definition' })
  }

  if (normalizedTarget && !isDocumentTarget) {
    const target = ensureCandidate(normalizedTarget, { kind: 'query-subject', signal: 'explicit_query_subject', obligation: 'definition' })
    for (const chunk of analysisChunks) {
      target?.chunkIds.add(chunk.id)
      target?.obligationChunks.get('definition')?.add(chunk.id)
    }
  }

  for (const chunk of analysisChunks) {
    const sentences = sentenceList(chunk.text)
    for (const sentence of sentences) {
      for (const item of extractInventoryItems(sentence)) {
        const base = cleanLabel(item, isDocumentTarget ? rootTarget : null)
        ensureCandidate(base, { kind: 'category', signal: 'quantified_inventory', chunkId: chunk.id, obligation: 'definition' })
      }

      const namedPattern = /\b(called|known as|named)\s+(?:the\s+)?([A-Z][A-Za-z-]*(?:\s+[A-Z][A-Za-z-]*){0,3})(?:\s+(rule|policy|benefit|product|plan|programme|program|feature|membership))?/g
      for (const match of sentence.matchAll(namedPattern)) {
        const prefix = sentence.slice(0, match.index)
        const structuralContext = /\b(?:feature|benefit|product|policy|rule|programme|program|pilot|proposal|plan|membership|loyalty)\b/i.test(prefix)
          || Boolean(match[3])
        if (!structuralContext) continue
        const named = ensureCandidate(match[2], { kind: 'named-policy-or-benefit', signal: 'named_policy_or_benefit', chunkId: chunk.id, obligation: 'definition' })
        named?.signals.add('explicit_introduction')
      }
    }
  }

  const dimensionChunks = new Map<string, Set<string>>()
  for (const chunk of analysisChunks) {
    for (const subject of extractPolicyDimensions(chunk.text)) {
      const subjectChunks = dimensionChunks.get(subject) ?? new Set<string>()
      subjectChunks.add(chunk.id)
      dimensionChunks.set(subject, subjectChunks)
    }
  }
  for (const [subject, subjectChunks] of dimensionChunks) {
    if (subjectChunks.size < 2) continue
    const dimension = ensureCandidate(titleCase(subject), {
      kind: 'recurring-policy-dimension',
      normalizedSubject: subject,
      signal: 'recurring_policy_dimension',
      obligation: 'current-state',
    })
    subjectChunks.forEach((chunkId) => {
      dimension?.chunkIds.add(chunkId)
      dimension?.obligationChunks.get('current-state')?.add(chunkId)
    })
  }

  const knownParents = [...candidates.values()].filter((candidate) => candidate.kind === 'category' || candidate.kind === 'named-policy-or-benefit')
  for (const parent of knownParents) {
    for (const chunk of analysisChunks) {
      for (const sentence of sentenceList(chunk.text)) {
        for (const alias of parent.aliases) {
          const escapedAlias = escapeRegExp(alias)
          const exceptionPredicate = '(?:unlimited|only|except|eligible|qualif(?:y|ied|ies)|receive[ds]?|differ(?:s|ed)?|entitled|allowed)'
          const prefixMatch = sentence.match(new RegExp(`\\b([a-z][a-z-]{2,})\\s+${escapedAlias}\\b.{0,120}\\b${exceptionPredicate}\\b`, 'i'))
          const suffixMatch = sentence.match(new RegExp(`\\b${escapedAlias}\\s+(?:members?|accounts?|users?)\\s+with\\s+(?:an?\\s+)?([a-z][a-z-]{2,}).{0,120}\\b${exceptionPredicate}\\b`, 'i'))
          const modifier = prefixMatch?.[1] ?? suffixMatch?.[1]
          if (!modifier || SCOPED_MODIFIER_STOP_WORDS.has(modifier.toLocaleLowerCase('en'))) continue
          const normalizedModifier = modifierKey(modifier)
          const existing = [...candidates.values()].find((candidate) => (
            candidate.kind === 'scoped-exception'
            && candidate.parentId === parent.id
            && candidate.normalizedSubject === `${parent.normalizedSubject}:${normalizedModifier}`
          ))
          ensureCandidate(`${titleCase(modifier)} ${parent.label}`, {
            kind: 'scoped-exception',
            id: existing?.id ?? `${slugify(modifier)}-${parent.id}`,
            normalizedSubject: `${parent.normalizedSubject}:${normalizedModifier}`,
            parentId: parent.id,
            signal: 'exception_or_limitation',
            chunkId: chunk.id,
            obligation: 'exception',
          })
        }
      }
    }
  }

  const exceptionChunks = analysisChunks.filter((chunk) => EXCEPTION_LANGUAGE.test(chunk.text))
  if (exceptionChunks.length >= 2) {
    const exceptions = ensureCandidate('Important exceptions', { kind: 'exception-collection', id: 'important-exceptions', signal: 'exception_or_limitation', obligation: 'exception' })
    exceptionChunks.forEach((chunk) => {
      exceptions?.chunkIds.add(chunk.id)
      exceptions?.obligationChunks.get('exception')?.add(chunk.id)
    })
  }

  const inactiveChunks = analysisChunks.filter((chunk) => INACTIVE_LANGUAGE.test(chunk.text) || /\b(?:proposal|proposed|discussion only|pilot)\b/i.test(chunk.text))
  if (inactiveChunks.length >= 2) {
    const inactive = ensureCandidate('Inactive or proposed rules', { kind: 'inactive-collection', id: 'inactive-or-proposed', signal: 'deprecation_or_replacement', obligation: 'change-status' })
    inactive?.signals.add('state_change')
    inactiveChunks.forEach((chunk) => {
      inactive?.chunkIds.add(chunk.id)
      inactive?.obligationChunks.get('change-status')?.add(chunk.id)
    })
  }

  for (const candidate of candidates.values()) {
    const aliases = [...candidate.aliases]
    const matchingChunks = analysisChunks.filter((chunk) => aliases.some((alias) => normalizeText(chunk.text).toLocaleLowerCase('en').includes(alias.toLocaleLowerCase('en'))))
    matchingChunks.forEach((chunk) => candidate.chunkIds.add(chunk.id))
    if (matchingChunks.length >= 2) candidate.signals.add('recurring_named_subject')

    for (const chunk of matchingChunks) {
      const text = chunk.text
      const addObligation = (kind: FacetObligationKind) => {
        const obligationChunks = candidate.obligationChunks.get(kind) ?? new Set<string>()
        obligationChunks.add(chunk.id)
        candidate.obligationChunks.set(kind, obligationChunks)
      }
      if (CURRENT_LANGUAGE.test(text)) addObligation('current-state')
      if (APPLICABILITY_LANGUAGE.test(text)) addObligation('applicability')
      if (EXCEPTION_LANGUAGE.test(text)) addObligation('exception')
      if (CHANGE_LANGUAGE.test(text)) addObligation('change-status')
    }

    const candidateSentences = analysisChunks
      .flatMap((chunk) => sentenceList(chunk.text))
      .filter((sentence) => aliases.some((alias) => sentence.toLocaleLowerCase('en').includes(alias.toLocaleLowerCase('en'))))
    const inactiveForSubject = candidateSentences.some((sentence) => aliases.some((alias) => {
      const subject = escapeRegExp(alias)
      return new RegExp(`\\b${subject}\\b.{0,50}\\b(?:ended|replaced|experimental|not launched|never approved)\\b`, 'i').test(sentence)
        || new RegExp(`\\b(?:pilot|proposal)\\b.{0,50}\\b${subject}\\b`, 'i').test(sentence)
    }))
    const currentForSubject = candidateSentences.some((sentence) => aliases.some((alias) => {
      const subject = escapeRegExp(alias)
      return new RegExp(`\\b${subject}\\b(?:\\s+[a-z-]+){0,3}\\s+(?:is|are|was|were|remains?|remained|became)\\s+(?:made\\s+)?(?:available|applicable|approved|current|permanent|in force|\\d)`, 'i').test(sentence)
        || new RegExp(`\\bnewly approved\\b.{0,40}\\b${subject}\\b`, 'i').test(sentence)
    }))
    const inactiveOnly = inactiveForSubject && !currentForSubject
    if (inactiveOnly && candidate.id !== 'inactive-or-proposed') {
      candidate.forceRejected = true
      candidate.signals.add('deprecation_or_replacement')
    }
  }

  const explicitComparisonIds = new Set(comparisonEntities.map((item) => slugify(cleanLabel(item, null))))
  const targetId = normalizedTarget ? slugify(normalizedTarget) : null
  const finalized = [...candidates.values()].map((candidate): DiscoveredFacetCandidate => {
    const obligationKinds = candidate.obligationChunks.size ? [...candidate.obligationChunks.keys()] : ['definition' as const]
    const evidenceObligations = obligationKinds.map((kind) => ({
      id: `${candidate.id}:${kind}`,
      kind,
      description: `${candidate.label}: establish ${kind.replace('-', ' ')} from corpus evidence`,
      chunkIds: [...(candidate.obligationChunks.get(kind) ?? candidate.chunkIds)].sort(),
    }))
    let rejectionReason: string | null = null
    if (candidate.forceRejected) rejectionReason = 'inactive_or_proposed_covered_by_composite'
    if (comparisonEntities.length && !explicitComparisonIds.has(candidate.id)) rejectionReason = 'outside_explicit_comparison'
    if (normalizedTarget && !isDocumentTarget && candidate.id !== targetId) rejectionReason = 'outside_requested_subject'
    return {
      id: candidate.id,
      label: candidate.label,
      kind: candidate.kind,
      normalizedSubject: candidate.normalizedSubject,
      parentId: candidate.parentId,
      aliases: [...candidate.aliases].sort(),
      occurrenceCount: candidate.chunkIds.size,
      chunkIds: [...candidate.chunkIds].sort(),
      signals: [...candidate.signals].sort(),
      evidenceObligations,
      confidence: candidateConfidence(candidate),
      rejectionReason,
    }
  }).sort((left, right) => left.id.localeCompare(right.id))

  const selected = finalized.filter((candidate) => candidate.rejectionReason === null)
  const rejected = finalized.filter((candidate) => candidate.rejectionReason !== null)
  const topLevelSelected = selected.filter((candidate) => candidate.parentId === null)
  const scopeRefinement = scopeDecision.mode === 'focused'
    ? 'keep-focused'
    : normalizedTarget && !isDocumentTarget && topLevelSelected.length <= 1
      ? 'downgrade-to-focused'
      : 'keep-synthesis'

  return { candidates: finalized, selected, rejected, scopeRefinement }
}
