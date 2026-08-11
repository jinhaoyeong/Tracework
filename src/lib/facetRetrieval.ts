import { buildLexicalIndex, searchLexical, toLexicalResults } from './lexical.ts'
import type { LexicalIndex } from './lexical.ts'
import { searchDocuments, tokenize } from './rag.ts'
import {
  buildCandidateUnion,
  pruneCandidates,
  rerank,
} from './reranker.ts'
import type {
  PruningResult,
  RankedCandidate,
  UnionCandidate,
} from './reranker.ts'
import type { DiscoveredFacet, FacetEvidenceObligation } from './facetDiscovery.ts'
import type { DocumentRecord, LocalRetrievalEngine, SearchResult } from '../types'

export interface FacetRetrievalCorpus {
  documents: DocumentRecord[]
  lexicalIndex?: LexicalIndex
}

export interface FacetRetrievalOptions {
  engine?: LocalRetrievalEngine
  denseLimit?: number
  lexicalLimit?: number
  unionLimit?: number
  maxSelected?: number
  minRelevanceScore?: number
  maxScoreGap?: number
}

export interface FacetRetrievalResult {
  facetId: string
  query: string
  retrievalQueries: string[]
  rankingQuery: string
  candidateCount: number
  denseCandidates: SearchResult[]
  lexicalCandidates: SearchResult[]
  unionCandidates: UnionCandidate[]
  rerankedCandidates: RankedCandidate[]
  selected: SearchResult[]
  pruning: PruningResult
  evidenceObligations: FacetEvidenceObligation[]
}

// A slightly wider candidate window is intentional here: each facet gets its
// own small budget, and sparse current/exception evidence can sit just beyond
// the focused-QA top ten. The selected context remains capped separately.
const DEFAULT_DENSE_LIMIT = 14
const DEFAULT_LEXICAL_LIMIT = 14
// The union is a recall boundary, not the final context budget. It is wider
// than either focused-QA source window so a witness found by one query pass is
// not discarded before later coverage logic can inspect it.
const DEFAULT_UNION_LIMIT = 18
const DEFAULT_SELECTED_LIMIT = 5
const DEFAULT_FACET_MIN_RELEVANCE_SCORE = 0.12

const MONTHS = new Set([
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
])

// These terms carry scope or answer-shape information from the user's question.
// They are deliberately bounded: the full broad question would dilute the
// facet identity in the existing relevance scorer. The vocabulary is generic
// and contains no domain facts or benchmark answer values.
const QUESTION_CONTEXT_TERMS = new Set([
  'current', 'currently', 'historical', 'history', 'future', 'proposed',
  'obsolete', 'inactive', 'pilot', 'pilot-only', 'rejected', 'approved',
  'effective', 'applicable', 'change', 'changes', 'policy', 'policies',
  'exception', 'exceptions', 'important', 'major', 'price', 'pricing',
  'cost', 'costs', 'rate', 'rates', 'allowance', 'allowances', 'limit',
  'limits', 'member', 'members', 'membership', 'memberships', 'type',
  'types', 'average', 'expenditure', 'exact', 'number', 'every', 'main',
  'reasons', 'state', 'overview',
])
const TEMPORAL_CONTEXT_TERMS = new Set([
  'current', 'currently', 'historical', 'history', 'future', 'proposed',
  'obsolete', 'inactive', 'pilot', 'pilot-only', 'rejected', 'approved',
  'effective', 'applicable', 'change', 'changes',
])

// Compact, corpus-agnostic expansions for evidence-obligation kinds. These
// terms describe what a passage may establish; they do not encode any answer
// value, named entity, or benchmark anchor.
const OBLIGATION_QUERY_TERMS: Record<FacetEvidenceObligation['kind'], string[]> = {
  definition: ['introduced', 'category', 'membership'],
  'current-state': ['current', 'effective'],
  applicability: ['applicable', 'eligible', 'included'],
  exception: ['exception', 'unlimited', 'special'],
  'change-status': ['changed', 'proposed', 'future'],
}

const unique = (values: string[]) => [...new Set(values.filter(Boolean))]

const mergeSearchResults = (resultLists: SearchResult[][], limit: number) => {
  const byChunkId = new Map<string, SearchResult>()
  for (const results of resultLists) {
    for (const result of results) {
      const existing = byChunkId.get(result.chunk.id)
      if (!existing || result.score > existing.score) {
        byChunkId.set(result.chunk.id, existing
          ? { ...result, matchedTerms: unique([...(existing.matchedTerms ?? []), ...(result.matchedTerms ?? [])]) }
          : result)
      } else {
        byChunkId.set(result.chunk.id, {
          ...existing,
          matchedTerms: unique([...(existing.matchedTerms ?? []), ...(result.matchedTerms ?? [])]),
        })
      }
    }
  }
  return [...byChunkId.values()]
    .sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id))
    .slice(0, limit)
}

const extractQuestionContext = (question: string, includeTemporalContext: boolean) => unique(
  tokenize(question).filter((term) => {
    const isTemporal = TEMPORAL_CONTEXT_TERMS.has(term) || MONTHS.has(term) || /^\d{4}$/.test(term)
    if (isTemporal) return includeTemporalContext
    return QUESTION_CONTEXT_TERMS.has(term)
  }),
)

/**
 * Builds an inspectable query for one facet. The expansion vocabulary describes
 * evidence obligations only; it never supplies a domain fact or answer value.
 */
