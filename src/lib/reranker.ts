import { tokenize } from './rag.ts'
import type { LexicalFieldHits } from './lexical'
import type { SearchResult } from '../types'

export type CandidateAppearance = 'dense' | 'lexical' | 'both'

export interface CandidateRetrievalMetadata {
  denseRank: number | null
  denseSimilarity: number | null
  denseDistance: number | null
  lexicalRank: number | null
  bm25Score: number | null
  lexicalFieldHits: LexicalFieldHits | null
  matchedTerms: string[]
  appearedIn: CandidateAppearance
}

export interface UnionCandidate {
  result: SearchResult
  retrieval: CandidateRetrievalMetadata
  unionRank: number
}

export interface RelevanceFeatures {
  bodyCoverage: number
  titlePathCoverage: number
  exactTitlePathMatch: number
  phraseCoverage: number
  denseSignal: number
  lexicalSignal: number
}

export type RelevanceLabel = 'high' | 'medium' | 'low'

export interface RankedCandidate extends UnionCandidate {
  relevanceScore: number
  relevanceLabel: RelevanceLabel
  relevanceReason: string
  features: RelevanceFeatures
  rerankedRank: number
  originalUnionRank: number
}

export interface CandidateUnionInput {
  dense: SearchResult[]
  lexical: SearchResult[]
  limit?: number
}

export interface RerankOptions {
  strategy?: 'transparent-v1'
}

export interface PruningOptions {
  maxChunks?: number
  minRelevanceScore?: number
  maxScoreGap?: number
}

export interface PruningDecision {
  candidate: RankedCandidate
  selected: boolean
  reason: string
}

export interface PruningResult {
  considered: number
  selected: RankedCandidate[]
  rejected: PruningDecision[]
  decisions: PruningDecision[]
}

const DEFAULT_CANDIDATE_LIMIT = 10
const DEFAULT_MAX_CONTEXT_CHUNKS = 5
const DEFAULT_MIN_RELEVANCE_SCORE = 0.28
const DEFAULT_MAX_SCORE_GAP = 0.32

const clamp = (value: number) => Math.max(0, Math.min(1, value))

const unique = (values: string[]) => [...new Set(values)]

const resultMatchedTerms = (result: SearchResult | undefined) => result?.matchedTerms ?? []

const denseSimilarity = (result: SearchResult | undefined) => {
  if (!result) return null
  const value = result.semanticScore || result.score
  return Number.isFinite(value) ? clamp(value) : null
}

const copyFieldHits = (hits: LexicalFieldHits | undefined) => hits
  ? { body: hits.body, title: hits.title, path: hits.path }
  : null

/**
 * Build the Phase 5B candidate pool without calculating an RRF score. The
 * first-seen order is intentionally dense-first followed by lexical-only
 * candidates; it is an inspection order, not a hidden ranking decision.
 */
export const buildCandidateUnion = ({ dense, lexical, limit = DEFAULT_CANDIDATE_LIMIT }: CandidateUnionInput): UnionCandidate[] => {
  const denseRows = dense.slice(0, limit)
  const lexicalRows = lexical.slice(0, limit)
  const denseByChunk = new Map(denseRows.map((result, index) => [result.chunk.id, { result, rank: index + 1 }]))
  const lexicalByChunk = new Map(lexicalRows.map((result, index) => [result.chunk.id, { result, rank: index + 1 }]))
  const chunkIds = [...denseRows.map((result) => result.chunk.id)]
  for (const result of lexicalRows) {
    if (!denseByChunk.has(result.chunk.id)) chunkIds.push(result.chunk.id)
  }

  return chunkIds.flatMap((chunkId, index): UnionCandidate[] => {
    const denseRow = denseByChunk.get(chunkId)
    const lexicalRow = lexicalByChunk.get(chunkId)
    const preferredResult = denseRow?.result ?? lexicalRow?.result
    if (!preferredResult) return []

    const matchedTerms = unique([
      ...resultMatchedTerms(denseRow?.result),
      ...resultMatchedTerms(lexicalRow?.result),
    ])
    const appearedIn: CandidateAppearance = denseRow && lexicalRow
      ? 'both'
      : denseRow
        ? 'dense'
        : 'lexical'

    return [{
      result: matchedTerms.length ? { ...preferredResult, matchedTerms } : preferredResult,
      retrieval: {
        denseRank: denseRow?.rank ?? null,
        denseSimilarity: denseSimilarity(denseRow?.result),
        denseDistance: denseRow?.result?.distance ?? null,
        lexicalRank: lexicalRow?.rank ?? null,
        bm25Score: lexicalRow?.result?.lexicalScore ?? null,
        lexicalFieldHits: copyFieldHits(lexicalRow?.result?.lexicalFieldHits),
        matchedTerms,
        appearedIn,
      },
      unionRank: index + 1,
    }]
  })
}

