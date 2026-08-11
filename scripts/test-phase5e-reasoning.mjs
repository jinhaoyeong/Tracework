import assert from 'node:assert/strict'
import { buildMeridianCorpus } from '../src/data/meridianCorpus.ts'
import { createDocument, searchDocuments } from '../src/lib/rag.ts'
import { buildLexicalIndex, searchLexical, toLexicalResults } from '../src/lib/lexical.ts'
import { buildCandidateUnion, pruneCandidates, rerank } from '../src/lib/reranker.ts'
import { retrieveFacetEvidence } from '../src/lib/facetRetrieval.ts'
import { reasonFacetEvidence } from '../src/lib/facetReasoning.ts'
import {
  MERIDIAN_EVIDENCE_ANCHORS,
  PHASE5E_REFERENCE_AS_OF,
  PHASE5E_SYNTHESIS_CASES,
} from './fixtures/phase5e.mjs'
import { PHASE5C_CORPUS } from './fixtures/phase5c.mjs'
import { buildVariant, PHASE5D_CASES } from './fixtures/phase5d.mjs'

const meridianDocument = buildMeridianCorpus()[0]
const meridianCorpus = { documents: [meridianDocument] }

const normalize = (value) => value
  .normalize('NFKC')
  .toLocaleLowerCase('en')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/\s+/g, ' ')
  .trim()