export const buildFacetQuery = (question: string, facet: DiscoveredFacet): string => {
  const obligationTerms = facet.evidenceObligations.map((obligation) => obligation.kind.replace(/-/g, ' '))
  const exceptionTerms = facet.kind === 'exception-collection' || facet.kind === 'scoped-exception'
    ? ['eligible', 'unlimited', 'special', 'differs']
    : []
  const identityTerms = [facet.label, facet.normalizedSubject, ...facet.aliases]
  const kindTerms = facet.kind.replace(/-/g, ' ')
  const includeTemporalContext = facet.kind === 'exception-collection' || facet.kind === 'inactive-collection'
  return unique([
    ...identityTerms,
    kindTerms,
    ...obligationTerms,
    ...exceptionTerms,
    ...extractQuestionContext(question, includeTemporalContext),
  ]).join(' ')
}

/**
 * A second generic query pass gives sparse evidence obligations their own
 * vocabulary without making the focused identity query longer. The adapter
 * merges this pass with the ordinary facet/context passes before Phase 5B
 * unioning and reranking.
 */
export const buildFacetObligationQueries = (facet: DiscoveredFacet): string[] => {
  const facetText = `${facet.label} ${facet.normalizedSubject}`.toLocaleLowerCase('en')
  const isChronologicalFacet = /\b(?:19|20)\d{2}\b/.test(facetText) || [...MONTHS].some((month) => facetText.includes(month))
  if (!isChronologicalFacet) return []

  const identityTerms = [facet.label, facet.normalizedSubject, ...facet.aliases]
  return unique(facet.evidenceObligations.map((obligation) => unique([
    ...identityTerms,
    obligation.kind.replace(/-/g, ' '),
    ...OBLIGATION_QUERY_TERMS[obligation.kind],
  ]).join(' ')))
}

/**
 * Keeps the existing transparent reranker focused on the facet identity after
 * retrieval has used the question's scope context. This is still a query, not
 * a support decision: it only prevents broad status language from outranking
 * the subject the facet is responsible for.
 */
export const buildFacetRankingQuery = (facet: DiscoveredFacet): string => {
  const identityTerms = [facet.label, facet.normalizedSubject, ...facet.aliases]
  const kindTerms = facet.kind === 'exception-collection' || facet.kind === 'scoped-exception' || facet.kind === 'inactive-collection'
    ? [facet.kind.replace(/-/g, ' ')]
    : []
  const exceptionTerms = facet.kind === 'exception-collection' || facet.kind === 'scoped-exception'
    ? ['exception', 'eligible', 'unlimited', 'special', 'differs']
    : []
  const statusTerms = facet.kind === 'inactive-collection'
    ? ['proposed', 'future', 'ended', 'replaced', 'pilot']
    : []
  return unique([...identityTerms, ...kindTerms, ...exceptionTerms, ...statusTerms]).join(' ')
}

const resolveLexicalIndex = (corpus: FacetRetrievalCorpus) => corpus.lexicalIndex ?? buildLexicalIndex(corpus.documents)

/**
 * Provider-free per-facet adapter over the existing Phase 5B retrieval stack.
 * Retrieval presence is deliberately returned as evidence candidates only;
 * temporal, provenance, contradiction, and support decisions belong later.
 */
export const retrieveFacetEvidence = (
  question: string,
  facet: DiscoveredFacet,
  corpus: FacetRetrievalCorpus,
  options: FacetRetrievalOptions = {},
): FacetRetrievalResult => {
  const query = buildFacetQuery(question, facet)
  const rankingQuery = buildFacetRankingQuery(facet)
  const retrievalQueries = unique([rankingQuery, query, ...buildFacetObligationQueries(facet)])
  const perQueryDenseCandidates = retrievalQueries.map((retrievalQuery) => searchDocuments(corpus.documents, retrievalQuery, {
    engine: options.engine ?? 'hashed',
    limit: options.denseLimit ?? DEFAULT_DENSE_LIMIT,
  }))
  const lexicalIndex = resolveLexicalIndex(corpus)
  const perQueryLexicalCandidates = retrievalQueries.map((retrievalQuery) => toLexicalResults(
    searchLexical(lexicalIndex, retrievalQuery, options.lexicalLimit ?? DEFAULT_LEXICAL_LIMIT),
    corpus.documents,
  ))
  const denseCandidates = mergeSearchResults(perQueryDenseCandidates, (options.denseLimit ?? DEFAULT_DENSE_LIMIT) * retrievalQueries.length)
  const lexicalCandidates = mergeSearchResults(perQueryLexicalCandidates, (options.lexicalLimit ?? DEFAULT_LEXICAL_LIMIT) * retrievalQueries.length)
  const unionCandidates = buildCandidateUnion({
    dense: denseCandidates,
    lexical: lexicalCandidates,
    limit: options.unionLimit ?? DEFAULT_UNION_LIMIT,
  })
  const rerankedCandidates = rerank(rankingQuery, unionCandidates)
  const pruning = pruneCandidates(rerankedCandidates, {
    maxChunks: options.maxSelected ?? DEFAULT_SELECTED_LIMIT,
    // Facet queries intentionally carry a compact scope context rather than
    // the full broad question. Their hard per-facet cap remains the primary
    // budget; this lower floor prevents sparse singleton evidence from being
    // discarded before later coverage/adjudication steps inspect it.
    minRelevanceScore: options.minRelevanceScore ?? DEFAULT_FACET_MIN_RELEVANCE_SCORE,
    maxScoreGap: options.maxScoreGap,
  })

  return {
    facetId: facet.id,
    query,
    retrievalQueries,
    rankingQuery,
    candidateCount: unionCandidates.length,
    denseCandidates,
    lexicalCandidates,
    unionCandidates,
    rerankedCandidates,
    selected: pruning.selected.map((candidate) => candidate.result),
    pruning,
    evidenceObligations: facet.evidenceObligations,
  }
}
