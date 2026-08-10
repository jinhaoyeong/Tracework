/**
 * Shared provider-usage accounting for the evaluation harnesses.
 *
 * Artifacts previously reported generation tokens only, so an experiment's
 * embedding work was invisible: the Phase 5C figure of "313 in / 19 out"
 * omitted every embedding request the run actually made. Generation and
 * embeddings are counted separately here because they are billed separately
 * and because a phase can move one without touching the other — Phase 5C's
 * conflict hold removes a generation call while leaving embeddings untouched.
 */
export const createUsageTracker = () => {
  const usage = {
    generation: { requests: 0, inputTokens: 0, outputTokens: 0 },
    embeddings: { requests: 0, texts: 0, promptTokens: 0 },
  }

  /** Call with the route path and its parsed response payload. */
  const record = (path, requestBody, payload) => {
    if (path === '/api/generate') {
      usage.generation.requests += 1
      usage.generation.inputTokens += payload?.inputTokens ?? 0
      usage.generation.outputTokens += payload?.outputTokens ?? 0
      return
    }
    if (path === '/api/embed') {
      const input = requestBody?.input
      usage.embeddings.requests += 1
      usage.embeddings.texts += Array.isArray(input) ? input.length : input ? 1 : 0
      // Present only when the embed route passes the provider's usage through.
      usage.embeddings.promptTokens += payload?.usage?.prompt_tokens ?? 0
    }
  }

  const summary = () => ({
    generation: { ...usage.generation },
    embeddings: { ...usage.embeddings },
    note: usage.embeddings.promptTokens
      ? undefined
      : 'Embedding prompt tokens were not reported by the route; request and text counts are exact.',
  })

  const line = () => (
    `generation: ${usage.generation.requests} calls / ${usage.generation.inputTokens} in / ${usage.generation.outputTokens} out`
    + ` · embeddings: ${usage.embeddings.requests} requests / ${usage.embeddings.texts} texts`
    + (usage.embeddings.promptTokens ? ` / ${usage.embeddings.promptTokens} tokens` : ' / tokens not reported')
  )

  return { usage, record, summary, line }
}
