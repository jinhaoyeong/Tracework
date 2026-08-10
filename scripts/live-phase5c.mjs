/**
 * Phase 5C live regression — three authorised synthetic cases.
 *
 * Mirrors App.tsx's runGroundedGeneration decision order exactly:
 *   evaluateEvidence -> insufficient? -> adjudicate -> conflicted? -> generate
 *
 * Every call to /api/generate is counted, so "the conflict hold skips the
 * provider" is verified by observation rather than by reading the branch.
 *
 *   npm.cmd run dev
 *   node --experimental-strip-types scripts/live-phase5c.mjs
 */
import { writeFileSync } from 'node:fs'
import { createDocument, searchDocuments } from '../src/lib/rag.ts'
import { adjudicateEvidence, ensureConflictCoverage } from '../src/lib/adjudication.ts'
import { buildConflictAnswer, buildGroundedContext, buildInsufficientAnswer, classifyGeneratedAnswer, evaluateEvidence } from '../src/lib/grounded.ts'
import { PHASE5C_CORPUS } from './fixtures/phase5c.mjs'

const BASE = process.env.TRACEWORK_BASE_URL ?? 'http://localhost:5173'
let generateCallCount = 0

const post = async (path, body) => {
  if (path === '/api/generate') generateCallCount += 1
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

const documentsFor = (indices) => indices.map((index) => {
  const source = PHASE5C_CORPUS[index]
  return createDocument(source.title, `synthetic / phase 5C / ${source.title}`, source.content, 'sample', { provenance: source.provenance })
})

const CASES = [
  {
    id: 'CASE-1-CONFLICT-HOLD',
    label: 'Conflict hold',
    question: 'Where was Tracework invented?',
    // changelog.md (Japan) vs project-history.md (Malaysia), neither authoritative.
    sources: [0, 1],
    expect: { adjudication: 'conflicted', outcome: 'conflict-held', providerCalled: false },
  },
  {
    id: 'CASE-2-EXPLICIT-AUTHORITY',
    label: 'Explicit authority',
    question: 'Where was Tracework invented?',
    // Adds README.md, explicitly authoritative for project origin.
    sources: [0, 1, 2],
    expect: { adjudication: 'authority-supported', outcome: 'answered', providerCalled: true },
  },
  {
    id: 'CASE-3-NO-CONFLICT',
    label: 'Normal no-conflict generation',
    // Both fixtures word this as "created", so asking "invented" scored 0.30 on
    // the hashed engine and the case was blocked by the evidence floor before
    // reaching the grounded path it exists to exercise. The question wording is
    // the harness's variable; the 0.42 floor is Tracework's and stays untouched.
    question: 'Where was Tracework created?',
    // project-history.md and README.md agree on Malaysia 2026: no conflict.
    sources: [1, 2],
    expect: { adjudication: 'clear', outcome: 'answered', providerCalled: true },
  },
]

const main = async () => {
  console.log(`Phase 5C live regression against ${BASE}\n`)
  const records = []

  for (const testCase of CASES) {
    const callsBefore = generateCallCount
    const documents = documentsFor(testCase.sources)
    const ranked = searchDocuments(documents, testCase.question, { engine: 'hashed', limit: 5 })
    const adjudication = adjudicateEvidence(testCase.question, ranked)
    const selected = ensureConflictCoverage(adjudication, ranked, 5)
    const contextAdjudication = adjudicateEvidence(testCase.question, selected)
    const assessment = evaluateEvidence(testCase.question, selected)
    const context = buildGroundedContext(testCase.question, selected, {
      retrievalEngine: 'phase5c-hashed',
      requestedTopK: selected.length,
      limit: selected.length,
      adjudication: contextAdjudication,
    })

    const record = {
      id: testCase.id,
      label: testCase.label,
      question: testCase.question,
      sources: documents.map((document) => document.title),
      evidenceStatus: assessment.status,
      adjudicationStatus: adjudication.status,
      expected: testCase.expect,
      claims: contextAdjudication.claims.map((claim) => ({
        source: claim.sourceTitle, value: claim.value, citation: claim.citation,
        authority: claim.result.document.provenance?.authority ?? 'unknown',
      })),
      conflicts: contextAdjudication.conflicts.length,
      notice: contextAdjudication.notice,
    }

    // Same order as the app: insufficient first, then the conflict hold, then generation.
    if (assessment.status === 'insufficient') {
      const answer = buildInsufficientAnswer(assessment)
      record.outcome = 'insufficient'
      record.body = answer.body
      record.citations = []
    } else if (adjudication.status === 'conflicted') {
      const answer = buildConflictAnswer(adjudication)
      record.outcome = 'conflict-held'
      record.body = answer.body
      record.citations = answer.validCitationNumbers.map((number) => ({
        marker: number, source: context.chunks[number - 1]?.result.document.title ?? 'out of range',
      }))
    } else {
      const generated = await post('/api/generate', {
        question: context.question,
        context: context.text,
        retrievalEngine: context.retrievalEngine,
        requestedTopK: context.requestedTopK,
        chunks: context.chunks.map((chunk) => ({ citation: chunk.citation, sourceId: chunk.result.document.id, chunkId: chunk.result.chunk.id })),
      })
      const classified = classifyGeneratedAnswer(generated.answer, context, { model: generated.model })
      record.outcome = classified.outcome
      record.body = classified.answer.body
      record.model = generated.model
      record.inputTokens = generated.inputTokens
      record.outputTokens = generated.outputTokens
      record.totalTokens = generated.totalTokens
      record.citations = classified.answer.validCitationNumbers.map((number) => ({
        marker: number, source: context.chunks[number - 1].result.document.title,
      }))
      record.invalidCitationNumbers = classified.answer.invalidCitationNumbers
      record.malformedCitationMarkers = classified.answer.malformedCitationMarkers
    }

    record.providerCalled = generateCallCount > callsBefore
    record.providerCallCount = generateCallCount - callsBefore
    record.passed = record.adjudicationStatus === testCase.expect.adjudication
      && record.outcome === testCase.expect.outcome
      && record.providerCalled === testCase.expect.providerCalled
    records.push(record)

    console.log(`${record.id}  ${record.passed ? 'PASS' : 'FAIL'}`)
    console.log(`  adjudication : ${record.adjudicationStatus} (expected ${testCase.expect.adjudication})`)
    console.log(`  outcome      : ${record.outcome} (expected ${testCase.expect.outcome})`)
    console.log(`  provider call: ${record.providerCalled} (expected ${testCase.expect.providerCalled})`)
    console.log(`  citations    : ${JSON.stringify(record.citations)}`)
    if (record.totalTokens) console.log(`  tokens       : ${record.inputTokens} in / ${record.outputTokens} out`)
    console.log(`  answer       : ${(record.body ?? '').replace(/\s+/g, ' ')}\n`)
  }

  const output = {
    recordedAt: new Date().toISOString(),
    phase: '5C-live',
    generationModel: records.find((record) => record.model)?.model ?? null,
    totalProviderCalls: generateCallCount,
    totalInputTokens: records.reduce((total, record) => total + (record.inputTokens ?? 0), 0),
    totalOutputTokens: records.reduce((total, record) => total + (record.outputTokens ?? 0), 0),
    passed: records.every((record) => record.passed),
    records,
  }
  writeFileSync('docs/phase5c-live.json', `${JSON.stringify(output, null, 2)}\n`)

  console.log(`${output.passed ? 'PASS' : 'FAIL'} / ${records.filter((r) => r.passed).length}/${records.length} cases`)
  console.log(`provider calls: ${generateCallCount} · tokens ${output.totalInputTokens} in / ${output.totalOutputTokens} out`)
  console.log('written to docs/phase5c-live.json')
  if (!output.passed) process.exitCode = 1
}

main().catch((error) => {
  console.error(`\nrun aborted: ${error.code ?? 'error'} — ${error.message}`)
  process.exitCode = 1
})
