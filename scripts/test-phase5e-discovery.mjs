import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { buildMeridianCorpus } from '../src/data/meridianCorpus.ts'
import { discoverFacets } from '../src/lib/facetDiscovery.ts'
import { classifyQueryScope } from '../src/lib/synthesisScope.ts'
import { PHASE5E_SYNTHESIS_CASES } from './fixtures/phase5e.mjs'

const meridianDocument = buildMeridianCorpus()[0]
const meridianChunks = meridianDocument.chunks.map((chunk) => ({
  id: chunk.id,
  documentId: chunk.documentId,
  documentTitle: meridianDocument.title,
  text: chunk.text,
}))

const synthesisCase = (id) => PHASE5E_SYNTHESIS_CASES.find((item) => item.id === id)
const selectedIds = (result) => new Set(result.selected.map((item) => item.id))
const candidateById = (result, id) => result.candidates.find((item) => item.id === id)

/* ----------------------------------------- S1 broad discovery and obligations */

const s1 = synthesisCase('S1')
const s1Scope = classifyQueryScope(s1.question)
const s1Discovery = discoverFacets(s1.question, meridianChunks, s1Scope)
const s1SelectedIds = selectedIds(s1Discovery)

const semanticCorrespondence = {
  'standard-plan': (candidate) => candidate.kind === 'category' && candidate.normalizedSubject === 'standard',
  'supported-plan': (candidate) => candidate.kind === 'category' && candidate.normalizedSubject === 'supported',
  'institutional-plan': (candidate) => candidate.kind === 'category' && candidate.normalizedSubject === 'institutional',
  'ferry-policy': (candidate) => candidate.kind === 'recurring-policy-dimension' && candidate.normalizedSubject === 'ferry',
}

for (const expectedFacet of s1.facets) {
  const corresponds = semanticCorrespondence[expectedFacet.id]
    ?? ((candidate) => candidate.id === expectedFacet.id)
  assert.ok(s1Discovery.selected.some(corresponds), `S1 discovery must semantically produce ${expectedFacet.id} without benchmark seeding`)
}
assert.equal(s1Discovery.scopeRefinement, 'keep-synthesis', 'Meridian must remain synthesis after corpus discovery')
assert.ok(s1Discovery.selected.length >= s1.facets.length, 'S1 may preserve scoped child facets in addition to required top-level facets')
for (const selected of s1Discovery.selected) {
  assert.ok(selected.signals.length > 0, `${selected.id} must expose discovery signals`)
  assert.ok(selected.evidenceObligations.length > 0, `${selected.id} must expose evidence obligations rather than a topic word`)
  assert.ok(selected.evidenceObligations.every((item) => item.description.trim()), `${selected.id} contains an empty evidence obligation`)
}

/* -------------------------------- singleton-salient Continuity Credit forcing */

const singletonCorpus = meridianChunks.filter((chunk) => !chunk.id.endsWith('-chunk-25'))
const singletonDiscovery = discoverFacets(s1.question, singletonCorpus, s1Scope)
const continuity = candidateById(singletonDiscovery, 'continuity-credit')
assert.ok(continuity, 'Continuity Credit must be discovered when only its introducing chunk remains')
assert.ok(selectedIds(singletonDiscovery).has('continuity-credit'), 'singleton Continuity Credit must remain selected')
assert.equal(continuity.occurrenceCount, 1, 'the forcing corpus must make Continuity Credit genuinely singleton')
assert.ok(continuity.signals.includes('named_policy_or_benefit'), 'Continuity Credit must use generic named-benefit salience')
assert.ok(continuity.signals.includes('explicit_introduction'), 'Continuity Credit must use its explicit introduction')
assert.ok(!continuity.signals.includes('recurring_named_subject'), 'singleton discovery must not depend on recurrence')

/* ------------------------------------ scoped exception survives normalization */

const mobilitySupported = s1Discovery.candidates.find((item) => (
  item.kind === 'scoped-exception'
  && item.parentId === 'supported'
  && item.normalizedSubject.startsWith('supported:mobil-disab')
))
assert.ok(mobilitySupported, 'mobility-disabled Supported must remain an inspectable scoped candidate')
assert.ok(s1SelectedIds.has(mobilitySupported.id), 'the accessibility exception must survive selection')
assert.equal(mobilitySupported.parentId, 'supported', 'the scoped exception should retain its neutral category parent')
assert.ok(mobilitySupported.signals.includes('exception_or_limitation'))
assert.ok(mobilitySupported.evidenceObligations.some((item) => item.kind === 'exception'))

/* ------------------------------------ named-subject ambiguity is refined here */

const journeyQuestion = 'Summarise Journey Guard.'
const journeyScope = classifyQueryScope(journeyQuestion)
assert.equal(journeyScope.mode, 'synthesis', 'Step 4 must initially route the dimensionless named summary to synthesis')
const journeyDiscovery = discoverFacets(journeyQuestion, meridianChunks, journeyScope)
assert.equal(journeyDiscovery.scopeRefinement, 'downgrade-to-focused', 'one dominant corpus subject should downgrade Journey Guard')
assert.deepEqual([...selectedIds(journeyDiscovery)], ['journey-guard'])
assert.ok(journeyDiscovery.rejected.some((item) => item.rejectionReason === 'outside_requested_subject'), 'related context subjects must remain inspectable as rejected')

const meridianQuestion = 'Summarise Meridian.'
const meridianDiscovery = discoverFacets(meridianQuestion, meridianChunks, classifyQueryScope(meridianQuestion))
assert.equal(meridianDiscovery.scopeRefinement, 'keep-synthesis', 'document-level Meridian discovery must remain synthesis')
assert.ok(meridianDiscovery.selected.length >= 10, 'Meridian must expose many substantive evidence obligations')

