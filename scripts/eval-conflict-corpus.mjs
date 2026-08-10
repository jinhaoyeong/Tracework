/**
 * Phase 5C integration experiment: control vs treatment on one conflict corpus.
 *
 * Both conditions share the corpus, the embeddings, the retrieval, the union,
 * the reranker, and the pruner. They differ only in whether adjudication runs,
 * so any difference in outcome is attributable to Phase 5C alone.
 *
 * The question under test is whether the real chain preserves both conflicting
 * witnesses. Context is recorded before and after ensureConflictCoverage, so
 * its specific contribution is visible rather than assumed.
 *
 *   npm.cmd run dev
 *   node --experimental-strip-types scripts/eval-conflict-corpus.mjs
 */
import { writeFileSync } from 'node:fs'
import { createDocument, tokenize } from '../src/lib/rag.ts'
import { buildLexicalIndex, searchLexical, toLexicalResults } from '../src/lib/lexical.ts'
import { buildCandidateUnion, pruneCandidates, rerank } from '../src/lib/reranker.ts'
import { adjudicateEvidence, ensureConflictCoverage } from '../src/lib/adjudication.ts'
import { buildConflictAnswer, buildGroundedContext, classifyGeneratedAnswer, evaluateEvidence } from '../src/lib/grounded.ts'
import { CONFLICT_CORPUS, CONFLICT_QUESTIONS } from './fixtures/conflict-corpus.mjs'

const BASE = process.env.TRACEWORK_BASE_URL ?? 'http://localhost:5173'
const TOP_K = 5
const CANDIDATE_N = 10
let providerCalls = 0

const post = async (path, body) => {
  if (path === '/api/generate') providerCalls += 1
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.error) {
    const error = new Error(payload?.error?.message ?? `${path} failed with ${response.status}`)
    error.code = payload?.error?.code ?? `http_${response.status}`
    throw error
  }
  return payload
}

const titlesOf = (rows) => rows.map((row) => (row.result ?? row).document.title)

