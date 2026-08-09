export interface NeuralEmbeddingResponse {
  vectors: number[][]
  model: string
  dimensions: number
}

export class NeuralEmbeddingError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'NeuralEmbeddingError'
    this.code = code
  }
}

interface ProviderPayload {
  embeddings?: number[][]
  model?: string
  dimensions?: number
  error?: { code?: string; message?: string }
}

export const requestNeuralEmbeddings = async (
  inputs: string[],
  onProgress?: (completed: number, total: number) => void,
): Promise<NeuralEmbeddingResponse> => {
  if (!inputs.length) return { vectors: [], model: '', dimensions: 0 }

  const batchSize = 32
  const vectors: number[][] = []
  let model = ''
  let dimensions = 0

  for (let start = 0; start < inputs.length; start += batchSize) {
    const batch = inputs.slice(start, start + batchSize)
    let response: Response
    try {
      response = await fetch('/api/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: batch }),
      })
    } catch {
      throw new NeuralEmbeddingError('network_error', 'The embedding route could not be reached. Start Tracework with npm run dev.')
    }

    let payload: ProviderPayload = {}
    try {
      payload = await response.json() as ProviderPayload
    } catch {
      throw new NeuralEmbeddingError('invalid_response', 'The embedding provider returned an unreadable response.')
    }

    if (!response.ok || !payload.embeddings?.length) {
      throw new NeuralEmbeddingError(
        payload.error?.code ?? 'provider_error',
        payload.error?.message ?? 'The embedding provider did not return vectors.',
      )
    }

    vectors.push(...payload.embeddings)
    model = payload.model ?? model
    dimensions = payload.dimensions ?? payload.embeddings[0].length
    onProgress?.(Math.min(start + batch.length, inputs.length), inputs.length)
  }

  return { vectors, model, dimensions }
}
