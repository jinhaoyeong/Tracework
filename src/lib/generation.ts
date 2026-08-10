import type { GroundedContext } from './grounded'

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

export const requestGroundedAnswer = async (context: GroundedContext): Promise<GroundedGenerationResponse> => {
  let response: Response
  try {
    response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: context.question,
        context: context.text,
        retrievalEngine: context.retrievalEngine,
        requestedTopK: context.requestedTopK,
        chunks: context.chunks.map((chunk) => ({
          citation: chunk.citation,
          sourceId: chunk.result.document.id,
          chunkId: chunk.result.chunk.id,
        })),
      }),
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
