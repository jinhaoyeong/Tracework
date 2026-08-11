import type { SearchResult } from '../types.ts'
import type { TemporalNormalization } from './temporalNormalization.ts'
import type { TemporalDisposition, TemporalHoldReason, TemporalResolution } from './temporalResolution.ts'

/**
 * Phase 5D step 7: preserve evidence needed to prove a supersession relation.
 *
 * Claim extraction and normalization happen over the PRE-pruning ranked pool.
 * This function only changes the context selection: it never changes ranking,
 * deletes a claim, or decides which value applies. Temporal resolution remains
 * a separate step after this coverage pass.
 */

const uniqueResults = (results: SearchResult[]) => results.filter((result, index, all) => (
  all.findIndex((candidate) => candidate.chunk.id === result.chunk.id) === index
))

/**
 * Return both endpoints of every expanded supersession relation. Keeping both
 * endpoints makes the resolved period and the historical period inspectable;
 * it also restores the superseding endpoint when pruning kept only the stale
 * claim, which is the T7 failure mode.
 */
export const temporalCoverageWitnesses = (normalization: TemporalNormalization): SearchResult[] => {
  const claimsById = new Map(normalization.claims.map((claim) => [claim.claimId, claim]))
  return uniqueResults(normalization.relations.flatMap((relation) => {
    const superseding = claimsById.get(relation.supersedingClaimId)?.claim.result
    const superseded = claimsById.get(relation.supersededClaimId)?.claim.result
    return [superseding, superseded].filter((result): result is SearchResult => Boolean(result))
  }))
}

export const temporalCoverageWitnessChunkIds = (normalization: TemporalNormalization): ReadonlySet<string> => (
  new Set(temporalCoverageWitnesses(normalization).map((result) => result.chunk.id))
)

export interface TemporalCoverageReport {
  /** The context after restoration. */
  results: SearchResult[]
  witnesses: SearchResult[]
  /** Witnesses present in the final context. */
  admitted: string[]
  /** Witnesses that could not be admitted under the context budget. */
  omitted: Array<{ chunkId: string; source: string }>
  /** False when a required witness did not fit. */
  complete: boolean
}

/**
 * Restore missing temporal witnesses without evicting an existing witness
 * supplied by either coverage pass, and report what could not fit.
 *
 * Recall must never be bought with evidentiary completeness. When the witness
 * pair proving a supersession cannot fit under maxChunks, the honest outcome is
 * a recorded shortfall, not a context holding half a relation from which the
 * resolver would answer as though the whole relation were present.
 */
export const planTemporalCoverage = (
  normalization: TemporalNormalization,
  selected: SearchResult[],
  maxChunks?: number,
  protectedChunkIds: ReadonlySet<string> = new Set(),
): TemporalCoverageReport => {
  const witnessResults = temporalCoverageWitnesses(normalization)
  if (!witnessResults.length) {
    return { results: selected, witnesses: [], admitted: [], omitted: [], complete: true }
  }

  const output = [...selected]
  const witnessIds = new Set(witnessResults.map((result) => result.chunk.id))
  const preservedIds = new Set([...witnessIds, ...protectedChunkIds])

  witnessResults.forEach((witness) => {
    if (output.some((result) => result.chunk.id === witness.chunk.id)) return
    if (maxChunks === undefined || output.length < maxChunks) {
      output.push(witness)
      return
    }

    const removableIndex = [...output].reverse().findIndex((result) => !preservedIds.has(result.chunk.id))
    if (removableIndex >= 0) output.splice(output.length - 1 - removableIndex, 1, witness)
  })

  const presentIds = new Set(output.map((result) => result.chunk.id))
  const omitted = witnessResults
    .filter((witness) => !presentIds.has(witness.chunk.id))
    .map((witness) => ({ chunkId: witness.chunk.id, source: witness.document.title }))

  return {
    results: output,
    witnesses: witnessResults,
    admitted: witnessResults.filter((witness) => presentIds.has(witness.chunk.id)).map((witness) => witness.chunk.id),
    omitted,
    complete: omitted.length === 0,
  }
}

export const ensureTemporalCoverage = (
  normalization: TemporalNormalization,
  selected: SearchResult[],
  maxChunks?: number,
  protectedChunkIds: ReadonlySet<string> = new Set(),
): SearchResult[] => planTemporalCoverage(normalization, selected, maxChunks, protectedChunkIds).results

/**
 * The temporal layer's final gate: the resolver's own disposition, plus the
 * separate fact that required evidence may not have fitted the context. Either
 * one is sufficient to hold.
 */
export const temporalGate = (
  resolution: Pick<TemporalResolution, 'disposition' | 'holdReason'>,
  coverage: Pick<TemporalCoverageReport, 'complete'>,
): { disposition: TemporalDisposition; holdReason: TemporalHoldReason | null } => {
  if (!coverage.complete) return { disposition: 'hold', holdReason: 'incomplete_temporal_evidence' }
  return { disposition: resolution.disposition, holdReason: resolution.holdReason }
}
