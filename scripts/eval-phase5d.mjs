// Phase 5D step 8: offline integrated evaluation. No provider calls.
//
// The unit suites check each stage in isolation. This runs the frozen T1-T9 set
// through the whole path a real question takes -- retrieval, rerank, pruning,
// temporal coverage, resolution, and the Phase 5C fallback -- and records the
// intermediate state, so a passing case can be inspected rather than trusted.
//
//   npm run eval:phase5d

import { writeFileSync } from 'node:fs'
import { createDocument, searchDocuments } from '../src/lib/rag.ts'
import { buildCandidateUnion, pruneCandidates, rerank } from '../src/lib/reranker.ts'
import { buildLexicalIndex, searchLexical, toLexicalResults } from '../src/lib/lexical.ts'
import { adjudicateEvidence, ensureConflictCoverage } from '../src/lib/adjudication.ts'
import { extractTemporalClaims } from '../src/lib/temporal.ts'
import { normalizeTemporalExtraction } from '../src/lib/temporalNormalization.ts'
import { resolveTemporalNormalization } from '../src/lib/temporalResolution.ts'
import { planTemporalCoverage, temporalCoverageWitnessChunkIds, temporalCoverageWitnesses, temporalGate } from '../src/lib/temporalCoverage.ts'
import { buildVariant, PHASE5D_CASES, PHASE5D_WORDING_CASES } from './fixtures/phase5d.mjs'

const CANDIDATE_LIMIT = 10
// Default budget, large enough that the unpadded 2-3 source variants keep their
// whole corpus so pruning is not silently doing the work. A case may override it
// via `spec.topK` when the budget is part of the experiment, as T7's is.
const TOP_K = 4

const titlesOf = (results) => results.map((result) => result.document.title)
const uniqueTitles = (results) => [...new Set(titlesOf(results))]

const makeDocuments = (variantName) => buildVariant(variantName).map((source) => createDocument(
  source.title,
  `synthetic / phase 5D / ${source.title}`,
  source.content,
  'sample',
  { id: `phase5d-${source.title}`, provenance: source.provenance },
))

const normalize = (question, results) => normalizeTemporalExtraction(extractTemporalClaims(question, results))

const resolve = (question, results, spec) => resolveTemporalNormalization(
  normalize(question, results),
  { asOf: spec.asOf, requestedPeriod: spec.requestedPeriod },
)

const claimSummary = (claim) => ({
  source: claim.claim.source,
  value: claim.claim.value,
  validFrom: claim.validFrom,
  historical: claim.historical,
  status: claim.status,
})

