/**
 * Phase 5E Step 10C — broad-answer surface and rendered state transitions.
 *
 * Two layers are checked:
 *
 *   view model   buildSynthesisAnswerView, exhaustively across every generation
 *                status. This is the logic that used to live inside App.tsx.
 *   real JSX     SynthesisInspector and SynthesisAnswerCitations, compiled with
 *                the esbuild already present as a Vite dependency and rendered
 *                with react-dom/server. No test framework is installed.
 *
 * What this does NOT cover: App.tsx as a whole, browser layout, and click
 * behaviour. App reads localStorage at module scope, so rendering it here would
 * test a shim rather than the app. Those remain manual browser QA.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transform } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildMeridianCorpus } from '../src/data/meridianCorpus.ts'
import { prepareSynthesis } from '../src/lib/synthesisOrchestrator.ts'
import {
  MAX_SYNTHESIS_CONTEXT_CHARACTERS,
  buildSynthesisGenerationContext,
  generateSynthesisAnswer,
} from '../src/lib/synthesisGeneration.ts'
import { IDLE_SYNTHESIS_GENERATION, buildSynthesisAnswerView } from '../src/lib/synthesisAnswerView.ts'
import { PHASE5E_SYNTHESIS_CASES } from './fixtures/phase5e.mjs'

globalThis.fetch = () => { throw new Error('Phase 5E Step 10C render tests forbid network access') }

/* ------------------------------------------------------------ jsx harness */

/**
 * Compile a component and its local imports, then load it.
 *
 * esbuild ships with Vite, so this adds no dependency. It is needed because
 * node --experimental-strip-types removes TS types but cannot handle JSX. React
 * stays external so the real installed copy is used. Transforming each local
 * module separately avoids esbuild's bundle resolver trying to walk outside the
 * restricted Windows workspace; rewritten file URLs still load the complete
 * local import graph.
 */
const CACHE_DIR = 'node_modules/.cache/phase5e-render'
mkdirSync(CACHE_DIR, { recursive: true })

const LOCAL_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js']
const compiledModules = new Map()

