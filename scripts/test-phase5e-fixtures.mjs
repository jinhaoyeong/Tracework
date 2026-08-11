import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMeridianCorpus } from '../src/data/meridianCorpus.ts'
import {
  MERIDIAN_BENCHMARK_SOURCE,
  MERIDIAN_EVIDENCE_ANCHORS,
  PHASE5E_FOCUSED_CONTROLS,
  PHASE5E_SYNTHESIS_CASES,
} from './fixtures/phase5e.mjs'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDirectory, '..')

const expectedAnchorIds = [
  'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09', 'M10', 'M12', 'M13', 'M14',
  'M15', 'M16', 'M17', 'M18', 'M19', 'M20', 'M21', 'M22', 'M23', 'M24', 'M27', 'M28',
]
const expectedSynthesisIds = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']
const expectedFocusedIds = ['F1', 'F2', 'F3', 'F4', 'F5']
const expectedS6Cells = [
  'standard-member-count',
  'standard-average-expenditure',
  'supported-member-count',
  'supported-average-expenditure',
  'institutional-member-count',
  'institutional-average-expenditure',
  'dayline-member-count',
  'dayline-average-expenditure',
]

const normalize = (value) => value
  .normalize('NFKC')
  .toLocaleLowerCase('en')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/\s+/g, ' ')
  .trim()

const sorted = (values) => [...values].sort()
const assertExactIds = (actual, expected, label) => {
  assert.deepEqual(sorted(actual), sorted(expected), `${label} ids changed without a contract review`)
}

const anchorIds = Object.keys(MERIDIAN_EVIDENCE_ANCHORS)
assertExactIds(anchorIds, expectedAnchorIds, 'Meridian evidence anchor')

for (const [key, evidenceAnchor] of Object.entries(MERIDIAN_EVIDENCE_ANCHORS)) {
  assert.equal(evidenceAnchor.id, key, `${key} must agree with its object key`)
  assert.equal(evidenceAnchor.sourceId, MERIDIAN_BENCHMARK_SOURCE.documentId, `${key} must use the frozen Meridian source`)
  assert.ok(evidenceAnchor.auditChunkId, `${key} must record its current audit chunk id`)
  assert.ok(evidenceAnchor.semanticSignatures.length > 0, `${key} must define at least one semantic signature`)

  const signatureIds = evidenceAnchor.semanticSignatures.map((item) => item.id)
  assert.equal(new Set(signatureIds).size, signatureIds.length, `${key} has duplicate semantic signature ids`)
  for (const item of evidenceAnchor.semanticSignatures) {
    assert.ok(item.proposition.trim(), `${key}/${item.id} must describe its proposition`)
    assert.ok(item.allOf.length > 0, `${key}/${item.id} must define semantic evidence text`)
    assert.ok(item.allOf.every((needle) => needle.trim()), `${key}/${item.id} contains an empty semantic evidence string`)
  }
}

/* ----------------------------------------- corpus rebuild and anchor mapping */

const meridianDocuments = buildMeridianCorpus()
assert.equal(meridianDocuments.length, 1, 'the frozen Meridian benchmark expects one document')
const meridianDocument = meridianDocuments[0]
assert.equal(meridianDocument.id, MERIDIAN_BENCHMARK_SOURCE.documentId)
assert.equal(meridianDocument.title, MERIDIAN_BENCHMARK_SOURCE.title)
assert.equal(meridianDocument.chunks.length, MERIDIAN_BENCHMARK_SOURCE.expectedChunkCount)

const auditChunkDrift = []
for (const evidenceAnchor of Object.values(MERIDIAN_EVIDENCE_ANCHORS)) {
  const matchingChunks = meridianDocument.chunks.filter((chunk) => {
    const normalizedText = normalize(chunk.text)
    return evidenceAnchor.semanticSignatures.every((item) => (
      item.allOf.every((needle) => normalizedText.includes(normalize(needle)))
    ))
  })

  assert.equal(
    matchingChunks.length,
    1,
    `${evidenceAnchor.id} semantic signatures must map to exactly one Meridian chunk; found ${matchingChunks.map((chunk) => chunk.id).join(', ') || 'none'}`,
  )

  if (matchingChunks[0].id !== evidenceAnchor.auditChunkId) {
    auditChunkDrift.push({ anchor: evidenceAnchor.id, recorded: evidenceAnchor.auditChunkId, current: matchingChunks[0].id })
  }
}

/* -------------------------------------------------------- fixture integrity */

