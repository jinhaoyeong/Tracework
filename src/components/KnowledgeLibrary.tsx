import { Icon } from './Icon'
import type { KnowledgeCollection } from '../lib/knowledgeLibrary'

export type LibraryStatus = 'idle' | 'loading' | 'ready' | 'error'

const formatCharacters = (count: number) => {
  if (count < 1000) return `${count} chars`
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k chars`
  return `${(count / 1_000_000).toFixed(1)}M chars`
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
}: {
  status: LibraryStatus
  message: string | null
  collections: KnowledgeCollection[]
  indexedSlugs: Set<string>
  pendingSlug: string | null
  onRefresh: () => void
  onAdd: (slug: string) => void
  onRemove: (slug: string) => void
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
      <p className="library-intro">
        Collections stored in the shared database. Anyone opening Tracework reads the same catalog; adding one indexes it into this browser.
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
                  <span>{collection.documentCount} {collection.documentCount === 1 ? 'source' : 'sources'}</span>
                  <span>{formatCharacters(collection.characterCount)}</span>
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

      {status === 'ready' && message && <p className="library-note">{message}</p>}
    </section>
  )
}