/** Run one frozen case through the full pipeline and record every stage. */
const evaluateCase = (spec) => {
  const documents = makeDocuments(spec.variant)
  const lexicalIndex = buildLexicalIndex(documents)
  const dense = searchDocuments(documents, spec.question, { engine: 'hashed', limit: CANDIDATE_LIMIT })
  const lexical = toLexicalResults(searchLexical(lexicalIndex, spec.question, CANDIDATE_LIMIT), documents)
  const ranked = rerank(spec.question, buildCandidateUnion({ dense, lexical, limit: CANDIDATE_LIMIT }))
  const rankedResults = ranked.map((candidate) => candidate.result)

  // Extraction and normalization run over the PRE-pruning pool, which is what
  // lets coverage know a witness went missing.
  const preNormalization = normalize(spec.question, rankedResults)
  const witnesses = temporalCoverageWitnesses(preNormalization)
  const witnessIds = temporalCoverageWitnessChunkIds(preNormalization)

  const budget = spec.topK ?? TOP_K
  const prunedResults = pruneCandidates(ranked, { maxChunks: budget }).selected.map((candidate) => candidate.result)
  const coverage = planTemporalCoverage(preNormalization, prunedResults, budget)
  const coveredResults = coverage.results

  const prunedTitles = uniqueTitles(prunedResults)
  const coveredTitles = uniqueTitles(coveredResults)
  const restored = coveredTitles.filter((title) => !prunedTitles.includes(title))
  const droppedByPruning = uniqueTitles(rankedResults).filter((title) => !prunedTitles.includes(title))

  // Both arms are recorded. Coverage restoring a witness and coverage changing
  // the answer are different facts, and conflating them would let a case pass
  // for a reason the fixture did not intend.
  const withoutCoverage = resolve(spec.question, prunedResults, spec)
  const resolution = resolve(spec.question, coveredResults, spec)

  const adjudication = adjudicateEvidence(spec.question, coveredResults)
  const finalContext = ensureConflictCoverage(adjudication, coveredResults, budget, witnessIds)
  const contextAdjudication = adjudicateEvidence(spec.question, finalContext)

  const resolvedSources = resolution.resolvedClaims.map((claim) => claim.claim.source)
  const checks = []
  const check = (name, passed, detail) => checks.push({ name, passed, detail })

  check('resolution status', resolution.status === spec.expectedResolution,
    `expected ${spec.expectedResolution}, got ${resolution.status}`)

  if (spec.expectedValue) {
    check('resolved value', Boolean(resolution.resolvedValue?.includes(spec.expectedValue)),
      `expected a value containing ${spec.expectedValue}, got ${JSON.stringify(resolution.resolvedValue)}`)
  } else {
    check('no value asserted', resolution.resolvedValue === null,
      `an unresolved or unassessed case must not answer; got ${JSON.stringify(resolution.resolvedValue)}`)
  }

  if (spec.mustNotAnswer) {
    check(`must not answer ${spec.mustNotAnswer}`, !resolution.resolvedValue?.includes(spec.mustNotAnswer),
      `forbidden value ${spec.mustNotAnswer} appeared in ${JSON.stringify(resolution.resolvedValue)}`)
  }

  if (spec.expectedCitations && spec.expectedResolution === 'resolved') {
    const missing = spec.expectedCitations.filter((title) => !resolvedSources.includes(title))
    check('expected citations resolved', missing.length === 0,
      missing.length ? `missing ${missing.join(', ')} from ${resolvedSources.join(', ') || 'none'}` : 'all present')
  }

  const gate = temporalGate(resolution, coverage)
  check('disposition', gate.disposition === spec.expectedDisposition,
    `expected ${spec.expectedDisposition}, got ${gate.disposition}`)
  check('hold reason', (gate.holdReason ?? null) === (spec.expectedHoldReason ?? null),
    `expected ${spec.expectedHoldReason ?? 'null'}, got ${gate.holdReason ?? 'null'}`)
  // A hold is only meaningful if it actually stops the provider call.
  check('provider call', (gate.disposition === 'hold' ? false : true) === (spec.expectedDisposition !== 'hold'),
    `a hold must prevent generation; disposition=${gate.disposition}`)

  if (spec.expectedPrunedWithoutCoverage) {
    check('superseder genuinely pruned', !prunedTitles.includes(spec.expectedPrunedWithoutCoverage),
      `${spec.expectedPrunedWithoutCoverage} survived pruning; the fixture requires it be dropped on merit`)
  }

  if (spec.expectedCoverageRestores) {
    check('coverage restores witness', coveredTitles.includes(spec.expectedCoverageRestores),
      `${spec.expectedCoverageRestores} was not restored into context`)
    check('coverage respects topK', coveredResults.length <= budget,
      `context grew to ${coveredResults.length} against a cap of ${budget}`)
  }

  // The forcing case must show the harm, not merely the restoration. Without
  // these, a corpus that leaks the right answer from an unrelated document
  // would let the flagship case pass without exercising anything.
  if (spec.expectedValueWithoutCoverage) {
    check('stale answer without coverage', Boolean(withoutCoverage.resolvedValue?.includes(spec.expectedValueWithoutCoverage)),
      `expected the no-coverage arm to answer ${spec.expectedValueWithoutCoverage}, got ${JSON.stringify(withoutCoverage.resolvedValue)}`)
  }

  if (spec.expectedAnswerRescued) {
    check('coverage changes the answer', withoutCoverage.resolvedValue !== resolution.resolvedValue,
      `coverage must turn a stale answer into a current one; both arms returned ${JSON.stringify(resolution.resolvedValue)}`)
  }

  return {
    id: spec.id,
    name: spec.name,
    variant: spec.variant,
    question: spec.question,
    asOf: spec.asOf,
    requestedPeriod: spec.requestedPeriod,
    corpusSize: documents.length,
    ranking: {
      preview: uniqueTitles(rankedResults).slice(0, 6),
      droppedByPruning,
      afterPruning: prunedTitles,
      afterTemporalCoverage: coveredTitles,
      restoredByCoverage: restored,
    },
    temporal: {
      claims: preNormalization.claims.map(claimSummary),
      relations: preNormalization.relations.map((relation) => ({
        superseding: preNormalization.claims.find((claim) => claim.claimId === relation.supersedingClaimId)?.claim.source ?? null,
        superseded: preNormalization.claims.find((claim) => claim.claimId === relation.supersededClaimId)?.claim.source ?? null,
      })),
      unassessedReasons: preNormalization.unassessedReasons,
      witnesses: uniqueTitles(witnesses),
    },
    resolution: {
      status: resolution.status,
      value: resolution.resolvedValue,
      citations: resolvedSources,
      disposition: gate.disposition,
      holdReason: gate.holdReason,
      providerWouldBeCalled: gate.disposition !== 'hold',
      notice: resolution.notice,
      assessments: resolution.assessments.map((assessment) => ({
        source: assessment.claim.claim.source,
        state: assessment.state,
        reason: assessment.reason,
      })),
    },
    coverage: { complete: coverage.complete, omitted: coverage.omitted },
    // Recorded for every case so the contribution of coverage is auditable,
    // not just asserted where the fixture happens to expect a rescue.
    withoutCoverage: {
      status: withoutCoverage.status,
      value: withoutCoverage.resolvedValue,
      citations: withoutCoverage.resolvedClaims.map((claim) => claim.claim.source),
      changedByCoverage: withoutCoverage.resolvedValue !== resolution.resolvedValue
        || withoutCoverage.status !== resolution.status,
    },
    phase5c: {
      status: contextAdjudication.status,
      conflicts: contextAdjudication.conflicts.length,
      notice: contextAdjudication.notice,
      finalContext: uniqueTitles(finalContext),
    },
    checks,
    passed: checks.every((entry) => entry.passed),
  }
}

