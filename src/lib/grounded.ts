import type { SearchResult } from '../types'

export type EvidenceStatus = 'strong' | 'partial' | 'insufficient'

export interface EvidenceAssessment {
  status: EvidenceStatus
  bestScore: number
  /**
   * Chunks whose retrieval score cleared PARTIAL_SCORE_FLOOR. This counts
   * eligibility, not support: nothing here has checked whether a chunk actually
   * contains an answer to the question. Renaming it back to "supporting" would
   * claim a measurement Tracework cannot yet make.
   */
  candidateChunksAboveFloor: number
  distinctSourceCount: number
  coverage: number
  reason: string
}

export interface GroundedContextChunk {
  citation: number
  result: SearchResult
  formatted: string
}

export interface GroundedContext {
  question: string
  retrievalEngine: string
  requestedTopK: number
  chunks: GroundedContextChunk[]
  text: string
  characters: number
  approximateTokens: number
  embeddingModel: string | null
  embeddingDimensions: number | null
}

export interface GroundedAnswer {
  title: string
  body: string
  citations: SearchResult[]
  citationNumbers: number[]
  validCitationNumbers: number[]
  invalidCitationNumbers: number[]
  model: string | null
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export interface GenerationMetadata {
  model?: string | null
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export interface GroundedSession {
  context: GroundedContext
  assessment: EvidenceAssessment
  answer: GroundedAnswer | null
}

const PARTIAL_SCORE_FLOOR = 0.42
const STRONG_SCORE_FLOOR = 0.62
const DEFAULT_CONTEXT_LIMIT = 5

const clamp = (value: number) => Math.max(0, Math.min(1, value))

const sourceModel = (result: SearchResult) => result.embeddingModel ?? result.chunk.neuralEmbedding?.model ?? null

const sourceDimensions = (result: SearchResult) => result.embeddingDimensions ?? result.chunk.neuralEmbedding?.dimensions ?? null

/**
 * Scores retrieval quality only. The question is deliberately unused: this
 * function measures similarity, source spread, and score floors, none of which
 * can tell whether a chunk answers what was asked. Real support measurement
 * belongs to reranking work, not here.
 */
export const evaluateEvidence = (_question: string, results: SearchResult[]): EvidenceAssessment => {
  const bestScore = results[0]?.score ?? 0
  const candidateResults = results.filter((result) => result.score >= PARTIAL_SCORE_FLOOR)
  const distinctSourceCount = new Set(candidateResults.map((result) => result.document.id)).size
  const candidateCoverage = Math.min(1, candidateResults.length / 3)
  const sourceCoverage = Math.min(1, distinctSourceCount / 2)
  const coverage = clamp(bestScore * 0.7 + candidateCoverage * 0.2 + sourceCoverage * 0.1)

  if (!results.length) {
    return {
      status: 'insufficient',
      bestScore,
      candidateChunksAboveFloor: 0,
      distinctSourceCount: 0,
      coverage,
      reason: 'No retrieved chunk cleared the retrieval threshold.',
    }
  }

  if (bestScore < PARTIAL_SCORE_FLOOR) {
    return {
      status: 'insufficient',
      bestScore,
      candidateChunksAboveFloor: candidateResults.length,
      distinctSourceCount,
      coverage,
      reason: `The best match is only ${(bestScore * 100).toFixed(0)}%, below the ${Math.round(PARTIAL_SCORE_FLOOR * 100)}% evidence floor.`,
    }
  }

  if (bestScore >= STRONG_SCORE_FLOOR && candidateResults.length >= 1) {
    return {
      status: 'strong',
      bestScore,
      candidateChunksAboveFloor: candidateResults.length,
      distinctSourceCount,
      coverage,
      reason: `At least one match cleared ${(STRONG_SCORE_FLOOR * 100).toFixed(0)}%, with ${candidateResults.length} candidate chunk${candidateResults.length === 1 ? '' : 's'} above the evidence floor.`,
    }
  }

  return {
    status: 'partial',
    bestScore,
    candidateChunksAboveFloor: candidateResults.length,
    distinctSourceCount,
    coverage,
    reason: `Evidence is usable but partial: the best match is ${(bestScore * 100).toFixed(0)}% and ${candidateResults.length} chunk${candidateResults.length === 1 ? '' : 's'} cleared the evidence floor.`,
  }
}

const formatContextChunk = (citation: number, result: SearchResult) => {
  const model = sourceModel(result) ?? 'unknown'
  const dimensions = sourceDimensions(result) ?? 'unknown'
  const distance = result.distance === undefined ? 'n/a' : result.distance.toFixed(4)
  return [
    `[${citation}] ${result.document.title}`,
    `source: ${result.document.source}`,
    `type: ${result.document.kind}`,
    `chunk: ${result.chunk.index + 1} / ${result.document.chunks.length}`,
    `offsets: ${result.chunk.start}-${result.chunk.end} chars`,
    `similarity: ${result.score.toFixed(4)}`,
    `distance: ${distance}`,
    `embedding: ${model} / ${dimensions}d`,
    'content:',
    result.chunk.text,
  ].join('\n')
}

export const buildGroundedContext = (
  question: string,
  results: SearchResult[],
  options: { retrievalEngine?: string; requestedTopK?: number; limit?: number } = {},
): GroundedContext => {
  const chunks = results.slice(0, options.limit ?? DEFAULT_CONTEXT_LIMIT).map((result, index) => ({
    citation: index + 1,
    result,
    formatted: formatContextChunk(index + 1, result),
  }))
  const text = chunks.map((chunk) => chunk.formatted).join('\n\n')
  const firstEmbedding = chunks.find((chunk) => sourceModel(chunk.result))?.result

  return {
    question,
    retrievalEngine: options.retrievalEngine ?? results[0]?.engine ?? 'none',
    requestedTopK: options.requestedTopK ?? results.length,
    chunks,
    text,
    characters: text.length,
    approximateTokens: Math.ceil(text.length / 4),
    embeddingModel: firstEmbedding ? sourceModel(firstEmbedding) : null,
    embeddingDimensions: firstEmbedding ? sourceDimensions(firstEmbedding) : null,
  }
}

/**
 * Marker validation only: it confirms every [n] refers to a chunk that was
 * actually sent. It does not check that chunk [n] supports the sentence citing
 * it, so a well-formed citation on an unsupported claim still passes here.
 */
export const validateCitations = (answer: string, context: GroundedContext) => {
  const numbers = [...answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]))
  const citationNumbers = [...new Set(numbers)].filter((number) => Number.isInteger(number) && number > 0)
  const invalidCitationNumbers = [...new Set(citationNumbers.filter((number) => number > context.chunks.length))]
  const validCitationNumbers = citationNumbers.filter((number) => !invalidCitationNumbers.includes(number))
  const citations = validCitationNumbers.map((number) => context.chunks[number - 1].result)

