/**
 * Phase 5A retrieval benchmark: dense vs lexical vs hybrid on one corpus.
 *
 * Retrieval is measured for all three engines on every question. Generation is
 * optional (--generate) and runs the unchanged Phase 4 grounding path, so any
 * change in answers is attributable to retrieval alone.
 *
 *   npm.cmd run dev
 *   node --experimental-strip-types scripts/eval-retrieval.mjs [--generate] [--core]
 */
import { writeFileSync } from 'node:fs'
import { createDocument, tokenize } from '../src/lib/rag.ts'
import { buildLexicalIndex, searchLexical, toLexicalResults } from '../src/lib/lexical.ts'
import { fuseRankings, RRF_K } from '../src/lib/fusion.ts'
import { buildGroundedContext, classifyGeneratedAnswer, evaluateEvidence } from '../src/lib/grounded.ts'
import { CORE_CORPUS, PADDED_CORPUS, QUESTIONS } from './fixtures/stress-corpus.mjs'
import { createUsageTracker } from './usage.mjs'

const BASE = process.env.TRACEWORK_BASE_URL ?? 'http://localhost:5173'
const usageTracker = createUsageTracker()
const TOP_K = 5
const CANDIDATE_K = 10
const withGeneration = process.argv.includes('--generate')
const corpusSpec = process.argv.includes('--core') ? CORE_CORPUS : PADDED_CORPUS
const corpusLabel = process.argv.includes('--core') ? 'core' : 'padded'

const post = async (path, body) => {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.error) {
    const error = new Error(payload?.error?.message ?? `${path} failed with ${response.status}`)
    error.code = payload?.error?.code ?? `http_${response.status}`
    throw error
  }
  usageTracker.record(path, body, payload)
  return payload
}

const embed = (input) => post('/api/embed', { input })

/** Reciprocal rank of the first expected source, 0 when it never appears. */
const reciprocalRank = (rows, expectSources) => {
  const index = rows.findIndex((row) => expectSources.includes(row.source))
  return index === -1 ? 0 : 1 / (index + 1)
}

const summarise = (rows) => rows.map((row, index) => ({
  rank: index + 1,
  source: row.document.title,
  score: Number(row.score.toFixed(4)),
  lexicalScore: row.lexicalScore === undefined ? undefined : Number(row.lexicalScore.toFixed(4)),
  titleMatched: row.lexicalFieldHits ? row.lexicalFieldHits.title > 0 : undefined,
  matchedTerms: row.matchedTerms,
  denseRank: row.fusion?.denseRank ?? undefined,
  lexicalRank: row.fusion?.lexicalRank ?? undefined,
  rrfScore: row.fusion ? Number(row.fusion.rrfScore.toFixed(6)) : undefined,
}))

