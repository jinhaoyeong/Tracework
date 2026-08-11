import assert from 'node:assert/strict'
import { resetPlanForQuerySurface } from '../src/lib/queryRoute.ts'

const emptyFocusedState = { neural: false, pgvector: false, grounded: false }

const applyReset = (state, route) => {
  const plan = resetPlanForQuerySurface(route)
  return {
    focused: plan.clearFocusedRetrieval ? { ...emptyFocusedState } : { ...state.focused },
    synthesis: plan.clearSynthesisPreparation ? null : state.synthesis,
  }
}

const focusedState = {
  focused: { neural: true, pgvector: true, grounded: true },
  synthesis: null,
}
const afterSynthesisReset = applyReset(focusedState, 'synthesis')
assert.deepEqual(afterSynthesisReset.focused, emptyFocusedState)
assert.equal(afterSynthesisReset.synthesis, null)
const synthesisReady = { ...afterSynthesisReset, synthesis: { route: 'synthesis', question: 'Summarise Meridian.' } }

const afterFocusedReset = applyReset(synthesisReady, 'focused')
assert.deepEqual(afterFocusedReset.focused, emptyFocusedState)
assert.equal(afterFocusedReset.synthesis, null)
const focusedReady = { ...afterFocusedReset, focused: { neural: true, pgvector: false, grounded: false } }
assert.equal(focusedReady.focused.neural, true)
assert.equal(focusedReady.synthesis, null)

assert.deepEqual(resetPlanForQuerySurface('synthesis'), { clearFocusedRetrieval: true, clearSynthesisPreparation: true })
assert.deepEqual(resetPlanForQuerySurface('focused'), { clearFocusedRetrieval: false, clearSynthesisPreparation: true })

console.log('Phase 5E query state boundary passed / focused → synthesis clears focused surfaces; synthesis → focused clears packet')