/* ------------------------------------------ explicit comparison decomposition */

const s2 = synthesisCase('S2')
const s2Discovery = discoverFacets(s2.question, meridianChunks, classifyQueryScope(s2.question))
assert.equal(s2Discovery.scopeRefinement, 'keep-synthesis')
assert.deepEqual(
  [...selectedIds(s2Discovery)].sort(),
  ['dayline', 'institutional', 'standard', 'supported'],
  'explicit comparison entities define the selected decomposition boundary',
)
assert.ok(s2Discovery.selected.every((item) => item.signals.includes('explicit_comparison_entity')))

/* ------------------------------------- normalization and incidental-name noise */

const aliasChunks = [
  { id: 'alias-1', documentTitle: 'atlas.md', text: 'The authority introduced a product called Atlas Dayline.' },
  { id: 'alias-2', documentTitle: 'atlas.md', text: 'Dayline remained available to residents.' },
  { id: 'alias-3', documentTitle: 'atlas.md', text: 'The Dayline product retained its daily billing model.' },
]
const aliasQuestion = 'Summarise Atlas.'
const aliasDiscovery = discoverFacets(aliasQuestion, aliasChunks, classifyQueryScope(aliasQuestion))
assert.equal(aliasDiscovery.candidates.filter((item) => item.id === 'dayline').length, 1, 'prefixed and descriptive aliases must deduplicate')
assert.equal(candidateById(aliasDiscovery, 'dayline').occurrenceCount, 3)

const noiseChunks = [
  { id: 'noise-1', documentTitle: 'travel-note.md', text: 'Mira recorded 72 journeys in Bellweather and paid 18 credits.' },
  { id: 'noise-2', documentTitle: 'travel-note.md', text: 'Theo met Lena on Tuesday near Platform 4.' },
]
const noiseQuestion = 'Summarise the travel note.'
const noiseDiscovery = discoverFacets(noiseQuestion, noiseChunks, classifyQueryScope(noiseQuestion))
const noiseIds = new Set(noiseDiscovery.candidates.map((item) => item.id))
for (const incidental of ['mira', 'theo', 'lena', 'bellweather', '72', '18', '4']) {
  assert.ok(!noiseIds.has(incidental), `incidental name/number ${incidental} must not become a facet`)
}

/* ----------------------------------------- non-Meridian mechanism regression */

const atlasChunks = [
  { id: 'atlas-1', documentTitle: 'atlas.md', text: 'Atlas offers Core and Assisted memberships.' },
  { id: 'atlas-2', documentTitle: 'atlas.md', text: 'Core includes five storage transfers each month.' },
  { id: 'atlas-3', documentTitle: 'atlas.md', text: 'Assisted includes five storage transfers each month.' },
  { id: 'atlas-4', documentTitle: 'atlas.md', text: 'Assisted members with archival requirements receive unlimited storage transfers.' },
  { id: 'atlas-5', documentTitle: 'atlas.md', text: 'A loyalty benefit known as Recovery Credit was introduced for account recovery charges.' },
]
const atlasQuestion = 'Summarise Atlas.'
const atlasDiscovery = discoverFacets(atlasQuestion, atlasChunks, classifyQueryScope(atlasQuestion))
assert.equal(atlasDiscovery.scopeRefinement, 'keep-synthesis')
assert.ok(atlasDiscovery.selected.some((item) => item.kind === 'category' && item.normalizedSubject === 'core'), 'Atlas Core category must be discovered')
assert.ok(atlasDiscovery.selected.some((item) => item.kind === 'category' && item.normalizedSubject === 'assisted'), 'Atlas Assisted category must be discovered')
assert.ok(atlasDiscovery.selected.some((item) => item.kind === 'recurring-policy-dimension' && item.normalizedSubject === 'storage'), 'Atlas storage dimension must use the recurring policy mechanism')
const archivalAssisted = atlasDiscovery.selected.find((item) => item.kind === 'scoped-exception' && item.parentId === 'assisted')
assert.ok(archivalAssisted, 'Atlas archival Assisted subtype must use generic scoped-exception discovery')
assert.ok(archivalAssisted.evidenceObligations.some((item) => item.kind === 'exception'))
const recoveryCredit = candidateById(atlasDiscovery, 'recovery-credit')
assert.ok(recoveryCredit, 'Atlas singleton Recovery Credit must use named-benefit discovery')
assert.equal(recoveryCredit.occurrenceCount, 1)
assert.ok(recoveryCredit.signals.includes('explicit_introduction'))

const productionDiscoverySource = await readFile(new URL('../src/lib/facetDiscovery.ts', import.meta.url), 'utf8')
for (const forbiddenLiteral of ['Meridian', 'Supported', 'Ferry', 'mobility-disabled', 'standard-plan', 'supported-plan', 'institutional-plan']) {
  assert.ok(!productionDiscoverySource.includes(forbiddenLiteral), `production discovery must not contain frozen benchmark literal ${forbiddenLiteral}`)
}

const rejectedIds = new Set(s1Discovery.rejected.map((item) => item.id))
assert.ok(rejectedIds.has('flex'), 'ended Flex must remain inspectable but rejected as a current top-level facet')
assert.ok(rejectedIds.has('north'), 'unlaunched North must remain inspectable but rejected as a current top-level facet')
assert.ok(s1SelectedIds.has('inactive-or-proposed'), 'inactive/proposed evidence must survive through its composite obligation')

console.log(`Phase 5E discovery tests passed / ${s1Discovery.selected.length} S1 facets + Atlas generalization + singleton salience + scope refinement + normalization/noise controls`)
