import type { ProvenanceAuthority, SourceProvenance, SearchResult } from '../types'

export type ClaimKind = 'origin' | 'elasticsearch-use'
export type AdjudicationStatus = 'unassessed' | 'clear' | 'conflicted' | 'authority-supported'

export interface EvidenceClaim {
  id: string
  key: ClaimKind
  predicate: string
  value: string
  sentence: string
  sourceId: string
  sourceTitle: string
  chunkId: string
  citation: number
  result: SearchResult
}

export interface EvidenceConflict {
  key: ClaimKind
  summary: string
  claims: EvidenceClaim[]
}

export interface SourceAssessment {
  sourceId: string
  title: string
  provenance: SourceProvenance
  claimCount: number
  conflictCount: number
  state: 'unknown' | 'declared' | 'authoritative' | 'conflicted'
}

export interface EvidenceAdjudication {
  question: string
  status: AdjudicationStatus
  claims: EvidenceClaim[]
  conflicts: EvidenceConflict[]
  sources: SourceAssessment[]
  notice: string
}

const defaultProvenance = (result: SearchResult): SourceProvenance => ({
  origin: result.document.kind === 'sample' ? 'synthetic-fixture' : result.document.kind === 'file' ? 'indexed-file' : 'user-note',
  authority: 'unknown',
  basis: 'No authority metadata was supplied.',
})

const sentencesOf = (text: string) => text
  .split(/(?<=[.!?])\s+|\n+/)
  .map((sentence) => sentence.trim())
  .filter(Boolean)

const questionWords = (question: string) => question
  .toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
  .split(/\s+/)
  .filter((word) => word.length > 2)

const sentenceMatchesQuestion = (question: string, sentence: string) => {
  const sentenceWords = new Set(questionWords(sentence))
  return questionWords(question).some((word) => sentenceWords.has(word))
}

const hasAnyWord = (value: string, words: string[]) => words.some((word) => value.toLocaleLowerCase().includes(word))

const pushClaim = (
  claims: EvidenceClaim[],
  result: SearchResult,
  citation: number,
  key: ClaimKind,
  predicate: string,
  value: string,
  sentence: string,
) => {
  const normalizedValue = value.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
  const id = `${result.chunk.id}:${key}:${normalizedValue}`
  if (claims.some((claim) => claim.id === id)) return
  claims.push({
    id,
    key,
    predicate,
    value: normalizedValue,
    sentence,
    sourceId: result.document.id,
    sourceTitle: result.document.title,
    chunkId: result.chunk.id,
    citation,
    result,
  })
}

/**
 * Extracts only transparent, high-signal claim shapes. This is deliberately
 * not a general truth detector: unknown language remains unknown, while the
 * obvious origin and direct Elasticsearch propositions become inspectable.
 */
