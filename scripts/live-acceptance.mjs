/**
 * Phase 4 live credentialed acceptance run.
 *
 * Drives the real pipeline end to end against the running dev server:
 *   real text -> /api/embed -> pgvector sync -> /api/vector/search
 *   -> evaluateEvidence -> buildGroundedContext -> /api/generate
 *   -> classifyGeneratedAnswer
 *
 * Nothing here re-implements retrieval or grounding: it imports the same
 * functions the app uses, so the numbers describe Tracework, not the harness.
 *
 *   npm.cmd run dev            # in another terminal
 *   node --experimental-strip-types scripts/live-acceptance.mjs
 */
import { writeFileSync } from 'node:fs'
import { createDocument, tokenize } from '../src/lib/rag.ts'
import { buildGroundedContext, classifyGeneratedAnswer, evaluateEvidence } from '../src/lib/grounded.ts'
import { CORE_CORPUS, PADDED_CORPUS, QUESTIONS } from './fixtures/stress-corpus.mjs'

const BASE = process.env.TRACEWORK_BASE_URL ?? 'http://localhost:5173'
const TOP_K = 5
// --padded runs the same questions against the padded benchmark corpus, which
// is the dense-only control that Phase 5 must be compared against.
const padded = process.argv.includes('--padded')

const post = async (path, body) => {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.error) {
    const error = new Error(payload?.error?.message ?? `${path} failed with ${response.status}`)
    error.code = payload?.error?.code ?? `http_${response.status}`
    throw error
  }
  return payload
}

/* ------------------------------------------------------------------ corpus */

const CORPUS = padded ? PADDED_CORPUS : CORE_CORPUS

/* --------------------------------------------------------------- pipeline */

const log = (...parts) => console.log(...parts)

const embed = async (input) => post('/api/embed', { input })