const evaluateWordingCase = (spec) => {
  const base = PHASE5D_CASES.find((entry) => entry.variant === spec.variant) ?? PHASE5D_CASES[0]
  const question = 'What is the current Team plan price?'
  const documents = makeDocuments(spec.variant)
  const results = documents.flatMap((document) => document.chunks.map((chunk) => ({
    chunk, document, score: 1, semanticScore: 1, keywordScore: 1, matchedTerms: [], engine: 'hashed',
  })))
  const resolution = resolve(question, results, { asOf: base.asOf, requestedPeriod: null })
  const passed = resolution.status === spec.expectedResolution
  return {
    id: spec.id,
    level: spec.level,
    variant: spec.variant,
    expected: spec.expectedResolution,
    actual: resolution.status,
    value: resolution.resolvedValue,
    passed,
  }
}

const records = PHASE5D_CASES.map(evaluateCase)
const wording = PHASE5D_WORDING_CASES.map(evaluateWordingCase)

/* ------------------------------------------------ cross-case invariants ---- */

const invariants = []
const invariant = (name, passed, detail) => invariants.push({ name, passed, detail })

const t5 = records.find((record) => record.id === 'T5')
const t8 = records.find((record) => record.id === 'T8')
invariant(
  'T5 and T8 fail for different reasons',
  t5.resolution.status === 'unresolved' && t8.resolution.status === 'unassessed',
  `T5=${t5.resolution.status}/${t5.resolution.holdReason} vs T8=${t8.resolution.status}/${t8.resolution.holdReason}`,
)

const t9 = records.find((record) => record.id === 'T9')
invariant(
  'authority does not break a temporal tie',
  t9.resolution.status === 'unresolved' && t9.resolution.value === null && t9.resolution.disposition === 'hold',
  `T9 resolution=${t9.resolution.status} value=${JSON.stringify(t9.resolution.value)} disposition=${t9.resolution.disposition} providerCalled=${t9.resolution.providerWouldBeCalled}`,
)

const t7 = records.find((record) => record.id === 'T7')
invariant(
  'T7 superseding source is pruned on merit and restored',
  t7.ranking.droppedByPruning.includes('t-pricing-2025.md') && t7.ranking.restoredByCoverage.includes('t-pricing-2025.md'),
  `dropped=${t7.ranking.droppedByPruning.join(', ') || 'none'}; restored=${t7.ranking.restoredByCoverage.join(', ') || 'none'}`,
)

// Recorded, not asserted. The padded corpus contains pricing-2025.md, a
// baseline Phase 4 fixture carrying the same 2025 value as the designated
// superseder, so the no-coverage arm can reach the right answer from the wrong
// document. That makes T7 a witness-restoration proof, not an answer-rescue
// proof, and the report must not overstate it.
const t7AnswerRescued = t7.withoutCoverage.changedByCoverage

