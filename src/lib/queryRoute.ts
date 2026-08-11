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
