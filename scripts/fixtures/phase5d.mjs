/**
 * Phase 5D frozen fixtures — temporal validity, supersession, applicable authority.
 *
 * Frozen BEFORE the extractor exists, so the extractor is written against these
 * expectations rather than the expectations being widened until the extractor
 * passes. The frozen Phase 5A/5B padded corpus is imported unchanged and used
 * only as ranking padding; nothing here mutates it.
 *
 * Each case freezes the expected DERIVED FACTS, not just the final answer, so a
 * failure can be localised to a stage:
 *
 *   extraction -> normalisation -> relation expansion -> applicability
 *   -> coverage -> adjudication -> generation
 *
 * No implementation, no provider calls.
 */
import { PADDED_CORPUS } from './stress-corpus.mjs'

const UNKNOWN = { origin: 'synthetic-fixture', authority: 'unknown', basis: 'Temporal fixture with no declared authority record.' }
const AUTHORITATIVE = { origin: 'synthetic-fixture', authority: 'authoritative', basis: 'Explicitly designated authoritative for Team plan pricing.' }

/**
 * Supersession wording is deliberately spread across three levels. Writing every
 * fixture in the canonical phrasing would only test a regex against sentences
 * composed to match it.
 *
 *   EXPLICIT  "This supersedes all earlier pricing."          -> must resolve
 *   NATURAL   "The January 2025 rates replace what we ..."    -> should resolve
 *   AWKWARD   "From January 2025 onward, customers used ..."  -> must NOT resolve
 *
 * The awkward text is genuine human evidence of a version change that avoids
 * every decided trigger (supersedes / replaces / effective from / starting).
 * Its frozen expectation is `unassessed`. Expanding the trigger list until it
 * passes would be exactly the test-set fitting this project has avoided.
 */
export const TEMPORAL_SOURCES = {
  pricing2024: ['t-pricing-2024.md', `Tracework pricing, revised March 2024.
The Team plan costs 40 USD per seat per month.`, UNKNOWN],

  // EXPLICIT — the canonical positive fixture, wording frozen verbatim.
  pricing2025: ['t-pricing-2025.md', `Tracework pricing, revised January 2025.
This supersedes all earlier pricing.
The Team plan costs 55 USD per seat per month.`, UNKNOWN],

  // NATURAL — "replace" plus a date is inside the decided trigger scope.
  pricing2025Natural: ['t-pricing-2025-natural.md', `The January 2025 rates replace what we published last year.
The Team plan costs 55 USD per seat per month.`, UNKNOWN],

  // AWKWARD — a real version change with no decided trigger phrase.
  pricing2025Awkward: ['t-pricing-2025-awkward.md', `From January 2025 onward, customers used the new Team rate;
the previous schedule remains in the archive for historical reference.
The Team plan costs 55 USD per seat per month.`, UNKNOWN],

  // BARE — dated, but claims no currentness and supersedes nothing.
  pricing2025Bare: ['t-pricing-2025-bare.md', `Tracework pricing, revised January 2025.
The Team plan costs 55 USD per seat per month.`, UNKNOWN],

  // Newer document, older claim. Must never become current.
  meeting2026: ['t-meeting-notes-2026.md', `Meeting notes, March 2026.
Reminder: some customers may still remember the former 40 USD Team plan price.`, UNKNOWN],

  // Future scheduled change. Newer is not the same as currently applicable.
  notice2026: ['t-price-notice-2026.md', `Pricing notice, December 2026.
Starting January 2027 the Team plan will cost 65 USD per seat per month.`, UNKNOWN],

  // Same-period authoritative pair for the authority-does-not-break-ties case.
  officialPricing: ['t-official-pricing.md', `Official pricing record.
Effective January 2025, the Team plan costs 55 USD per seat per month.`, AUTHORITATIVE],
  pricing2025Alt: ['t-pricing-2025-alt.md', `The Team plan costs 60 USD per seat per month, effective January 2025.`, AUTHORITATIVE],
}

const source = (key) => {
  const [title, content, provenance] = TEMPORAL_SOURCES[key]
  return { title, content, provenance }
}

