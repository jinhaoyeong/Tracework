// Explicit extension so both Vite and `node --experimental-strip-types` resolve
// this the same way; the benchmark scripts import these modules directly.
import { tokenize } from './rag.ts'
import type { DocumentRecord, SearchResult } from '../types'

/**
 * Okapi BM25 over chunks, with title and source path folded in as boosted
 * fields (a simplified BM25F). Dense retrieval matches meaning and misses a
 * document whose subject only appears in its filename; lexical retrieval is the
 * complement, so the fields are kept separate and reported rather than merged
 * into one opaque number.
 *
 *   idf(t)   = ln(1 + (N - df + 0.5) / (df + 0.5))
 *   score(t) = idf(t) * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * len / avgLen))
 *
 * k1 controls term-frequency saturation, b controls length normalisation.
 * tf is the weighted sum of body, title, and path occurrences.
 */
export const BM25_K1 = 1.2
export const BM25_B = 0.75
export const TITLE_WEIGHT = 3
export const PATH_WEIGHT = 2

export interface LexicalFieldHits {
  body: number
  title: number
  path: number
}

export interface LexicalMatch {
  chunkId: string
  documentId: string
  score: number
  matchedTerms: string[]
  fieldHits: LexicalFieldHits
  titleMatched: boolean
  pathMatched: boolean
}

interface LexicalEntry {
  chunkId: string
  documentId: string
  bodyTokens: string[]
  titleTokens: string[]
  pathTokens: string[]
  weightedLength: number
  frequencies: Map<string, LexicalFieldHits>
}

export interface LexicalIndex {
  entries: LexicalEntry[]
  documentFrequency: Map<string, number>
  averageLength: number
  size: number
}

const countInto = (target: Map<string, LexicalFieldHits>, tokens: string[], field: keyof LexicalFieldHits) => {
  for (const token of tokens) {
    const current = target.get(token) ?? { body: 0, title: 0, path: 0 }
    current[field] += 1
    target.set(token, current)
  }
}

export const buildLexicalIndex = (documents: DocumentRecord[]): LexicalIndex => {
  const entries: LexicalEntry[] = []
  const documentFrequency = new Map<string, number>()

  for (const document of documents) {
    const titleTokens = tokenize(document.title)
    const pathTokens = tokenize(document.source)
    for (const chunk of document.chunks) {
      const bodyTokens = chunk.tokens.length ? chunk.tokens : tokenize(chunk.text)
      const frequencies = new Map<string, LexicalFieldHits>()
      countInto(frequencies, bodyTokens, 'body')
      countInto(frequencies, titleTokens, 'title')
      countInto(frequencies, pathTokens, 'path')

      for (const token of new Set([...bodyTokens, ...titleTokens, ...pathTokens])) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
      }

      entries.push({
        chunkId: chunk.id,
        documentId: document.id,
        bodyTokens,
        titleTokens,
        pathTokens,
        weightedLength: bodyTokens.length + titleTokens.length * TITLE_WEIGHT + pathTokens.length * PATH_WEIGHT,
        frequencies,
      })
    }
  }

  const averageLength = entries.length
    ? entries.reduce((total, entry) => total + entry.weightedLength, 0) / entries.length
    : 0

  return { entries, documentFrequency, averageLength, size: entries.length }
}

export const searchLexical = (index: LexicalIndex, query: string, limit = 8): LexicalMatch[] => {
  const queryTerms = [...new Set(tokenize(query))]
  if (!queryTerms.length || !index.size) return []

  const matches: LexicalMatch[] = []
  for (const entry of index.entries) {
    let score = 0
    const matchedTerms: string[] = []
    const fieldHits: LexicalFieldHits = { body: 0, title: 0, path: 0 }

    for (const term of queryTerms) {
      const hits = entry.frequencies.get(term)
      if (!hits) continue
      const termFrequency = hits.body + hits.title * TITLE_WEIGHT + hits.path * PATH_WEIGHT
      if (termFrequency <= 0) continue

      const documentFrequency = index.documentFrequency.get(term) ?? 0
      const idf = Math.log(1 + (index.size - documentFrequency + 0.5) / (documentFrequency + 0.5))
      const normalisation = BM25_K1 * (1 - BM25_B + BM25_B * (entry.weightedLength / (index.averageLength || 1)))
      score += idf * ((termFrequency * (BM25_K1 + 1)) / (termFrequency + normalisation))

      matchedTerms.push(term)
      fieldHits.body += hits.body
      fieldHits.title += hits.title
      fieldHits.path += hits.path
    }

    if (score > 0) {
      matches.push({
        chunkId: entry.chunkId,
        documentId: entry.documentId,
        score,
        matchedTerms,
        fieldHits,
        titleMatched: fieldHits.title > 0,
        pathMatched: fieldHits.path > 0,
      })
    }
  }

  return matches
    .sort((left, right) => right.score - left.score || left.chunkId.localeCompare(right.chunkId))
    .slice(0, limit)
}

/**
 * BM25 scores are unbounded and not comparable to cosine similarity, so the
 * value carried on a SearchResult is normalised against the best score in this
 * result set. It orders results correctly and must not be read as a similarity.
 */
export const toLexicalResults = (
  matches: LexicalMatch[],
  documents: DocumentRecord[],
): SearchResult[] => {
  const documentsById = new Map(documents.map((document) => [document.id, document]))
  const best = matches[0]?.score ?? 0

  return matches.flatMap((match) => {
    const document = documentsById.get(match.documentId)
    const chunk = document?.chunks.find((item) => item.id === match.chunkId)
    if (!document || !chunk) return []
    return [{
      chunk,
      document,
      score: best > 0 ? match.score / best : 0,
      semanticScore: 0,
      keywordScore: best > 0 ? match.score / best : 0,
      matchedTerms: match.matchedTerms,
      engine: 'lexical' as const,
      lexicalScore: match.score,
      lexicalFieldHits: match.fieldHits,
    }]
  })
}