const phraseCoverage = (queryTokens: string[], candidateText: string) => {
  if (queryTokens.length < 2) return 0
  const candidateTokens = tokenize(candidateText)
  const candidateBigrams = new Set(candidateTokens.slice(0, -1).map((token, index) => `${token}:${candidateTokens[index + 1]}`))
  let matched = 0
  for (let index = 0; index < queryTokens.length - 1; index += 1) {
    if (candidateBigrams.has(`${queryTokens[index]}:${queryTokens[index + 1]}`)) matched += 1
  }
  return matched / (queryTokens.length - 1)
}

const formatPercent = (value: number) => `${Math.round(value * 100)}%`

const relevanceLabel = (score: number): RelevanceLabel => {
  if (score >= 0.5) return 'high'
  if (score >= 0.28) return 'medium'
  return 'low'
}

const makeReason = (features: RelevanceFeatures, candidate: UnionCandidate) => {
  const appearance = candidate.retrieval.appearedIn === 'both'
    ? 'found by dense and lexical retrieval'
    : `found by ${candidate.retrieval.appearedIn} retrieval only`
  return [
    `body coverage ${formatPercent(features.bodyCoverage)}`,
    `title/path coverage ${formatPercent(features.titlePathCoverage)}`,
    `exact title/path ${features.exactTitlePathMatch ? 'yes' : 'no'}`,
    `phrase coverage ${formatPercent(features.phraseCoverage)}`,
    `dense ${formatPercent(features.denseSignal)}`,
    `lexical ${formatPercent(features.lexicalSignal)}`,
    appearance,
  ].join(' · ')
}

const scoreCandidate = (questionTokens: string[], maxBm25Score: number, candidate: UnionCandidate): { score: number; features: RelevanceFeatures } => {
  const bodyTokens = new Set(tokenize(candidate.result.chunk.text))
  const titleTokens = new Set(tokenize(candidate.result.document.title))
  const titlePathTokens = new Set(tokenize(`${candidate.result.document.title} ${candidate.result.document.source}`))
  const questionTermCount = Math.max(1, questionTokens.length)
  const bodyMatches = questionTokens.filter((token) => bodyTokens.has(token))
  const titlePathMatches = questionTokens.filter((token) => titlePathTokens.has(token))
  const features: RelevanceFeatures = {
    bodyCoverage: bodyMatches.length / questionTermCount,
    titlePathCoverage: titlePathMatches.length / questionTermCount,
    exactTitlePathMatch: questionTokens.some((token) => titleTokens.has(token)) ? 1 : 0,
    phraseCoverage: phraseCoverage(questionTokens, `${candidate.result.document.title} ${candidate.result.document.source} ${candidate.result.chunk.text}`),
    denseSignal: candidate.retrieval.denseSimilarity ?? 0,
    lexicalSignal: maxBm25Score > 0 && candidate.retrieval.bm25Score !== null
      ? clamp(candidate.retrieval.bm25Score / maxBm25Score)
      : 0,
  }

  // This is deliberately a relevance-only score. It sees the question and
  // passage, plus the retrieval signals already attached to that passage. It
  // does not inspect source kind, dates, authority, contradiction, or truth.
  const score = clamp(
    features.bodyCoverage * 0.40
      + features.titlePathCoverage * 0.14
      + features.exactTitlePathMatch * 0.16
      + features.phraseCoverage * 0.05
      + features.denseSignal * 0.10
      + features.lexicalSignal * 0.15,
  )
  return { score, features }
}

