import { Icon } from './Icon'
import type { SynthesisAnswerView } from '../lib/synthesisAnswerView'

/**
 * The broad-answer citation rail.
 *
 * Every row comes from Step 10A's deduplicated reference table, so the marker
 * the reader sees is the marker the validator resolved. Rows carry the chunk id
 * because that, not the document title, is what makes a citation traceable back
 * through the packet to the facets that admitted it.
 *
 * Presence of a row means the marker resolved to supplied evidence. It does not
 * mean the cited passage entails the sentence citing it.
 */
export function SynthesisAnswerCitations({ view, onSelectChunk }: {
  view: SynthesisAnswerView
  onSelectChunk: (chunkId: string) => void
}) {
  if (!view.citations.length) {
    return <div className="citation-empty">{view.citationEmptyMessage}</div>
  }

  return (
    <>
      {view.citations.map((citation) => (
        <button className="citation-line" key={citation.chunkId} type="button" onClick={() => onSelectChunk(citation.chunkId)}>
          <span className="citation-number">[{citation.citation}]</span>
          <span>
            <strong>{citation.documentTitle}</strong>
            <small>packet reference {String(citation.citation).padStart(2, '0')} · {citation.chunkId}</small>
          </span>
          <Icon name="arrow" size={16} />
        </button>
      ))}
    </>
  )
}
