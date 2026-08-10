import { QUESTIONS as FROZEN_EVAL_QUESTIONS } from './stress-corpus.mjs'

/**
 * The ten Phase 5A stress questions remain frozen evaluation questions. These
 * additional questions are development material for checking that the
 * relevance strategy is not being tuned only to Q3/Q8/Q9 and pricing.
 */
export const EVAL_QUESTIONS = FROZEN_EVAL_QUESTIONS.map((question) => ({ ...question, split: 'EVAL' }))

export const DEV_QUESTIONS = [
  {
    id: 'D1', question: 'Where are Tracework web app builds deployed?',
    behavior: 'answer', expectSources: ['deployment-guide.md'], relevant: ['deployment-guide.md'],
    expect: /Vercel/i, probe: 'deployment wording', split: 'DEV',
  },
  {
    id: 'D2', question: 'What does paragraph chunking preserve?',
    behavior: 'answer', expectSources: ['chunking-strategies.md'], relevant: ['chunking-strategies.md'],
    expect: /meaning/i, probe: 'definition retrieval', split: 'DEV',
  },
  {
    id: 'D3', question: 'Which secrets must never be exposed to browser code?',
    behavior: 'answer', expectSources: ['security-policy.md'], relevant: ['security-policy.md'],
    expect: /service role|secrets/i, probe: 'security wording', split: 'DEV',
  },
  {
    id: 'D4', question: 'What does recall measure in a retrieval system?',
    behavior: 'answer', expectSources: ['retrieval-glossary.md'], relevant: ['retrieval-glossary.md'],
    expect: /relevant/i, probe: 'retrieval definition', split: 'DEV',
  },
  {
    id: 'D5', question: 'What must happen when the embedding dimension changes?',
    behavior: 'answer', expectSources: ['embedding-models.md'], relevant: ['embedding-models.md', 'database-configuration.md'],
    expect: /reindex/i, probe: 'schema constraint', split: 'DEV',
  },
]
