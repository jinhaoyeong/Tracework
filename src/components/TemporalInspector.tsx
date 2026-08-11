import { Icon } from './Icon'
import type { TemporalCoverageReport, TemporalQueryRelevance } from '../lib/temporalCoverage'
import type { RequestedPeriodReading, TemporalDisposition, TemporalHoldReason, TemporalResolution } from '../lib/temporalResolution'

/**
 * Phase 5D step 9: why the temporal layer decided what it decided.
 *
 * Phase 5D is now sophisticated enough that the final answer no longer explains
 * itself. This panel shows the reference time actually used, the claims and
 * relations considered, what coverage restored or could not fit, and whether the
 * provider was called -- so a decision can be inspected rather than trusted.
 */

const HOLD_LABELS: Record<TemporalHoldReason, string> = {
  multiple_applicable_propositions: 'several versions apply and none supersedes the others',
  temporal_evidence_insufficient: 'a change is visible but its applicability is not established',
  unestablished_subject: 'a claim’s subject could not be established',
  unparseable_reference: 'the reference period could not be parsed',
  incomplete_temporal_evidence: 'required supersession evidence did not fit the context budget',
}

export function TemporalInspector({
  resolution,
  coverage,
  gate,
  relevance,
  periodReading,
  asOf,
  onAsOfChange,
  onUseNow,
  onSelect,
}: {
  resolution: TemporalResolution
  coverage: TemporalCoverageReport
  gate: { disposition: TemporalDisposition; holdReason: TemporalHoldReason | null; proceedReason?: string }
  relevance: TemporalQueryRelevance
  periodReading: RequestedPeriodReading
  asOf: string
  onAsOfChange: (value: string) => void
  onUseNow: () => void
  onSelect: (chunkId: string) => void
}) {
  const isHold = gate.disposition === 'hold'
  const isIrrelevant = !relevance.relevant && resolution.assessments.length > 0
  const effectiveTime = resolution.requestedPeriod ?? asOf
  const claims = resolution.assessments

  return (
    <section className="temporal-section" aria-labelledby="temporal-title">
      <div className="temporal-heading">
        <div>
          <div className="section-marker"><span className="marker-line" /> phase 5D / temporal applicability <span className="marker-line short" /></div>
          <h2 id="temporal-title">Which version applies, and when.</h2>
        </div>
        <span className={`temporal-badge is-${isHold ? 'hold' : resolution.status}`}>
          {isHold ? 'hold' : resolution.status}
        </span>
      </div>

      <div className="temporal-clock">
        <label>
          <span>as of</span>
          <input
            type="date"
            value={asOf}
            onChange={(event) => onAsOfChange(event.target.value)}
            aria-label="Reference date for temporal applicability"
          />
        </label>
        <button type="button" onClick={onUseNow}>now</button>
        <div className="temporal-clock-derived">
          <div>
            <span>requested period</span>
            <strong className={periodReading.reason === 'ambiguous' ? 'is-ambiguous' : undefined}>
              {periodReading.reason === 'ambiguous'
                ? `multiple: ${periodReading.found.join(', ')}`
                : resolution.requestedPeriod ?? 'none'}
            </strong>
          </div>
          <div><span>as-of fallback</span><strong>{asOf}</strong></div>
          <div>
            <span>effective applicability</span>
            <strong>{periodReading.reason === 'ambiguous' ? 'not derived' : effectiveTime}</strong>
          </div>
        </div>
      </div>

      <div className="temporal-stat-grid">
        <div><span>status</span><strong>{resolution.status}</strong><small>what the evidence supports</small></div>
        <div><span>question relevance</span><strong className={isIrrelevant ? 'is-irrelevant' : undefined}>{isIrrelevant ? 'not relevant' : 'relevant'}</strong><small>{isIrrelevant ? 'findings concern another subject' : 'findings concern this subject'}</small></div>
        <div>
          <span>applicable to question</span>
          {/* Never headline a value the question did not ask about. The claim is
              still listed below for inspection; it is simply not an answer here. */}
          <strong>{isIrrelevant ? 'not used' : resolution.resolvedValue ?? '—'}</strong>
          <small>{isIrrelevant ? 'no temporal subject matches the question' : `${resolution.resolvedClaims.length} selected claim${resolution.resolvedClaims.length === 1 ? '' : 's'}`}</small>
        </div>
        <div><span>provider called</span><strong>{isHold ? 'no' : 'yes, if generating'}</strong><small>{isHold ? 'answered locally from evidence' : 'context passes to generation'}</small></div>
      </div>

      {isHold && gate.holdReason && (
        <p className="temporal-hold-notice" role="status">
          <strong>{gate.holdReason}</strong> — {HOLD_LABELS[gate.holdReason]}
        </p>
      )}
      {isIrrelevant && (
        <p className="temporal-relevance-note" role="status">
          Temporal claims were found in the retrieved evidence, but they concern another subject
          {relevance.unmatchedSubjectKeys.length ? ` (${relevance.unmatchedSubjectKeys.join(', ')})` : ''}
          , not what this question asks about. The findings are reported rather than hidden, but they do not authorise a hold here.
        </p>
      )}
      {periodReading.reason === 'ambiguous' && (
        <p className="temporal-ambiguous-note" role="status">
          This question names more than one period, so it has no single applicability time. Tracework will not pick one of them; comparing across periods is not something it can do yet.
        </p>
      )}
      <p className="temporal-notice">{resolution.notice}</p>

      <div className="temporal-grid">
        <div className="temporal-column">
          <div className="temporal-column-heading"><h3>CLAIMS CONSIDERED</h3><span>{claims.length ? `${claims.length} claims` : 'empty'}</span></div>
          {claims.length ? <ul className="temporal-claims">
            {claims.map((assessment) => (
              <li key={assessment.claim.claimId} className={`is-${assessment.state}`}>
                <button type="button" onClick={() => onSelect(assessment.claim.claim.result.chunk.id)}>
                  <span className="temporal-claim-value">{assessment.claim.claim.value}</span>
                  <span className={`temporal-claim-state is-${assessment.state}`}>{assessment.state}</span>
                  <small>valid from {assessment.claim.validFrom ?? 'undated'} · {assessment.claim.claim.source}</small>
                  <small className="temporal-claim-reason">{assessment.reason}</small>
                </button>
              </li>
            ))}
          </ul> : <div className="temporal-empty">No temporal claim was extracted. Applicability does not apply to this question.</div>}
        </div>

        <div className="temporal-column">
          <div className="temporal-column-heading"><h3>RELATIONS &amp; COVERAGE</h3><span>{resolution.boundaries.length ? `${resolution.boundaries.length} relations` : 'none'}</span></div>
          {resolution.boundaries.length ? <ul className="temporal-relations">
            {resolution.boundaries.map((boundary, index) => (
              <li key={`${boundary.kind}-${index}`}>
                <strong>{boundary.kind} from {boundary.startsAt}</strong>
                {/* The evidence sentence, so a relation can be checked against
                    the words that produced it rather than taken on trust. */}
                <small className="temporal-relation-evidence">“{boundary.sentence}”</small>
              </li>
            ))}
          </ul> : <div className="temporal-empty">No supersession relation was derived from the evidence.</div>}

          <div className="temporal-coverage">
            <div className="temporal-column-heading"><h3>COVERAGE</h3><span className={coverage.complete ? '' : 'is-incomplete'}>{coverage.complete ? 'complete' : 'incomplete'}</span></div>
            {coverage.witnesses.length ? (
              <ul className="temporal-witnesses">
                {coverage.witnesses.map((witness) => {
                  const omitted = coverage.omitted.some((entry) => entry.chunkId === witness.chunk.id)
                  return (
                    <li key={witness.chunk.id} className={omitted ? 'is-omitted' : ''}>
                      <Icon name={omitted ? 'x' : 'check'} size={14} />
                      <span>{witness.document.title}</span>
                      <small>{omitted ? 'could not fit the budget' : 'present in context'}</small>
                    </li>
                  )
                })}
              </ul>
            ) : <div className="temporal-empty">No supersession witness was required.</div>}
            {!coverage.complete && (
              <p className="temporal-incomplete-note">
                A supersession is proved by a witness pair. Rather than answer from half a relation, Tracework holds and says so.
              </p>
            )}
          </div>
        </div>
      </div>

      <p className="grounded-debug-note">
        The reference time is read once, here in the interface, and passed down as a fixed value. Temporal resolution never reads a clock, never assumes the newest document wins, and never lets source authority settle a tie between two simultaneously applicable versions.
      </p>
    </section>
  )
}