const main = async () => {
  console.log(`Phase 5C conflict-corpus experiment against ${BASE}\n`)

  const documents = CONFLICT_CORPUS.map(([title, content]) => createDocument(title, title, content, 'note', { id: `fixture-${title}` }))
  const allChunks = documents.flatMap((document) => document.chunks)
  console.log(`corpus: ${documents.length} sources / ${allChunks.length} chunks (frozen padded corpus + project-history.md)`)

  // One embedding pass, shared by both conditions.
  const vectors = []
  for (let offset = 0; offset < allChunks.length; offset += 64) {
    const batch = allChunks.slice(offset, offset + 64)
    const response = await post('/api/embed', { input: batch.map((chunk) => chunk.text) })
    vectors.push(...response.embeddings)
  }
  allChunks.forEach((chunk, index) => {
    chunk.neuralEmbedding = { model: 'text-embedding-3-small', dimensions: 1536, vector: vectors[index], createdAt: '2026-08-10T00:00:00.000Z' }
  })

  const sync = await post('/api/vector/sync', {
    documents: documents.map((document) => ({
      id: document.id, title: document.title, sourcePath: document.source, kind: document.kind,
      content: document.content, createdAt: document.createdAt,
      chunks: document.chunks.map((chunk) => ({
        id: chunk.id, index: chunk.index, text: chunk.text, start: chunk.start, end: chunk.end, neuralEmbedding: chunk.neuralEmbedding,
      })),
    })),
  })
  console.log(`pgvector: ${sync.syncedSources} sources / ${sync.syncedChunks} chunks`)

  const lexicalIndex = buildLexicalIndex(documents)
  const documentsById = new Map(documents.map((document) => [document.id, document]))
  const records = []

  for (const spec of CONFLICT_QUESTIONS) {
    // ---- shared pipeline: identical for both conditions ----
    const queryEmbedding = await post('/api/embed', { input: [spec.question] })
    const search = await post('/api/vector/search', { queryVector: queryEmbedding.embeddings[0], limit: CANDIDATE_N, sourceKind: null })
    const queryTokens = tokenize(spec.question)

    const dense = search.results.flatMap((match) => {
      const document = documentsById.get(match.sourceId)
      const chunk = document?.chunks.find((item) => item.id === match.id)
      if (!document || !chunk) return []
      const matched = [...new Set(queryTokens.filter((term) => chunk.tokens.includes(term)))]
      return [{
        chunk, document,
        score: Math.max(0, Math.min(1, match.similarity)), semanticScore: Math.max(0, Math.min(1, match.similarity)),
        keywordScore: matched.length / (queryTokens.length || 1), matchedTerms: matched,
        engine: 'pgvector', distance: match.distance,
        embeddingModel: match.embeddingModel, embeddingDimensions: match.embeddingDimensions,
        candidateCount: match.candidateCount, database: search.database,
      }]
    })
    const lexical = toLexicalResults(searchLexical(lexicalIndex, spec.question, CANDIDATE_N), documents)
    const union = buildCandidateUnion({ dense, lexical, limit: CANDIDATE_N })
    const ranked = rerank(spec.question, union)
    const pruning = pruneCandidates(ranked, { maxChunks: TOP_K })
    const prunedRows = pruning.selected.map((candidate) => candidate.result)

    const rankOf = (rows, title) => {
      const index = rows.findIndex((row) => (row.result ?? row).document.title === title)
      return index === -1 ? null : index + 1
    }

    const witnessTracking = spec.conflictWitnesses.map((title) => ({
      source: title,
      denseRank: rankOf(dense, title),
      lexicalRank: rankOf(lexical, title),
      inUnion: rankOf(union, title) !== null,
      unionRank: rankOf(union, title),
      rerankedRank: rankOf(ranked, title),
      survivedPruning: rankOf(prunedRows, title) !== null,
    }))

    const record = {
      id: spec.id,
      question: spec.question,
      probe: spec.probe,
      denseCandidates: dense.map((row, index) => ({ rank: index + 1, source: row.document.title, similarity: Number(row.score.toFixed(4)), distance: Number((row.distance ?? 0).toFixed(4)) })),
      lexicalCandidates: lexical.map((row, index) => ({ rank: index + 1, source: row.document.title, bm25: Number((row.lexicalScore ?? 0).toFixed(4)) })),
      unionMembership: union.map((candidate) => ({ unionRank: candidate.unionRank, source: candidate.result.document.title, appearedIn: candidate.retrieval.appearedIn })),
      rerankedCandidates: ranked.map((candidate) => ({ rank: candidate.rerankedRank, source: candidate.result.document.title, relevanceScore: Number(candidate.relevanceScore.toFixed(4)), label: candidate.relevanceLabel })),
      contextBeforeConflictCoverage: titlesOf(prunedRows),
      witnessTracking,
      conditions: {},
    }

    // ---- CONTROL: Phase 5B, adjudication disabled ----
    {
      const rows = prunedRows
      const assessment = evaluateEvidence(spec.question, rows)
      const context = buildGroundedContext(spec.question, rows, { retrievalEngine: 'unionRerankPrune', requestedTopK: rows.length, limit: rows.length })
      const condition = {
        adjudicationEnabled: false,
        contextSent: titlesOf(rows),
        evidenceStatus: assessment.status,
        adjudicationStatus: null,
        claims: [],
        conflicts: 0,
      }
      if (assessment.status === 'insufficient') {
        Object.assign(condition, { providerCalled: false, outcome: 'refused', refusalKind: 'deterministic', body: assessment.reason, citations: [], inputTokens: 0, outputTokens: 0 })
      } else {
        const generated = await post('/api/generate', {
          question: context.question, context: context.text, retrievalEngine: context.retrievalEngine, requestedTopK: context.requestedTopK,
          chunks: context.chunks.map((chunk) => ({ citation: chunk.citation, sourceId: chunk.result.document.id, chunkId: chunk.result.chunk.id })),
        })
        const classified = classifyGeneratedAnswer(generated.answer, context, { model: generated.model })
        Object.assign(condition, {
          providerCalled: true, outcome: classified.outcome, body: classified.answer.body, model: generated.model,
          citations: classified.answer.validCitationNumbers.map((number) => context.chunks[number - 1].result.document.title),
          inputTokens: generated.inputTokens ?? 0, outputTokens: generated.outputTokens ?? 0,
        })
      }
      condition.correct = !(spec.forbid && spec.forbid.test(condition.body ?? ''))
      record.conditions.control = condition
    }

    // ---- TREATMENT: identical pipeline, adjudication enabled ----
    {
      // Adjudicate over the PRE-pruning ranked list, exactly as App.tsx does.
      // Adjudicating the pruned rows instead is circular: pruning removes the
      // counter-witness, so no conflict is detected, so ensureConflictCoverage
      // returns early and never restores the witness it exists to protect.
      const adjudication = adjudicateEvidence(spec.question, ranked.map((candidate) => candidate.result))
      const covered = ensureConflictCoverage(adjudication, prunedRows, TOP_K)
      const contextAdjudication = adjudicateEvidence(spec.question, covered)
      const assessment = evaluateEvidence(spec.question, covered)
      const context = buildGroundedContext(spec.question, covered, {
        retrievalEngine: 'unionRerankPrune', requestedTopK: covered.length, limit: covered.length, adjudication: contextAdjudication,
      })

      const condition = {
        adjudicationEnabled: true,
        adjudicationBeforeCoverage: adjudication.status,
        contextAfterConflictCoverage: titlesOf(covered),
        conflictCoverageAddedSources: titlesOf(covered).filter((title) => !titlesOf(prunedRows).includes(title)),
        contextSent: titlesOf(covered),
        evidenceStatus: assessment.status,
        adjudicationStatus: contextAdjudication.status,
        claims: contextAdjudication.claims.map((claim) => ({ source: claim.sourceTitle, value: claim.value, citation: claim.citation, authority: claim.result.document.provenance?.authority ?? 'unknown' })),
        conflicts: contextAdjudication.conflicts.length,
        notice: contextAdjudication.notice,
      }

      if (assessment.status !== 'insufficient' && contextAdjudication.status === 'conflicted') {
        const held = buildConflictAnswer(contextAdjudication)
        Object.assign(condition, {
          providerCalled: false, outcome: 'conflict-held', body: held.body,
          citations: held.validCitationNumbers.map((number) => context.chunks[number - 1]?.result.document.title ?? 'out of range'),
          inputTokens: 0, outputTokens: 0,
        })
      } else if (assessment.status === 'insufficient') {
        Object.assign(condition, { providerCalled: false, outcome: 'refused', refusalKind: 'deterministic', body: assessment.reason, citations: [], inputTokens: 0, outputTokens: 0 })
      } else {
        const generated = await post('/api/generate', {
          question: context.question, context: context.text, retrievalEngine: context.retrievalEngine, requestedTopK: context.requestedTopK,
          chunks: context.chunks.map((chunk) => ({ citation: chunk.citation, sourceId: chunk.result.document.id, chunkId: chunk.result.chunk.id })),
        })
        const classified = classifyGeneratedAnswer(generated.answer, context, { model: generated.model })
        Object.assign(condition, {
          providerCalled: true, outcome: classified.outcome, body: classified.answer.body, model: generated.model,
          citations: classified.answer.validCitationNumbers.map((number) => context.chunks[number - 1].result.document.title),
          inputTokens: generated.inputTokens ?? 0, outputTokens: generated.outputTokens ?? 0,
        })
      }
      condition.correct = !(spec.forbid && spec.forbid.test(condition.body ?? ''))
      record.conditions.treatment = condition
    }

    // Did ensureConflictCoverage actually rescue a witness pruning had dropped?
    const treatment = record.conditions.treatment
    record.conflictCoverageWasNecessary = treatment.conflictCoverageAddedSources.length > 0
    record.bothWitnessesReachedAdjudication = spec.conflictWitnesses.every((title) => treatment.contextSent.includes(title))

    records.push(record)

    console.log(`\n${spec.id}`)
    console.log(`  witness tracking:`)
    for (const witness of witnessTracking) {
      console.log(`    ${witness.source.padEnd(22)} dense=${witness.denseRank ?? '—'} lexical=${witness.lexicalRank ?? '—'} union=${witness.unionRank ?? '—'} rerank=${witness.rerankedRank ?? '—'} survivedPrune=${witness.survivedPruning}`)
    }
    console.log(`  context before coverage : ${record.contextBeforeConflictCoverage.join(', ') || '(empty)'}`)
    console.log(`  context after coverage  : ${treatment.contextAfterConflictCoverage.join(', ') || '(empty)'}`)
    console.log(`  coverage added          : ${treatment.conflictCoverageAddedSources.join(', ') || '(nothing — witness already present)'}`)
    console.log(`\n  CONTROL   provider=${record.conditions.control.providerCalled} outcome=${record.conditions.control.outcome} correct=${record.conditions.control.correct}`)
    console.log(`            cites: ${JSON.stringify(record.conditions.control.citations)}`)
    console.log(`            ${(record.conditions.control.body ?? '').replace(/\s+/g, ' ').slice(0, 130)}`)
    console.log(`\n  TREATMENT provider=${treatment.providerCalled} outcome=${treatment.outcome} adjudication=${treatment.adjudicationStatus} correct=${treatment.correct}`)
    console.log(`            cites: ${JSON.stringify(treatment.citations)}`)
    console.log(`            ${(treatment.body ?? '').replace(/\s+/g, ' ').slice(0, 200)}`)
  }

  try {
    await post('/api/vector/delete', { sourceIds: documents.map((document) => document.id) })
    console.log('\npgvector: test sources deleted')
  } catch (error) {
    console.log(`\npgvector cleanup failed: ${error.message}`)
  }

  const output = {
    recordedAt: new Date().toISOString(),
    phase: '5C-conflict-corpus',
    corpusSources: documents.length,
    topK: TOP_K,
    candidateLimit: CANDIDATE_N,
    providerCalls,
    totalInputTokens: records.reduce((total, record) => total + record.conditions.control.inputTokens + record.conditions.treatment.inputTokens, 0),
    totalOutputTokens: records.reduce((total, record) => total + record.conditions.control.outputTokens + record.conditions.treatment.outputTokens, 0),
    records,
  }
  writeFileSync('docs/phase5c-conflict-corpus.json', `${JSON.stringify(output, null, 2)}\n`)
  console.log(`\nprovider calls: ${providerCalls} · tokens ${output.totalInputTokens} in / ${output.totalOutputTokens} out`)
  console.log('written to docs/phase5c-conflict-corpus.json')
}

main().catch((error) => {
  console.error(`\nrun aborted: ${error.code ?? 'error'} — ${error.message}`)
  process.exitCode = 1
})