const main = async () => {
  const startedAt = Date.now()
  log(`Tracework live acceptance run against ${BASE}\n`)

  // 1. Index the corpus with the app's own chunker.
  const documents = CORPUS.map(([title, content]) => createDocument(title, title, content, 'note', { id: `fixture-${title}` }))
  const allChunks = documents.flatMap((document) => document.chunks)
  log(`corpus: ${documents.length} sources / ${allChunks.length} chunks`)

  // 2. Real neural embeddings.
  const embedResponse = await embed(allChunks.map((chunk) => chunk.text))
  const embeddingModel = embedResponse.model
  const embeddingDimensions = embedResponse.dimensions
  log(`embeddings: ${embedResponse.embeddings.length} vectors / ${embeddingModel} / ${embeddingDimensions}d`)

  allChunks.forEach((chunk, index) => {
    chunk.neuralEmbedding = {
      model: embeddingModel,
      dimensions: embeddingDimensions,
      vector: embedResponse.embeddings[index],
      createdAt: new Date().toISOString(),
    }
  })

  // 3. Real Supabase / pgvector storage.
  const sync = await post('/api/vector/sync', {
    documents: documents.map((document) => ({
      id: document.id,
      title: document.title,
      sourcePath: document.source,
      kind: document.kind,
      content: document.content,
      createdAt: document.createdAt,
      chunks: document.chunks.map((chunk) => ({
        id: chunk.id,
        index: chunk.index,
        text: chunk.text,
        start: chunk.start,
        end: chunk.end,
        neuralEmbedding: chunk.neuralEmbedding,
      })),
    })),
  })
  log(`pgvector: ${sync.syncedSources} sources / ${sync.syncedChunks} chunks -> ${sync.database}\n`)

  const documentsById = new Map(documents.map((document) => [document.id, document]))
  const records = []
  let queryEmbeddingCount = 0

  for (const spec of QUESTIONS) {
    const record = { ...spec, retrieved: [], errors: [] }
    try {
      // 4. Real query embedding + real pgvector ranking.
      const queryEmbedding = await embed([spec.question])
      queryEmbeddingCount += 1
      const search = await post('/api/vector/search', {
        queryVector: queryEmbedding.embeddings[0],
        limit: TOP_K,
        sourceKind: null,
      })

      const queryTokens = tokenize(spec.question)
      const results = search.results.map((match) => {
        const document = documentsById.get(match.sourceId)
        const chunk = document?.chunks.find((item) => item.id === match.id) ?? {
          id: match.id, documentId: match.sourceId, index: match.chunkIndex, text: match.content,
          start: match.startOffset, end: match.endOffset, tokens: tokenize(match.content), vector: [],
        }
        return {
          chunk,
          document: document ?? {
            id: match.sourceId, title: match.title, source: match.sourcePath, kind: match.kind,
            content: match.sourceContent, createdAt: new Date().toISOString(), chunks: [chunk],
          },
          score: Math.max(0, Math.min(1, match.similarity)),
          semanticScore: Math.max(0, Math.min(1, match.similarity)),
          keywordScore: [...new Set(queryTokens.filter((term) => chunk.tokens.includes(term)))].length / (queryTokens.length || 1),
          matchedTerms: [...new Set(queryTokens.filter((term) => chunk.tokens.includes(term)))],
          engine: 'pgvector',
          distance: match.distance,
          embeddingModel: match.embeddingModel,
          embeddingDimensions: match.embeddingDimensions,
          candidateCount: match.candidateCount,
          database: search.database,
        }
      })

      record.retrieved = results.map((result, index) => ({
        rank: index + 1,
        source: result.document.title,
        similarity: Number(result.score.toFixed(4)),
        distance: Number((result.distance ?? 0).toFixed(4)),
        distractor: !spec.relevant.includes(result.document.title),
      }))
      record.candidateCount = results[0]?.candidateCount ?? 0
      // Rows already in the database from earlier work. They are real retrieval
      // competition, but they are outside this corpus, so a rerun only compares
      // to this baseline if the database holds the same pre-existing sources.
      const corpusTitles = new Set(CORPUS.map(([title]) => title))
      record.foreignSources = record.retrieved.filter((row) => !corpusTitles.has(row.source)).map((row) => row.source)

      // 5. Evidence assessment + exact context, unchanged from the app.
      const assessment = evaluateEvidence(spec.question, results)
      const context = buildGroundedContext(spec.question, results, { retrievalEngine: 'pgvector', requestedTopK: TOP_K })
      record.assessment = {
        status: assessment.status,
        bestScore: Number(assessment.bestScore.toFixed(4)),
        candidateChunksAboveFloor: assessment.candidateChunksAboveFloor,
        distinctSourceCount: assessment.distinctSourceCount,
        reason: assessment.reason,
      }
      record.sentToModel = context.chunks.map((chunk) => chunk.result.document.title)
      record.contextWarnings = context.chunks.flatMap((chunk) => chunk.warnings.map((warning) => `${chunk.result.document.title}: ${warning}`))
      record.contextCharacters = context.characters

      if (assessment.status === 'insufficient') {
        record.outcome = 'refused'
        record.refusalKind = 'deterministic'
        record.body = `Generation skipped. ${assessment.reason}`
        record.citations = []
      } else {
        // 6. Real generation.
        const generation = await post('/api/generate', {
          question: context.question,
          context: context.text,
          retrievalEngine: context.retrievalEngine,
          requestedTopK: context.requestedTopK,
          chunks: context.chunks.map((chunk) => ({ citation: chunk.citation, sourceId: chunk.result.document.id, chunkId: chunk.result.chunk.id })),
        })
        const classified = classifyGeneratedAnswer(generation.answer, context, { model: generation.model })
        record.outcome = classified.outcome
        record.refusalKind = classified.outcome === 'refused' ? 'model' : undefined
        record.body = classified.answer.body
        record.reason = classified.reason
        record.generationModel = generation.model
        record.inputTokens = generation.inputTokens
        record.outputTokens = generation.outputTokens
        record.totalTokens = generation.totalTokens
        record.citations = classified.answer.validCitationNumbers.map((number) => ({
          marker: number,
          source: context.chunks[number - 1].result.document.title,
        }))
        record.invalidCitationNumbers = classified.answer.invalidCitationNumbers
        record.malformedCitationMarkers = classified.answer.malformedCitationMarkers
      }
    } catch (error) {
      record.outcome = 'error'
      record.errors.push(`${error.code ?? 'error'}: ${error.message}`)
    }

    // 7. Automatic verdict. Citation-support remains a manual judgement.
    const answered = record.outcome === 'answered'
    const refused = record.outcome === 'refused'
    let pass = false
    let category = ''
    if (record.outcome === 'error') {
      category = 'provider/API failure'
    } else if (spec.behavior === 'refuse') {
      pass = refused
      if (!pass) category = answered ? 'model hallucination' : 'unusable response'
    } else if (spec.behavior === 'either') {
      const forbidOk = !spec.forbid || !spec.forbid.test(record.body ?? '')
      pass = forbidOk && (refused || (answered && record.citations.length > 0))
      if (!forbidOk) category = 'model hallucination'
      else if (!pass) category = 'unusable response'
    } else {
      const bodyOk = !spec.expect || spec.expect.test(record.body ?? '')
      const forbidOk = !spec.forbid || !spec.forbid.test(record.body ?? '')
      const sourceOk = !spec.expectSources.length || record.citations?.some((citation) => spec.expectSources.includes(citation.source))
      pass = answered && bodyOk && forbidOk && sourceOk
      if (!answered) category = refused ? 'model refusal (evidence was present)' : 'unusable response'
      else if (!forbidOk) category = 'model hallucination / injection obeyed'
      else if (!bodyOk) category = 'wrong answer from retrieved evidence'
      else if (!sourceOk) category = 'citation-support failure'
    }
    record.pass = pass
    record.failureCategory = pass ? '' : category

    // Retrieval metrics are independent of what the model then did.
    record.recallAt1 = spec.expectSources.length ? spec.expectSources.includes(record.retrieved[0]?.source) : null
    record.recallAt5 = spec.expectSources.length
      ? record.retrieved.some((row) => spec.expectSources.includes(row.source))
      : null
    record.distractorsInContext = record.retrieved.filter((row) => row.distractor).length

    records.push(record)
    log(`${record.id} ${record.pass ? 'PASS' : 'FAIL'}  ${spec.behavior.padEnd(6)} -> ${record.outcome.padEnd(8)} ` +
      `evidence=${record.assessment?.status ?? 'n/a'} top1=${record.retrieved[0]?.source ?? 'n/a'} ` +
      `distractors=${record.distractorsInContext}${record.failureCategory ? `  [${record.failureCategory}]` : ''}`)
  }

  // 8. Leave the database as we found it.
  try {
    await post('/api/vector/delete', { sourceIds: documents.map((document) => document.id) })
    log('\npgvector: test sources deleted')
  } catch (error) {
    log(`\npgvector cleanup failed: ${error.message}`)
  }

  const scored = records.filter((record) => record.expectSources.length)
  const summary = {
    startedAt: new Date(startedAt).toISOString(),
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    embeddingModel,
    embeddingDimensions,
    generationModel: records.find((record) => record.generationModel)?.generationModel ?? null,
    topK: TOP_K,
    corpusSources: documents.length,
    corpusChunks: allChunks.length,
    retrieval: {
      scoredQuestions: scored.length,
      recallAt1: scored.filter((record) => record.recallAt1).length,
      recallAt5: scored.filter((record) => record.recallAt5).length,
      questionsWithDistractors: records.filter((record) => record.distractorsInContext > 0).length,
      questionsWithTwoOrMoreDistractors: records.filter((record) => record.distractorsInContext >= 2).length,
      averageRelevantChunksSent: Number((records.reduce((total, record) => total + (record.retrieved.length - record.distractorsInContext), 0) / records.length).toFixed(2)),
      questionsWithForeignSources: records.filter((record) => (record.foreignSources?.length ?? 0) > 0).length,
      foreignSourcesSeen: [...new Set(records.flatMap((record) => record.foreignSources ?? []))],
    },
    generation: {
      answered: records.filter((record) => record.outcome === 'answered').length,
      refused: records.filter((record) => record.outcome === 'refused').length,
      modelRefusals: records.filter((record) => record.refusalKind === 'model').length,
      deterministicRefusals: records.filter((record) => record.refusalKind === 'deterministic').length,
      unusable: records.filter((record) => record.outcome === 'unusable').length,
      errors: records.filter((record) => record.outcome === 'error').length,
      passed: records.filter((record) => record.pass).length,
      citationMarkerFailures: records.filter((record) => (record.invalidCitationNumbers?.length ?? 0) + (record.malformedCitationMarkers?.length ?? 0) > 0).length,
    },
    tokens: {
      generationInput: records.reduce((total, record) => total + (record.inputTokens ?? 0), 0),
      generationOutput: records.reduce((total, record) => total + (record.outputTokens ?? 0), 0),
      generationTotal: records.reduce((total, record) => total + (record.totalTokens ?? 0), 0),
      embeddingRequests: 1 + queryEmbeddingCount,
      embeddedChunks: allChunks.length,
      embeddedQueries: queryEmbeddingCount,
    },
  }

  writeFileSync(process.env.TRACEWORK_OUT ?? 'docs/phase4-baseline.json', `${JSON.stringify({ summary, records }, null, 2)}\n`)
  log(`\n${summary.generation.passed}/${records.length} questions passed`)
  log(`recall@1 ${summary.retrieval.recallAt1}/${scored.length} · recall@5 ${summary.retrieval.recallAt5}/${scored.length}`)
  log(`tokens in/out ${summary.tokens.generationInput}/${summary.tokens.generationOutput}`)
  log('baseline written to docs/phase4-baseline.json')
}

main().catch((error) => {
  console.error(`\nrun aborted: ${error.code ?? 'error'} — ${error.message}`)
  process.exitCode = 1
})