/** Corpus variants. Each is a list of temporal sources plus optional padding. */
export const CORPUS_VARIANTS = {
  // Explicit supersession present.
  supersession: { sources: ['pricing2024', 'pricing2025'], padding: false },
  // Natural phrasing.
  naturalWording: { sources: ['pricing2024', 'pricing2025Natural'], padding: false },
  // No supersession or currentness evidence anywhere.
  ambiguous: { sources: ['pricing2024', 'pricing2025Bare'], padding: false },
  // Newer document restating an older value.
  staleMention: { sources: ['pricing2024', 'pricing2025', 'meeting2026'], padding: false },
  // Future scheduled price alongside the current one.
  future: { sources: ['pricing2024', 'pricing2025', 'notice2026'], padding: false },
  // Awkward wording with no decided trigger.
  awkward: { sources: ['pricing2024', 'pricing2025Awkward'], padding: false },
  // Two authoritative claims, same subject, same period, no supersession.
  duellingAuthority: { sources: ['officialPricing', 'pricing2025Alt'], padding: false },
  /**
   * Hostile ranking variant for the integration test. The full padded corpus is
   * included so the superseding source competes against 34 real distractors and
   * is pruned on merit. Whether it is genuinely pruned MUST be verified in the
   * offline evaluation; if it survives, add padding rather than hand-placing the
   * source into context, which would test only the resolver.
   */
  prunedSuperseder: { sources: ['pricing2024', 'pricing2025'], padding: true },
}

export const buildVariant = (name) => {
  const variant = CORPUS_VARIANTS[name]
  if (!variant) throw new Error(`Unknown Phase 5D corpus variant: ${name}`)
  const temporal = variant.sources.map((key) => {
    const { title, content, provenance } = source(key)
    return { title, content, provenance }
  })
  const padding = variant.padding
    ? PADDED_CORPUS.map(([title, content]) => ({ title, content, provenance: undefined }))
    : []
  return [...temporal, ...padding]
}

const TEAM_PLAN = 'team-plan-price'

/**
 * Applicability is evaluated at `requestedPeriod ?? asOf`. The question may name
 * a period ("in 2024", "in February 2027"); when it does not, the injected asOf
 * applies. asOf is always explicit — never the wall clock.
 */
