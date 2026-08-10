import assert from 'node:assert/strict'
import { createDocument } from '../src/lib/rag.ts'
import { extractTemporalClaims } from '../src/lib/temporal.ts'
import { normalizeTemporalExtraction, temporalKey } from '../src/lib/temporalNormalization.ts'
import { buildVariant, PHASE5D_CASES } from './fixtures/phase5d.mjs'

const QUESTION = 'What is the current Team plan price?'

const resultsFrom = (documents) => documents.flatMap((document) => document.chunks.map((chunk) => ({
  chunk, document, score: 1, semanticScore: 1, keywordScore: 1, matchedTerms: [], engine: 'hashed',
})))

const doc = (title, content) => createDocument(title, `synthetic / phase 5D / ${title}`, content, 'sample', { id: `norm-${title}` })

const run = (documents, question = QUESTION) => normalizeTemporalExtraction(extractTemporalClaims(question, resultsFrom(documents)))

const variantRun = (variant, question = QUESTION) => normalizeTemporalExtraction(extractTemporalClaims(
  question,
  resultsFrom(buildVariant(variant).map((source) => createDocument(
    source.title, `synthetic / phase 5D / ${source.title}`, source.content, 'sample',
    { id: `phase5d-${source.title}`, provenance: source.provenance },
  ))),
))

/* ------------------------------------------- claim-scoped validity (step 4.1) */

// The first date in a document must not become the date for every claim: the
// supersession test compares exactly these dates.
//
// "Effective January 2025", not "From January 2025": "from" is deliberately not
// a decided trigger, because "From January 2025 onward..." is the exact wording
// frozen as unassessed in T8. Adding "from" here to make this fixture read more
// naturally would silently break that frozen expectation.
const sameDocument = run([doc('t-pricing-history.md', `In 2024 the Team plan cost 40 USD per seat per month.
Effective January 2025 the Team plan costs 55 USD per seat per month.`)])
const forty = sameDocument.claims.find((claim) => claim.claim.value === '40 usd per seat per month')
const fiftyFive = sameDocument.claims.find((claim) => claim.claim.value === '55 usd per seat per month')
assert.ok(forty && fiftyFive, 'both prices in one document should be extracted')
assert.equal(forty.validFrom, '2024')
assert.equal(fiftyFive.validFrom, '2025-01', 'the second claim keeps its own date')
assert.ok(temporalKey(forty.validFrom) < temporalKey(fiftyFive.validFrom))

// The same boundary inside a multi-claim document: a "from" sentence carries no
// date of its own, so the claim inherits the nearest preceding one rather than
// inventing 2025.
const fromWording = run([doc('t-from.md', `In 2024 the Team plan cost 40 USD per seat per month.
From January 2025 the Team plan costs 55 USD per seat per month.`)])
const inherited = fromWording.claims.find((claim) => claim.claim.value === '55 usd per seat per month')
assert.equal(inherited.validFrom, '2024', '"from" is not a decided trigger, so no new validity period is asserted')

// Retrieval position is not a citation number.
assert.equal(typeof sameDocument.claims[0].claim.sourceResultIndex, 'number')
assert.equal('citation' in sameDocument.claims[0].claim, false, 'extractor must not carry a citation number')

/* -------------------------------------------------- subject normalisation */

const canonical = variantRun('supersession')
const canonicalSubjects = [...new Set(canonical.claims.map((claim) => claim.subject?.key))]
assert.deepEqual(canonicalSubjects, ['team|usd|per-seat-per-month|subscription'])

// A missing unit leaves the subject unestablished rather than guessed.
const noUnit = run([doc('t-vague.md', 'The Team plan price is 55 USD.')])
assert.equal(noUnit.claims.length, 1)
assert.equal(noUnit.claims[0].subject, null)
assert.equal(noUnit.claims[0].status, 'unresolved')
assert.match(noUnit.claims[0].reason, /amount unit/)

/* --------------------------------------------------- expansion, positive */

assert.equal(canonical.relations.length, 1, 'explicit same-subject supersession expands to exactly one relation')
const relation = canonical.relations[0]
assert.equal(relation.supersedingSource, 't-pricing-2025.md')
assert.equal(relation.supersededSource, 't-pricing-2024.md')
assert.equal(relation.triggerSentence, 'This supersedes all earlier pricing.', 'the original trigger sentence is preserved')
assert.match(relation.reason, /same normalized subject/)
assert.match(relation.reason, /strictly earlier validity/)
assert.equal(relation.derivedFromText, true)

