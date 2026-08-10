import type { SearchResult } from '../types'

/**
 * Reciprocal Rank Fusion.
 *
 *   rrf(chunk) = Σ over rankings  1 / (k + rank)      rank is 1-based
 *
 * Rank-based rather than score-based on purpose: BM25 scores are unbounded and
 * cosine similarities sit in [0,1], so any weighted sum of the two would be
 * comparing incompatible scales and the weights would be doing invisible work.
 * Fusing ranks needs no calibration and no tuned constant per corpus.
 *
 * k = 60 is the value from the original RRF paper (Cormack et al., 2009). It
 * damps the influence of the very top ranks so one confident ranker cannot
 * dominate a chunk that both rankers place reasonably well.
 */
export const RRF_K = 60

export interface FusionInput {
  dense: SearchResult[]
  lexical: SearchResult[]
}

const rankMap = (results: SearchResult[]) => {
  const ranks = new Map<string, number>()
  results.forEach((result, index) => {
    if (!ranks.has(result.chunk.id)) ranks.set(result.chunk.id, index + 1)
  })
  return ranks
}

export const fuseRankings = ({ dense, lexical }: FusionInput, limit = 5, k: number = RRF_K): SearchResult[] => {
  const denseRanks = rankMap(dense)
  const lexicalRanks = rankMap(lexical)

  // Prefer the dense record when a chunk appears in both, so pgvector metadata
  // (distance, embedding model, candidate count) survives fusion.
  const byChunk = new Map<string, SearchResult>()
  for (const result of [...lexical, ...dense]) byChunk.set(result.chunk.id, result)

  const fused = [...byChunk.entries()].map(([chunkId, result]) => {
    const denseRank = denseRanks.get(chunkId) ?? null
    const lexicalRank = lexicalRanks.get(chunkId) ?? null
    const denseContribution = denseRank === null ? 0 : 1 / (k + denseRank)
    const lexicalContribution = lexicalRank === null ? 0 : 1 / (k + lexicalRank)
    const rrfScore = denseContribution + lexicalContribution

    return {
      ...result,
      engine: 'hybrid' as const,
      fusion: { rrfScore, denseRank, lexicalRank, denseContribution, lexicalContribution },
    }
  })

  return fused
    .sort((left, right) => (
      right.fusion.rrfScore - left.fusion.rrfScore
      // Deterministic ties: better dense rank first, then chunk id. Without
      // this, equal-score chunks would order by Map insertion and a rerun could
      // silently produce a different Top-K.
      || (left.fusion.denseRank ?? Infinity) - (right.fusion.denseRank ?? Infinity)
      || (left.fusion.lexicalRank ?? Infinity) - (right.fusion.lexicalRank ?? Infinity)
      || left.chunk.id.localeCompare(right.chunk.id)
    ))
    .slice(0, limit)
}
