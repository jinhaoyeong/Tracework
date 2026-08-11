import assert from 'node:assert/strict'
import { createDocument } from '../src/lib/rag.ts'
import { extractTemporalClaims } from '../src/lib/temporal.ts'
import { normalizeTemporalExtraction } from '../src/lib/temporalNormalization.ts'
import { resolveTemporalNormalization, parseTemporalReference } from '../src/lib/temporalResolution.ts'
import { buildVariant, PHASE5D_CASES } from './fixtures/phase5d.mjs'

const makeResults = (variantName, question) => buildVariant(variantName)
  .map((source) => createDocument(
    source.title,
    `synthetic / phase 5D / ${source.title}`,
    source.content,
    'sample',
    { id: `phase5d-${source.title}`, provenance: source.provenance },
  ))
  .flatMap((document) => document.chunks.map((chunk) => ({
    chunk,
    document,
    score: 1,
    semanticScore: 1,
    keywordScore: 1,
    matchedTerms: [],
    engine: 'hashed',
  })))

const runCase = (spec) => {
  const extraction = extractTemporalClaims(spec.question, makeResults(spec.variant, spec.question))
  const normalization = normalizeTemporalExtraction(extraction)
  return resolveTemporalNormalization(normalization, {
    asOf: spec.asOf,
    requestedPeriod: spec.requestedPeriod,
  })
}

const bySource = (claims, source) => claims.filter((claim) => claim.claim.source === source)

for (const spec of PHASE5D_CASES) {
  const resolution = runCase(spec)
  assert.equal(resolution.status, spec.expectedResolution, `${spec.id} resolution status`)
  assert.equal(resolution.asOf, spec.asOf, `${spec.id} must record the injected asOf`)
  assert.equal(resolution.requestedPeriod, spec.requestedPeriod, `${spec.id} must record requestedPeriod`)

  if (spec.expectedValue) {
    assert.equal(resolution.resolvedValue, `${spec.expectedValue} usd per seat per month`, `${spec.id} resolved value`)
  }

  if (spec.expectedCitations) {
    assert.deepEqual(
      (resolution.status === 'resolved' ? resolution.resolvedClaims : resolution.applicableClaims)
        .map((claim) => claim.claim.source),
      spec.expectedCitations,
      `${spec.id} selected sources`,
    )
  }

  if (spec.mustNotAnswer) {
    assert.notEqual(resolution.resolvedValue, `${spec.mustNotAnswer} usd per seat per month`, `${spec.id} must not select the forbidden value`)
  }

  // Every frozen case declares a disposition, so this must never be skipped.
  assert.ok(spec.expectedDisposition, `${spec.id} must declare an expected disposition`)
  assert.equal(resolution.disposition, spec.expectedDisposition, `${spec.id} generation disposition`)
  assert.equal(resolution.holdReason ?? null, spec.expectedHoldReason ?? null, `${spec.id} hold reason`)
}

const current = runCase(PHASE5D_CASES.find((spec) => spec.id === 'T1'))
assert.equal(current.boundaries.length, 1, 'T1 should expose the supersession boundary')
assert.equal(current.boundaries[0].kind, 'supersession')
assert.equal(current.boundaries[0].supersededClaimId.includes('40 usd per seat per month'), true)
assert.equal(current.assessments.find((assessment) => assessment.claim.claim.value.startsWith('40 ')).state, 'superseded')

const historical = runCase(PHASE5D_CASES.find((spec) => spec.id === 'T2'))
assert.equal(historical.resolvedValue, '40 usd per seat per month', 'a superseded claim remains answerable for 2024')
assert.equal(historical.resolvedClaims[0].claim.source, 't-pricing-2024.md')

const future = runCase(PHASE5D_CASES.find((spec) => spec.id === 'T6a'))
assert.equal(future.assessments.find((assessment) => assessment.claim.claim.value.startsWith('65 ')).state, 'future')

const futurePeriod = runCase(PHASE5D_CASES.find((spec) => spec.id === 'T6b'))
assert.equal(futurePeriod.boundaries.some((boundary) => boundary.kind === 'explicit-start'), true,
  'T6b should expose the explicit Starting January 2027 boundary')
assert.equal(futurePeriod.resolvedClaims[0].claim.source, 't-price-notice-2026.md')
assert.equal(futurePeriod.assessments.find((assessment) => assessment.claim.claim.value.startsWith('55 ')).state, 'superseded')

const awkward = runCase(PHASE5D_CASES.find((spec) => spec.id === 'T8'))
assert.equal(awkward.assessments.filter((assessment) => assessment.state === 'undated').length, 1,
  'T8 must preserve the undated replacement claim')
assert.match(awkward.notice, /undated/i)

const authorityTie = runCase(PHASE5D_CASES.find((spec) => spec.id === 'T9'))
assert.equal(authorityTie.status, 'unresolved')
assert.equal(authorityTie.resolvedValue, null)
assert.equal(authorityTie.applicableClaims.length, 2, 'authority cannot hide either same-period claim')
// The temporal layer explains its own hold. It no longer defers to Phase 5C,
// whose extractor cannot recognise a pricing claim at all.
assert.match(authorityTie.notice, /does not establish which value is correct/i)
assert.equal(authorityTie.disposition, 'hold')
assert.equal(authorityTie.holdReason, 'multiple_applicable_propositions')

assert.deepEqual(parseTemporalReference('2024', true), { input: '2024', key: 202412, precision: 'year' })
assert.deepEqual(parseTemporalReference('2027-02'), { input: '2027-02', key: 202702, precision: 'month' })
assert.equal(parseTemporalReference('2027-13'), null, 'invalid month must fail closed')

const invalid = resolveTemporalNormalization(
  normalizeTemporalExtraction(extractTemporalClaims('What is the current Team plan price?', makeResults('supersession', 'What is the current Team plan price?'))),
  { asOf: 'not-a-date' },
)
assert.equal(invalid.status, 'unassessed')
assert.equal(invalid.reference, null)
assert.match(invalid.notice, /no wall-clock fallback/i)

// Keep the source helper used above honest: the selected claims are not an
// implicit citation list and historical evidence remains inspectable.
assert.equal(bySource(current.assessments.map((assessment) => assessment.claim), 't-pricing-2024.md').length, 1)

console.log(`Phase 5D temporal resolution tests passed / ${PHASE5D_CASES.length} frozen cases`)
