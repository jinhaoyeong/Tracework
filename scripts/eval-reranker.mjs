/**
 * Phase 5B benchmark: dense + lexical candidate union, relevance reranking,
 * and context pruning. Phase 5A's eval script and JSON artifacts are not
 * modified; this harness writes phase5b-* artifacts beside them.
 *
 *   npm.cmd run dev
 *   node --experimental-strip-types scripts/eval-reranker.mjs
 *   node --experimental-strip-types scripts/eval-reranker.mjs --offline
 *   node --experimental-strip-types scripts/eval-reranker.mjs --generate
 *   node --experimental-strip-types scripts/eval-reranker.mjs --generate --ids=Q8,Q3,Q9,Q10,D1
 *   node --experimental-strip-types scripts/eval-reranker.mjs --offline --generate --live-generation --phase5b-only --ids=Q8,Q3,Q9,Q10,D1
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createDocument, searchDocuments, tokenize } from '../src/lib/rag.ts'
import { buildLexicalIndex, searchLexical, toLexicalResults } from '../src/lib/lexical.ts'
import { fuseRankings, RRF_K } from '../src/lib/fusion.ts'
import { buildGroundedContext, classifyGeneratedAnswer, evaluateEvidence } from '../src/lib/grounded.ts'
import { buildCandidateUnion, pruneCandidates, rerank } from '../src/lib/reranker.ts'
import { CORE_CORPUS, PADDED_CORPUS } from './fixtures/stress-corpus.mjs'
import { DEV_QUESTIONS, EVAL_QUESTIONS } from './fixtures/phase5b.mjs'

const BASE = process.env.TRACEWORK_BASE_URL ?? 'http://localhost:5173'
const TOP_K = 5
const CANDIDATE_N = 10
const withGeneration = process.argv.includes('--generate')
const offline = process.argv.includes('--offline')
const liveGeneration = process.argv.includes('--live-generation')
const phase5bOnly = process.argv.includes('--phase5b-only')
const useCoreCorpus = process.argv.includes('--core')
const idsArgument = process.argv.find((argument) => argument.startsWith('--ids='))
const corpusSpec = useCoreCorpus ? CORE_CORPUS : PADDED_CORPUS
const corpusLabel = useCoreCorpus ? 'core' : 'padded'
const allQuestions = [...DEV_QUESTIONS, ...EVAL_QUESTIONS]
const questionsById = new Map(allQuestions.map((question) => [question.id, question]))
const selectedQuestionIds = idsArgument
  ? idsArgument.slice('--ids='.length).split(',').map((id) => id.trim()).filter(Boolean)
  : null
const questions = selectedQuestionIds
  ? selectedQuestionIds.map((id) => questionsById.get(id)).filter(Boolean)
  : allQuestions

if (selectedQuestionIds && questions.length !== selectedQuestionIds.length) {
  const availableIds = new Set(allQuestions.map((question) => question.id))
  const unknownIds = selectedQuestionIds.filter((id) => !availableIds.has(id))
  throw new Error(`Unknown question id(s): ${unknownIds.join(', ')}`)
}

if (liveGeneration && !offline) {
  throw new Error('--live-generation is only available with --offline so no embedding or vector-database calls are made.')
}
if (offline && withGeneration && !liveGeneration) {
  throw new Error('The offline replay measures ranking only. Add --live-generation to send selected contexts to /api/generate.')
}

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
  return payload
}

const reciprocalRank = (rows, expectedSources) => {
  const index = rows.findIndex((row) => expectedSources.includes(row.source ?? row.document?.title))
  return index === -1 ? 0 : 1 / (index + 1)
}

const rowSummary = (row, index) => ({
  rank: index + 1,
  source: row.document.title,
  chunkId: row.chunk.id,
  score: Number(row.score.toFixed(4)),
  semanticScore: Number(row.semanticScore.toFixed(4)),
  lexicalScore: row.lexicalScore === undefined ? undefined : Number(row.lexicalScore.toFixed(4)),
  matchedTerms: row.matchedTerms,
  denseRank: row.fusion?.denseRank ?? undefined,
  lexicalRank: row.fusion?.lexicalRank ?? undefined,
  rrfScore: row.fusion ? Number(row.fusion.rrfScore.toFixed(6)) : undefined,
})

const makeFrozenDenseResult = (row, documentsByTitle, question) => {
  const document = documentsByTitle.get(row.source)
  const chunk = document?.chunks[0]
  if (!document || !chunk) return null
  const queryTokens = tokenize(question)
  const matchedTerms = row.matchedTerms ?? []
  return {
    chunk,
    document,
    score: row.score,
    semanticScore: row.score,
    keywordScore: matchedTerms.length / (queryTokens.length || 1),
    matchedTerms,
    engine: 'neural',
    distance: Math.max(0, 1 - row.score),
    embeddingModel: 'phase5a-frozen-dense',
    embeddingDimensions: 1536,
  }
}

const unionSummary = (candidate) => ({
  unionRank: candidate.unionRank,
  source: candidate.result.document.title,
  chunkId: candidate.result.chunk.id,
  appearedIn: candidate.retrieval.appearedIn,
  denseRank: candidate.retrieval.denseRank,
  denseSimilarity: candidate.retrieval.denseSimilarity === null ? null : Number(candidate.retrieval.denseSimilarity.toFixed(4)),
  denseDistance: candidate.retrieval.denseDistance === null ? null : Number(candidate.retrieval.denseDistance.toFixed(4)),
  lexicalRank: candidate.retrieval.lexicalRank,
  bm25Score: candidate.retrieval.bm25Score === null ? null : Number(candidate.retrieval.bm25Score.toFixed(4)),
  lexicalFieldHits: candidate.retrieval.lexicalFieldHits,
  matchedTerms: candidate.retrieval.matchedTerms,
})

const rankedSummary = (candidate) => ({
  ...unionSummary(candidate),
  originalUnionRank: candidate.originalUnionRank,
  rerankedRank: candidate.rerankedRank,
  relevanceScore: Number(candidate.relevanceScore.toFixed(4)),
  relevanceLabel: candidate.relevanceLabel,
  relevanceReason: candidate.relevanceReason,
  features: Object.fromEntries(Object.entries(candidate.features).map(([key, value]) => [key, Number(value.toFixed(4))])),
})

const sourceRows = (candidates) => candidates.map((candidate) => candidate.result)

const measure = (rows, spec) => {
  const expectedRank = spec.expectSources.length
    ? (rows.findIndex((row) => spec.expectSources.includes(row.document.title)) + 1) || null
    : null
  const relevantSent = rows.filter((row) => spec.relevant.includes(row.document.title)).length
  return {
    top1: rows[0]?.document.title ?? null,
    recallAt1: spec.expectSources.length ? spec.expectSources.includes(rows[0]?.document.title) : null,
    recallAt5: spec.expectSources.length ? rows.slice(0, TOP_K).some((row) => spec.expectSources.includes(row.document.title)) : null,
    mrr: spec.expectSources.length ? Number(reciprocalRank(rows.slice(0, TOP_K), spec.expectSources).toFixed(4)) : null,
    expectedRank,
    selectedCount: rows.length,
    relevantSent,
    relevantContextRatio: rows.length ? Number((relevantSent / rows.length).toFixed(4)) : 0,
    distractors: rows.filter((row) => !spec.relevant.includes(row.document.title)).length,
  }
}

const generationIsCorrect = (spec, classified) => {
  const body = classified.answer.body
  if (spec.behavior === 'refuse') return classified.outcome === 'refused'
  if (spec.behavior === 'either') {
    return classified.outcome === 'refused'
      || (classified.outcome === 'answered' && (!spec.forbid || !spec.forbid.test(body)))
  }
  return classified.outcome === 'answered'
    && (!spec.expect || spec.expect.test(body))
    && (!spec.forbid || !spec.forbid.test(body))
}

const generateFor = async (spec, name, rows) => {
  const assessment = evaluateEvidence(spec.question, rows)
  const context = buildGroundedContext(spec.question, rows, {
    retrievalEngine: name,
    requestedTopK: rows.length,
    limit: rows.length,
  })
  if (assessment.status === 'insufficient') {
    return {
      outcome: 'refused',
      refusalKind: 'deterministic',
      correct: spec.behavior === 'refuse' || spec.behavior === 'either',
      evidence: assessment.status,
      body: assessment.reason,
      citations: [],
      inputTokens: 0,
      outputTokens: 0,
    }
  }

  const generated = await post('/api/generate', {
    question: context.question,
    context: context.text,
    retrievalEngine: context.retrievalEngine,
    requestedTopK: context.requestedTopK,
    chunks: context.chunks.map((chunk) => ({ citation: chunk.citation, sourceId: chunk.result.document.id, chunkId: chunk.result.chunk.id })),
  })
  const classified = classifyGeneratedAnswer(generated.answer, context, { model: generated.model })
  return {
    outcome: classified.outcome,
    refusalKind: classified.outcome === 'refused' ? 'model' : undefined,
    correct: generationIsCorrect(spec, classified),
    evidence: assessment.status,
    body: classified.answer.body,
    model: generated.model,
    citations: classified.answer.validCitationNumbers.map((number) => context.chunks[number - 1].result.document.title),
    invalidCitationNumbers: classified.answer.invalidCitationNumbers,
    malformedCitationMarkers: classified.answer.malformedCitationMarkers,
    inputTokens: generated.inputTokens ?? 0,
    outputTokens: generated.outputTokens ?? 0,
    totalTokens: generated.totalTokens ?? ((generated.inputTokens ?? 0) + (generated.outputTokens ?? 0)),
  }
}

const average = (records, selector) => records.length
  ? Number((records.reduce((total, record) => total + selector(record), 0) / records.length).toFixed(4))
  : 0

const summarizeEngine = (records, name, split) => {
  const scope = split ? records.filter((record) => record.split === split) : records
  const scored = scope.filter((record) => record.expectSources.length)
  return {
    recallAt1: scored.filter((record) => record.metrics[name].recallAt1).length,
    recallAt5: scored.filter((record) => record.metrics[name].recallAt5).length,
    mrr: average(scored, (record) => record.metrics[name].mrr),
    averageChunksSent: average(scope, (record) => record.metrics[name].selectedCount),
    averageRelevantSent: average(scope, (record) => record.metrics[name].relevantSent),
    relevantContextRatio: average(scope, (record) => record.metrics[name].relevantContextRatio),
    averageDistractors: average(scope, (record) => record.metrics[name].distractors),
  }
}

const main = async () => {
  const runMode = offline ? (liveGeneration ? 'offline ranking + live generation' : 'offline replay') : 'live provider'
  console.log(`Phase 5B candidate union + reranker benchmark / ${corpusLabel} corpus / ${runMode} / generation ${withGeneration ? 'on' : 'off'}`)
  console.log(`questions: ${DEV_QUESTIONS.length} DEV + ${EVAL_QUESTIONS.length} frozen EVAL / dense+lexical Top-${CANDIDATE_N} / context Top-${TOP_K}\n`)

  const documents = corpusSpec.map(([title, content]) => createDocument(title, title, content, 'note'))
  const allChunks = documents.flatMap((document) => document.chunks)
  const documentsByTitle = new Map(documents.map((document) => [document.title, document]))
  console.log(`corpus: ${documents.length} sources / ${allChunks.length} chunks`)

  let frozenSnapshot = null
  if (offline) {
    if (useCoreCorpus) throw new Error('Offline replay requires the padded Phase 5A snapshot.')
    frozenSnapshot = JSON.parse(readFileSync('docs/phase5a-padded.json', 'utf8'))
    console.log('dense EVAL candidates: replayed from frozen docs/phase5a-padded.json; DEV dense candidates use the local hashed proxy')
  } else {
    const vectors = []
    for (let offset = 0; offset < allChunks.length; offset += 64) {
      const batch = allChunks.slice(offset, offset + 64)
      const response = await post('/api/embed', { input: batch.map((chunk) => chunk.text) })
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
  }

  const lexicalIndex = buildLexicalIndex(documents)
  const documentsById = new Map(documents.map((document) => [document.id, document]))
  const records = []
  let generationInput = 0
  let generationOutput = 0

  for (const spec of questions) {
    let dense
    let denseSource
    if (offline) {
      const frozenRecord = frozenSnapshot.records.find((record) => record.id === spec.id)
      if (frozenRecord) {
        dense = frozenRecord.denseCandidates
          .map((row) => makeFrozenDenseResult(row, documentsByTitle, spec.question))
          .filter(Boolean)
        denseSource = 'phase5a-frozen'
      } else {
        dense = searchDocuments(documents, spec.question, { engine: 'hashed', limit: CANDIDATE_N })
        denseSource = 'hashed-dev-proxy'
      }
    } else {
      const queryEmbedding = await post('/api/embed', { input: [spec.question] })
      const search = await post('/api/vector/search', {
        queryVector: queryEmbedding.embeddings[0], limit: CANDIDATE_N, sourceKind: null,
      })
      const queryTokens = tokenize(spec.question)
      dense = search.results.flatMap((match) => {
        const document = documentsById.get(match.sourceId)
        const chunk = document?.chunks.find((item) => item.id === match.id)
        if (!document || !chunk) return []
        const matchedTerms = [...new Set(queryTokens.filter((term) => chunk.tokens.includes(term)))]
        return [{
          chunk, document,
          score: Math.max(0, Math.min(1, match.similarity)),
          semanticScore: Math.max(0, Math.min(1, match.similarity)),
          keywordScore: matchedTerms.length / (queryTokens.length || 1),
          matchedTerms,
          engine: 'pgvector', distance: match.distance,
          embeddingModel: match.embeddingModel, embeddingDimensions: match.embeddingDimensions,
          candidateCount: match.candidateCount, database: search.database,
        }]
      })
      denseSource = 'pgvector'
    }
    const lexical = toLexicalResults(searchLexical(lexicalIndex, spec.question, CANDIDATE_N), documents)
    const rrf = fuseRankings({ dense, lexical }, CANDIDATE_N)
    const union = buildCandidateUnion({ dense, lexical, limit: CANDIDATE_N })
    const ranked = rerank(spec.question, union)
    const pruning = pruneCandidates(ranked, { maxChunks: TOP_K })

    const engineRows = {
      dense: dense.slice(0, TOP_K),
      lexical: lexical.slice(0, TOP_K),
      rrf: rrf.slice(0, TOP_K),
      union: sourceRows(union.slice(0, TOP_K)),
      unionRerank: sourceRows(ranked.slice(0, TOP_K)),
      unionRerankPrune: sourceRows(pruning.selected),
    }
    const metrics = Object.fromEntries(Object.entries(engineRows).map(([name, rows]) => [name, measure(rows, spec)]))
    const unionPresence = spec.expectSources.length
      ? union.some((candidate) => spec.expectSources.includes(candidate.result.document.title))
      : null
    const rerankedExpected = spec.expectSources.length
      ? ranked.findIndex((candidate) => spec.expectSources.includes(candidate.result.document.title)) + 1
      : null
    const prunedExpected = spec.expectSources.length
      ? pruning.selected.findIndex((candidate) => spec.expectSources.includes(candidate.result.document.title)) + 1
      : null

    const record = {
      id: spec.id,
      split: spec.split,
      question: spec.question,
      probe: spec.probe,
      expectSources: spec.expectSources,
      relevant: spec.relevant,
      denseSource,
      candidateLimit: CANDIDATE_N,
      contextLimit: TOP_K,
      denseCandidates: dense.map(rowSummary),
      lexicalCandidates: lexical.map(rowSummary),
      rrfCandidates: rrf.map(rowSummary),
      unionCandidates: union.map(unionSummary),
      rerankedCandidates: ranked.map(rankedSummary),
      contextSelected: pruning.selected.map(rankedSummary),
      contextRejected: pruning.rejected.map((decision) => ({ ...rankedSummary(decision.candidate), reason: decision.reason })),
      unionPresence,
      correctSourceRanks: { union: unionPresence ? union.findIndex((candidate) => spec.expectSources.includes(candidate.result.document.title)) + 1 : null, rerank: rerankedExpected || null, prune: prunedExpected || null },
      metrics,
      generation: {},
    }

    if (withGeneration) {
      const generationStages = phase5bOnly
        ? { unionRerankPrune: sourceRows(pruning.selected) }
        : {
          dense: engineRows.dense,
          lexical: engineRows.lexical,
          rrf: engineRows.rrf,
          unionRerank: sourceRows(ranked),
          unionRerankPrune: sourceRows(pruning.selected),
        }
      for (const [name, rows] of Object.entries(generationStages)) {
        const result = await generateFor(spec, name, rows)
        record.generation[name] = result
        generationInput += result.inputTokens
        generationOutput += result.outputTokens
      }
    }

    records.push(record)
    const headline = ['dense', 'lexical', 'rrf', 'unionRerank', 'unionRerankPrune']
      .map((name) => `${name}=${record.metrics[name].expectedRank ?? '—'}`)
      .join(' ')
    const q9Danger = spec.id === 'Q9' ? ` changelog rerank=${ranked.find((candidate) => candidate.result.document.title === 'changelog.md')?.rerankedRank ?? 'absent'}` : ''
    console.log(`${spec.id} [${spec.split}] ${headline}${q9Danger}`)
  }

  if (!offline) {
    try {
      await post('/api/vector/delete', { sourceIds: documents.map((document) => document.id) })
      console.log('\npgvector: test sources deleted')
    } catch (error) {
      console.log(`\npgvector cleanup failed: ${error.message}`)
    }
  }

  const engineNames = ['dense', 'lexical', 'rrf', 'union', 'unionRerank', 'unionRerankPrune']
  const evalRecords = records.filter((record) => record.split === 'EVAL')
  const scored = evalRecords.filter((record) => record.expectSources.length)
  const improvements = { rerankVsDense: { improved: 0, worsened: 0, unchanged: 0 }, pruneVsRerank: { improved: 0, worsened: 0, unchanged: 0 } }
  for (const record of scored) {
    for (const [key, leftName, rightName] of [['rerankVsDense', 'dense', 'unionRerank'], ['pruneVsRerank', 'unionRerank', 'unionRerankPrune']]) {
      const left = record.metrics[leftName].expectedRank ?? Infinity
      const right = record.metrics[rightName].expectedRank ?? Infinity
      if (right < left) improvements[key].improved += 1
      else if (right > left) improvements[key].worsened += 1
      else improvements[key].unchanged += 1
    }
  }

  const summary = {
    recordedAt: new Date().toISOString(),
    corpus: corpusLabel,
    offline,
    liveGeneration,
    phase5bOnly,
    corpusSources: documents.length,
    corpusChunks: allChunks.length,
    devQuestions: DEV_QUESTIONS.length,
    frozenEvalQuestions: EVAL_QUESTIONS.length,
    selectedQuestionIds: questions.map((question) => question.id),
    scoredEvalQuestions: scored.length,
    candidateLimit: CANDIDATE_N,
    contextLimit: TOP_K,
    rrfK: RRF_K,
    engines: Object.fromEntries(engineNames.map((name) => [name, summarizeEngine(records, name, 'EVAL')])),
    devEngines: Object.fromEntries(engineNames.map((name) => [name, summarizeEngine(records, name, 'DEV')])),
    improvements,
    union: {
      averageCandidates: average(evalRecords, (record) => record.unionCandidates.length),
      expectedSourcePresent: scored.filter((record) => record.unionPresence).length,
      expectedSourcePresentDenominator: scored.length,
      accidentallyPrunedExpectedSource: scored.filter((record) => record.correctSourceRanks.rerank !== null && record.correctSourceRanks.prune === null).map((record) => record.id),
    },
    generation: withGeneration ? { inputTokens: generationInput, outputTokens: generationOutput, totalTokens: generationInput + generationOutput } : null,
  }
  const out = process.env.TRACEWORK_OUT ?? `docs/phase5b-${corpusLabel}${offline ? '-offline' : ''}${withGeneration ? '-generated' : ''}.json`
  writeFileSync(out, `${JSON.stringify({ summary, records }, null, 2)}\n`)

  console.log('\n                         R@1       R@5       MRR       relevant/context')
  for (const name of engineNames) {
    const stats = summary.engines[name]
    console.log(`${name.padEnd(24)} ${String(stats.recallAt1).padStart(2)}/${scored.length}      ${String(stats.recallAt5).padStart(2)}/${scored.length}      ${stats.mrr.toFixed(4)}      ${stats.relevantContextRatio.toFixed(4)}`)
  }
  console.log(`\nunion present: ${summary.union.expectedSourcePresent}/${summary.union.expectedSourcePresentDenominator}; average candidates: ${summary.union.averageCandidates}`)
  console.log(`rerank vs dense: ${improvements.rerankVsDense.improved} improved, ${improvements.rerankVsDense.worsened} worsened, ${improvements.rerankVsDense.unchanged} unchanged`)
  console.log(`prune vs rerank: ${improvements.pruneVsRerank.improved} improved, ${improvements.pruneVsRerank.worsened} worsened, ${improvements.pruneVsRerank.unchanged} unchanged`)
  console.log(`written to ${out}`)
}

main().catch((error) => {
  console.error(`\nrun aborted: ${error.code ?? 'error'} — ${error.message}`)
  process.exitCode = 1
})
