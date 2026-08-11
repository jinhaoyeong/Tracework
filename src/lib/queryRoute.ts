export type QuerySurfaceRoute = 'focused' | 'synthesis'

export interface QuerySurfaceResetPlan {
  clearFocusedRetrieval: boolean
  clearSynthesisPreparation: boolean
}

/**
 * State ownership at the query boundary. A synthesis request must not inherit
 * focused retrieval/debug surfaces; a focused request must not leave an old
 * synthesis packet presented as the active answer.
 */
export const resetPlanForQuerySurface = (route: QuerySurfaceRoute): QuerySurfaceResetPlan => (
  route === 'synthesis'
    ? { clearFocusedRetrieval: true, clearSynthesisPreparation: true }
    : { clearFocusedRetrieval: false, clearSynthesisPreparation: true }
)

export type AnswerSurfaceMode = 'retrieval' | 'grounded'

export interface QueryExecutionPlan {
  runFocusedRetrieval: boolean
  runFocusedGeneration: boolean
  runBroadGeneration: boolean
  reason: string
}

/**
 * Which paths a single user action is allowed to take.
 *
 * Extracted from the component so the rule "retrieval-only never reaches a
 * generation provider" is a testable fact rather than a branch buried in an
 * event handler. `preparedRoute` is the route the deterministic preparation
 * actually settled on, not the classifier's first guess: a broad question that
 * was refined down to a narrow subject runs the focused path.
 */
export const planQueryExecution = (
  preparedRoute: QuerySurfaceRoute,
  answerMode: AnswerSurfaceMode,
): QueryExecutionPlan => {
  const wantsGeneration = answerMode === 'grounded'
  if (preparedRoute === 'synthesis') {
    return {
      runFocusedRetrieval: false,
      runFocusedGeneration: false,
      runBroadGeneration: wantsGeneration,
      reason: wantsGeneration
        ? 'A broad packet was prepared and grounded answer mode was requested.'
        : 'Retrieval-only mode stops at the inspectable packet; no broad generation is attempted.',
    }
  }
  return {
    runFocusedRetrieval: true,
    runFocusedGeneration: wantsGeneration,
    runBroadGeneration: false,
    reason: wantsGeneration
      ? 'The focused route runs its existing retrieval and generation path.'
      : 'The focused route runs retrieval only.',
  }
}
