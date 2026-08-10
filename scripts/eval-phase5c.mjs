import { writeFileSync } from 'node:fs'
import { buildGroundedContext } from '../src/lib/grounded.ts'
import { adjudicateEvidence, ensureConflictCoverage } from '../src/lib/adjudication.ts'
import { createDocument, searchDocuments } from '../src/lib/rag.ts'
import { PHASE5C_CORPUS, PHASE5C_QUESTIONS } from './fixtures/phase5c.mjs'

const makeDocuments = (includeAuthority) => PHASE5C_CORPUS
  .filter((_source, index) => includeAuthority || index < 2)
  .map((source) => createDocument(source.title, `synthetic / phase 5C / ${source.title}`, source.content, 'sample', { provenance: source.provenance }))

const compactClaim = (claim) => ({
  key: claim.key,
  value: claim.value,
  sentence: claim.sentence,
  source: claim.sourceTitle,
  citation: claim.citation,
  authority: claim.result.document.provenance?.authority ?? 'unknown',
})

const records = PHASE5C_QUESTIONS.map((spec) => {
  const documents = makeDocuments(spec.corpus === 'authority')
  const ranked = searchDocuments(documents, spec.question, { engine: 'hashed', limit: 5 })
  const fullAdjudication = adjudicateEvidence(spec.question, ranked)
  const selected = ensureConflictCoverage(fullAdjudication, ranked, 5)
  const contextAdjudication = adjudicateEvidence(spec.question, selected)
  const context = buildGroundedContext(spec.question, selected, {
    retrievalEngine: 'phase5c-hashed',
    requestedTopK: selected.length,
    limit: selected.length,
    adjudication: contextAdjudication,
  })

  return {
    id: spec.id,
    question: spec.question,
    expectedStatus: spec.expectedStatus,
    actualStatus: fullAdjudication.status,
    passed: fullAdjudication.status === spec.expectedStatus,
    ranked: ranked.map((result, index) => ({ rank: index + 1, source: result.document.title, score: Number(result.score.toFixed(4)) })),
    selected: selected.map((result, index) => ({ citation: index + 1, source: result.document.title })),
    claims: contextAdjudication.claims.map(compactClaim),
    conflicts: contextAdjudication.conflicts.map((conflict) => ({
      key: conflict.key,
      summary: conflict.summary,
      claims: conflict.claims.map(compactClaim),
    })),
    sources: contextAdjudication.sources.map((source) => ({
      title: source.title,
      state: source.state,
      authority: source.provenance.authority,
      basis: source.provenance.basis,
    })),
    notice: contextAdjudication.notice,
    contextStatusLine: context.text.split('\n').slice(0, 4).join('\n'),
  }
})

const output = {
  recordedAt: new Date().toISOString(),
  phase: '5C',
  records,
  passed: records.every((record) => record.passed),
}

const destination = process.env.TRACEWORK_PHASE5C_OUT ?? 'docs/phase5c-evaluation.json'
writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`)
console.log(`Phase 5C adjudication evaluation / ${records.length} cases`)
records.forEach((record) => console.log(`${record.id} expected=${record.expectedStatus} actual=${record.actualStatus} claims=${record.claims.length} conflicts=${record.conflicts.length} selected=${record.selected.length}`))
console.log(`\n${output.passed ? 'PASS' : 'FAIL'} / written to ${destination}`)

if (!output.passed) process.exitCode = 1