const main = async () => {
  console.log(`Phase 5A retrieval benchmark / ${corpusLabel} corpus / generation ${withGeneration ? 'on' : 'off'}\n`)

  const documents = corpusSpec.map(([title, content]) => createDocument(title, title, content, 'note', { id: `fixture-${title}` }))
  const allChunks = documents.flatMap((document) => document.chunks)
  console.log(`corpus: ${documents.length} sources / ${allChunks.length} chunks`)

  // Dense side: real embeddings, real pgvector. Batches respect the route limit.
  const vectors = []
  for (let offset = 0; offset < allChunks.length; offset += 64) {
    const batch = allChunks.slice(offset, offset + 64)
    const response = await embed(batch.map((chunk) => chunk.text))
    vectors.push(...response.embeddings)
    if (offset === 0) console.log(`embeddings: ${response.model} / ${response.dimensions}d`)
  }
  allChunks.forEach((chunk, index) => {
    chunk.neuralEmbedding = {
      model: 'text-embedding-3-small', dimensions: 1536, vector: vectors[index], createdAt: new Date().toISOString(),
    }
  })

  const sync = await post('/api/vector/sync', {
    documents: documents.map((document) => ({
      id: document.id, title: document.title, sourcePath: document.source, kind: document.kind,
      content: document.content, createdAt: document.createdAt,
      chunks: document.chunks.map((chunk) => ({
        id: chunk.id, index: chunk.index, text: chunk.text, start: chunk.start, end: chunk.end,
        neuralEmbedding: chunk.neuralEmbedding,
      })),
    })),
  })
  console.log(`pgvector: ${sync.syncedSources} sources / ${sync.syncedChunks} chunks`)

  // Lexical side: built locally over the same documents.
  const lexicalIndex = buildLexicalIndex(documents)
  console.log(`lexical: ${lexicalIndex.size} entries / avg weighted length ${lexicalIndex.averageLength.toFixed(1)}\n`)

  const documentsById = new Map(documents.map((document) => [document.id, document]))
  const corpusTitles = new Set(corpusSpec.map(([title]) => title))
  const records = []
  let generationInput = 0
  let generationOutput = 0

  for (const spec of QUESTIONS) {
    const queryEmbedding = await embed([spec.question])
    const search = await post('/api/vector/search', {
      queryVector: queryEmbedding.embeddings[0], limit: CANDIDATE_K, sourceKind: null,
    })
    const queryTokens = tokenize(spec.question)

    const dense = search.results.flatMap((match) => {
      const document = documentsById.get(match.sourceId)
      const chunk = document?.chunks.find((item) => item.id === match.id)
      if (!document || !chunk) return []
      return [{
        chunk, document,
        score: Math.max(0, Math.min(1, match.similarity)),
        semanticScore: Math.max(0, Math.min(1, match.similarity)),
        keywordScore: [...new Set(queryTokens.filter((term) => chunk.tokens.includes(term)))].length / (queryTokens.length || 1),
        matchedTerms: [...new Set(queryTokens.filter((term) => chunk.tokens.includes(term)))],
        engine: 'pgvector', distance: match.distance,
        embeddingModel: match.embeddingModel, embeddingDimensions: match.embeddingDimensions,
        candidateCount: match.candidateCount, database: search.database,
      }]
    })
    const foreignRows = search.results.filter((match) => !documentsById.has(match.sourceId))

    const lexical = toLexicalResults(searchLexical(lexicalIndex, spec.question, CANDIDATE_K), documents)
    const hybrid = fuseRankings({ dense, lexical }, CANDIDATE_K)

    const engines = {
      dense: summarise(dense).slice(0, TOP_K),
      lexical: summarise(lexical).slice(0, TOP_K),
      hybrid: summarise(hybrid).slice(0, TOP_K),
    }

    // Explicit experiment: RRF's constant damps the top ranks. Sweeping it shows
    // whether hybrid's behaviour is a tuning artefact or a property of rank
    // fusion itself. k = 60 stays the default; nothing here changes it.
    const kSweep = {}
    for (const k of [60, 20, 5, 1]) {
      const fusedAtK = summarise(fuseRankings({ dense, lexical }, TOP_K, k))
      kSweep[k] = {
        top1: fusedAtK[0]?.source ?? null,
        expectedRank: spec.expectSources.length
          ? (fusedAtK.findIndex((row) => spec.expectSources.includes(row.source)) + 1) || null
          : null,
      }
    }

    const record = {
      id: spec.id, question: spec.question, probe: spec.probe,
      expectSources: spec.expectSources, relevant: spec.relevant,
      engines,
      denseCandidates: summarise(dense),
      lexicalCandidates: summarise(lexical),
      kSweep,
      foreignSources: foreignRows.map((match) => match.title),
      metrics: {},
    }

    for (const [name, rows] of Object.entries(engines)) {
      record.metrics[name] = {
        top1: rows[0]?.source ?? null,
        recallAt1: spec.expectSources.length ? spec.expectSources.includes(rows[0]?.source) : null,
        recallAt5: spec.expectSources.length ? rows.some((row) => spec.expectSources.includes(row.source)) : null,
        reciprocalRank: spec.expectSources.length ? Number(reciprocalRank(rows, spec.expectSources).toFixed(4)) : null,
        expectedRank: spec.expectSources.length
          ? (rows.findIndex((row) => spec.expectSources.includes(row.source)) + 1) || null
          : null,
        distractors: rows.filter((row) => !spec.relevant.includes(row.source)).length,
        relevantSent: rows.filter((row) => spec.relevant.includes(row.source)).length,
      }
    }

    if (withGeneration) {
      record.generation = {}
      for (const [name, results] of Object.entries({ dense, lexical, hybrid })) {
        const top = results.slice(0, TOP_K)
        const assessment = evaluateEvidence(spec.question, top)
        const context = buildGroundedContext(spec.question, top, { retrievalEngine: name, requestedTopK: TOP_K })
        if (assessment.status === 'insufficient') {
          record.generation[name] = { outcome: 'refused', refusalKind: 'deterministic', evidence: assessment.status, body: assessment.reason, citations: [] }
          continue
        }
        const generated = await post('/api/generate', {
          question: context.question, context: context.text,
          retrievalEngine: context.retrievalEngine, requestedTopK: TOP_K,
          chunks: context.chunks.map((chunk) => ({ citation: chunk.citation, sourceId: chunk.result.document.id, chunkId: chunk.result.chunk.id })),
        })
        const classified = classifyGeneratedAnswer(generated.answer, context, { model: generated.model })
        generationInput += generated.inputTokens ?? 0
        generationOutput += generated.outputTokens ?? 0
        record.generation[name] = {
          outcome: classified.outcome,
          refusalKind: classified.outcome === 'refused' ? 'model' : undefined,
          evidence: assessment.status,
          body: classified.answer.body,
          citations: classified.answer.validCitationNumbers.map((number) => context.chunks[number - 1].result.document.title),
          invalidCitationNumbers: classified.answer.invalidCitationNumbers,
          malformedCitationMarkers: classified.answer.malformedCitationMarkers,
        }
      }
    }

    records.push(record)
    const line = ['dense', 'lexical', 'hybrid']
      .map((name) => `${name}=${record.metrics[name].expectedRank ?? '-'}`)
      .join(' ')
    console.log(`${spec.id} expected-source rank: ${line}   top1(hybrid)=${record.metrics.hybrid.top1}`)
  }

  try {
    await post('/api/vector/delete', { sourceIds: documents.map((document) => document.id) })
    console.log('\npgvector: test sources deleted')
  } catch (error) {
    console.log(`\npgvector cleanup failed: ${error.message}`)
  }

  const scored = records.filter((record) => record.expectSources.length)
  const engineSummary = {}
  let improved = 0
  let worsened = 0
  let unchanged = 0

  for (const name of ['dense', 'lexical', 'hybrid']) {
    engineSummary[name] = {
      recallAt1: scored.filter((record) => record.metrics[name].recallAt1).length,
      recallAt5: scored.filter((record) => record.metrics[name].recallAt5).length,
      mrr: Number((scored.reduce((total, record) => total + record.metrics[name].reciprocalRank, 0) / scored.length).toFixed(4)),
      averageRelevantInTopK: Number((records.reduce((total, record) => total + record.metrics[name].relevantSent, 0) / records.length).toFixed(2)),
      questionsWithTwoOrMoreDistractors: records.filter((record) => record.metrics[name].distractors >= 2).length,
    }
  }

  for (const record of scored) {
    const denseRank = record.metrics.dense.expectedRank ?? Infinity
    const hybridRank = record.metrics.hybrid.expectedRank ?? Infinity
    if (hybridRank < denseRank) improved += 1
    else if (hybridRank > denseRank) worsened += 1
    else unchanged += 1
  }

  const summary = {
    recordedAt: new Date().toISOString(),
    corpus: corpusLabel,
    corpusSources: documents.length,
    corpusChunks: allChunks.length,
    topK: TOP_K,
    candidateK: CANDIDATE_K,
    rrfK: RRF_K,
    scoredQuestions: scored.length,
    engines: engineSummary,
    hybridVsDense: { improved, worsened, unchanged },
    generation: withGeneration ? { inputTokens: generationInput, outputTokens: generationOutput } : null,
    foreignSourcesSeen: [...new Set(records.flatMap((record) => record.foreignSources))],
  }

  const out = process.env.TRACEWORK_OUT ?? `docs/phase5a-${corpusLabel}${withGeneration ? '-generated' : ''}.json`
  // Generation and embedding cost are billed separately and move
  // independently, so the artifact reports them separately.
  summary.usage = usageTracker.summary()
  writeFileSync(out, `${JSON.stringify({ summary, records }, null, 2)}\n`)

  console.log(`\n            Recall@1  Recall@5   MRR     avg relevant in Top-${TOP_K}`)
  for (const name of ['dense', 'lexical', 'hybrid']) {
    const stats = engineSummary[name]
    console.log(`${name.padEnd(11)} ${String(stats.recallAt1).padStart(2)}/${scored.length}      ${String(stats.recallAt5).padStart(2)}/${scored.length}    ${stats.mrr.toFixed(4)}   ${stats.averageRelevantInTopK}`)
  }
  console.log(`\nhybrid vs dense: ${improved} improved, ${worsened} worsened, ${unchanged} unchanged`)

  console.log('\nRRF k sweep — recall@5 over scored questions, and Q8 rank:')
  for (const k of [60, 20, 5, 1]) {
    const recall = scored.filter((record) => record.kSweep[k].expectedRank !== null).length
    const q8 = records.find((record) => record.id === 'Q8').kSweep[k].expectedRank
    console.log(`  k=${String(k).padStart(2)}  recall@5 ${recall}/${scored.length}  Q8 onboarding.md rank ${q8 ?? 'not in top 5'}`)
  }
  summary.kSweep = Object.fromEntries([60, 20, 5, 1].map((k) => [k, {
    recallAt5: scored.filter((record) => record.kSweep[k].expectedRank !== null).length,
    q8Rank: records.find((record) => record.id === 'Q8').kSweep[k].expectedRank,
  }]))
  writeFileSync(out, `${JSON.stringify({ summary, records }, null, 2)}\n`)
  console.log(usageTracker.line())
  console.log(`written to ${out}`)
}

main().catch((error) => {
  console.error(`\nrun aborted: ${error.code ?? 'error'} — ${error.message}`)
  process.exitCode = 1
})
