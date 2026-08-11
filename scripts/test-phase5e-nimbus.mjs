import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createDocument } from '../src/lib/rag.ts'
import { discoverFacets } from '../src/lib/facetDiscovery.ts'
import { classifyQueryScope } from '../src/lib/synthesisScope.ts'
import { deriveSynthesisRequirements, materializeSynthesisFacets } from '../src/lib/synthesisRequirements.ts'
import { buildFacetQuery, retrieveFacetEvidence } from '../src/lib/facetRetrieval.ts'

const documents = [
  createDocument('Nimbus memberships', 'synthetic / Nimbus / memberships', 'Nimbus offers Basic and Plus plans.', 'sample', { id: 'nimbus-memberships' }),
  createDocument('Nimbus Basic quota', 'synthetic / Nimbus / basic', 'Basic includes five API requests per hour.', 'sample', { id: 'nimbus-basic' }),
  createDocument('Nimbus Plus quota', 'synthetic / Nimbus / plus', 'Plus includes twenty API requests per hour.', 'sample', { id: 'nimbus-plus' }),
  createDocument('Nimbus audit exception', 'synthetic / Nimbus / exceptions', 'Enterprise Plus accounts with audit requirements receive unlimited export operations.', 'sample', { id: 'nimbus-exception' }),
  createDocument('Nimbus recovery benefit', 'synthetic / Nimbus / benefits', 'A benefit called Recovery Token was introduced for account recovery charges.', 'sample', { id: 'nimbus-recovery' }),
]
const corpus = { documents }
const chunks = documents.flatMap((document) => document.chunks.map((chunk) => ({
  id: chunk.id,
  documentId: chunk.documentId,
  documentTitle: document.title,
  text: chunk.text,
})))

const selectedBySubject = (discovery, subject) => discovery.selected.find((facet) => facet.normalizedSubject === subject)
const selectedText = (retrieval) => retrieval.selected.map((result) => result.chunk.text).join('\n')

const summaryQuestion = 'Summarise Nimbus.'
const summaryScope = classifyQueryScope(summaryQuestion)
const summaryDiscovery = discoverFacets(summaryQuestion, chunks, summaryScope)
assert.equal(summaryScope.mode, 'synthesis')
assert.equal(summaryDiscovery.scopeRefinement, 'keep-synthesis')

const basic = selectedBySubject(summaryDiscovery, 'basic')
const plus = selectedBySubject(summaryDiscovery, 'plus')
const api = summaryDiscovery.selected.find((facet) => facet.kind === 'recurring-policy-dimension' && facet.normalizedSubject === 'api')
const recovery = selectedBySubject(summaryDiscovery, 'recovery-token')
const auditPlus = summaryDiscovery.selected.find((facet) => facet.kind === 'scoped-exception' && facet.parentId === 'plus')
assert.ok(basic, 'Nimbus Basic category must be discovered')
assert.ok(plus, 'Nimbus Plus category must be discovered')
assert.ok(api, 'Nimbus API dimension must be discovered generically')
assert.ok(api.lexicalAliases.includes('request'), 'API dimension must retain a corpus-derived singular companion')
assert.ok(api.lexicalAliases.includes('requests'), 'API dimension must retain a corpus-derived plural companion')
assert.ok(!api.lexicalAliases.some((alias) => /^(?:ferry|ferries|crossing|crossings)$/i.test(alias)), 'Nimbus must not receive unrelated domain vocabulary')
assert.ok(recovery, 'Nimbus singleton Recovery Token must be discovered')
assert.ok(auditPlus, 'Nimbus audit-scoped exception must retain its Plus parent')

const summaryPlan = deriveSynthesisRequirements(summaryQuestion, summaryScope, summaryDiscovery, chunks)
assert.ok(summaryPlan.requirements.some((requirement) => requirement.facetId === 'api'))
const plannedApi = materializeSynthesisFacets(summaryDiscovery, summaryPlan).find((planned) => planned.facet.id === 'api')
assert.ok(plannedApi, 'Nimbus API dimension must enter the runtime requirement plan')

const apiRetrieval = retrieveFacetEvidence(summaryQuestion, api, corpus, { maxSelected: 4 })
assert.match(selectedText(apiRetrieval), /API requests/i)
assert.match(buildFacetQuery(summaryQuestion, api), /requests/i)
assert.doesNotMatch(buildFacetQuery(summaryQuestion, api), /ferries?|crossings?/i)

const recoveryRetrieval = retrieveFacetEvidence(summaryQuestion, recovery, corpus, { maxSelected: 4 })
assert.match(selectedText(recoveryRetrieval), /Recovery Token/i)

const auditRetrieval = retrieveFacetEvidence(summaryQuestion, auditPlus, corpus, { maxSelected: 4 })
assert.match(selectedText(auditRetrieval), /export operations/i)

const comparisonQuestion = 'Compare Basic and Plus across quota and exceptions.'
const comparisonScope = classifyQueryScope(comparisonQuestion)
const comparisonDiscovery = discoverFacets(comparisonQuestion, chunks, comparisonScope)
const comparisonPlan = deriveSynthesisRequirements(comparisonQuestion, comparisonScope, comparisonDiscovery, chunks)
assert.equal(comparisonScope.mode, 'synthesis')
assert.equal(comparisonPlan.mode, 'comparison')
assert.ok(comparisonPlan.requirements.some((requirement) => requirement.dimension === 'allowance'))
assert.ok(comparisonPlan.requirements.some((requirement) => requirement.dimension === 'exception'))

for (const path of ['src/lib/facetDiscovery.ts', 'src/lib/synthesisRequirements.ts', 'src/lib/facetRetrieval.ts']) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
  for (const forbiddenLiteral of ['Meridian', 'Bellweather', 'Quiet Month', 'mobility-disabled', 'ferry', 'crossing', 'assistant']) {
    assert.ok(!source.toLocaleLowerCase('en').includes(forbiddenLiteral.toLocaleLowerCase('en')), `${path} must not contain domain-specific literal ${forbiddenLiteral}`)
  }
}

console.log('Phase 5E Nimbus generalization passed / categories + derived API vocabulary + scoped exception + singleton benefit + comparison requirements')
