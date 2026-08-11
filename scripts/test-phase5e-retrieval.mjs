import assert from 'node:assert/strict'
import { buildMeridianCorpus } from '../src/data/meridianCorpus.ts'
import { discoverFacets } from '../src/lib/facetDiscovery.ts'
import { retrieveFacetEvidence, buildFacetQuery } from '../src/lib/facetRetrieval.ts'
import { classifyQueryScope } from '../src/lib/synthesisScope.ts'
import { createDocument, searchDocuments } from '../src/lib/rag.ts'
import { buildLexicalIndex, searchLexical, toLexicalResults } from '../src/lib/lexical.ts'
import { PHASE5E_SYNTHESIS_CASES, MERIDIAN_EVIDENCE_ANCHORS } from './fixtures/phase5e.mjs'

const meridianDocument = buildMeridianCorpus()[0]
const meridianCorpus = { documents: [meridianDocument] }
const meridianLexicalIndex = buildLexicalIndex(meridianCorpus.documents)
const meridianChunks = meridianDocument.chunks.map((chunk) => ({
  id: chunk.id,
  documentId: chunk.documentId,
  documentTitle: meridianDocument.title,
  text: chunk.text,
}))

const normalize = (value) => value
  .normalize('NFKC')
  .toLocaleLowerCase('en')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/\s+/g, ' ')
  .trim()

