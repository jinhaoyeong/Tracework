// Explicit extension so Node can load this module directly, matching the
// convention the corpus modules already follow for the eval scripts.
import { createDocument } from './rag.ts'
import { requestWithAuth } from './apiClient.ts'
import type { DocumentRecord, SourceKind, SourceProvenance } from '../types'

/**
 * Client access to the shared knowledge library.
 *
 * The catalog is read from Postgres rather than rebuilt from bundled fixtures,
 * so a collection someone seeded is visible from any device that opens
 * Tracework. Chunking and embedding still happen here, on the client, before a
 * source is synced into the vector table.
 */

export class KnowledgeLibraryError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'KnowledgeLibraryError'
    this.code = code
  }
}

/**
 * Where a catalog entry came from, and therefore which containment rule applied.
 *
 * 'public'    the shared library, read through the service-role path and
 *             contained to published documents in public collections.
 * 'private'   a collection this signed-in reader owns.
 * 'workspace' a collection belonging to a workspace this reader is active in.
 */
export type CollectionScope = 'public' | 'private' | 'workspace'

export interface KnowledgeCollection {
  slug: string
  title: string
  description: string
  kind: SourceKind
  provenance: SourceProvenance | null
  /**
   * Null on private and workspace entries.
   *
   * These counts have exactly one meaning - published documents inside a public
   * collection - and it is only computable on the public path. Reusing the same
   * field for a caller-scoped count would put two different rules behind one
   * name, so a scoped entry reports null instead. Null means "not computed",
   * never zero, and must not be rendered as a number.
   */
  documentCount: number | null
  characterCount: number | null
  updatedAt: string | null
  /**
   * Absent on an anonymous response, which keeps the pre-6D4A contract exactly.
   * Absent means 'public': the anonymous catalog has no other scope.
   */
  scope?: CollectionScope
}

export interface KnowledgeLibraryDocument {
  id: string
  collectionSlug: string
  title: string
  sourcePath: string
  kind: SourceKind
  content: string
  provenance: SourceProvenance | null
}

interface ApiErrorPayload {
  error?: { code?: string; message?: string }
}

const requestJson = async <T>(path: string, body: unknown): Promise<T> => {
  let response: Response
  try {
    response = await requestWithAuth(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new KnowledgeLibraryError('network_error', 'The knowledge library route could not be reached. Start Tracework with npm run dev.')
  }

  let payload: (T & ApiErrorPayload) | ApiErrorPayload
  try {
    payload = await response.json() as (T & ApiErrorPayload) | ApiErrorPayload
  } catch {
    throw new KnowledgeLibraryError('invalid_response', 'The knowledge library route returned an unreadable response.')
  }

  if (!response.ok || 'error' in payload && payload.error) {
    throw new KnowledgeLibraryError(
      payload.error?.code ?? 'knowledge_library_error',
      payload.error?.message ?? 'The knowledge library request failed.',
    )
  }

  return payload as T
}

export const requestKnowledgeLibrary = () => (
  requestJson<{ database: string; collections: KnowledgeCollection[] }>('/api/library/collections', {})
)

export const requestCollectionDocuments = (slug: string) => (
  requestJson<{ collectionSlug: string; documents: KnowledgeLibraryDocument[] }>('/api/library/documents', { slug })
)

/**
 * Phase 6E: explicit publication.
 *
 * 'pending'    submitted, invisible to every reader through the public path
 * 'published'  visible in the shared catalog and to vector search
 * 'blocked'    quarantined; never returned, and not reachable by editing
 * 'superseded' terminal, so a withdrawn version cannot be resurrected
 */
export type PublicationState = 'pending' | 'published' | 'blocked' | 'superseded'

export interface LibraryIngestRequest {
  document: {
    id: string
    collectionSlug: string
    title: string
    sourcePath: string
    kind: SourceKind
    content: string
    provenance?: SourceProvenance | null
    sortOrder?: number
  }
  source: {
    id: string
    title: string
    sourcePath: string
    kind: SourceKind
    content: string
    fileType?: string | null
    createdAt?: string
  }
  chunks: unknown[]
}

export interface LibraryIngestResult {
  documentId: string | null
  publicationState: PublicationState | null
  /** True when an edit withdrew an already published document back to pending. */
  withdrawn: boolean
  /** True when the content hash matched and nothing was written. */
  unchanged: boolean
  chunkCount: number
}

/**
 * Submits content to the shared library. There is no argument that publishes:
 * a new document is created 'pending', and editing a published one withdraws it
 * back to 'pending' so a reader never receives an unreviewed change.
 */
export const submitLibraryDocument = (request: LibraryIngestRequest) => (
  requestJson<LibraryIngestResult>('/api/library/ingest', request)
)

/**
 * Builds an ingest payload from a locally indexed document.
 *
 * The source id is the document id, deliberately: one local document owns one
 * shared source, so re-submitting the same document adopts its own source rather
 * than colliding with anyone else's. The database rejects a source id already
 * claimed by a different document, so a guessed or copied id cannot re-point
 * another person's lineage.
 */
export const toIngestRequest = (
  document: DocumentRecord,
  collectionSlug: string,
): LibraryIngestRequest => ({
  document: {
    id: document.id,
    collectionSlug,
    title: document.title,
    sourcePath: document.source,
    kind: document.kind,
    content: document.content,
    provenance: document.provenance ?? null,
  },
  source: {
    id: document.id,
    title: document.title,
    sourcePath: document.source,
    kind: document.kind,
    content: document.content,
    createdAt: document.createdAt,
  },
  chunks: document.chunks.map((chunk) => ({
    id: chunk.id,
    index: chunk.index,
    text: chunk.text,
    start: chunk.start,
    end: chunk.end,
    neuralEmbedding: chunk.neuralEmbedding ?? null,
  })),
})

export interface LibraryDocumentStatus {
  id: string
  collectionSlug: string
  title: string
  publicationState: PublicationState
  chunkCount: number
}

/**
 * The reviewer's queue. Restricted to allowlisted publishers, because the 6D2A
 * catalog deliberately cannot show unpublished work and the list of pending
 * submissions is not public information.
 */
export const requestLibraryStatus = (collectionSlug?: string) => (
  requestJson<{ documents: LibraryDocumentStatus[] }>(
    '/api/library/status',
    collectionSlug ? { collectionSlug } : {},
  )
)

export interface PublicationChangeResult {
  documentId: string
  previousState: PublicationState | null
  currentState: PublicationState | null
}

/**
 * Moves a document between publication states. Rejected with
 * 'publish_not_permitted' unless the signed-in account is in the deployment's
 * TRACEWORK_PUBLISHERS allowlist; the legal transitions are enforced in the
 * database, not here.
 */
export const setLibraryPublicationState = (documentId: string, state: PublicationState) => (
  requestJson<PublicationChangeResult>('/api/library/publish', { documentId, state })
)

/**
 * Chunks a library document for the local index while keeping the database id,
 * so two devices indexing the same library row produce the same source id
 * instead of two duplicate rows in the shared vector table.
 */
export const toIndexedDocument = (document: KnowledgeLibraryDocument): DocumentRecord => ({
  ...createDocument(document.title, document.sourcePath, document.content, document.kind, {
    id: document.id,
    provenance: document.provenance ?? undefined,
  }),
  libraryCollection: document.collectionSlug,
})
