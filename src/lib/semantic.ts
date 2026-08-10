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

    if (payload.embeddings.length !== batch.length) {
      throw new NeuralEmbeddingError(
        'invalid_response',
        `The embedding provider returned ${payload.embeddings.length} vectors for ${batch.length} inputs.`,
      )
    }

    const batchDimensions = payload.embeddings[0]?.length ?? 0
    if (!batchDimensions || payload.embeddings.some((vector) => (
      !Array.isArray(vector)
      || vector.length !== batchDimensions
      || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))
    ))) {
      throw new NeuralEmbeddingError('invalid_dimensions', 'The embedding provider returned malformed vectors.')
    }
    if (payload.dimensions !== undefined && payload.dimensions !== batchDimensions) {
      throw new NeuralEmbeddingError('dimension_mismatch', 'The embedding provider metadata does not match the returned vector dimensions.')
    }

    const batchModel = payload.model?.trim() ?? ''
    if (!batchModel && !model) {
      throw new NeuralEmbeddingError('invalid_response', 'The embedding provider did not identify the embedding model.')
    }
    if (model && batchModel && model !== batchModel) {
      throw new NeuralEmbeddingError('model_mismatch', 'The embedding provider returned different models for one indexing run.')
    }
    if (dimensions && batchDimensions !== dimensions) {
      throw new NeuralEmbeddingError('dimension_mismatch', 'The embedding provider returned different vector dimensions for one indexing run.')
    }

    vectors.push(...payload.embeddings)
    model = batchModel || model
    dimensions = batchDimensions
    onProgress?.(Math.min(start + batch.length, inputs.length), inputs.length)
  }

  return { vectors, model, dimensions }
}
