import assert from 'node:assert/strict'
import { buildCandidateUnion, pruneCandidates, rerank } from '../src/lib/reranker.ts'

const makeResult = ({
  id,
  title = id,
  source = title,
  text,
  score = 0.5,
  engine = 'neural',
  lexicalScore,
  lexicalFieldHits,
}) => {
  const document = {
    id: `document-${id}`,
    title,
    source,
    kind: 'note',
    content: text,
    createdAt: '2026-08-10T00:00:00.000Z',
    chunks: [],
  }
  const chunk = {
    id,
    documentId: document.id,
    index: 0,
    text,
    start: 0,
    end: text.length,
    tokens: text.toLocaleLowerCase().split(/\s+/).filter(Boolean),
    vector: [],
  }
  document.chunks = [chunk]
  return {
    chunk,
    document,
    score,
    semanticScore: engine === 'lexical' ? 0 : score,
    keywordScore: 0,
    matchedTerms: [],
    engine,
    lexicalScore,
    lexicalFieldHits,
  }
}

const sharedDense = makeResult({ id: 'shared', text: 'Tracework uses a source-grounded retrieval guide.', score: 0.82 })
const sharedLexical = makeResult({
  id: 'shared',
  text: 'Tracework uses a source-grounded retrieval guide.',
  score: 1,
  engine: 'lexical',
  lexicalScore: 4.2,
  lexicalFieldHits: { body: 2, title: 1, path: 0 },
})
const denseOnly = makeResult({ id: 'dense-only', text: 'Semantic evidence about indexed passages.', score: 0.7 })
const lexicalOnly = makeResult({ id: 'lexical-only', title: 'onboarding.md', text: 'The engineering guide covers chunking and embeddings.', engine: 'lexical', score: 1, lexicalScore: 5.4, lexicalFieldHits: { body: 2, title: 1, path: 1 } })

const union = buildCandidateUnion({ dense: [sharedDense, denseOnly], lexical: [sharedLexical, lexicalOnly] })
assert.equal(union.length, 3, 'the union deduplicates chunks that appear in both lists')
assert.deepEqual(union.map((candidate) => candidate.result.chunk.id), ['shared', 'dense-only', 'lexical-only'])
assert.equal(union[0].retrieval.appearedIn, 'both')
assert.equal(union[0].retrieval.denseRank, 1)
assert.equal(union[0].retrieval.lexicalRank, 1)
assert.equal(union[0].retrieval.bm25Score, 4.2)
assert.equal(union[1].retrieval.appearedIn, 'dense')
assert.equal(union[2].retrieval.appearedIn, 'lexical')

const onboarding = makeResult({
  id: 'onboarding',
  title: 'onboarding.md',
  text: 'New engineers should read the retrieval guide first. The guide covers chunking, embeddings, and the citation contract.',
  score: 0.3,
  engine: 'lexical',
  lexicalScore: 6.2,
  lexicalFieldHits: { body: 2, title: 1, path: 1 },
})
const customerOnboarding = makeResult({
  id: 'customer-onboarding',
  title: 'customer-onboarding.md',
  text: 'Customer onboarding takes three calls: kickoff, data import, and review.',
  score: 0.91,
})
const onboardingUnion = buildCandidateUnion({ dense: [customerOnboarding], lexical: [onboarding] })
const onboardingRanked = rerank('Summarise Tracework onboarding guide.', onboardingUnion)
assert.equal(onboardingRanked[0].result.document.title, 'onboarding.md', 'the exact engineering guide beats a topical customer guide')
assert.equal(onboardingRanked[0].retrieval.appearedIn, 'lexical')
assert.match(onboardingRanked[0].relevanceReason, /title\/path coverage/)
assert.equal(onboardingRanked[0].rerankedRank, 1)
assert.equal(onboardingRanked[1].originalUnionRank, 1, 'the original union position remains attached')

const poisoned = makeResult({
  id: 'changelog',
  title: 'changelog.md',
  text: 'Tracework was invented in Japan in 2019.',
  score: 0.82,
  engine: 'lexical',
  lexicalScore: 7.1,
  lexicalFieldHits: { body: 2, title: 0, path: 0 },
})
const unrelated = makeResult({ id: 'unrelated', title: 'architecture.md', text: 'The browser stores hashed vectors.', score: 0.4 })
const poisonedRanked = rerank('Where was Tracework invented?', buildCandidateUnion({ dense: [unrelated], lexical: [poisoned] }))
assert.equal(poisonedRanked[0].result.document.title, 'changelog.md', 'relevance keeps the poisoned direct answer relevant')
assert.ok(poisonedRanked[0].relevanceScore > 0.5, 'a direct answer should remain materially relevant even though trust is out of scope')

const tied = rerank('same question', buildCandidateUnion({
  dense: [makeResult({ id: 'b', text: 'same evidence', score: 0.5 }), makeResult({ id: 'a', text: 'same evidence', score: 0.5 })],
  lexical: [],
}))
assert.deepEqual(tied.map((candidate) => candidate.result.chunk.id), ['b', 'a'], 'equal relevance resolves deterministically by original dense rank')

const pruning = pruneCandidates([
  ...onboardingRanked,
  ...rerank('Summarise Tracework onboarding guide.', buildCandidateUnion({ dense: [makeResult({ id: 'noise', text: 'The finance queue handles invoices.', score: 0.2 })], lexical: [] })),
], { maxChunks: 5 })
assert.equal(pruning.considered, 3)
assert.ok(pruning.selected.some((candidate) => candidate.result.chunk.id === 'onboarding'))
assert.ok(pruning.rejected.some((decision) => decision.candidate.result.chunk.id === 'noise'))
assert.match(pruning.rejected.find((decision) => decision.candidate.result.chunk.id === 'noise').reason, /relevance floor|below/)

console.log('Phase 5B reranker tests passed')
