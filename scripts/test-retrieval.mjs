import assert from 'node:assert/strict'
import { createDocument } from '../src/lib/rag.ts'
import { buildLexicalIndex, searchLexical, toLexicalResults, BM25_K1, BM25_B, TITLE_WEIGHT } from '../src/lib/lexical.ts'
import { fuseRankings, RRF_K } from '../src/lib/fusion.ts'

const documents = [
  createDocument('onboarding.md', 'onboarding.md', 'New engineers should read the retrieval guide first. The guide covers chunking and embeddings.'),
  createDocument('architecture.md', 'architecture.md', 'Tracework stores chunk embeddings in Postgres using pgvector. Retrieval ranks vectors by cosine distance.'),
  createDocument('billing-faq.md', 'billing-faq.md', 'Invoices are issued monthly. Seat changes are prorated in the following billing cycle.'),
]
const index = buildLexicalIndex(documents)

assert.equal(index.size, 3)
assert.ok(index.averageLength > 0)

// The Q8 case: the query term appears only in the title, never in the body.
const titleOnly = searchLexical(index, "Summarise Tracework's onboarding guide", 5)
assert.equal(titleOnly[0].documentId, documents[0].id, 'title match should win when the body never says "onboarding"')
assert.equal(titleOnly[0].titleMatched, true)
assert.equal(titleOnly[0].pathMatched, true)
assert.ok(titleOnly[0].fieldHits.title > 0)

// Body matching still works on its own.
const bodyOnly = searchLexical(index, 'cosine distance pgvector', 5)
assert.equal(bodyOnly[0].documentId, documents[1].id)
assert.equal(bodyOnly[0].fieldHits.body > 0, true)
assert.equal(bodyOnly[0].titleMatched, false)

// A term in no document scores nothing rather than returning noise.
assert.deepEqual(searchLexical(index, 'kubernetes helm', 5), [])
assert.deepEqual(searchLexical(index, '', 5), [])

// BM25 constants are the documented ones, not silently retuned.
assert.equal(BM25_K1, 1.2)
assert.equal(BM25_B, 0.75)
assert.equal(TITLE_WEIGHT, 3)

// Normalised SearchResult scores order identically and stay in [0,1].
const lexicalResults = toLexicalResults(searchLexical(index, 'retrieval guide embeddings', 5), documents)
assert.ok(lexicalResults.length >= 1)
assert.equal(lexicalResults[0].engine, 'lexical')
assert.equal(lexicalResults[0].score, 1)
assert.ok(lexicalResults.every((result) => result.score >= 0 && result.score <= 1))
assert.ok(lexicalResults.every((result) => result.lexicalScore > 0))

/* ------------------------------------------------------------------ fusion */

const asResult = (documentIndex, score) => ({
  chunk: documents[documentIndex].chunks[0],
  document: documents[documentIndex],
  score, semanticScore: score, keywordScore: 0, matchedTerms: [], engine: 'pgvector',
})

assert.equal(RRF_K, 60)

// A chunk found only by lexical search still enters the fused ranking.
const lexicalOnly = fuseRankings({ dense: [asResult(1, 0.9)], lexical: [asResult(0, 1)] }, 5)
assert.equal(lexicalOnly.length, 2)
assert.equal(lexicalOnly.some((result) => result.document.title === 'onboarding.md'), true)

// A chunk found only by dense search survives too.
const denseOnly = fuseRankings({ dense: [asResult(2, 0.8)], lexical: [] }, 5)
assert.equal(denseOnly.length, 1)
assert.equal(denseOnly[0].fusion.lexicalRank, null)
assert.equal(denseOnly[0].fusion.lexicalContribution, 0)

// Agreement beats a single strong ranking: ranked 2nd by both should outscore
// ranked 1st by one ranker and absent from the other.
const agreement = fuseRankings({
  dense: [asResult(0, 0.9), asResult(1, 0.8)],
  lexical: [asResult(2, 1), asResult(1, 0.5)],
}, 5)
assert.equal(agreement[0].document.title, 'architecture.md', 'the chunk both rankers liked should lead')
assert.equal(agreement[0].fusion.denseRank, 2)
assert.equal(agreement[0].fusion.lexicalRank, 2)
assert.ok(agreement[0].fusion.rrfScore > agreement[1].fusion.rrfScore)

// Duplicates are merged, not double counted.
const duplicated = fuseRankings({ dense: [asResult(0, 0.9), asResult(0, 0.9)], lexical: [asResult(0, 1)] }, 5)
assert.equal(duplicated.length, 1)
assert.equal(duplicated[0].fusion.denseRank, 1)

// Ties resolve deterministically: identical input must give identical output,
// so a rerun cannot silently reorder Top-K.
const tiedInput = { dense: [asResult(0, 0.5), asResult(1, 0.5)], lexical: [asResult(1, 0.5), asResult(0, 0.5)] }
const first = fuseRankings(tiedInput, 5)
const second = fuseRankings(tiedInput, 5)
assert.deepEqual(first.map((result) => result.chunk.id), second.map((result) => result.chunk.id))

// And the tie-break is the documented one: equal RRF score resolves to the
// better dense rank, which is why swapping the roles swaps the output.
assert.equal(first[0].fusion.denseRank, 1)
assert.equal(first[0].fusion.rrfScore, first[1].fusion.rrfScore)
const swapped = fuseRankings({ dense: [asResult(1, 0.5), asResult(0, 0.5)], lexical: [asResult(0, 0.5), asResult(1, 0.5)] }, 5)
assert.equal(swapped[0].chunk.id, first[1].chunk.id, 'swapping which ranker led should swap the tie-break winner')

// Fusion preserves dense metadata and marks the engine.
const merged = fuseRankings({ dense: [{ ...asResult(1, 0.9), distance: 0.11, embeddingModel: 'text-embedding-3-small' }], lexical: [asResult(1, 1)] }, 5)
assert.equal(merged[0].engine, 'hybrid')
assert.equal(merged[0].distance, 0.11)
assert.equal(merged[0].embeddingModel, 'text-embedding-3-small')
assert.equal(merged[0].fusion.denseRank, 1)
assert.equal(merged[0].fusion.lexicalRank, 1)

console.log('retrieval tests passed')
