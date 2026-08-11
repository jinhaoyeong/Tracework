import assert from 'node:assert/strict'
import { classifyQueryScope } from '../src/lib/synthesisScope.ts'
import { PHASE5E_FOCUSED_CONTROLS, PHASE5E_SYNTHESIS_CASES } from './fixtures/phase5e.mjs'

const assertDecision = (question, expectedMode, expectedReason, label) => {
  const first = classifyQueryScope(question)
  const second = classifyQueryScope(question)
  assert.deepEqual(second, first, `${label} must be deterministic`)
  assert.equal(first.mode, expectedMode, `${label}: ${question}`)
  if (expectedReason) assert.equal(first.reason, expectedReason, `${label} should expose the frozen reason`)
  assert.ok(first.signals.length > 0, `${label} must expose inspectable signals`)
  return first
}

for (const testCase of PHASE5E_SYNTHESIS_CASES) {
  assertDecision(testCase.question, testCase.expectedQueryMode, null, testCase.id)
}

for (const control of PHASE5E_FOCUSED_CONTROLS) {
  assertDecision(control.question, control.expectedQueryMode, null, control.id)
}

const adversarialCases = [
  {
    id: 'A1',
    question: 'Summarise the Standard price.',
    mode: 'focused',
    reason: 'focused_single_subject',
    requiredSignals: ['summary_language:summarise', 'narrow_dimension:price'],
  },
  {
    id: 'A2',
    question: "Summarise Meridian's Standard price.",
    mode: 'focused',
    reason: 'focused_single_subject',
    requiredSignals: ['summary_language:summarise', 'narrow_dimension:price'],
  },
  {
    id: 'A3',
    question: 'Compare Standard and Supported prices.',
    mode: 'focused',
    reason: 'focused_narrow_comparison',
    requiredSignals: ['comparison_entities:2', 'comparison_dimensions:1'],
  },
  {
    id: 'A4',
    question: 'Compare Standard, Supported and Institutional prices.',
    mode: 'synthesis',
    reason: 'multi_entity_comparison',
    requiredSignals: ['comparison_entities:3', 'comparison_dimensions:1'],
  },
  {
    id: 'A5',
    question: 'Compare Standard and Supported across price, ferry treatment and Quiet Month.',
    mode: 'synthesis',
    reason: 'multi_entity_comparison',
    requiredSignals: ['comparison_entities:2', 'comparison_dimensions:3'],
  },
  {
    id: 'A6',
    question: 'What are the main reasons Journey Guard uses 18 credits?',
    mode: 'focused',
    reason: 'focused_single_subject',
    requiredSignals: ['focused_language:main_reasons'],
  },
  {
    id: 'A7',
    question: 'Give an overview of the Journey Guard threshold.',
    mode: 'focused',
    reason: 'focused_single_subject',
    requiredSignals: ['summary_language:overview', 'narrow_dimension:threshold'],
  },
  {
    id: 'A8',
    question: 'What is the current state of the Standard price?',
    mode: 'focused',
    reason: 'focused_single_subject',
    requiredSignals: ['summary_language:current_state', 'narrow_dimension:price'],
  },
  {
    id: 'A9',
    question: 'Summarize all Meridian plans and benefits.',
    mode: 'synthesis',
    reason: 'broad_inventory',
    requiredSignals: ['broad_inventory:all_items'],
  },
  {
    id: 'A10',
    question: 'What is the exact Standard price?',
    mode: 'focused',
    reason: 'focused_fact_question',
    requiredSignals: ['narrow_dimension:price'],
  },
  {
    id: 'A11',
    question: 'Explain the major policy changes from 2024 through 2026.',
    mode: 'synthesis',
    reason: 'broad_chronology',
    requiredSignals: ['chronology:major_changes_or_range'],
  },
  {
    id: 'A12',
    question: 'Summarise Journey Guard.',
    mode: 'synthesis',
    reason: 'explicit_broad_summary',
    requiredSignals: ['summary_language:summarise'],
  },
]

for (const spec of adversarialCases) {
  const result = assertDecision(spec.question, spec.mode, spec.reason, spec.id)
  for (const requiredSignal of spec.requiredSignals) {
    assert.ok(result.signals.includes(requiredSignal), `${spec.id} must expose ${requiredSignal}; got ${result.signals.join(', ')}`)
  }
}

const s6 = PHASE5E_SYNTHESIS_CASES.find((item) => item.id === 'S6')
const s6Decision = classifyQueryScope(s6.question)
assert.equal(s6Decision.mode, 'synthesis', 'S6 breadth must remain separate from unsupported answerability')
assert.equal(s6.expectedDisposition, 'refuse-unsupported', 'S6 fixture must still expect refusal after synthesis classification')

console.log(`Phase 5E scope tests passed / ${PHASE5E_SYNTHESIS_CASES.length} synthesis fixtures + ${PHASE5E_FOCUSED_CONTROLS.length} focused controls + ${adversarialCases.length} adversarial cases`)
