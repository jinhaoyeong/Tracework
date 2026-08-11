import assert from 'node:assert/strict'
import { buildMeridianCorpus } from '../src/data/meridianCorpus.ts'
import { createDocument } from '../src/lib/rag.ts'
import { classifyQueryScope } from '../src/lib/synthesisScope.ts'
import { prepareSynthesis } from '../src/lib/synthesisOrchestrator.ts'
import { buildSynthesisInspector } from '../src/lib/synthesisInspector.ts'
import {
  MERIDIAN_EVIDENCE_ANCHORS,
  PHASE5E_FOCUSED_CONTROLS,
  PHASE5E_SYNTHESIS_CASES,
} from './fixtures/phase5e.mjs'

const meridianDocument = buildMeridianCorpus()[0]
const asOf = '2026-08-31T23:59:59Z'

const normalize = (value) => value
  .normalize('NFKC')
  .toLocaleLowerCase('en')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/\s+/g, ' ')
  .trim()

const anchorPresent = (results, anchor) => results.some((result) => {
  const text = normalize(result.chunk.text)
  return anchor.semanticSignatures.some((signature) => signature.allOf.every((needle) => text.includes(normalize(needle))))
})

const run = (question, documents = [meridianDocument], date = asOf) => prepareSynthesis(question, documents, { asOf: date })

const synthesisRows = []
for (const spec of PHASE5E_SYNTHESIS_CASES) {
  const preparation = run(spec.question, [meridianDocument], spec.asOf)
  assert.equal(preparation.scope.mode, 'synthesis', `${spec.id} must enter synthesis scope`)
  assert.equal(preparation.providerCalled, false)
  assert.ok(preparation.discovery, `${spec.id} must expose discovery`)
  assert.ok(preparation.requirements, `${spec.id} must expose runtime requirements`)
  assert.ok(preparation.coverage, `${spec.id} must expose coverage`)
  assert.equal(preparation.coverage.disposition, spec.expectedDisposition, `${spec.id} disposition must be runtime-derived`)
  assert.equal(preparation.packet?.question, spec.question)

  if (spec.id !== 'S6') {
    const contexts = preparation.facets.flatMap((facet) => facet.reasoning.reasoningContext)
    const expectedSupported = spec.facets.flatMap((facet) => facet.requiredPropositions)
      .filter((proposition) => proposition.expectedSupport === 'supported')
    const covered = expectedSupported.filter((proposition) => proposition.anchorIds.some((anchorId) => (
      anchorPresent(contexts, MERIDIAN_EVIDENCE_ANCHORS[anchorId])
    )))
    assert.equal(covered.length, expectedSupported.length, `${spec.id} lost expected semantic evidence in the orchestrated context`)
  }

  const inspector = buildSynthesisInspector(preparation)
  assert.equal(inspector.providerCalled, false)
  assert.equal(inspector.route, 'synthesis')
  assert.equal(inspector.packet.facetCount, preparation.packet?.facets.length ?? 0)
  assert.equal(inspector.queryBudget.totalRetrievalQueries, preparation.queryBudget.totalRetrievalQueries)
  synthesisRows.push({
    id: spec.id,
    disposition: preparation.coverage.disposition,
    facets: preparation.facetMetrics.length,
    requirements: preparation.requirements.requirements.length,
    queries: preparation.queryBudget.totalRetrievalQueries,
    maxQueriesPerFacet: preparation.queryBudget.maxQueriesPerFacet,
    aliases: preparation.queryBudget.aliasDerivedQueries,
    packetClaims: preparation.queryBudget.finalPacketClaims,
    packetChunks: preparation.queryBudget.finalPacketChunks,
  })
}

const s6 = run(PHASE5E_SYNTHESIS_CASES.find((spec) => spec.id === 'S6').question)
const s6Requirements = s6.requirements.requirements.filter((requirement) => requirement.kind === 'aggregate')
assert.equal(s6Requirements.length, 8, 'S6 must retain four discovered types x two runtime metrics')
assert.equal(new Set(s6Requirements.map((requirement) => requirement.facetId)).size, 4)
assert.equal(new Set(s6Requirements.map((requirement) => requirement.dimension)).size, 2)
assert.equal(s6.coverage.facets.flatMap((facet) => facet.propositions).filter((proposition) => proposition.status === 'unsupported').length, 8)
assert.equal(s6.coverage.disposition, 'refuse-unsupported')

