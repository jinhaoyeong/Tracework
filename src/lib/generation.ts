import type { GroundedContext } from './grounded'
import type {
  SynthesisGenerationAdapter,
  SynthesisGenerationRequest,
  SynthesisGenerationResponse,
} from './synthesisGeneration.ts'

export interface GroundedGenerationResponse {
  answer: string
  model: string
  responseId?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export class GenerationError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'GenerationError'
    this.code = code
  }
}

interface GenerationErrorPayload {
  error?: { code?: string; message?: string }
}

/**
 * The one place a generation request leaves the browser. Both routes share it so
 * an HTTP or transport failure can never be mistaken for a model outcome: every
 * failure here is thrown as a GenerationError with a code, and only a 200 with
 * answer text returns normally.
 */
const postGeneration = async (body: Record<string, unknown>): Promise<GroundedGenerationResponse> => {
  let response: Response
  try {
    response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new GenerationError('network_error', 'The generation route could not be reached. Start Tracework with npm run dev.')
  }

  let payload: (GroundedGenerationResponse & GenerationErrorPayload) | GenerationErrorPayload
  try {
    payload = await response.json() as (GroundedGenerationResponse & GenerationErrorPayload) | GenerationErrorPayload
  } catch {
    throw new GenerationError('invalid_response', 'The generation provider returned an unreadable response.')
  }

  const errorPayload = payload && typeof payload === 'object' && 'error' in payload ? payload.error : undefined
  if (!response.ok || errorPayload) {
    throw new GenerationError(
      errorPayload?.code ?? 'generation_provider_error',
      errorPayload?.message ?? 'The generation provider request failed.',
    )
  }

  if (!payload || typeof payload !== 'object' || !('answer' in payload) || typeof payload.answer !== 'string' || !payload.answer.trim()) {
    throw new GenerationError('malformed_response', 'The generation model returned no answer text.')
  }

  return payload as GroundedGenerationResponse
}

export const requestGroundedAnswer = async (context: GroundedContext): Promise<GroundedGenerationResponse> => postGeneration({
  question: context.question,
  context: context.text,
  retrievalEngine: context.retrievalEngine,
  requestedTopK: context.requestedTopK,
  chunks: context.chunks.map((chunk) => ({
    citation: chunk.citation,
    sourceId: chunk.result.document.id,
    chunkId: chunk.result.chunk.id,
  })),
})

/**
 * The Step 10A adapter, wired to the same transport.
 *
 * `mode: 'synthesis'` selects the broad context limit and instruction frame on
 * the server. It is sent explicitly rather than inferred, so a focused request
 * can never pick up the wider budget by accident.
 *
 * This function only transports. It does not classify the answer, validate
 * citations, or decide whether a provider should have been called at all —
 * generateSynthesisAnswer owns every one of those decisions.
 */
export const requestSynthesisAnswer = async (
  request: SynthesisGenerationRequest,
): Promise<SynthesisGenerationResponse> => {
  const response = await postGeneration({
    mode: 'synthesis',
    question: request.question,
    context: request.context,
    asOf: request.asOf,
    requestedPeriod: request.requestedPeriod,
    references: request.references,
  })
  return {
    answer: response.answer,
    model: response.model,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    totalTokens: response.totalTokens,
  }
}

export const serverSynthesisAdapter: SynthesisGenerationAdapter = requestSynthesisAnswer