const slugify = (value) => normalize(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const fixtureCase = (id) => PHASE5E_SYNTHESIS_CASES.find((item) => item.id === id)

const propositionKind = (description) => {
  const text = description.toLocaleLowerCase('en')
  if (/exception|misleading|unlimited|assistant|not universal|false/.test(text)) return 'exception'
  if (/proposed|obsolete|rejected|unapproved|future|ended|not current|not approved/.test(text)) return 'change-status'
  if (/current|august|price|cost|threshold|allowance|state/.test(text)) return 'current-state'
  return 'definition'
}

/* Evaluation-side projection only. Production receives discovered facets, not
 * these frozen expected propositions or anchor mappings. */
const retrievalLabel = (label) => label.replace(/\s+(?:plan|comparison row)$/i, '').trim()
const retrievalKind = (label) => {
  if (/\b(?:exception|exceptions|exclusion|exclusions)\b/i.test(label)) return 'exception-collection'
  if (/\binactive\b|\bproposed rules\b/i.test(label)) return 'inactive-collection'
  return 'named-policy-or-benefit'
}

const expectedFacet = (spec) => ({
  id: spec.id,
  label: retrievalLabel(spec.label),
  kind: retrievalKind(spec.label),
  normalizedSubject: slugify(retrievalLabel(spec.label)),
  parentId: null,
  aliases: [retrievalLabel(spec.label)],
  occurrenceCount: 0,
  chunkIds: [],
  signals: ['explicit_query_subject'],
  evidenceObligations: spec.requiredPropositions.map((item) => ({
    id: item.id,
    kind: propositionKind(item.description),
    description: item.description,
    chunkIds: [],
  })),
  confidence: 1,
  rejectionReason: null,
})

const anchorPresent = (results, anchor) => results.some((result) => {
  const text = normalize(result.chunk.text)
  return anchor.semanticSignatures.some((signature) => signature.allOf.every((needle) => text.includes(normalize(needle))))
})

const propositionRecall = (results, spec, layer) => {
  const obligations = spec.requiredPropositions.filter((item) => item.expectedSupport === 'supported')
  const covered = obligations.filter((item) => item.anchorIds.some((anchorId) => anchorPresent(results, MERIDIAN_EVIDENCE_ANCHORS[anchorId])))
  return {
    layer,
    covered: covered.length,
    total: obligations.length,
    recall: obligations.length ? covered.length / obligations.length : 1,
  }
}

const anchorMatchesResult = (result, anchor) => anchorPresent([result], anchor)
const rankMatches = (results, anchor) => results
  .map((result, index) => anchorMatchesResult(result, anchor) ? index + 1 : null)
  .filter((rank) => rank !== null)

const summarizeCandidates = (results) => results.map((result, index) => ({
  rank: index + 1,
  chunkId: result.chunk.id,
  score: Number(result.score.toFixed(6)),
  matchedTerms: result.matchedTerms ?? [],
}))

const summarizeUnion = (candidates) => candidates.map((candidate) => ({
  unionRank: candidate.unionRank,
  chunkId: candidate.result.chunk.id,
  appearedIn: candidate.retrieval.appearedIn,
  matchedTerms: candidate.retrieval.matchedTerms,
}))

const fullCandidateRankings = (retrieval) => retrieval.retrievalQueries.map((query) => ({
  query,
  dense: searchDocuments(meridianCorpus.documents, query, { limit: meridianChunks.length }),
  lexical: toLexicalResults(searchLexical(meridianLexicalIndex, query, meridianChunks.length), meridianCorpus.documents),
}))

const metricRows = []
const unionMissAudits = []
for (const caseId of ['S1', 'S2', 'S3', 'S4', 'S5']) {
  const testCase = fixtureCase(caseId)
  let caseSelectedChunks = []
  for (const spec of testCase.facets) {
    const facet = expectedFacet(spec)
    const retrieval = retrieveFacetEvidence(testCase.question, facet, meridianCorpus, {
      denseLimit: 14,
      lexicalLimit: 14,
      unionLimit: 18,
      maxSelected: 6,
    })
    const unionRecall = propositionRecall(retrieval.unionCandidates.map((item) => item.result), spec, 'union')
    const selectedRecall = propositionRecall(retrieval.selected, spec, 'selected')
    const unionResults = retrieval.unionCandidates.map((item) => item.result)
    const fullRankings = fullCandidateRankings(retrieval)
    for (const proposition of spec.requiredPropositions.filter((item) => item.expectedSupport === 'supported')) {
      const missingAnchorIds = proposition.anchorIds.filter((anchorId) => !anchorPresent(unionResults, MERIDIAN_EVIDENCE_ANCHORS[anchorId]))
      if (!missingAnchorIds.length) continue
      const anchorAudits = proposition.anchorIds.map((anchorId) => {
        const anchor = MERIDIAN_EVIDENCE_ANCHORS[anchorId]
        return {
          anchorId,
          auditChunkId: anchor.auditChunkId,
          adapterDenseRanks: rankMatches(retrieval.denseCandidates, anchor),
          adapterLexicalRanks: rankMatches(retrieval.lexicalCandidates, anchor),
          adapterUnionRanks: retrieval.unionCandidates
            .filter((candidate) => anchorMatchesResult(candidate.result, anchor))
            .map((candidate) => candidate.unionRank),
          fullDenseRanks: fullRankings.map((ranking) => ({
            query: ranking.query,
            ranks: rankMatches(ranking.dense, anchor),
          })),
          fullLexicalRanks: fullRankings.map((ranking) => ({
            query: ranking.query,
            ranks: rankMatches(ranking.lexical, anchor),
          })),
        }
      })
      const foundInFullRetrieval = anchorAudits.some((audit) => (
        audit.fullDenseRanks.some((ranking) => ranking.ranks.length > 0)
        || audit.fullLexicalRanks.some((ranking) => ranking.ranks.length > 0)
      ))
      unionMissAudits.push({
        caseId,
        facetId: spec.id,
        propositionId: proposition.id,
        proposition: proposition.description,
        expectedAnchorIds: proposition.anchorIds,
        missingAnchorIds,
        query: retrieval.query,
        retrievalQueries: retrieval.retrievalQueries,
        rankingQuery: retrieval.rankingQuery,
        denseCandidates: summarizeCandidates(retrieval.denseCandidates),
        lexicalCandidates: summarizeCandidates(retrieval.lexicalCandidates),
        unionCandidates: summarizeUnion(retrieval.unionCandidates),
        anchorAudits,
        preliminaryRootCause: foundInFullRetrieval ? 'candidate-budget-or-union-boundary' : 'representation-retrieval-or-benchmark-contract',
      })
    }
    metricRows.push({
      caseId,
      facetId: spec.id,
      unionCovered: unionRecall.covered,
      unionTotal: unionRecall.total,
      unionRecall: unionRecall.recall,
      selectedCovered: selectedRecall.covered,
      selectedTotal: selectedRecall.total,
      selectedRecall: selectedRecall.recall,
      selectedChunks: retrieval.selected.length,
    })
    caseSelectedChunks = [...caseSelectedChunks, ...retrieval.selected.map((result) => result.chunk.id)]
    assert.equal(retrieval.facetId, facet.id)
    assert.equal(retrieval.candidateCount, retrieval.unionCandidates.length)
    assert.equal(retrieval.evidenceObligations.length, facet.evidenceObligations.length)
    assert.ok(retrieval.query.includes(facet.label), `${caseId}/${facet.id} query must expose its facet identity`)
    assert.ok(retrieval.retrievalQueries.includes(retrieval.rankingQuery), `${caseId}/${facet.id} must expose its focused retrieval query`)
    assert.ok(!retrieval.query.includes('M18'), `${caseId}/${facet.id} query must not contain fixture anchor ids`)
  }
  const uniqueSelectedChunks = new Set(caseSelectedChunks)
  const duplicateCount = caseSelectedChunks.length - uniqueSelectedChunks.size
  const caseRows = metricRows.filter((row) => row.caseId === caseId)
  metricRows.push({ caseId, summary: true, averageChunksPerFacet: caseRows.reduce((sum, row) => sum + row.selectedChunks, 0) / caseRows.length, duplicateChunksShared: duplicateCount, totalUniqueSynthesisChunks: uniqueSelectedChunks.size })
}

/* ------------------------------------------- actual discovery forcing cases */

const s1 = fixtureCase('S1')
const s1Discovery = discoverFacets(s1.question, meridianChunks, classifyQueryScope(s1.question))
const findFacet = (predicate) => s1Discovery.selected.find(predicate)

const continuity = findFacet((facet) => facet.normalizedSubject === 'continuity-credit')
assert.ok(continuity, 'Continuity Credit must be discovered before facet retrieval')
const continuityRetrieval = retrieveFacetEvidence(s1.question, continuity, meridianCorpus, { maxSelected: 5 })
assert.ok(anchorPresent(continuityRetrieval.unionCandidates.map((item) => item.result), MERIDIAN_EVIDENCE_ANCHORS.M18), 'Continuity Credit evidence must enter its facet union')
assert.ok(anchorPresent(continuityRetrieval.selected, MERIDIAN_EVIDENCE_ANCHORS.M18), 'Continuity Credit evidence must survive facet pruning')
assert.ok(!buildFacetQuery(s1.question, continuity).includes('55'), 'facet query construction must not inject an expected value')
assert.ok(!buildFacetQuery(s1.question, continuity).includes('M18'), 'facet query construction must not inject an anchor id')

const ferry = findFacet((facet) => facet.kind === 'recurring-policy-dimension' && facet.normalizedSubject === 'ferry')
assert.ok(ferry, 'generic recurring policy dimension must discover ferry semantically')
const ferryRetrieval = retrieveFacetEvidence(s1.question, ferry, meridianCorpus, { maxSelected: 6 })
assert.ok(anchorPresent(ferryRetrieval.unionCandidates.map((item) => item.result), MERIDIAN_EVIDENCE_ANCHORS.M15), 'ferry current allowance evidence must enter the union')
assert.ok(anchorPresent(ferryRetrieval.unionCandidates.map((item) => item.result), MERIDIAN_EVIDENCE_ANCHORS.M22), 'ferry exception evidence must enter the union')

const exceptions = findFacet((facet) => facet.id === 'important-exceptions')
assert.ok(exceptions, 'important-exceptions composite must be discovered')
const exceptionRetrieval = retrieveFacetEvidence(s1.question, exceptions, meridianCorpus, { maxSelected: 6 })
assert.ok(anchorPresent(exceptionRetrieval.unionCandidates.map((item) => item.result), MERIDIAN_EVIDENCE_ANCHORS.M12), 'accessibility exception must enter exception union')
assert.ok(anchorPresent(exceptionRetrieval.unionCandidates.map((item) => item.result), MERIDIAN_EVIDENCE_ANCHORS.M21), 'Dayline exception must enter exception union')

const inactive = findFacet((facet) => facet.id === 'inactive-or-proposed')
assert.ok(inactive, 'inactive/proposed composite must be discovered')
const inactiveRetrieval = retrieveFacetEvidence(s1.question, inactive, meridianCorpus, { maxSelected: 6 })
assert.ok(anchorPresent(inactiveRetrieval.unionCandidates.map((item) => item.result), MERIDIAN_EVIDENCE_ANCHORS.M16), 'Standard proposal evidence must enter inactive union')
assert.ok(anchorPresent(inactiveRetrieval.unionCandidates.map((item) => item.result), MERIDIAN_EVIDENCE_ANCHORS.M23), 'North proposal evidence must enter inactive union')

/* ---------------------------------------------------- Atlas generalization */

// Keep this corpus small but multi-source so the recurring-dimension rule is
// exercised across chunks rather than accidentally within one packed block.
const atlasDocuments = [
  createDocument('Atlas memberships', 'synthetic / Atlas / memberships', 'Atlas offers Core and Assisted memberships.', 'sample', { id: 'atlas-memberships' }),
  createDocument('Atlas Core policy', 'synthetic / Atlas / core', 'Core includes five storage transfers each month.', 'sample', { id: 'atlas-core' }),
  createDocument('Atlas Assisted policy', 'synthetic / Atlas / assisted', 'Assisted includes five storage transfers each month.', 'sample', { id: 'atlas-assisted' }),
  createDocument('Atlas archival exception', 'synthetic / Atlas / exceptions', 'Assisted members with archival requirements receive unlimited storage transfers.', 'sample', { id: 'atlas-exception' }),
  createDocument('Atlas recovery benefit', 'synthetic / Atlas / benefits', 'A loyalty benefit known as Recovery Credit was introduced for account recovery charges.', 'sample', { id: 'atlas-recovery' }),
]
const atlasCorpus = { documents: atlasDocuments }
const atlasChunks = atlasDocuments.flatMap((document) => document.chunks.map((chunk) => ({
  id: chunk.id,
  documentId: chunk.documentId,
  documentTitle: document.title,
  text: chunk.text,
})))
const atlasQuestion = 'Summarise Atlas.'
const atlasDiscovery = discoverFacets(atlasQuestion, atlasChunks, classifyQueryScope(atlasQuestion))
const atlasStorage = atlasDiscovery.selected.find((facet) => facet.kind === 'recurring-policy-dimension' && facet.normalizedSubject === 'storage')
const atlasRecovery = atlasDiscovery.selected.find((facet) => facet.normalizedSubject === 'recovery-credit')
assert.ok(atlasStorage, 'Atlas storage dimension must be discovered before retrieval')
assert.ok(atlasRecovery, 'Atlas Recovery Credit must be discovered before retrieval')
const atlasStorageRetrieval = retrieveFacetEvidence(atlasQuestion, atlasStorage, atlasCorpus, { maxSelected: 4 })
const atlasRecoveryRetrieval = retrieveFacetEvidence(atlasQuestion, atlasRecovery, atlasCorpus, { maxSelected: 4 })
assert.ok(atlasStorageRetrieval.unionCandidates.length > 0, 'Atlas storage facet must retrieve candidates')
assert.ok(atlasStorageRetrieval.selected.some((result) => /storage transfers/i.test(result.chunk.text)), 'Atlas storage evidence must survive selection')
assert.ok(atlasRecoveryRetrieval.selected.some((result) => /Recovery Credit/i.test(result.chunk.text)), 'Atlas singleton benefit evidence must survive selection')

const metrics = metricRows.filter((row) => row.summary)
assert.equal(metrics.length, 5)
const propositionRows = metricRows.filter((row) => !row.summary)
const unionCovered = propositionRows.reduce((sum, row) => sum + row.unionCovered, 0)
const unionTotal = propositionRows.reduce((sum, row) => sum + row.unionTotal, 0)
const selectedCovered = propositionRows.reduce((sum, row) => sum + row.selectedCovered, 0)
const selectedTotal = propositionRows.reduce((sum, row) => sum + row.selectedTotal, 0)
assert.equal(unionTotal, 80, 'S1-S5 union gate must continue to cover 80 supported propositions')
assert.equal(unionCovered, 80, 'pre-pruning union must cover every supported S1-S5 proposition')
assert.equal(selectedTotal, 80, 'S1-S5 selected baseline must continue to measure 80 supported propositions')
assert.equal(selectedCovered, 68, 'pre-coverage selected baseline must remain 68/80 for Step 7')
console.log(JSON.stringify({
  propositionRecall: {
    unionCovered,
    unionTotal,
    unionRecall: unionTotal ? unionCovered / unionTotal : 1,
    selectedCovered,
    selectedTotal,
    selectedRecall: selectedTotal ? selectedCovered / selectedTotal : 1,
  },
  unionMissAudits,
  selectionGaps: propositionRows
    .filter((row) => row.selectedRecall < 1)
    .map((row) => ({
      caseId: row.caseId,
      facetId: row.facetId,
      selectedCovered: row.selectedCovered,
      selectedTotal: row.selectedTotal,
      selectedRecall: row.selectedRecall,
    })),
  facetEvidenceMetrics: metrics,
  forcing: {
    continuityUnion: continuityRetrieval.unionCandidates.length,
    continuitySelected: continuityRetrieval.selected.length,
    ferryUnion: ferryRetrieval.unionCandidates.length,
    exceptionUnion: exceptionRetrieval.unionCandidates.length,
    inactiveUnion: inactiveRetrieval.unionCandidates.length,
  },
}, null, 2))
console.log(`Phase 5E facet retrieval tests passed / ${metricRows.filter((row) => !row.summary).length} facet rows + singleton, exception, inactive, and Atlas query-path checks`)