const passed = records.every((record) => record.passed)
  && wording.every((record) => record.passed)
  && invariants.every((entry) => entry.passed)

const output = {
  recordedAt: new Date().toISOString(),
  phase: '5D',
  step: 8,
  providerCalls: 0,
  settings: { topK: TOP_K, candidateLimit: CANDIDATE_LIMIT },
  // Recorded so a reader does not mistake an unrun eval for a regression. These
  // reach /api/embed and abort with `proxy_error` unless a dev server is running
  // with credentials; they were deliberately NOT run for this provider-free
  // checkpoint, and no provider calls were spent to make it look complete.
  providerDependentEvalsNotRun: {
    scripts: ['eval:retrieval', 'eval:reranker', 'eval:conflict-corpus'],
    reason: 'require a running dev server and embedding credentials; step 8 is defined as zero provider calls',
    status: 'not executed in this run — not a regression',
  },
  records,
  wording,
  invariants,
  notes: {
    t7AnswerRescued,
    t7Caveat: t7AnswerRescued
      ? 'Coverage changed the resolved answer for T7.'
      : 'Coverage restored the frozen witness for T7 but did not change the resolved answer: the padded corpus contains pricing-2025.md, a baseline fixture carrying the same 2025 value as t-pricing-2025.md. T7 proves witness restoration, not answer rescue.',
  },
  passed,
}

const destination = process.env.TRACEWORK_PHASE5D_OUT ?? 'docs/phase5d-evaluation.json'
writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`)

/* ------------------------------------------------------------- console ----- */

const pad = (value, width) => String(value).padEnd(width)
console.log(`Phase 5D offline evaluation / ${records.length} frozen cases + ${wording.length} wording levels / 0 provider calls\n`)
console.log(`${pad('case', 5)}${pad('resolution', 12)}${pad('value', 10)}${pad('coverage', 26)}${pad('gate', 12)}ok`)
console.log('-'.repeat(72))
for (const record of records) {
  const coverage = record.ranking.restoredByCoverage.length
    ? `restored ${record.ranking.restoredByCoverage.join(',')}`
    : record.temporal.witnesses.length ? 'witnesses already present' : '-'
  console.log(
    pad(record.id, 5)
    + pad(record.resolution.status, 12)
    + pad(record.resolution.value ? record.resolution.value.replace(/[^0-9]/g, '').slice(0, 2) : '-', 10)
    + pad(coverage.slice(0, 25), 26)
    + pad(record.resolution.disposition === 'hold' ? `HOLD ${record.resolution.holdReason?.slice(0, 6) ?? ''}` : 'proceed', 12)
    + (record.passed ? 'PASS' : 'FAIL'),
  )
}

console.log('\nwording levels')
for (const record of wording) {
  console.log(`  ${record.id} ${pad(record.level, 10)} expected=${pad(record.expected, 11)} actual=${pad(record.actual, 11)} ${record.passed ? 'PASS' : 'FAIL'}`)
}

console.log('\ncross-case invariants')
for (const entry of invariants) {
  console.log(`  ${entry.passed ? 'PASS' : 'FAIL'}  ${entry.name}\n        ${entry.detail}`)
}

console.log('\nT7 trace')
console.log(`  ranked pool      : ${t7.ranking.preview.join(', ')}`)
console.log(`  after pruning    : ${t7.ranking.afterPruning.join(', ')}`)
console.log(`  relation         : ${t7.temporal.relations.map((r) => `${r.superseding} supersedes ${r.superseded}`).join('; ') || 'none'}`)
console.log(`  after coverage   : ${t7.ranking.afterTemporalCoverage.join(', ')}`)
console.log(`  resolution       : ${t7.resolution.status} -> ${t7.resolution.value}`)
console.log(`  without coverage : ${t7.withoutCoverage.status} -> ${t7.withoutCoverage.value} (from ${t7.withoutCoverage.citations.join(', ') || 'none'})`)
console.log(`  answer rescued   : ${t7AnswerRescued}`)
if (!t7AnswerRescued) console.log(`  caveat           : ${output.notes.t7Caveat}`)

for (const record of records.filter((entry) => !entry.passed)) {
  console.log(`\n${record.id} failed checks:`)
  record.checks.filter((entry) => !entry.passed).forEach((entry) => console.log(`  - ${entry.name}: ${entry.detail}`))
}

console.log(`\n${passed ? 'PASS' : 'FAIL'} / written to ${destination}`)
if (!passed) process.exitCode = 1
