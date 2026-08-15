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
