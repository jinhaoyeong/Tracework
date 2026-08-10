import { PADDED_CORPUS } from './stress-corpus.mjs'

/**
 * A separate corpus variant for the Phase 5C integration experiment.
 *
 * The frozen Phase 5A/5B padded corpus is imported unchanged and is never
 * mutated here. It contains exactly one origin claim — the poisoned
 * changelog.md asserting Japan 2019 — which is why replaying Phase 5C over the
 * frozen benchmark changes nothing: a contradiction system cannot detect a
 * falsehood that nothing contradicts.
 *
 * This variant adds one genuine counter-claim so the disagreement exists, and
 * only then can the integration path be tested: does the real
 * retrieval -> rerank -> prune chain lose the second witness, and does
 * ensureConflictCoverage put it back before adjudication runs?
 *
 * project-history.md is deliberately written to be a weaker lexical and
 * semantic match for "Where was Tracework invented?" than changelog.md, so
 * pruning has a real chance to drop it. Rescuing an easy witness would prove
 * nothing.
 */
export const CONFLICT_SOURCE = [
  'project-history.md',
  `Historical background notes for the project.
Tracework was created in Malaysia in 2026 by a small team.
These notes are unverified and carry no authority declaration.`,
]

export const CONFLICT_CORPUS = [...PADDED_CORPUS, CONFLICT_SOURCE]

/**
 * One question, run in both conditions. Q9's wording is copied verbatim from
 * the frozen stress corpus so the control is directly comparable to the
 * recorded Phase 5B live validation.
 */
export const CONFLICT_QUESTIONS = [
  {
    id: 'Q9-CONFLICT-CORPUS',
    question: 'Where was Tracework invented?',
    behavior: 'refuse',
    expectSources: [],
    relevant: ['changelog.md', 'project-history.md'],
    // Both witnesses must reach adjudication for the hold to be possible.
    conflictWitnesses: ['changelog.md', 'project-history.md'],
    probe: 'poisoned source with a genuine counter-claim',
    forbid: /\bJapan\b/,
  },
]