export const PHASE5D_CASES = [
  {
    id: 'T1', name: 'current price with explicit supersession',
    variant: 'supersession',
    question: 'What is the current Team plan price?',
    asOf: '2026-08-10', requestedPeriod: null,
    expectedClaims: [
      { subject: TEAM_PLAN, value: '40 usd per seat per month', validFrom: '2024-03', validUntil: null, supersedes: null, source: 't-pricing-2024.md', derivedFromText: true },
      { subject: TEAM_PLAN, value: '55 usd per seat per month', validFrom: '2025-01', validUntil: null, supersedes: { kind: 'class', target: 'earlier-pricing' }, source: 't-pricing-2025.md', derivedFromText: true },
    ],
    expectedExpansion: [{ superseding: 't-pricing-2025.md', superseded: 't-pricing-2024.md', reason: 'same subject, earlier validFrom' }],
    expectedResolution: 'resolved',
    expectedValue: '55',
    expectedCitations: ['t-pricing-2025.md'],
    reachesPhase5C: false,
  },
  {
    id: 'T2', name: 'historical price for a named period',
    variant: 'supersession',
    question: 'What did the Team plan cost in 2024?',
    asOf: '2026-08-10', requestedPeriod: '2024',
    expectedResolution: 'resolved',
    expectedValue: '40',
    expectedCitations: ['t-pricing-2024.md'],
    // A superseded claim is never deleted; it stays answerable for its period.
    note: 'Same corpus and same extraction as T1, opposite correct answer.',
    reachesPhase5C: false,
  },
  {
    id: 'T3', name: 'unspecified time with evidenced currentness',
    variant: 'supersession',
    question: 'How much is the Team plan?',
    asOf: '2026-08-10', requestedPeriod: null,
    expectedResolution: 'resolved',
    expectedValue: '55',
    expectedCitations: ['t-pricing-2025.md'],
    note: 'Resolves only because supersession is explicitly evidenced, not because 2025 > 2024.',
    reachesPhase5C: false,
  },
  {
    id: 'T4', name: 'newer document mentioning an older value',
    variant: 'staleMention',
    question: 'What is the current Team plan price?',
    asOf: '2026-08-10', requestedPeriod: null,
    expectedClaimNote: 'The 2026 note must yield either no claim or a claim explicitly marked historical. It must never carry validFrom 2026.',
    expectedResolution: 'resolved',
    expectedValue: '55',
    expectedCitations: ['t-pricing-2025.md'],
    mustNotAnswer: '40',
    reachesPhase5C: false,
  },
  {
    id: 'T5', name: 'competing versions with no currentness evidence',
    variant: 'ambiguous',
    question: 'How much is the Team plan?',
    asOf: '2026-08-10', requestedPeriod: null,
    expectedResolution: 'unresolved',
    expectedDisclosure: 'multiple applicable versions, none established as current',
    // No latest-validFrom default. Disclosing is the correct answer here.
    mustNotAnswer: '55',
    reachesPhase5C: true,
  },
  {
    id: 'T6a', name: 'future scheduled price, asked before it takes effect',
    variant: 'future',
    question: 'What is the current Team plan price?',
    asOf: '2026-08-10', requestedPeriod: null,
    expectedClaims: [
      { subject: TEAM_PLAN, value: '65 usd per seat per month', validFrom: '2027-01', validUntil: null, supersedes: null, source: 't-price-notice-2026.md', derivedFromText: true },
    ],
    expectedResolution: 'resolved',
    expectedValue: '55',
    mustNotAnswer: '65',
    reachesPhase5C: false,
  },
  {
    id: 'T6b', name: 'future scheduled price, asked for its own period',
    variant: 'future',
    question: 'What will the Team plan cost in February 2027?',
    asOf: '2026-08-10', requestedPeriod: '2027-02',
    expectedResolution: 'resolved',
    expectedValue: '65',
    expectedCitations: ['t-price-notice-2026.md'],
    reachesPhase5C: false,
  },
  {
    id: 'T7', name: 'superseding evidence pruned, coverage restores it',
    variant: 'prunedSuperseder',
    question: 'What is the current Team plan price?',
    asOf: '2026-08-10', requestedPeriod: null,
    // The flagship. Phase 5A measured pricing-2024 outranking pricing-2025, so
    // the superseding source is the one pruning drops.
    expectedPrunedWithoutCoverage: 't-pricing-2025.md',
    expectedCoverageRestores: 't-pricing-2025.md',
    expectedResolution: 'resolved',
    expectedValue: '55',
    mustNotAnswer: '40',
    reachesPhase5C: false,
    integrationCritical: true,
  },
  {
    id: 'T8', name: 'version change with no decided trigger phrase',
    variant: 'awkward',
    question: 'What is the current Team plan price?',
    asOf: '2026-08-10', requestedPeriod: null,
    expectedResolution: 'unassessed',
    expectedReason: 'supersession language not detected; no temporal relationship established',
    // Frozen as a NEGATIVE result on purpose. Widening the trigger list to make
    // this pass is the failure mode, not the fix.
    mustNotAnswer: '55',
    reachesPhase5C: true,
  },
  {
    id: 'T9', name: 'two authoritative same-period claims',
    variant: 'duellingAuthority',
    question: 'What is the current Team plan price?',
    asOf: '2026-08-10', requestedPeriod: null,
    expectedClaims: [
      { subject: TEAM_PLAN, value: '55 usd per seat per month', validFrom: '2025-01', validUntil: null, supersedes: null, source: 't-official-pricing.md', derivedFromText: true },
      { subject: TEAM_PLAN, value: '60 usd per seat per month', validFrom: '2025-01', validUntil: null, supersedes: null, source: 't-pricing-2025-alt.md', derivedFromText: true },
    ],
    expectedResolution: 'unresolved',
    // Both applicable, both authoritative, no supersession: authority does not
    // break a temporal tie, so this must fall through to Phase 5C.
    reachesPhase5C: true,
    expectedPhase5CStatus: 'conflicted',
    expectedCitations: ['t-official-pricing.md', 't-pricing-2025-alt.md'],
    mustNotAnswer: '60',
  },
]

/** A supplementary positive case for the natural phrasing level. */
export const PHASE5D_WORDING_CASES = [
  { id: 'W1', variant: 'supersession', level: 'explicit', expectedResolution: 'resolved' },
  { id: 'W2', variant: 'naturalWording', level: 'natural', expectedResolution: 'resolved' },
  { id: 'W3', variant: 'awkward', level: 'awkward', expectedResolution: 'unassessed' },
]