export const extractEvidenceClaims = (question: string, results: SearchResult[]): EvidenceClaim[] => {
  const originQuestion = hasAnyWord(question, ['invented', 'created', 'built', 'founded', 'origin', 'where'])
  const elasticsearchQuestion = question.toLocaleLowerCase().includes('elasticsearch')
  const claims: EvidenceClaim[] = []

  results.forEach((result, resultIndex) => {
    sentencesOf(result.chunk.text).forEach((sentence) => {
      if (!sentenceMatchesQuestion(question, sentence)) return

      if (originQuestion) {
        const originMatch = sentence.match(/\b(?:invented|created|built|founded|originated)\s+in\s+([A-Za-z][A-Za-z-]*)(?:\s+in\s+(\d{4}))?/i)
        if (originMatch) {
          const year = originMatch[2] ? ` ${originMatch[2]}` : ''
          pushClaim(claims, result, resultIndex + 1, 'origin', 'project origin', `${originMatch[1]}${year}`, sentence)
        }
      }

      if (elasticsearchQuestion) {
        const negative = sentence.match(/\b(?:does not|doesn't|never)\s+(?:use|uses|run|runs)\s+(?:on\s+)?elasticsearch\b/i)
        if (negative) pushClaim(claims, result, resultIndex + 1, 'elasticsearch-use', 'current Elasticsearch use', 'does not use Elasticsearch', sentence)

        const positive = !negative && sentence.match(/\b(?:use|uses|run|runs)\s+(?:on\s+)?elasticsearch\b/i)
        if (positive && !/\b(?:should|proposal|proposed|rejected)\b/i.test(sentence)) {
          pushClaim(claims, result, resultIndex + 1, 'elasticsearch-use', 'current Elasticsearch use', 'uses Elasticsearch', sentence)
        }
      }
    })
  })

  return claims
}

const uniqueValues = (claims: EvidenceClaim[]) => new Set(claims.map((claim) => claim.value)).size

const authorityOf = (claim: EvidenceClaim): ProvenanceAuthority => claim.result.document.provenance?.authority ?? 'unknown'

const sourceState = (provenance: SourceProvenance, conflictCount: number): SourceAssessment['state'] => {
  if (provenance.authority === 'authoritative') return 'authoritative'
  if (provenance.authority === 'declared') return 'declared'
  if (conflictCount) return 'conflicted'
  return 'unknown'
}

export const adjudicateEvidence = (question: string, results: SearchResult[]): EvidenceAdjudication => {
  const claims = extractEvidenceClaims(question, results)
  const grouped = new Map<ClaimKind, EvidenceClaim[]>()
  claims.forEach((claim) => grouped.set(claim.key, [...(grouped.get(claim.key) ?? []), claim]))
  const conflicts: EvidenceConflict[] = [...grouped.entries()]
    .filter(([, groupedClaims]) => uniqueValues(groupedClaims) > 1)
    .map(([key, groupedClaims]) => ({
      key,
      summary: `${groupedClaims[0].predicate} has ${uniqueValues(groupedClaims)} incompatible values across the retrieved evidence.`,
      claims: groupedClaims,
    }))

  const sources = results.reduce<SourceAssessment[]>((all, result) => {
    if (all.some((source) => source.sourceId === result.document.id)) return all
    const sourceClaims = claims.filter((claim) => claim.sourceId === result.document.id)
    const conflictCount = conflicts.filter((conflict) => conflict.claims.some((claim) => claim.sourceId === result.document.id)).length
    const provenance = result.document.provenance ?? defaultProvenance(result)
    all.push({
      sourceId: result.document.id,
      title: result.document.title,
      provenance,
      claimCount: sourceClaims.length,
      conflictCount,
      state: sourceState(provenance, conflictCount),
    })
    return all
  }, [])

  if (!claims.length) {
    return {
      question,
      status: 'unassessed',
      claims,
      conflicts,
      sources,
      notice: 'No comparable claim pattern was extracted. This is not evidence that the sources are true or consistent.',
    }
  }

  if (!conflicts.length) {
    return {
      question,
      status: 'clear',
      claims,
      conflicts,
      sources,
      notice: 'No direct disagreement was detected among the extracted claims. Source truth remains unproven.',
    }
  }

  // Judge each conflict on its own. Comparing a global count of authoritative
  // values against the number of conflicts lets two authorities contradicting
  // each other on one key cancel out a second key that has no authority at all,
  // and the totals coincidentally match — which reported a winner where none
  // exists. Authority resolves a disagreement only when, for every conflict,
  // exactly one distinct value carries authoritative provenance.
  const authoritySupportsOneValue = conflicts.every((conflict) => {
    const authoritativeValues = new Set(
      conflict.claims
        .filter((claim) => authorityOf(claim) === 'authoritative')
        .map((claim) => claim.value),
    )
    return authoritativeValues.size === 1
  })

  if (authoritySupportsOneValue) {
    return {
      question,
      status: 'authority-supported',
      claims,
      conflicts,
      sources,
      notice: 'Retrieved sources disagree, but explicit provenance marks one claim as authoritative. The answer may lead with that claim and disclose the conflict.',
    }
  }

  const sourceNames = [...new Set(conflicts.flatMap((conflict) => conflict.claims.map((claim) => claim.sourceTitle)))]
  return {
    question,
    status: 'conflicted',
    claims,
    conflicts,
    sources,
    notice: `Sources disagree across ${sourceNames.join(', ')}. No supplied provenance establishes a winner, so Tracework must report the conflict instead of choosing by majority or relevance.`,
  }
}

/**
 * Context pruning must not erase the witness for a detected disagreement. It
 * preserves the current selection, then adds or swaps in one chunk for every
 * conflicting claim value, without changing the Phase 5B ranking itself.
 */
export const ensureConflictCoverage = (
  adjudication: EvidenceAdjudication,
  selected: SearchResult[],
  maxChunks?: number,
  protectedChunkIds: ReadonlySet<string> = new Set(),
): SearchResult[] => {
  if (adjudication.status !== 'conflicted' || !adjudication.conflicts.length) return selected

  const output = [...selected]
  const witnessResults = adjudication.conflicts
    .flatMap((conflict) => conflict.claims.map((claim) => claim.result))
    .filter((result, index, all) => all.findIndex((candidate) => candidate.chunk.id === result.chunk.id) === index)
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
