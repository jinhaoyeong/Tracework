import { buildSynthesisInspector, type SynthesisInspectorModel } from '../lib/synthesisInspector'
import type { SynthesisGenerationReportModel } from '../lib/synthesisAnswerView'
import type { SynthesisPreparationResult } from '../lib/synthesisOrchestrator'

const statusLabel = (value: string) => value.replace(/-/g, ' ')

const SynthesisFacetDetails = ({ facet }: { facet: SynthesisInspectorModel['facets'][number] }) => (
  <details className="synthesis-inspector-facet">
    <summary>
      <span className="synthesis-inspector-summary-label">
        <strong>{facet.label}</strong>
        <small>{facet.kind}{facet.parentId ? ` / child of ${facet.parentId}` : ''}</small>
      </span>
      <span className={`synthesis-inspector-status is-${facet.coverageStatus}`}>{statusLabel(facet.coverageStatus)}</span>
    </summary>
    <div className="synthesis-inspector-facet-body">
      <div className="synthesis-inspector-subgrid">
        <div><span>discovery signals</span><strong>{facet.discoverySignals.join(', ') || 'none'}</strong></div>
        <div><span>lexical aliases</span><strong>{facet.lexicalAliasCount}</strong></div>
        <div><span>requirements</span><strong>{facet.requirements.length}</strong></div>
        <div><span>required / critical</span><strong>{facet.requirements.filter((requirement) => requirement.required).length} / {facet.requirements.filter((requirement) => requirement.critical).length}</strong></div>
        <div><span>retrieval queries</span><strong>{facet.retrievalQueryCount} ({facet.aliasQueryCount} alias)</strong></div>
        <div><span>union / selected / reasoned</span><strong>{facet.unionCandidateCount} / {facet.selectedCandidateCount} / {facet.reasoningContextCount}</strong></div>
        <div><span>restored witnesses</span><strong>{facet.restoredWitnesses.length}</strong></div>
        <div><span>temporal</span><strong>{facet.temporal.status} / {facet.temporal.disposition}</strong></div>
        <div><span>provenance</span><strong>{facet.provenance.status}</strong></div>
      </div>

      <details className="synthesis-inspector-nested">
        <summary>runtime requirements ({facet.requirements.length})</summary>
        {facet.requirements.length ? <ul>
          {facet.requirements.map((requirement) => (
            <li key={requirement.id}>
              <strong>{requirement.dimension ?? requirement.kind}</strong>
              <span>{requirement.evidenceKind} / {requirement.required ? 'required' : 'optional'} / {requirement.critical ? 'critical' : 'non-critical'}</span>
            </li>
          ))}
        </ul> : <p className="synthesis-inspector-empty">No broad requirements were materialized.</p>}
      </details>

      <details className="synthesis-inspector-nested">
        <summary>queries ({facet.retrievalQueryCount})</summary>
        <ul>
          {facet.retrievalQueries.map((query, index) => <li key={`${facet.facetId}-query-${index}`}><code>{query}</code></li>)}
        </ul>
      </details>

      <details className="synthesis-inspector-nested">
        <summary>proposition coverage ({facet.propositions.length})</summary>
        {facet.propositions.length ? <ul>
          {facet.propositions.map((proposition) => (
            <li key={proposition.id}>
              <strong>{proposition.status}</strong>
              <span>{proposition.id} / {proposition.supportingChunkIds.length} witness{proposition.supportingChunkIds.length === 1 ? '' : 'es'}</span>
            </li>
          ))}
        </ul> : <p className="synthesis-inspector-empty">No proposition-level coverage was produced.</p>}
      </details>

      <details className="synthesis-inspector-nested">
        <summary>reasoning details</summary>
        <p><strong>temporal:</strong> {facet.temporal.notice}</p>
        <p><strong>provenance:</strong> {facet.provenance.notice}</p>
        {facet.restoredWitnesses.length ? <ul>
          {facet.restoredWitnesses.map((witness) => <li key={`${witness.chunkId}-${witness.reason}`}><strong>{witness.reason}</strong><span>{witness.chunkId}</span></li>)}
        </ul> : <p className="synthesis-inspector-empty">No witnesses were restored beyond the ordinary selected context.</p>}
      </details>

      {facet.missingPropositions.length ? <p className="synthesis-inspector-warning">Missing: {facet.missingPropositions.join(', ')}</p> : null}
    </div>
  </details>
)

/**
 * What the generation boundary actually did. Request count and provider flag are
 * read from the Step 10A result, so a deterministic hold can be told apart from
 * a request that was made and came back badly cited.
 */
export type SynthesisGenerationReport = SynthesisGenerationReportModel

