import type { SearchResult } from '../types.ts'
import type { TemporalNormalization } from './temporalNormalization.ts'

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

/**
 * Restore missing temporal witnesses without evicting an existing witness
 * supplied by either coverage pass. If the union of required witnesses cannot
 * fit under maxChunks, the function preserves the evidence already protected
 * and remains fail-closed rather than evicting it to make room.
 */
export const ensureTemporalCoverage = (
  normalization: TemporalNormalization,
  selected: SearchResult[],
  maxChunks?: number,
  protectedChunkIds: ReadonlySet<string> = new Set(),
): SearchResult[] => {
  const witnessResults = temporalCoverageWitnesses(normalization)
  if (!witnessResults.length) return selected

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

  return output
}
