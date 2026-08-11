import type { SynthesisPreparationResult } from './synthesisOrchestrator.ts'
import {
  MAX_SYNTHESIS_CONTEXT_CHARACTERS,
  type SynthesisCitation,
  type SynthesisGenerationContext,
  type SynthesisGenerationResult,
} from './synthesisGeneration.ts'

/**
 * The broad-answer surface, derived rather than assembled inside the component.
 *
 * Pulling this out of App.tsx is what makes the state transitions testable: the
 * project has no DOM test harness, so a `switch` buried in a 1,700-line
 * component could only ever be verified by looking at it. Here every status maps
 * to a title, a body, and a citation list that a test can assert directly.
 */

export type SynthesisSurfaceStatus = 'idle' | 'generating' | SynthesisGenerationResult['status']

export interface SynthesisGenerationSurfaceState {
  status: SynthesisSurfaceStatus
  result: SynthesisGenerationResult | null
  context: SynthesisGenerationContext | null
  requests: number
  providerCalled: boolean
  message: string | null
}

export interface SynthesisGenerationReportModel {
  status: string
  requests: number
  providerCalled: boolean
  model: string | null
  contextCharacters: number | null
  contextBudget: number
  evidenceReferences: number | null
  validCitationCount: number
  invalidCitationMarkers: string[]
  message: string | null
}

export interface SynthesisAnswerView {
  title: string
  body: string
  /** Only markers the validator resolved against the packet. */
  citations: SynthesisCitation[]
  citationCount: number
  citationEmptyMessage: string
  report: SynthesisGenerationReportModel | null
}

export const IDLE_SYNTHESIS_GENERATION: SynthesisGenerationSurfaceState = {
  status: 'idle',
  result: null,
  context: null,
  requests: 0,
  providerCalled: false,
  message: null,
}

const dispositionTitle = (preparation: SynthesisPreparationResult | null) => {
  switch (preparation?.coverage?.disposition) {
    case 'refuse-unsupported': return 'Synthesis needs missing metrics'
    case 'hold-for-conflict': return 'Synthesis is on conflict hold'
    case 'partial-with-disclosure': return 'Synthesis is incomplete'
    default: return 'Synthesis evidence is ready'
  }
}

const answerTitle = (
  preparation: SynthesisPreparationResult | null,
  generation: SynthesisGenerationSurfaceState,
  citationCount: number,
) => {
  if (generation.status === 'generating') return 'Writing the broad answer'
  switch (generation.result?.status) {
    case 'answered': return `${citationCount} cited ${citationCount === 1 ? 'source' : 'sources'} / broad answer`
    case 'model-refusal': return 'Evidence insufficient / model refused'
    case 'deterministic-refusal': return 'Synthesis needs missing metrics'
    case 'deterministic-hold': return 'Synthesis is on conflict hold'
    case 'deterministic-partial': return 'Synthesis is incomplete / answer withheld'
    case 'context-too-large': return 'Synthesis packet is too large to send'
    case 'unusable': return 'Broad generation returned unusable citations'
    case 'generation-failure': return 'Broad generation failed'
    default: return dispositionTitle(preparation)
  }
}

const answerBody = (
  preparation: SynthesisPreparationResult | null,
  generation: SynthesisGenerationSurfaceState,
) => {
  if (generation.status === 'generating') {
    return generation.message ?? 'The validated packet is being sent as a single generation request.'
  }
  const result = generation.result
  if (!result) {
    return preparation?.coverage?.disposition === 'answer'
      ? 'The deterministic broad-synthesis pipeline prepared a structured evidence packet. Switch to grounded answer mode to generate prose from it.'
      : preparation?.coverage?.dispositionReason ?? 'The deterministic broad-synthesis pipeline could not establish a complete answer.'
  }
  // A refusal and an unusable answer keep their text visible: the reader should
  // see what came back, not a summary of it.
  if (result.status === 'answered' || result.status === 'model-refusal' || result.status === 'unusable') return result.body
  return result.reason
}

const citationEmptyMessage = (generation: SynthesisGenerationSurfaceState) => {
  if (generation.status === 'generating') return 'Validated citations will appear once the single generation request returns.'
  if (generation.result) return 'No citation resolved against the packet, so none is presented as a source.'
  return 'The structured synthesis packet is inspectable below; citations appear after generation.'
}

const generationReport = (generation: SynthesisGenerationSurfaceState, citationCount: number): SynthesisGenerationReportModel | null => {
  if (generation.status === 'idle') return null
  const result = generation.result
  return {
    status: generation.status,
    requests: generation.requests,
    providerCalled: generation.providerCalled,
    model: result && 'metadata' in result ? result.metadata.model ?? null : null,
    contextCharacters: generation.context?.characters ?? null,
    contextBudget: MAX_SYNTHESIS_CONTEXT_CHARACTERS,
    evidenceReferences: generation.context?.references.length ?? null,
    validCitationCount: citationCount,
    invalidCitationMarkers: result?.status === 'unusable'
      ? [
          ...result.malformedCitationMarkers.map((token) => `[${token}]`),
          ...result.invalidCitationNumbers.map((number) => `[${number}]`),
        ]
      : [],
    message: generation.message,
  }
}

/**
 * Build the broad-answer surface.
 *
 * Only an `answered` result contributes citations. An unusable answer still
 * shows its text so the failure is inspectable, but its markers did not resolve,
 * so presenting them as sources would assert a trail that does not exist.
 */
export const buildSynthesisAnswerView = (
  preparation: SynthesisPreparationResult | null,
  generation: SynthesisGenerationSurfaceState,
): SynthesisAnswerView => {
  const citations = generation.result?.status === 'answered' ? generation.result.citations : []
  return {
    title: answerTitle(preparation, generation, citations.length),
    body: answerBody(preparation, generation),
    citations,
    citationCount: citations.length,
    citationEmptyMessage: citationEmptyMessage(generation),
    report: generationReport(generation, citations.length),
  }
}