/**
 * Replaceable relevance boundary. The shipped strategy is deterministic and
 * inspectable so ranking changes can be attributed to relevance features,
 * rather than an opaque provider call.
 */
export const rerank = (question: string, candidates: UnionCandidate[], _options: RerankOptions = {}): RankedCandidate[] => {
  const questionTokens = unique(tokenize(question))
  const maxBm25Score = candidates.reduce((best, candidate) => Math.max(best, candidate.retrieval.bm25Score ?? 0), 0)
  return candidates
    .map((candidate) => {
      const { score, features } = scoreCandidate(questionTokens, maxBm25Score, candidate)
      return {
        ...candidate,
        relevanceScore: score,
        relevanceLabel: relevanceLabel(score),
        relevanceReason: makeReason(features, candidate),
        features,
        rerankedRank: 0,
        originalUnionRank: candidate.unionRank,
      }
    })
    .sort((left, right) => (
      right.relevanceScore - left.relevanceScore
      || right.features.bodyCoverage - left.features.bodyCoverage
      || (left.retrieval.denseRank ?? Infinity) - (right.retrieval.denseRank ?? Infinity)
      || (left.retrieval.lexicalRank ?? Infinity) - (right.retrieval.lexicalRank ?? Infinity)
      || left.result.chunk.id.localeCompare(right.result.chunk.id)
    ))
    .map((candidate, index) => ({ ...candidate, rerankedRank: index + 1 }))
}

/**
 * Context selection is intentionally a second operation. A candidate must be
 * relevant enough to enter the context floor and close enough to the best
 * relevance score; the cap is a safety bound, not a request to fill slots.
 */
export const pruneCandidates = (
  ranked: RankedCandidate[],
  options: PruningOptions = {},
): PruningResult => {
  const maxChunks = Math.max(0, Math.floor(options.maxChunks ?? DEFAULT_MAX_CONTEXT_CHUNKS))
  const minRelevanceScore = clamp(options.minRelevanceScore ?? DEFAULT_MIN_RELEVANCE_SCORE)
  const maxScoreGap = Math.max(0, options.maxScoreGap ?? DEFAULT_MAX_SCORE_GAP)
  const bestScore = ranked[0]?.relevanceScore ?? 0
  const decisions: PruningDecision[] = []

  for (const candidate of ranked) {
    if (candidate.relevanceScore < minRelevanceScore) {
      decisions.push({ candidate, selected: false, reason: `below relevance floor ${formatPercent(minRelevanceScore)}` })
      continue
    }
    if (bestScore - candidate.relevanceScore > maxScoreGap) {
      decisions.push({ candidate, selected: false, reason: `more than ${formatPercent(maxScoreGap)} below the best relevance score` })
      continue
    }
    if (decisions.filter((decision) => decision.selected).length >= maxChunks) {
      decisions.push({ candidate, selected: false, reason: `context limit reached at ${maxChunks} chunk${maxChunks === 1 ? '' : 's'}` })
      continue
    }
    decisions.push({ candidate, selected: true, reason: 'cleared the relevance floor and context gap' })
  }

  return {
    considered: ranked.length,
    selected: decisions.filter((decision) => decision.selected).map((decision) => decision.candidate),
    rejected: decisions.filter((decision) => !decision.selected),
    decisions,
  }
}

export const DEFAULT_PHASE5B_CANDIDATE_LIMIT = DEFAULT_CANDIDATE_LIMIT
export const DEFAULT_PHASE5B_CONTEXT_LIMIT = DEFAULT_MAX_CONTEXT_CHUNKS
