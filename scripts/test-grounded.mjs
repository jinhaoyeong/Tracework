import assert from 'node:assert/strict'
import {
  attachValidatedCitations,
  buildGroundedContext,
  buildInsufficientAnswer,
  evaluateEvidence,
  validateCitations,
} from '../src/lib/grounded.ts'

const makeResult = ({ id, sourceId = 'source-a', title = 'notes.md', score, text, engine = 'neural', distance = 1 - score }) => ({
  chunk: {
    id,
    documentId: sourceId,
    index: 0,
    text,
    start: 0,
    end: text.length,
    tokens: text.toLocaleLowerCase().split(/\s+/),
    vector: [],
    neuralEmbedding: { model: 'text-embedding-3-small', dimensions: 1536, vector: [], createdAt: '2026-08-10T00:00:00.000Z' },
  },
  document: {
    id: sourceId,
    title,
    source: title,
    kind: 'note',
    content: text,
    createdAt: '2026-08-10T00:00:00.000Z',
    chunks: [],
  },
  score,
  semanticScore: score,
  keywordScore: 0,
  matchedTerms: [],
  engine,
  distance,
  embeddingModel: 'text-embedding-3-small',
  embeddingDimensions: 1536,
})

const strongResults = [
  makeResult({ id: 'chunk-1', score: 0.86, text: 'Tracework uses pgvector for database-backed semantic retrieval.' }),
  makeResult({ id: 'chunk-2', sourceId: 'source-b', title: 'architecture.md', score: 0.71, text: 'The database search ranks stored embeddings by cosine distance.' }),
]

const strong = evaluateEvidence('What does Tracework use for database vector search?', strongResults)
assert.equal(strong.status, 'strong')
assert.equal(strong.supportingChunkCount, 2)
assert.equal(strong.distinctSourceCount, 2)

const context = buildGroundedContext('What does Tracework use for database vector search?', strongResults, {
  retrievalEngine: 'pgvector',
  requestedTopK: 5,
})
assert.equal(context.chunks.length, 2)
assert.match(context.text, /^\[1\] notes\.md/)
assert.match(context.text, /embedding: text-embedding-3-small \/ 1536d/)
assert.match(context.text, /Tracework uses pgvector/)
assert.equal(context.retrievalEngine, 'pgvector')

const valid = attachValidatedCitations('Tracework uses pgvector for database search [1]. The search uses cosine distance [2].', context, { model: 'gpt-5-mini' })
assert.deepEqual(valid.citationNumbers, [1, 2])
assert.deepEqual(valid.validCitationNumbers, [1, 2])
assert.deepEqual(valid.invalidCitationNumbers, [])
assert.equal(valid.citations[0].chunk.id, 'chunk-1')
assert.equal(valid.model, 'gpt-5-mini')

const mixed = validateCitations('Supported claim [1], malformed source [9], then another supported claim [2].', context)
assert.deepEqual(mixed.citationNumbers, [1, 9, 2])
assert.deepEqual(mixed.validCitationNumbers, [1, 2])
assert.deepEqual(mixed.invalidCitationNumbers, [9])
assert.equal(mixed.isValid, false)

const weak = evaluateEvidence('What did I eat on a date not in the corpus?', [
  makeResult({ id: 'weak-1', score: 0.31, text: 'The Tokyo planner stores destination notes.' }),
])
assert.equal(weak.status, 'insufficient')
const refusal = buildInsufficientAnswer(weak)
assert.match(refusal.body, /couldn't find enough evidence/i)
assert.deepEqual(refusal.citations, [])

console.log('grounded RAG tests passed')