// "replaces" plus a date expands the same way.
assert.equal(variantRun('naturalWording').relations.length, 1)

/* --------------------------------------------------- expansion, negative */

// earlier-pricing is not a wildcard: a different unit is a different subject.
const differentUnit = run([
  doc('t-monthly.md', 'In 2024 the Team plan cost 400 USD per month.'),
  doc('t-seat.md', `Tracework pricing, revised January 2025.
This supersedes all earlier pricing.
The Team plan costs 55 USD per seat per month.`),
])
assert.equal(differentUnit.relations.length, 0, 'a per-month price is not superseded by a per-seat-per-month price')
assert.ok(differentUnit.unresolved.some((entry) => /expands to nothing/.test(entry.reason)))

// A different pricing scope is a different subject.
const differentScope = run([
  doc('t-fee.md', 'In 2024 the Team plan one-time installation fee was 300 USD per month.'),
  doc('t-sub.md', `Tracework pricing, revised January 2025.
This supersedes all earlier pricing.
The Team plan costs 55 USD per seat per month.`),
])
assert.equal(differentScope.relations.length, 0, 'a one-time fee is not superseded by a subscription price')

// An unrelated plan never even becomes a claim, so it cannot be superseded.
const unrelatedPlan = run([
  doc('t-enterprise.md', 'In 2024 the enterprise plan cost 1,200 USD per month.'),
  doc('t-team.md', `Tracework pricing, revised January 2025.
This supersedes all earlier pricing.
The Team plan costs 55 USD per seat per month.`),
])
assert.equal(unrelatedPlan.claims.length, 1, 'only the Team plan claim is in scope')
assert.equal(unrelatedPlan.relations.length, 0)

// Identical or later dates are not earlier targets.
const notEarlier = run([
  doc('t-same-a.md', 'Effective January 2025, the Team plan costs 60 USD per seat per month.'),
  doc('t-same-b.md', `Tracework pricing, revised January 2025.
This supersedes all earlier pricing.
The Team plan costs 55 USD per seat per month.`),
])
assert.equal(notEarlier.relations.length, 0, 'an equally dated claim is not strictly earlier')

const laterTarget = run([
  doc('t-later.md', 'Effective January 2026, the Team plan costs 70 USD per seat per month.'),
  doc('t-trigger.md', `Tracework pricing, revised January 2025.
This supersedes all earlier pricing.
The Team plan costs 55 USD per seat per month.`),
])
assert.equal(laterTarget.relations.length, 0, 'a later claim is never a supersession target')

// A trigger on a claim whose own subject is unestablished expands to nothing.
const ambiguousTrigger = run([
  doc('t-old.md', 'In 2024 the Team plan cost 40 USD per seat per month.'),
  doc('t-ambiguous.md', `Tracework pricing, revised January 2025.
This supersedes all earlier pricing.
The Team plan price is 55 USD.`),
])
assert.equal(ambiguousTrigger.relations.length, 0, 'an unestablished subject may not supersede anything')
assert.ok(ambiguousTrigger.unresolved.some((entry) => /subject is unestablished|amount unit/.test(entry.reason)))

/* ------------------------------------------------------------ T8 stays put */

const awkward = variantRun('awkward')
assert.equal(awkward.relations.length, 0, 'trigger-free wording must not expand into a supersession')
assert.ok(awkward.claims.some((claim) => claim.claim.source === 't-pricing-2025-awkward.md'))

/* --------------------------------------------- frozen case relation summary */

const derived = {}
for (const spec of PHASE5D_CASES) {
  const normalization = variantRun(spec.variant, spec.question)
  derived[spec.id] = normalization.relations.length
}
// Only the variants carrying an explicit trigger derive a relation.
assert.ok(derived.T1 >= 1 && derived.T3 >= 1 && derived.T7 >= 1, 'explicit supersession variants derive relations')
assert.equal(derived.T5, 0, 'dated versions without a trigger derive nothing')
assert.equal(derived.T8, 0, 'trigger-free wording derives nothing')
assert.equal(derived.T9, 0, 'two authoritative same-period claims derive nothing')

console.log('Phase 5D normalization tests passed')
console.log(`derived relations per frozen case: ${Object.entries(derived).map(([id, count]) => `${id}=${count}`).join(' ')}`)