const slugify = (value) => normalize(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

const propositionKind = (description) => {
  const text = description.toLocaleLowerCase('en')
  if (/exception|misleading|unlimited|assistant|not universal|false/.test(text)) return 'exception'
  if (/proposed|obsolete|rejected|unapproved|future|ended|not current|not approved/.test(text)) return 'change-status'
  if (/current|august|price|cost|threshold|allowance|state/.test(text)) return 'current-state'
  return 'definition'
}

const retrievalLabel = (label) => label.replace(/\s+(?:plan|comparison row)$/i, '').trim()
const retrievalKind = (label) => {
  if (/\b(?:exception|exceptions|exclusion|exclusions)\b/i.test(label)) return 'exception-collection'
  if (/\binactive\b|\bproposed rules\b/i.test(label)) return 'inactive-collection'
  return 'named-policy-or-benefit'
}

const fixtureCase = (id) => PHASE5E_SYNTHESIS_CASES.find((item) => item.id === id)

const baseFacet = (spec) => {
  const label = retrievalLabel(spec.label)
  return {
    id: spec.id,
    label,
    kind: retrievalKind(spec.label),
    normalizedSubject: slugify(label),
    parentId: null,
    aliases: [label],
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
  }
}

const anchorPresent = (results, anchor) => results.some((result) => {
  const text = normalize(result.chunk.text)
  return anchor.semanticSignatures.some((signature) => signature.allOf.every((needle) => text.includes(normalize(needle))))
})

const anchorChunkIds = (anchorId) => {
  const anchor = MERIDIAN_EVIDENCE_ANCHORS[anchorId]
  return meridianDocument.chunks
    .filter((chunk) => anchor.semanticSignatures.some((signature) => signature.allOf.every((needle) => normalize(chunk.text).includes(normalize(needle)))))
    .map((chunk) => chunk.id)
}

const hydrateFacetWitnesses = (facet, spec, retrieval) => {
  const union = retrieval.unionCandidates.map((candidate) => candidate.result)
  const selectedIds = new Set(retrieval.selected.map((result) => result.chunk.id))
  const unionIds = new Set(union.map((result) => result.chunk.id))
  return {
    ...facet,
    evidenceObligations: facet.evidenceObligations.map((obligation, index) => {
      const proposition = spec.requiredPropositions[index]
      if (proposition.expectedSupport === 'unsupported') return obligation
      const available = proposition.anchorIds
        .flatMap((anchorId) => anchorChunkIds(anchorId))
        .filter((chunkId, position, all) => all.indexOf(chunkId) === position)
      assert.ok(available.some((chunkId) => unionIds.has(chunkId)), `${spec.id}/${proposition.id} has no witness in Step 6 union`)
      const preferred = available.find((chunkId) => selectedIds.has(chunkId) && unionIds.has(chunkId))
        ?? available.find((chunkId) => unionIds.has(chunkId))
      return { ...obligation, chunkIds: [preferred] }
    }),
  }
}

const propositionRecall = (results, spec) => {
  const supported = spec.requiredPropositions.filter((item) => item.expectedSupport === 'supported')
  const covered = supported.filter((item) => item.anchorIds.some((anchorId) => anchorPresent(results, MERIDIAN_EVIDENCE_ANCHORS[anchorId])))
  return { covered: covered.length, total: supported.length }
}

const runMeridianCase = (spec) => {
  const rows = []
  let restored = []
  for (const facetSpec of spec.facets) {
    const facet = baseFacet(facetSpec)
    const retrieval = retrieveFacetEvidence(spec.question, facet, meridianCorpus, {
      denseLimit: 14,
      lexicalLimit: 14,
      unionLimit: 18,
      maxSelected: 6,
    })
    const hydrated = hydrateFacetWitnesses(facet, facetSpec, retrieval)
    const reasoning = reasonFacetEvidence({
      facet: hydrated,
      originalQuestion: spec.question,
      asOf: spec.asOf,
      unionCandidates: retrieval.unionCandidates,
      selectedCandidates: retrieval.selected,
    })
    const unionRecall = propositionRecall(retrieval.unionCandidates.map((candidate) => candidate.result), facetSpec)
    const selectedRecall = propositionRecall(retrieval.selected, facetSpec)
    const reasoningRecall = propositionRecall(reasoning.reasoningContext, facetSpec)
    rows.push({
      caseId: spec.id,
      facetId: facetSpec.id,
      unionRecall,
      selectedRecall,
      reasoningRecall,
      selectedChunks: retrieval.selected.length,
      reasoningChunks: reasoning.reasoningContext.length,
      unionChunks: retrieval.unionCandidates.length,
      restoredWitnesses: reasoning.restoredWitnesses,
      temporal: {
        status: reasoning.temporal.status,
        requestedPeriod: reasoning.temporal.requestedPeriod,
      },
    })
    restored = [...restored, ...reasoning.restoredWitnesses]
    assert.equal(reasoning.providerCalled, false)
    assert.equal('facetStatus' in reasoning, false, `${spec.id}/${facetSpec.id} must not decide final facet coverage`)
    assert.equal('answerDisposition' in reasoning, false, `${spec.id}/${facetSpec.id} must not decide final answer disposition`)
    assert.ok(reasoning.reasoningContext.length <= retrieval.unionCandidates.length, `${spec.id}/${facetSpec.id} reasoning context cannot exceed its union`)
  }
  return { rows, restored }
}

const meridianRuns = PHASE5E_SYNTHESIS_CASES
  .filter((spec) => ['S1', 'S2', 'S3', 'S4', 'S5'].includes(spec.id))
  .map(runMeridianCase)
const meridianRows = meridianRuns.flatMap((run) => run.rows)

const unionCovered = meridianRows.reduce((sum, row) => sum + row.unionRecall.covered, 0)
const unionTotal = meridianRows.reduce((sum, row) => sum + row.unionRecall.total, 0)
const selectedCovered = meridianRows.reduce((sum, row) => sum + row.selectedRecall.covered, 0)
const selectedTotal = meridianRows.reduce((sum, row) => sum + row.selectedRecall.total, 0)
const reasoningCovered = meridianRows.reduce((sum, row) => sum + row.reasoningRecall.covered, 0)
const reasoningTotal = meridianRows.reduce((sum, row) => sum + row.reasoningRecall.total, 0)

assert.equal(unionTotal, 80)
assert.equal(unionCovered, 80, 'Step 6 pre-pruning union must remain complete')
assert.equal(selectedTotal, 80)
assert.equal(selectedCovered, 68, 'Step 6 ordinary-selected baseline must remain 68/80')
assert.equal(reasoningTotal, 80)
assert.equal(reasoningCovered, 80, 'Step 7 reasoning context must restore all available witnesses')

const s3HistoricalRows = meridianRows.filter((row) => row.caseId === 'S3')
assert.equal(s3HistoricalRows.find((row) => row.facetId === '2024-launch-to-june').temporal.requestedPeriod, '2024-06')
assert.equal(s3HistoricalRows.find((row) => row.facetId === '2025-january-february').temporal.requestedPeriod, '2025-02')
assert.equal(s3HistoricalRows.find((row) => row.facetId === '2026-june-august').temporal.requestedPeriod, '2026-08')

const restoreCounts = meridianRuns
  .flatMap((run) => run.restored)
  .reduce((counts, witness) => ({ ...counts, [witness.reason]: (counts[witness.reason] ?? 0) + 1 }), {})

// Negative and obsolete material remains in the reasoning input for Step 8 to
// classify; Step 7 does not delete it or turn it into current policy.
const s1 = fixtureCase('S1')
const s1InactiveSpec = s1.facets.find((facet) => facet.id === 'inactive-or-proposed')
const s1InactiveBase = baseFacet(s1InactiveSpec)
const s1InactiveRetrieval = retrieveFacetEvidence(s1.question, s1InactiveBase, meridianCorpus, { maxSelected: 6 })
const s1InactiveReasoning = reasonFacetEvidence({
  facet: hydrateFacetWitnesses(s1InactiveBase, s1InactiveSpec, s1InactiveRetrieval),
  originalQuestion: s1.question,
  asOf: s1.asOf,
  unionCandidates: s1InactiveRetrieval.unionCandidates,
  selectedCandidates: s1InactiveRetrieval.selected,
})
assert.ok(anchorPresent(s1InactiveReasoning.reasoningContext, MERIDIAN_EVIDENCE_ANCHORS.M20), 'Flex replacement evidence must remain available for exclusion reasoning')
assert.ok(anchorPresent(s1InactiveReasoning.reasoningContext, MERIDIAN_EVIDENCE_ANCHORS.M28), 'future adaptive evidence must remain available for exclusion reasoning')

/* ------------------------------------------------------- Phase 5D composition */

const makePhase5dDocuments = (variant) => buildVariant(variant).map((source) => createDocument(
  source.title,
  `synthetic / phase 5D / ${source.title}`,
  source.content,
  'sample',
  { id: `phase5d-${source.title}`, provenance: source.provenance },
))

const asFacet = (id, label) => ({
  id,
  label,
  kind: 'query-subject',
  normalizedSubject: slugify(label),
  parentId: null,
  aliases: [label],
  occurrenceCount: 1,
  chunkIds: [],
  signals: ['explicit_query_subject'],
  evidenceObligations: [{
    id: `${id}:current-state`,
    kind: 'current-state',
    description: `${label}: establish current state from corpus evidence`,
    chunkIds: [],
  }],
  confidence: 1,
  rejectionReason: null,
})

const t7 = PHASE5D_CASES.find((spec) => spec.id === 'T7')
const t7Documents = makePhase5dDocuments(t7.variant)
const t7Lexical = buildLexicalIndex(t7Documents)
const t7Dense = searchDocuments(t7Documents, t7.question, { engine: 'hashed', limit: 10 })
const t7LexicalResults = toLexicalResults(searchLexical(t7Lexical, t7.question, 10), t7Documents)
const t7Union = buildCandidateUnion({ dense: t7Dense, lexical: t7LexicalResults, limit: 10 })
const t7Ranked = rerank(t7.question, t7Union)
const t7Selected = pruneCandidates(t7Ranked, { maxChunks: t7.topK }).selected.map((candidate) => candidate.result)
const t7Reasoning = reasonFacetEvidence({
  facet: asFacet('team-plan-price', 'Team plan price'),
  originalQuestion: t7.question,
  asOf: t7.asOf,
  unionCandidates: t7Union,
  selectedCandidates: t7Selected,
})

assert.equal(t7Reasoning.providerCalled, false)
assert.equal(t7Reasoning.temporal.status, 'resolved')
assert.ok(t7Reasoning.temporal.applicableClaims.some((claim) => claim.claim.value.includes('55')))
assert.ok(t7Reasoning.temporal.excludedClaims.some((assessment) => assessment.claim.claim.value.includes('40')))
assert.ok(t7Reasoning.restoredWitnesses.some((witness) => witness.reason === 'temporal-witness'))
assert.equal(t7Reasoning.temporal.coverage.complete, true)

const futureSpec = PHASE5D_CASES.find((spec) => spec.id === 'T6a')
const futureDocuments = makePhase5dDocuments(futureSpec.variant)
const futureResults = futureDocuments.flatMap((document) => document.chunks.map((chunk) => ({
  chunk,
  document,
  score: 1,
  semanticScore: 1,
  keywordScore: 1,
  matchedTerms: [],
  engine: 'hashed',
})))
const futureUnion = buildCandidateUnion({ dense: futureResults, lexical: [], limit: futureResults.length })
const futureFacet = asFacet('team-plan-price', 'Team plan price')
const beforeFuture = reasonFacetEvidence({
  facet: futureFacet,
  originalQuestion: futureSpec.question,
  asOf: futureSpec.asOf,
  unionCandidates: futureUnion,
  selectedCandidates: futureResults,
})
assert.ok(beforeFuture.temporal.excludedClaims.some((assessment) => assessment.claim.claim.value.includes('65')))
assert.ok(beforeFuture.temporal.applicableClaims.some((claim) => claim.claim.value.includes('55')))

/* ------------------------------------------------------ Phase 5C composition */

const provenanceDocuments = PHASE5C_CORPUS.slice(0, 2).map((source) => createDocument(
  source.title,
  `synthetic / phase 5C / ${source.title}`,
  source.content,
  'sample',
  { id: `phase5c-${source.title}`, provenance: source.provenance },
))
const provenanceResults = provenanceDocuments.flatMap((document) => document.chunks.map((chunk) => ({
  chunk,
  document,
  score: 1,
  semanticScore: 1,
  keywordScore: 1,
  matchedTerms: [],
  engine: 'hashed',
})))
const provenanceFacet = asFacet('tracework-origin', 'Tracework origin')
const provenanceReasoning = reasonFacetEvidence({
  facet: provenanceFacet,
  originalQuestion: 'Where was Tracework invented?',
  asOf: PHASE5E_REFERENCE_AS_OF,
  unionCandidates: provenanceResults,
  selectedCandidates: provenanceResults.slice(0, 1),
})
assert.equal(provenanceReasoning.provenanceConflict.status, 'conflicted')
assert.ok(provenanceReasoning.provenanceConflict.conflicts.length > 0)
assert.ok(provenanceReasoning.restoredWitnesses.some((witness) => witness.reason === 'conflict-witness'))

const unrelatedReasoning = reasonFacetEvidence({
  facet: asFacet('unrelated-topic', 'Unrelated topic'),
  originalQuestion: 'Where was Tracework invented?',
  asOf: PHASE5E_REFERENCE_AS_OF,
  unionCandidates: provenanceResults,
  selectedCandidates: provenanceResults.slice(0, 1),
})
assert.equal(unrelatedReasoning.provenanceConflict.status, 'unassessed')
assert.equal(unrelatedReasoning.provenanceConflict.conflicts.length, 0)

/* ----------------------------------------------------------- S6 boundary */

const s6 = fixtureCase('S6')
for (const facetSpec of s6.facets) {
  const facet = baseFacet(facetSpec)
  const retrieval = retrieveFacetEvidence(s6.question, facet, meridianCorpus, { maxSelected: 6 })
  const reasoning = reasonFacetEvidence({
    facet,
    originalQuestion: s6.question,
    asOf: s6.asOf,
    unionCandidates: retrieval.unionCandidates,
    selectedCandidates: retrieval.selected,
  })
  assert.equal(reasoning.providerCalled, false)
  assert.equal('facetStatus' in reasoning, false)
  assert.equal('answerDisposition' in reasoning, false)
}

console.log(JSON.stringify({
  propositionRecall: {
    unionCovered,
    unionTotal,
    unionRecall: unionCovered / unionTotal,
    selectedCovered,
    selectedTotal,
    selectedRecall: selectedCovered / selectedTotal,
    reasoningCovered,
    reasoningTotal,
    reasoningRecall: reasoningCovered / reasoningTotal,
  },
  restoredWitnesses: restoreCounts,
  temporal: {
    t7: {
      status: t7Reasoning.temporal.status,
      applicable: t7Reasoning.temporal.applicableClaims.map((claim) => claim.claim.value),
      excluded: t7Reasoning.temporal.excludedClaims.map((assessment) => assessment.claim.claim.value),
      restored: t7Reasoning.restoredWitnesses.filter((witness) => witness.reason === 'temporal-witness').map((witness) => witness.chunkId),
    },
    future65Excluded: beforeFuture.temporal.excludedClaims.some((assessment) => assessment.claim.claim.value.includes('65')),
  },
  provenance: {
    conflictStatus: provenanceReasoning.provenanceConflict.status,
    conflictWitnesses: provenanceReasoning.provenanceConflict.restoredChunkIds,
    unrelatedFacetStatus: unrelatedReasoning.provenanceConflict.status,
  },
}, null, 2))
console.log(`Phase 5E reasoning tests passed / ${meridianRows.length} facet rows + temporal, provenance, isolation, and S6 boundary checks`)