const GenerationReport = ({ report }: { report: SynthesisGenerationReport }) => (
  <details className="synthesis-inspector-nested synthesis-inspector-generation" open>
    <summary>generation boundary</summary>
    <div className="synthesis-inspector-budget">
      <div><span>status</span><strong>{statusLabel(report.status)}</strong></div>
      <div><span>generation requests</span><strong>{report.requests}</strong></div>
      <div><span>provider called</span><strong>{report.providerCalled ? 'yes' : 'no'}</strong></div>
      <div><span>model</span><strong>{report.model ?? 'none'}</strong></div>
      <div><span>context characters</span><strong>{report.contextCharacters === null ? 'not built' : report.contextCharacters.toLocaleString()}</strong></div>
      <div><span>context budget</span><strong>{report.contextBudget.toLocaleString()}</strong></div>
      <div><span>evidence references</span><strong>{report.evidenceReferences ?? 'none'}</strong></div>
      <div><span>valid citations</span><strong>{report.validCitationCount}</strong></div>
    </div>
    {report.invalidCitationMarkers.length
      ? <p className="synthesis-inspector-warning">Rejected markers: {report.invalidCitationMarkers.join(', ')}</p>
      : null}
    {report.message ? <p>{report.message}</p> : null}
    <p className="synthesis-inspector-empty">
      Citation validation confirms every marker resolves to supplied packet evidence. It does not prove the cited passage entails the sentence citing it.
    </p>
  </details>
)

export function SynthesisInspector({ preparation, generation }: {
  preparation: SynthesisPreparationResult | null
  generation?: SynthesisGenerationReport | null
}) {
  if (!preparation) return null
  const model = buildSynthesisInspector(preparation)
  const isFocused = model.route === 'focused'

  return (
    <section className="synthesis-inspector-section" aria-labelledby="synthesis-inspector-title">
      <div className="synthesis-inspector-heading">
        <div>
          <div className="section-marker"><span className="marker-line" /> phase 5E / synthesis preparation <span className="marker-line short" /></div>
          <h2 id="synthesis-inspector-title">Make breadth inspectable.</h2>
        </div>
        <span className={`synthesis-inspector-badge is-${isFocused ? 'focused' : model.disposition}`}>{isFocused ? 'focused path' : statusLabel(model.disposition)}</span>
      </div>

      <div className="synthesis-inspector-stat-grid">
        <div><span>initial mode</span><strong>{model.initialMode}</strong><small>{model.classifierReason}</small></div>
        <div><span>scope refinement</span><strong>{statusLabel(model.scopeRefinement)}</strong><small>{model.routeReason}</small></div>
        <div><span>selected / runtime facets</span><strong>{model.discoveredFacetCount} / {model.runtimeFacetCount}</strong><small>{model.requirements.length} requirements / {model.coveredFacetCount} covered / {model.partialFacetCount} partial / {model.unsupportedFacetCount} unsupported / {model.conflictedFacetCount} conflicted</small></div>
        <div><span>provider called</span><strong>{generation?.providerCalled ? 'yes' : 'no'}</strong><small>{generation ? `${generation.requests} generation request${generation.requests === 1 ? '' : 's'}` : 'deterministic preparation only'}</small></div>
      </div>

      <div className="synthesis-inspector-budget">
        <div><span>as of</span><strong>{model.asOf}</strong></div>
        <div><span>requested period</span><strong>{model.requestedPeriod ?? 'none'}</strong></div>
        <div><span>retrieval queries</span><strong>{model.queryBudget.totalRetrievalQueries}</strong></div>
        <div><span>max / facet</span><strong>{model.queryBudget.maxQueriesPerFacet}</strong></div>
        <div><span>alias queries</span><strong>{model.queryBudget.aliasDerivedQueries}</strong></div>
        <div><span>unique union chunks</span><strong>{model.queryBudget.uniqueRetrievedChunks}</strong></div>
        <div><span>packet claims / chunks</span><strong>{model.packet.claimCount} / {model.packet.chunkCount}</strong></div>
      </div>

      <p className={`synthesis-inspector-notice is-${isFocused ? 'focused' : model.disposition}`}>
        {isFocused
          ? 'This request returned to the existing focused QA path. No broad synthesis context was built.'
          : model.disposition === 'answer'
            ? generation
              ? `The structured synthesis packet is ready. ${generation.requests === 1 ? 'One generation request was made from it.' : 'No generation request was made.'}`
              : 'The structured synthesis packet is ready. Final prose generation has not been called.'
            : model.dispositionReason}
      </p>

      {generation ? <GenerationReport report={generation} /> : null}

      <details className="synthesis-inspector-nested synthesis-inspector-plan">
        <summary>classifier and requirement plan</summary>
        <p><strong>signals:</strong> {model.classifierSignals.join(', ') || 'none'}</p>
        <p><strong>requirements:</strong> {model.requirements.length ? model.requirements.map((requirement) => `${requirement.facetId}:${requirement.dimension ?? requirement.kind}`).join(' · ') : 'none'}</p>
      </details>

      {model.facets.length ? <div className="synthesis-inspector-facets">
        {model.facets.map((facet) => <SynthesisFacetDetails key={facet.facetId} facet={facet} />)}
      </div> : null}

      {model.rejectedCandidates.length ? <details className="synthesis-inspector-nested synthesis-inspector-rejected">
        <summary>rejected discovery candidates ({model.rejectedCandidates.length})</summary>
        <ul>
          {model.rejectedCandidates.map((candidate) => <li key={candidate.id}><strong>{candidate.label}</strong><span>{candidate.reason ?? 'rejected'} / {candidate.signals.join(', ')}</span></li>)}
        </ul>
      </details> : null}
    </section>
  )
}