const resolveLocalModule = (fromPath, specifier) => {
  const base = resolve(dirname(fromPath), specifier)
  const candidates = [
    base,
    ...LOCAL_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...LOCAL_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error(`Could not resolve local render import ${specifier} from ${fromPath}`)
  return found
}

const loaderFor = (filePath) => {
  const extension = extname(filePath).toLowerCase()
  return extension === '.tsx' || extension === '.jsx' ? 'tsx' : 'ts'
}

const compileModule = async (filePath, outputName) => {
  const absolutePath = resolve(filePath)
  const existing = compiledModules.get(absolutePath)
  if (existing) return existing

  const outputPath = join(CACHE_DIR, `${outputName}-${compiledModules.size}.mjs`)
  const promise = (async () => {
    const source = readFileSync(absolutePath, 'utf8')
    const localImports = [...source.matchAll(/\bfrom\s+(['"])(\.[^'"]+)\1/g)]
    const rewrittenImports = new Map()
    for (const match of localImports) {
      const specifier = match[2]
      if (!rewrittenImports.has(specifier)) {
        const dependencyPath = resolveLocalModule(absolutePath, specifier)
        const dependencyOutput = await compileModule(dependencyPath, 'dependency')
        rewrittenImports.set(specifier, pathToFileURL(dependencyOutput).href)
      }
    }

    const { code } = await transform(source, {
      loader: loaderFor(absolutePath),
      format: 'esm',
      jsx: 'automatic',
      target: 'es2022',
      sourcefile: absolutePath,
    })
    const rewritten = code.replace(/\bfrom\s+(['"])(\.[^'"]+)\1/g, (match, quote, specifier) => {
      const replacement = rewrittenImports.get(specifier)
      return replacement ? `from ${quote}${replacement}${quote}` : match
    })
    writeFileSync(outputPath, rewritten, 'utf8')
    return outputPath
  })()
  compiledModules.set(absolutePath, promise)
  return promise
}

const loadComponent = async (path, name) => {
  const outFile = await compileModule(path, name)
  return import(pathToFileURL(outFile).href)
}

const meridianDocument = buildMeridianCorpus()[0]
const fixtureCase = (id) => PHASE5E_SYNTHESIS_CASES.find((item) => item.id === id)
const prepare = (spec) => prepareSynthesis(spec.question, [meridianDocument], { asOf: spec.asOf })

const s1Preparation = prepare(fixtureCase('S1'))
const s1Context = buildSynthesisGenerationContext(s1Preparation)
const s6Preparation = prepare(fixtureCase('S6'))

const generateWith = async (preparation, respond) => generateSynthesisAnswer(preparation, { adapter: respond })

const stateFor = (result, context) => ({
  status: result.status,
  result,
  context,
  requests: result.generationRequests,
  providerCalled: result.providerCalled,
  message: result.reason,
})

/* ---------------------------------------- 1. synthesis + answer */

const answered = await generateWith(s1Preparation, (request) => ({
  answer: `Meridian's current state is summarised here [${request.references[0].citation}] and corroborated [${request.references[1].citation}].`,
  model: 'render-harness-model',
}))
assert.equal(answered.status, 'answered')
const answeredView = buildSynthesisAnswerView(s1Preparation, stateFor(answered, s1Context))
assert.match(answeredView.title, /^2 cited sources \/ broad answer$/)
assert.equal(answeredView.body, answered.body)
assert.equal(answeredView.citationCount, 2)
assert.deepEqual(answeredView.citations.map((citation) => citation.citation), [1, 2])
assert.equal(answeredView.report.requests, 1)
assert.equal(answeredView.report.providerCalled, true)
assert.equal(answeredView.report.model, 'render-harness-model')
assert.equal(answeredView.report.contextCharacters, s1Context.characters)
assert.equal(answeredView.report.contextBudget, MAX_SYNTHESIS_CONTEXT_CHARACTERS)
assert.equal(answeredView.report.evidenceReferences, s1Context.references.length)
assert.deepEqual(answeredView.report.invalidCitationMarkers, [])

// Every presented citation is a row of the packet reference table, and resolves
// back to a chunk that at least one facet admitted.
for (const citation of answeredView.citations) {
  const reference = s1Context.references.find((item) => item.citation === citation.citation)
  assert.ok(reference, `citation [${citation.citation}] must exist in the reference table`)
  assert.equal(reference.chunkId, citation.chunkId)
  assert.ok(reference.facetIds.length > 0, 'a presented reference must name the facets that admitted it')
  for (const facetId of reference.facetIds) {
    assert.ok(
      s1Preparation.packet.facets.some((facet) => facet.facetId === facetId),
      `reference [${citation.citation}] names facet ${facetId}, which is not in the packet`,
    )
  }
}

/* ------------------------------- 2-5. withheld and failed outcomes */

const partialResult = { status: 'deterministic-partial', reason: 'A bounded answer is available, but 1 required facet remains incomplete: dayline.', disposition: 'partial-with-disclosure', missingFacetIds: ['dayline'], generationRequests: 0, providerCalled: false }
const partialView = buildSynthesisAnswerView(s1Preparation, stateFor(partialResult, null))
assert.equal(partialView.title, 'Synthesis is incomplete / answer withheld')
assert.equal(partialView.body, partialResult.reason)
assert.equal(partialView.citationCount, 0, 'a withheld partial must present no generated answer or sources')
assert.equal(partialView.report.requests, 0)
assert.equal(partialView.report.providerCalled, false)

const holdResult = { status: 'deterministic-hold', reason: 'Coverage withheld the answer because a critical facet conflict is unresolved.', disposition: 'hold-for-conflict', generationRequests: 0, providerCalled: false }
const holdView = buildSynthesisAnswerView(s1Preparation, stateFor(holdResult, null))
assert.equal(holdView.title, 'Synthesis is on conflict hold')
assert.match(holdView.body, /conflict is unresolved/)
assert.equal(holdView.citationCount, 0)

const refusal = await generateWith(s6Preparation, () => { throw new Error('the provider must never be reached') })
assert.equal(refusal.status, 'deterministic-refusal')
const refusalView = buildSynthesisAnswerView(s6Preparation, stateFor(refusal, null))
assert.equal(refusalView.title, 'Synthesis needs missing metrics')
assert.match(refusalView.body, /unsupported/)
assert.equal(refusalView.citationCount, 0)
assert.equal(refusalView.report.providerCalled, false)
assert.equal(refusalView.report.contextCharacters, null, 'no context is built for a refusal')

const oversizedResult = { status: 'context-too-large', reason: 'The assembled synthesis context is 161,693 characters, over the 36,000-character budget.', code: 'context_too_large', characters: 161693, budget: MAX_SYNTHESIS_CONTEXT_CHARACTERS, generationRequests: 0, providerCalled: false }
const oversizedView = buildSynthesisAnswerView(s1Preparation, stateFor(oversizedResult, null))
assert.equal(oversizedView.title, 'Synthesis packet is too large to send')
assert.equal(oversizedView.report.providerCalled, false)
assert.equal(oversizedView.report.requests, 0)
assert.equal(oversizedView.citationCount, 0)

/* --------------------------- 6. model refusal, unusable, transport failure */

const modelRefusal = await generateWith(s1Preparation, () => ({ answer: 'I could not find enough evidence in the supplied knowledge base to answer this.', model: 'render-harness-model' }))
const modelRefusalView = buildSynthesisAnswerView(s1Preparation, stateFor(modelRefusal, s1Context))
assert.equal(modelRefusalView.title, 'Evidence insufficient / model refused')
assert.equal(modelRefusalView.body, modelRefusal.body, 'the refusal text itself is shown, not a paraphrase')
assert.equal(modelRefusalView.citationCount, 0, 'a refusal carries no claim and so no sources')
assert.equal(modelRefusalView.report.providerCalled, true)
assert.equal(modelRefusalView.report.requests, 1)

const unusable = await generateWith(s1Preparation, () => ({ answer: 'Meridian charges a fee [99] and [01].', model: 'render-harness-model' }))
assert.equal(unusable.status, 'unusable')
const unusableView = buildSynthesisAnswerView(s1Preparation, stateFor(unusable, s1Context))
assert.equal(unusableView.title, 'Broad generation returned unusable citations')
assert.equal(unusableView.body, unusable.body, 'the unusable text stays visible so the failure is inspectable')
assert.equal(unusableView.citationCount, 0, 'unresolved markers must never be presented as sources')
assert.deepEqual(unusableView.report.invalidCitationMarkers, ['[01]', '[99]'])

const failure = await generateWith(s1Preparation, () => { const error = new Error('upstream timed out'); error.code = 'provider_timeout'; throw error })
const failureView = buildSynthesisAnswerView(s1Preparation, stateFor(failure, s1Context))
assert.equal(failureView.title, 'Broad generation failed')
assert.notEqual(failureView.title, modelRefusalView.title, 'a transport failure must not read as a model refusal')

/* ------------------------------------------- 7. idle and in-flight surfaces */

const idleView = buildSynthesisAnswerView(s1Preparation, IDLE_SYNTHESIS_GENERATION)
assert.equal(idleView.title, 'Synthesis evidence is ready')
assert.match(idleView.body, /Switch to grounded answer mode/)
assert.equal(idleView.report, null, 'an idle surface reports no generation boundary at all')
assert.match(idleView.citationEmptyMessage, /citations appear after generation/)

const idleRefusalView = buildSynthesisAnswerView(s6Preparation, IDLE_SYNTHESIS_GENERATION)
assert.equal(idleRefusalView.title, 'Synthesis needs missing metrics')

const generatingView = buildSynthesisAnswerView(s1Preparation, { ...IDLE_SYNTHESIS_GENERATION, status: 'generating', context: s1Context, message: 'Sending the validated packet...' })
assert.equal(generatingView.title, 'Writing the broad answer')
assert.equal(generatingView.body, 'Sending the validated packet...')
assert.match(generatingView.citationEmptyMessage, /single generation request returns/)
assert.equal(generatingView.report.requests, 0)

/* ---------------------------- 8. route switching clears the broad surface */

// A focused question resets the preparation; the surface must go with it.
const clearedView = buildSynthesisAnswerView(null, IDLE_SYNTHESIS_GENERATION)
assert.equal(clearedView.citationCount, 0)
assert.equal(clearedView.report, null)
assert.equal(clearedView.title, 'Synthesis evidence is ready')
assert.match(clearedView.body, /could not establish a complete answer/)

/* ------------------------------------------------------ 9. real JSX render */

const { SynthesisAnswerCitations } = await loadComponent('src/components/SynthesisAnswerCitations.tsx', 'citations')
const { SynthesisInspector } = await loadComponent('src/components/SynthesisInspector.tsx', 'inspector')

const citationMarkup = renderToStaticMarkup(createElement(SynthesisAnswerCitations, { view: answeredView, onSelectChunk: () => {} }))
for (const citation of answeredView.citations) {
  assert.ok(citationMarkup.includes(`[${citation.citation}]`), `the rail must render marker [${citation.citation}]`)
  assert.ok(citationMarkup.includes(citation.chunkId), 'the rail must render the chunk id so a citation is traceable')
  assert.ok(citationMarkup.includes(citation.documentTitle), 'the rail must render the source title')
}
assert.equal((citationMarkup.match(/citation-line/g) ?? []).length, answeredView.citations.length)

const emptyRail = renderToStaticMarkup(createElement(SynthesisAnswerCitations, { view: unusableView, onSelectChunk: () => {} }))
assert.ok(emptyRail.includes('citation-empty'))
assert.ok(emptyRail.includes('No citation resolved against the packet'))
assert.ok(!emptyRail.includes('[99]'), 'a rejected marker must never appear as a source row')
assert.ok(!emptyRail.includes('citation-line'))

const inspectorMarkup = renderToStaticMarkup(createElement(SynthesisInspector, { preparation: s1Preparation, generation: answeredView.report }))
assert.ok(inspectorMarkup.includes('generation boundary'), 'the inspector must stay visible with a generation report')
assert.ok(inspectorMarkup.includes('Make breadth inspectable.'), 'the packet inspector must remain rendered after generation')
assert.ok(inspectorMarkup.includes('>1<'), 'the inspector must report the generation request count')
assert.ok(inspectorMarkup.includes('render-harness-model'))
assert.ok(inspectorMarkup.includes(MAX_SYNTHESIS_CONTEXT_CHARACTERS.toLocaleString()))
assert.ok(
  inspectorMarkup.includes('does not prove the cited passage entails the sentence citing it'),
  'the inspector must state that citation validation is not entailment validation',
)

const refusalInspector = renderToStaticMarkup(createElement(SynthesisInspector, { preparation: s6Preparation, generation: refusalView.report }))
assert.ok(refusalInspector.includes('deterministic refusal'))
assert.ok(refusalInspector.includes('>no<'), 'a refusal must report provider called: no')
assert.ok(refusalInspector.includes('>0<'), 'a refusal must report zero generation requests')

const unusableInspector = renderToStaticMarkup(createElement(SynthesisInspector, { preparation: s1Preparation, generation: unusableView.report }))
assert.ok(unusableInspector.includes('Rejected markers: [01], [99]'))

const idleInspector = renderToStaticMarkup(createElement(SynthesisInspector, { preparation: s1Preparation, generation: null }))
assert.ok(!idleInspector.includes('generation boundary'), 'no generation panel before a request is attempted')
assert.ok(idleInspector.includes('Final prose generation has not been called'))

const nullInspector = renderToStaticMarkup(createElement(SynthesisInspector, { preparation: null, generation: null }))
assert.equal(nullInspector, '', 'the inspector must disappear when the preparation is cleared')

console.log(JSON.stringify({
  viewModel: [
    { state: 'answered', title: answeredView.title, citations: answeredView.citationCount, requests: answeredView.report.requests },
    { state: 'deterministic-partial', title: partialView.title, citations: 0, requests: 0 },
    { state: 'deterministic-hold', title: holdView.title, citations: 0, requests: 0 },
    { state: 'deterministic-refusal', title: refusalView.title, citations: 0, requests: 0 },
    { state: 'context-too-large', title: oversizedView.title, citations: 0, requests: 0 },
    { state: 'model-refusal', title: modelRefusalView.title, citations: 0, requests: 1 },
    { state: 'unusable', title: unusableView.title, citations: 0, rejected: unusableView.report.invalidCitationMarkers },
    { state: 'generation-failure', title: failureView.title },
    { state: 'generating', title: generatingView.title },
    { state: 'idle', title: idleView.title, report: idleView.report },
  ],
  renderedComponents: ['SynthesisAnswerCitations', 'SynthesisInspector'],
  citationTrace: answeredView.citations.map((citation) => ({
    marker: `[${citation.citation}]`,
    chunkId: citation.chunkId,
    facetIds: s1Context.references.find((reference) => reference.citation === citation.citation).facetIds,
  })),
  liveProviderCalls: 0,
}, null, 2))
rmSync(CACHE_DIR, { recursive: true, force: true })

console.log('Phase 5E Step 10C render tests passed / every broad-generation state maps to a checked surface, and the rail and inspector render from real JSX')
