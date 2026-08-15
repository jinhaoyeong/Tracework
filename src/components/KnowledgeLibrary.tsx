import { Icon } from './Icon'
import type {
  CollectionScope,
  KnowledgeCollection,
  LibraryDocumentStatus,
  PublicationState,
} from '../lib/knowledgeLibrary'

export type LibraryStatus = 'idle' | 'loading' | 'ready' | 'error'

/**
 * Phase 6E. Mirrors the state machine in
 * 20260815081045_tracework_6e_explicit_publication.sql exactly, so the UI never
 * offers a transition the database will reject. 'superseded' is terminal, which
 * is why it maps to no actions: a withdrawn version cannot be resurrected into
 * the public catalog by a state change alone.
 *
 * Exported so the offline suite can assert it against the migration SQL rather
 * than trusting that the two stay in step by hand.
 */
export const REVIEW_TRANSITIONS: Record<PublicationState, readonly PublicationState[]> = {
  pending: ['published', 'blocked'],
  published: ['superseded', 'blocked'],
  blocked: ['pending'],
  superseded: [],
}

const REVIEW_ACTION_LABELS: Record<PublicationState, string> = {
  published: 'publish',
  blocked: 'block',
  pending: 'reopen',
  superseded: 'supersede',
}

const formatCharacters = (count: number) => {
  if (count < 1000) return `${count} chars`
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k chars`
  return `${(count / 1_000_000).toFixed(1)}M chars`
}

/**
 * Private and workspace entries carry no counts, because the only count the
 * database computes is "published documents in a public collection". Rendering
 * a placeholder rather than a zero keeps an uncounted collection from reading as
 * an empty one.
 */
const formatDocumentCount = (count: number | null | undefined) => {
  // Null means "not computed for this scope", never "unpublished" and never
  // zero: the only count the database produces is published documents inside a
  // public collection.
  if (count === null || count === undefined) return 'count unavailable'
  return `${count} ${count === 1 ? 'source' : 'sources'}`
}

/**
 * UNREACHABLE while Phase 6D4A is deferred. The composed catalog path is the
 * only thing that can attach a scope to a row, and it needs both the 6D4A grants
 * (unapplied) and TRACEWORK_AUTHENTICATED_LIBRARY_READS (unset). Every row the
 * catalog returns today is public, so no badge renders. Kept, not deleted,
 * because the code is inert rather than wrong - see supabase/deferred/README.md.
 */
const SCOPE_LABELS: Record<CollectionScope, string | null> = {
  public: null,
  private: 'private',
  workspace: 'workspace',
}

export function KnowledgeLibrary({
  status,
  message,
  collections,
  indexedSlugs,
  pendingSlug,
  onRefresh,
  onAdd,
  onRemove,
  reviewQueue,
  reviewPendingId = null,
  reviewMessage = null,
  onChangePublicationState,
  onRefreshReview,
  contributable,
  contributeTargets,
  contributePendingId = null,
  contributeMessage = null,
  onSubmitDocument,
}: {
  status: LibraryStatus
  message: string | null
  collections: KnowledgeCollection[]
  indexedSlugs: Set<string>
  pendingSlug: string | null
  onRefresh: () => void
  onAdd: (slug: string) => void
  onRemove: (slug: string) => void
  /**
   * Phase 6E review queue. Optional, and absent for every caller that is not an
   * allowlisted publisher - including the current App wiring, so this panel is
   * inert until a reviewer surface is connected. The server refuses the
   * underlying routes regardless of what this component renders.
   */
  reviewQueue?: LibraryDocumentStatus[]
  reviewPendingId?: string | null
  reviewMessage?: string | null
  onChangePublicationState?: (documentId: string, next: PublicationState) => void
  onRefreshReview?: () => void
  /**
   * Phase 6E contribution. Locally indexed documents the signed-in reader can
   * submit to a shared collection. Submission creates a 'pending' row that no
   * reader can see until a publisher promotes it.
   */
  contributable?: { id: string; title: string; chunkCount: number }[]
  contributeTargets?: { slug: string; title: string }[]
  contributePendingId?: string | null
  contributeMessage?: string | null
  onSubmitDocument?: (documentId: string, collectionSlug: string) => void
}) {
  return (
    <section className="library-block" aria-labelledby="library-title">
      <div className="library-heading">
        <div>
          <span className="rail-code">library / shared</span>
          <h2 id="library-title">Knowledge library</h2>
        </div>
        <button className="library-refresh" type="button" onClick={onRefresh} disabled={status === 'loading'}>
          {status === 'loading' ? 'reading...' : 'refresh'}
        </button>
      </div>
      {/*
        This text must not promise cloud-private storage. Phase 6D4A, which would
        have made owned and workspace collections visible to their owner, is
        deferred and unapplied (see supabase/deferred/README.md), so the catalog
        returns public collections and nothing else. Knowledge kept out of the
        shared library stays in this browser.
      */}
      <p className="library-intro">
        Collections stored in the shared database. Everyone opening Tracework reads the same catalog, and adding one indexes it into this browser. Anything you do not submit stays on this device only &mdash; there is no private cloud storage yet.
      </p>

      {status === 'error' && (
        <div className="library-state is-error" role="status">
          <strong>library unavailable</strong>
          <span>{message ?? 'The shared library could not be read.'}</span>
        </div>
      )}

      {status === 'loading' && !collections.length && (
        <div className="library-state" role="status">reading the shared catalog...</div>
      )}

      {status === 'ready' && !collections.length && (
        <div className="library-state" role="status">
          <strong>the library is empty</strong>
          <span>Run npm run seed:library to publish the bundled collections into the database.</span>
        </div>
      )}

      {collections.length > 0 && (
        <ul className="library-list">
          {collections.map((collection) => {
            const isIndexed = indexedSlugs.has(collection.slug)
            const isPending = pendingSlug === collection.slug
            return (
              <li key={collection.slug} className={isIndexed ? 'is-indexed' : ''}>
                <div className="library-item-head">
                  <Icon name={isIndexed ? 'check' : 'archive'} size={15} />
                  <strong>{collection.title}</strong>
                  <span className="library-item-state">{isIndexed ? 'indexed' : 'in library'}</span>
                </div>
                <p>{collection.description}</p>
                <div className="library-item-meta">
                  {SCOPE_LABELS[collection.scope ?? 'public'] && (
                    <span className="library-item-scope">{SCOPE_LABELS[collection.scope ?? 'public']}</span>
                  )}
                  <span>{formatDocumentCount(collection.documentCount)}</span>
                  {typeof collection.characterCount === 'number' && (
                    <span>{formatCharacters(collection.characterCount)}</span>
                  )}
                  <span>{collection.provenance?.authority ?? 'unknown'} authority</span>
                </div>
                <button
                  className="library-item-action"
                  type="button"
                  disabled={isPending}
                  onClick={() => (isIndexed ? onRemove(collection.slug) : onAdd(collection.slug))}
                >
                  {isPending
                    ? 'indexing...'
                    : isIndexed
                      ? 'remove from this index'
                      : 'add to index'}
                  <Icon name={isIndexed ? 'x' : 'plus'} size={15} />
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {/*
        Phase 6E contribution. Submitting sends a locally indexed document to a
        shared collection as 'pending'. It is invisible to every reader until a
        publisher promotes it, so this button shares nothing by itself.
      */}
      {contributable && contributable.length > 0 && (
        <div className="library-review" role="region" aria-labelledby="library-contribute-title">
          <span className="rail-code">library / contribute</span>
          <h3 id="library-contribute-title">Submit to a shared collection</h3>
          {!contributeTargets?.length && (
            <p className="library-note">
              No collection accepts submissions yet. A submission needs a public collection that is not system-managed; the bundled and quarantine collections are managed and reject contributions.
            </p>
          )}
          {contributeTargets && contributeTargets.length > 0 && (
            <ul className="library-review-list">
              {contributable.map((document) => {
                const isBusy = contributePendingId === document.id
                return (
                  <li key={document.id}>
                    <div className="library-item-head">
                      <strong>{document.title}</strong>
                      <span className="library-item-state">{document.chunkCount} chunks</span>
                    </div>
                    <div className="library-review-actions">
                      {contributeTargets.map((target) => (
                        <button
                          key={target.slug}
                          className="library-item-action"
                          type="button"
                          disabled={isBusy || !onSubmitDocument}
                          onClick={() => onSubmitDocument?.(document.id, target.slug)}
                        >
                          {isBusy ? 'submitting...' : `submit to ${target.title}`}
                        </button>
                      ))}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          {contributeMessage && <p className="library-note">{contributeMessage}</p>}
        </div>
      )}

      {/*
        Phase 6E. Submitted work is 'pending' and the 6D2A catalog above cannot
        show it: that path returns published rows in public collections only,
        which is the containment 6D2A exists to enforce. This panel is the only
        place unpublished work is visible, and only to a reviewer.
      */}
      {(reviewQueue || onRefreshReview) && (
        <div className="library-review" role="region" aria-labelledby="library-review-title">
          <span className="rail-code">library / review</span>
          <h3 id="library-review-title">Awaiting review</h3>
          {onRefreshReview && (
            <button className="library-refresh" type="button" onClick={onRefreshReview}>
              load review queue
            </button>
          )}
          {reviewQueue && reviewQueue.length === 0 && (
            <p className="library-note">Nothing is awaiting review.</p>
          )}
          <ul className="library-review-list">
            {(reviewQueue ?? []).map((document) => {
              const transitions = REVIEW_TRANSITIONS[document.publicationState] ?? []
              const isBusy = reviewPendingId === document.id
              return (
                <li key={document.id}>
                  <div className="library-item-head">
                    <strong>{document.title}</strong>
                    <span className="library-item-state">{document.publicationState}</span>
                  </div>
                  <div className="library-item-meta">
                    <span>{document.collectionSlug}</span>
                    <span>{document.chunkCount} indexed {document.chunkCount === 1 ? 'chunk' : 'chunks'}</span>
                  </div>
                  <div className="library-review-actions">
                    {transitions.length === 0 && <span className="library-note">terminal state</span>}
                    {transitions.map((next) => (
                      <button
                        key={next}
                        className="library-item-action"
                        type="button"
                        disabled={isBusy || !onChangePublicationState}
                        onClick={() => onChangePublicationState?.(document.id, next)}
                      >
                        {isBusy ? 'saving...' : REVIEW_ACTION_LABELS[next]}
                      </button>
                    ))}
                  </div>
                </li>
              )
            })}
          </ul>
          {reviewMessage && <p className="library-note">{reviewMessage}</p>}
        </div>
      )}

      {status === 'ready' && message && <p className="library-note">{message}</p>}
    </section>
  )
}