const knownAnchorIds = new Set(anchorIds)
const allowedStatuses = new Set(['covered', 'partially-covered', 'unsupported', 'conflicted'])
const allowedDispositions = new Set(['answer', 'partial-with-disclosure', 'hold-for-conflict', 'refuse-unsupported'])

const assertAnchorReferences = (value, location = 'fixture') => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertAnchorReferences(item, `${location}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return

  for (const [key, child] of Object.entries(value)) {
    if (/anchorIds$/i.test(key)) {
      assert.ok(Array.isArray(child), `${location}.${key} must be an array`)
      for (const referencedAnchor of child) {
        assert.ok(knownAnchorIds.has(referencedAnchor), `${location}.${key} references undefined anchor ${referencedAnchor}`)
      }
    } else {
      assertAnchorReferences(child, `${location}.${key}`)
    }
  }
}

assertExactIds(PHASE5E_SYNTHESIS_CASES.map((item) => item.id), expectedSynthesisIds, 'Phase 5E synthesis case')
assertExactIds(PHASE5E_FOCUSED_CONTROLS.map((item) => item.id), expectedFocusedIds, 'Phase 5E focused control')
assertAnchorReferences(PHASE5E_SYNTHESIS_CASES, 'PHASE5E_SYNTHESIS_CASES')
assertAnchorReferences(PHASE5E_FOCUSED_CONTROLS, 'PHASE5E_FOCUSED_CONTROLS')

for (const testCase of PHASE5E_SYNTHESIS_CASES) {
  assert.equal(testCase.expectedQueryMode, 'synthesis', `${testCase.id} must remain a synthesis case`)
  assert.ok(allowedDispositions.has(testCase.expectedDisposition), `${testCase.id} has an unknown disposition`)
  assert.ok(testCase.question.trim(), `${testCase.id} must define a question`)
  assert.ok(testCase.asOf, `${testCase.id} must define an asOf value`)
  assert.ok(testCase.facets.length > 0, `${testCase.id} must define facets`)

  const facetIds = testCase.facets.map((item) => item.id)
  assert.equal(new Set(facetIds).size, facetIds.length, `${testCase.id} contains duplicate facet ids`)

  for (const expectedFacet of testCase.facets) {
    assert.equal(typeof expectedFacet.required, 'boolean', `${testCase.id}/${expectedFacet.id} must define required`)
    assert.equal(typeof expectedFacet.critical, 'boolean', `${testCase.id}/${expectedFacet.id} must define critical`)
    assert.ok(allowedStatuses.has(expectedFacet.expectedStatus), `${testCase.id}/${expectedFacet.id} has an unknown expected status`)
    assert.ok(expectedFacet.expectedTemporalOutcome.trim(), `${testCase.id}/${expectedFacet.id} must define a temporal outcome`)
    assert.ok(expectedFacet.requiredPropositions.length > 0, `${testCase.id}/${expectedFacet.id} has no required proposition`)

    const propositionIds = expectedFacet.requiredPropositions.map((item) => item.id)
    assert.equal(new Set(propositionIds).size, propositionIds.length, `${testCase.id}/${expectedFacet.id} has duplicate proposition ids`)
    for (const expectedProposition of expectedFacet.requiredPropositions) {
      assert.ok(expectedProposition.description.trim(), `${testCase.id}/${expectedFacet.id}/${expectedProposition.id} needs a description`)
      assert.ok(['supported', 'unsupported'].includes(expectedProposition.expectedSupport), `${testCase.id}/${expectedFacet.id}/${expectedProposition.id} has an invalid support expectation`)
      if (expectedProposition.expectedSupport === 'supported') {
        assert.ok(expectedProposition.anchorIds.length > 0, `${testCase.id}/${expectedFacet.id}/${expectedProposition.id} needs supporting anchors`)
      } else {
        assert.equal(expectedProposition.anchorIds.length, 0, `${testCase.id}/${expectedFacet.id}/${expectedProposition.id} is unsupported and must not cite answer evidence`)
      }
    }
  }
}

const s1 = PHASE5E_SYNTHESIS_CASES.find((item) => item.id === 'S1')
const s1Continuity = s1.facets.find((item) => item.id === 'continuity-credit')
assert.ok(s1Continuity, 'S1 must require the continuity-credit facet')
assert.equal(s1Continuity.required, true, 'S1 continuity-credit must remain required')
assert.equal(s1Continuity.critical, true, 'S1 continuity-credit must remain critical')
assert.deepEqual(s1.singletonSalientForcing?.anchorIds, ['M18'], 'S1 singleton forcing must use M18')
assert.equal(s1.singletonSalientForcing?.facetId, 'continuity-credit', 'S1 singleton forcing must target continuity-credit')
assert.equal(s1.singletonSalientForcing?.recurrenceRequired, false, 'singleton salience must not require recurrence')
assert.equal(s1.singletonSalientForcing?.discoverBeforePerFacetRetrieval, true, 'singleton forcing must be asserted at discovery time')
assert.equal(s1.singletonSalientForcing?.benchmarkSeedAllowed, false, 'benchmark seeding must remain forbidden')
assert.equal(s1.singletonSalientForcing?.meridianSpecificRuleAllowed, false, 'Meridian-specific discovery must remain forbidden')
assert.ok(s1.singletonSalientForcing?.expectedStructuralSignals.length > 0, 'singleton forcing needs generic structural signals')

const s6 = PHASE5E_SYNTHESIS_CASES.find((item) => item.id === 'S6')
assert.equal(s6.expectedDisposition, 'refuse-unsupported', 'S6 must remain an unsupported refusal')
assertExactIds(s6.expectedUnsupportedMetricCells, expectedS6Cells, 'S6 unsupported metric cell')
assert.equal(s6.expectedUnsupportedMetricCells.length, 8, 'S6 must require all eight unsupported metric cells')
for (const cellId of expectedS6Cells) {
  const cell = s6.facets.find((item) => item.id === cellId)
  assert.ok(cell, `S6 is missing unsupported metric cell ${cellId}`)
  assert.equal(cell.required, true, `S6/${cellId} must remain required`)
  assert.equal(cell.critical, true, `S6/${cellId} must remain critical`)
  assert.equal(cell.expectedStatus, 'unsupported', `S6/${cellId} must remain unsupported`)
  assert.ok(cell.requiredPropositions.every((item) => item.expectedSupport === 'unsupported'), `S6/${cellId} must not gain answer evidence`)
}

for (const control of PHASE5E_FOCUSED_CONTROLS) {
  assert.equal(control.expectedQueryMode, 'focused', `${control.id} must remain focused`)
  assert.ok(allowedDispositions.has(control.expectedDisposition), `${control.id} has an unknown disposition`)
  assert.ok(control.expectedTemporalOutcome.trim(), `${control.id} must define a temporal outcome`)
  assert.ok(control.requiredPropositions.length > 0, `${control.id} must define required propositions`)
}

/* --------------------------------------- production/evaluation import guard */

const productionRoots = ['src', 'api', 'server']
const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'])
const forbiddenFixtureSymbols = [
  'MERIDIAN_EVIDENCE_ANCHORS',
  'PHASE5E_SYNTHESIS_CASES',
  'PHASE5E_FOCUSED_CONTROLS',
  'MERIDIAN_BENCHMARK_SOURCE',
]

const listSourceFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return listSourceFiles(entryPath)
    return sourceExtensions.has(path.extname(entry.name)) ? [entryPath] : []
  }))
  return nested.flat()
}

const productionFiles = (await Promise.all(productionRoots.map((root) => listSourceFiles(path.join(repositoryRoot, root))))).flat()
const forbiddenImports = []
for (const filename of productionFiles) {
  const content = await readFile(filename, 'utf8')
  const importsFixturePath = /(?:from\s+|import\s*\(|require\s*\()\s*['"][^'"]*(?:scripts[\\/]fixtures[\\/]phase5e|fixtures[\\/]phase5e|phase5e-fixtures)/i.test(content)
  const importsFixtureSymbol = forbiddenFixtureSymbols.some((symbol) => content.includes(symbol))
  if (importsFixturePath || importsFixtureSymbol) forbiddenImports.push(path.relative(repositoryRoot, filename))
}
assert.deepEqual(forbiddenImports, [], `production modules must not import Phase 5E answer-key data: ${forbiddenImports.join(', ')}`)

const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'))
assert.equal(
  packageJson.scripts?.['test:phase5e-fixtures'],
  'node --experimental-strip-types scripts/test-phase5e-fixtures.mjs',
  'package.json must expose the offline Phase 5E fixture validation command',
)

if (auditChunkDrift.length) {
  console.warn(`Phase 5E semantic anchors remain valid, but audit chunk ids drifted: ${JSON.stringify(auditChunkDrift)}`)
}

console.log(`Phase 5E fixture validation passed / ${PHASE5E_SYNTHESIS_CASES.length} synthesis cases + ${PHASE5E_FOCUSED_CONTROLS.length} focused controls + ${anchorIds.length} semantic anchors`)
