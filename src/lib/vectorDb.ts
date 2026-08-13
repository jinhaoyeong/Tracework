import type { DocumentRecord, SourceKind, SourceProvenance } from '../types'
import { ACCOUNT_REQUIRED, AUTHORIZATION_PENDING, AccountRequiredError, requestWithAuth } from './apiClient.ts'

export const PGVECTOR_DIMENSIONS = 1536

/**
 * Returned when a deployment refuses writes to the shared knowledge base. It is
 * a deliberate configuration, not a fault: retrieval should fall back to
 * searching what is already stored rather than reporting a failure.
 */
export const SHARED_WRITES_DISABLED = 'shared_writes_disabled'

/**
 * The three reasons a shared write can be unavailable without anything being
 * broken. Callers treat these as "read-only right now" rather than as failures,
 * so local indexing and search keep working.
 */
export const SHARED_WRITE_UNAVAILABLE_CODES: readonly string[] = [
  SHARED_WRITES_DISABLED,
  ACCOUNT_REQUIRED,
  AUTHORIZATION_PENDING,
]

export const isSharedWriteUnavailable = (error: unknown): boolean => (
  error instanceof PgvectorError && SHARED_WRITE_UNAVAILABLE_CODES.includes(error.code)
)

export class PgvectorError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PgvectorError'
    this.code = code
  }
}

export interface PgvectorSyncResponse {
  database: string
  embeddingDimensions: number
  syncedSources: number
  syncedChunks: number
}

export interface PgvectorMatch {
  id: string
  sourceId: string
  content: string
  sourceContent: string
  chunkIndex: number
  startOffset: number
  endOffset: number
  title: string
  sourcePath: string
  kind: SourceKind
  /** Null when the stored source predates provenance being persisted. */
  provenance: SourceProvenance | null
  embeddingModel: string
  embeddingDimensions: number
  distance: number
  similarity: number
  candidateCount: number
}

export interface PgvectorSearchResponse {
  database: string
  distanceMetric: string
  embeddingDimensions: number
  results: PgvectorMatch[]
  topK: number
}

interface ApiErrorPayload {
  error?: { code?: string; message?: string }
}

const requestJson = async <T>(path: string, body: unknown, requireAccount = false): Promise<T> => {
  let response: Response
  try {
    response = await requestWithAuth(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, { requireAccount })
  } catch (error) {
    // A missing account is a known state, not an unreachable route; reporting it
    // as a network error would send the reader to fix the wrong thing.
    if (error instanceof AccountRequiredError) {
      throw new PgvectorError(ACCOUNT_REQUIRED, 'Sign in to Tracework to change the shared knowledge base.')
    }
    throw new PgvectorError('network_error', 'The vector database route could not be reached. Start Tracework with npm run dev.')
  }

  let payload: (T & ApiErrorPayload) | ApiErrorPayload
  try {
    payload = await response.json() as (T & ApiErrorPayload) | ApiErrorPayload
  } catch {
    throw new PgvectorError('invalid_response', 'The vector database route returned an unreadable response.')
  }

  if (!response.ok || 'error' in payload && payload.error) {
    throw new PgvectorError(
      payload.error?.code ?? 'vector_database_error',
      payload.error?.message ?? 'The vector database request failed.',
    )
  }

  return payload as T
}

const serializeDocument = (document: DocumentRecord) => ({
  id: document.id,
  title: document.title,
  sourcePath: document.source,
  kind: document.kind,
  content: document.content,
  provenance: document.provenance ?? null,
  createdAt: document.createdAt,
  chunks: document.chunks.map((chunk) => ({
    id: chunk.id,
    index: chunk.index,
    text: chunk.text,
    start: chunk.start,
    end: chunk.end,
    neuralEmbedding: chunk.neuralEmbedding ?? null,
  })),
})

export const requestPgvectorSync = (documents: DocumentRecord[]) => {
  return requestJson<PgvectorSyncResponse>('/api/vector/sync', {
    documents: documents.map(serializeDocument),
  }, true)
}

export const requestPgvectorSearch = (
  queryVector: number[],
  options: { limit: number; sourceKind: SourceKind | 'all' },
) => {
  return requestJson<PgvectorSearchResponse>('/api/vector/search', {
    queryVector,
    limit: options.limit,
    sourceKind: options.sourceKind === 'all' ? null : options.sourceKind,
  })
}

export const requestPgvectorDelete = (sourceIds: string[]) => {
  if (!sourceIds.length) return Promise.resolve({ deletedSources: 0 })
  return requestJson<{ deletedSources: number }>('/api/vector/delete', { sourceIds }, true)
}