for (const control of PHASE5E_FOCUSED_CONTROLS) {
  const scope = classifyQueryScope(control.question)
  assert.equal(scope.mode, 'focused', `${control.id} must remain focused`)
  const preparation = run(control.question)
  assert.equal(preparation.route, 'focused', `${control.id} must not enter broad preparation`)
  assert.equal(preparation.requirements, null)
  assert.equal(preparation.queryBudget.facets, 0)
}

const journeyGuard = run('Summarise Journey Guard')
assert.equal(journeyGuard.scope.mode, 'synthesis')
assert.equal(journeyGuard.route, 'focused')
assert.equal(journeyGuard.discovery?.scopeRefinement, 'downgrade-to-focused')
assert.equal(journeyGuard.routeReason, 'evidence_derived_narrow_subject')

const atlas = createDocument('atlas-policy.md', 'synthetic / Atlas', `Atlas offers Core and Assisted memberships.

Core includes five storage transfers each month. Assisted members with archival requirements receive unlimited storage transfers.

A benefit known as Recovery Credit was introduced for qualifying accounts.`, 'sample', { id: 'step9-atlas' })
const atlasDetails = createDocument('atlas-details.md', 'synthetic / Atlas details', `Core includes five storage transfers each month. Assisted members with archival requirements receive unlimited storage transfers.

Recovery Credit is a named benefit for qualifying accounts.`, 'sample', { id: 'step9-atlas-details' })
const atlasPreparation = run('Summarise Atlas.', [atlas, atlasDetails])
assert.equal(atlasPreparation.route, 'synthesis')
assert.ok(atlasPreparation.discovery?.selected.some((facet) => facet.normalizedSubject === 'core'))
assert.ok(atlasPreparation.discovery?.selected.some((facet) => facet.normalizedSubject === 'assisted'))
assert.ok(atlasPreparation.discovery?.selected.some((facet) => facet.normalizedSubject === 'storage'))
assert.ok(atlasPreparation.discovery?.selected.some((facet) => facet.normalizedSubject === 'recovery-credit'))
assert.equal(atlasPreparation.providerCalled, false)

const nimbus = createDocument('nimbus-policy.md', 'synthetic / Nimbus', `Nimbus offers Basic and Plus plans.

Basic includes five API requests per hour. Plus includes twenty API requests per hour.

Enterprise Plus accounts with audit requirements receive unlimited export operations.

A benefit called Recovery Token was introduced for qualifying accounts.`, 'sample', { id: 'step9-nimbus' })
const nimbusPreparation = run('Compare Basic and Plus across quota and exceptions.', [nimbus])
assert.equal(nimbusPreparation.route, 'synthesis')
assert.ok(nimbusPreparation.discovery?.selected.some((facet) => facet.normalizedSubject === 'basic'))
assert.ok(nimbusPreparation.discovery?.selected.some((facet) => facet.normalizedSubject === 'plus'))
assert.ok(nimbusPreparation.requirements?.requirements.some((requirement) => requirement.dimension === 'allowance'))
assert.ok(nimbusPreparation.requirements?.requirements.some((requirement) => requirement.dimension === 'exception'))
assert.equal(nimbusPreparation.providerCalled, false)

console.log(JSON.stringify({
  synthesisRows,
  focusedControls: PHASE5E_FOCUSED_CONTROLS.length,
  journeyGuard: {
    initialMode: journeyGuard.scope.mode,
    refinement: journeyGuard.discovery?.scopeRefinement,
    route: journeyGuard.route,
  },
  generalization: {
    atlasFacets: atlasPreparation.discovery?.selected.map((facet) => facet.normalizedSubject),
    nimbusFacets: nimbusPreparation.discovery?.selected.map((facet) => facet.normalizedSubject),
  },
  providerCalls: 0,
}, null, 2))
console.log('Phase 5E Step 9 pipeline passed / scope -> discovery -> requirements -> retrieval -> reasoning -> coverage -> inspector')