  return {
    citationNumbers,
    validCitationNumbers,
    invalidCitationNumbers,
    citations,
    hasCitations: citationNumbers.length > 0,
    isValid: citationNumbers.length > 0 && invalidCitationNumbers.length === 0,
  }
}

export const attachValidatedCitations = (
  answer: string,
  context: GroundedContext,
  metadata: GenerationMetadata = {},
): GroundedAnswer => {
  const citationState = validateCitations(answer, context)
  return {
    title: `${citationState.citations.length} cited ${citationState.citations.length === 1 ? 'source' : 'sources'} / grounded answer`,
    body: answer,
    citations: citationState.citations,
    citationNumbers: citationState.citationNumbers,
    validCitationNumbers: citationState.validCitationNumbers,
    invalidCitationNumbers: citationState.invalidCitationNumbers,
    model: metadata.model ?? null,
    inputTokens: metadata.inputTokens,
    outputTokens: metadata.outputTokens,
    totalTokens: metadata.totalTokens,
  }
}

export const buildInsufficientAnswer = (assessment: EvidenceAssessment): GroundedAnswer => ({
  title: 'Evidence insufficient',
  body: `I couldn't find enough evidence in your knowledge base to answer this. ${assessment.reason}`,
  citations: [],
  citationNumbers: [],
  validCitationNumbers: [],
  invalidCitationNumbers: [],
  model: null,
})

/**
 * The exact sentence the generation route instructs the model to return when
 * the supplied evidence does not answer the question. Keep this string in sync
 * with the server instructions in vite.config.ts.
 */
export const MODEL_REFUSAL_SENTENCE = 'I could not find enough evidence in the supplied knowledge base to answer this.'

const normalizeRefusalText = (value: string) =>
  value
    .toLocaleLowerCase()
    .replace(/[*_`>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!]+$/, '')
    .trim()

const NORMALIZED_REFUSAL = normalizeRefusalText(MODEL_REFUSAL_SENTENCE)

/**
 * A correct refusal is a safety outcome, not a failure. It carries no claim, so
 * it carries no citations, and the citation requirement must not be applied to
 * it. A refusal wrapped in a short caveat still counts, as long as the model
 * made no cited claim of its own alongside it.
 */
export const isModelRefusal = (answer: string): boolean => {
  const normalized = normalizeRefusalText(answer)
  if (!normalized) return false
  if (normalized === NORMALIZED_REFUSAL) return true
  return normalized.includes(NORMALIZED_REFUSAL) && !/\[\d+\]/.test(answer)
}

export type GenerationOutcome = 'answered' | 'refused' | 'unusable'

export interface ClassifiedGeneration {
  outcome: GenerationOutcome
  answer: GroundedAnswer
  reason: string
}

export const buildModelRefusalAnswer = (answer: string, metadata: GenerationMetadata = {}): GroundedAnswer => ({
  title: 'Evidence insufficient / model refused',
  body: answer.trim(),
  citations: [],
  citationNumbers: [],
  validCitationNumbers: [],
  invalidCitationNumbers: [],
  model: metadata.model ?? null,
  inputTokens: metadata.inputTokens,
  outputTokens: metadata.outputTokens,
  totalTokens: metadata.totalTokens,
})

/**
 * Splits a returned generation into the three outcomes the pipeline can act on:
 * an answered claim that must cite valid evidence, a refusal that must not, and
 * an unusable response that is a genuine generation failure.
 */
export const classifyGeneratedAnswer = (
  answer: string,
  context: GroundedContext,
  metadata: GenerationMetadata = {},
): ClassifiedGeneration => {
  if (isModelRefusal(answer)) {
    return {
      outcome: 'refused',
      answer: buildModelRefusalAnswer(answer, metadata),
      reason: 'The generation model reported that the supplied evidence does not answer the question.',
    }
  }

  const validated = attachValidatedCitations(answer, context, metadata)

  if (validated.invalidCitationNumbers.length) {
    return {
      outcome: 'unusable',
      answer: validated,
      reason: `The generation model cited unavailable evidence markers: ${validated.invalidCitationNumbers.map((number) => `[${number}]`).join(', ')}.`,
    }
  }

  if (!validated.citations.length) {
    return {
      outcome: 'unusable',
      answer: validated,
      reason: 'The generation model made a claim without citing any evidence, and did not return the explicit insufficient-evidence refusal.',
    }
  }

  return {
    outcome: 'answered',
    answer: validated,
    reason: `Grounded answer returned with ${validated.citations.length} validated citation${validated.citations.length === 1 ? '' : 's'}.`,
  }
}
