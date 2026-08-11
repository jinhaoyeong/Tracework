/**
 * Phase 5E Step 10C — the /api/generate route itself, offline only.
 *
 * Step 10B left one gap: the Vite dev middleware duplicated the deployed
 * handler's rules and could only be exercised by starting Vite against a real
 * key. That duplicate is gone. vite.config.ts is now a thin adapter over the
 * same `handleGeneration` the deployed function uses, and this suite drives
 * BOTH entry points:
 *
 *   deployed  handleGeneration(request, response, { env, fetchImpl })
 *   dev       the real middleware, pulled out of the real vite config
 *
 * No real credential and no network are involved. The upstream provider is a
 * counted stub, and any request to an unexpected host fails the suite. The dev
 * middleware closes over Vite's own loadEnv result, so whatever key is on this
 * machine is handed to the stub and never inspected, logged, or transmitted.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { handleGeneration } from '../server/traceworkApi.ts'
import * as serverApi from '../server/traceworkApi.ts'
import {
  FOCUSED_CONTEXT_CHARACTER_LIMIT,
  SERVER_GENERATION_CONTEXT_LIMIT,
  SYNTHESIS_CONTEXT_CHARACTER_LIMIT,
} from '../src/lib/generationContract.ts'

/* ------------------------------------------------------------ upstream stub */

const upstream = { calls: [], reply: () => ({ output_text: 'Answer [1].', model: 'stub-model', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }) }

const stubFetch = async (url, init) => {
  const target = String(url)
  if (!target.startsWith('https://api.openai.com/')) {
    throw new Error(`Phase 5E Step 10C forbids requests to ${target}`)
  }
  // The request body is recorded; the Authorization header deliberately is not.
  upstream.calls.push(JSON.parse(init.body))
  const payload = upstream.reply()
  return { ok: true, status: 200, json: async () => payload }
}

const FAKE_ENV = { OPENAI_API_KEY: 'test-key-not-a-real-credential' }

const callDeployed = async (body, env = FAKE_ENV, method = 'POST') => {
  const captured = { status: 0, payload: null }
  await handleGeneration({ method, body }, {
    status(code) { captured.status = code; return this },
    json(payload) { captured.payload = payload },
  }, { env, fetchImpl: stubFetch })
  return captured
}

/* ------------------------------------ pull the real middleware out of vite */

const viteConfigFactory = (await import('../vite.config.ts')).default
const viteConfig = await viteConfigFactory({ mode: 'development', command: 'serve' })
const plugin = viteConfig.plugins.flat().find((item) => item?.name === 'tracework-neural-embeddings')
assert.ok(plugin, 'the dev plugin must be present in the real vite config')

const middlewares = new Map()
plugin.configureServer({ middlewares: { use: (route, handler) => middlewares.set(route, handler) } })
const generateMiddleware = middlewares.get('/api/generate')
assert.ok(generateMiddleware, 'the dev config must register an /api/generate middleware')

const callDev = async (rawBody, method = 'POST') => {
  const request = new EventEmitter()
  request.method = method
  request[Symbol.asyncIterator] = async function* () {
    if (rawBody !== undefined) yield Buffer.from(rawBody)
  }
  const captured = { status: 0, payload: null, headers: {} }
  const response = {
    set statusCode(value) { captured.status = value },
    get statusCode() { return captured.status },
    setHeader(name, value) { captured.headers[name] = value },
    end(text) { captured.payload = JSON.parse(text) },
  }
  await generateMiddleware(request, response)
  return captured
}

/**
 * The dev route reaches the provider through the ambient global, so the stub is
 * installed globally for its duration. This is also what guarantees the local
 * .env.local key cannot leave the process.
 */
const realFetch = globalThis.fetch
globalThis.fetch = stubFetch

/* --------------------------------------------- the frozen route behaviours */

const cases = [
  {
    name: 'focused at the limit is accepted',
    body: () => ({ question: 'What did Standard cost?', context: 'x'.repeat(FOCUSED_CONTEXT_CHARACTER_LIMIT) }),
    status: 200,
    provider: 1,
  },
  {
    name: 'focused over the limit is refused before the provider',
    body: () => ({ mode: 'focused', question: 'Q', context: 'x'.repeat(FOCUSED_CONTEXT_CHARACTER_LIMIT + 1) }),
    status: 400,
    code: 'context_too_large',
    provider: 0,
  },
  {
    name: 'synthesis at the limit is accepted',
    body: () => ({ mode: 'synthesis', question: 'Summarise Meridian.', context: 'x'.repeat(SYNTHESIS_CONTEXT_CHARACTER_LIMIT) }),
    status: 200,
    provider: 1,
  },
  {
    name: 'synthesis over the limit is refused before the provider',
    body: () => ({ mode: 'synthesis', question: 'Q', context: 'x'.repeat(SYNTHESIS_CONTEXT_CHARACTER_LIMIT + 1) }),
    status: 400,
    code: 'context_too_large',
    provider: 0,
  },
  {
    name: 'an absent mode keeps focused behaviour',
    body: () => ({ question: 'Q', context: 'x'.repeat(FOCUSED_CONTEXT_CHARACTER_LIMIT + 1) }),
    status: 400,
    code: 'context_too_large',
    provider: 0,
  },
  {
    name: 'an unknown mode is refused before the provider',
    body: () => ({ mode: 'broad', question: 'Q', context: 'evidence' }),
    status: 400,
    code: 'invalid_mode',
    provider: 0,
  },
  {
    name: 'an empty question is refused before the provider',
    body: () => ({ mode: 'synthesis', question: '   ', context: 'evidence' }),
    status: 400,
    code: 'invalid_question',
    provider: 0,
  },
  {
    name: 'an empty context is refused before the provider',
    body: () => ({ mode: 'synthesis', question: 'Q', context: '' }),
    status: 400,
    code: 'invalid_context',
    provider: 0,
  },
]

const rows = []
for (const testCase of cases) {
  for (const entry of ['deployed', 'dev']) {
    const before = upstream.calls.length
    const body = testCase.body()
    const result = entry === 'deployed' ? await callDeployed(body) : await callDev(JSON.stringify(body))
    const providerCalls = upstream.calls.length - before

    assert.equal(result.status, testCase.status, `${entry} / ${testCase.name}: ${JSON.stringify(result.payload)}`)
    assert.equal(providerCalls, testCase.provider, `${entry} / ${testCase.name}: provider invoked ${providerCalls} times`)
    if (testCase.code) assert.equal(result.payload.error.code, testCase.code, `${entry} / ${testCase.name}`)
    if (testCase.status === 200) assert.equal(result.payload.answer, 'Answer [1].')
    rows.push({ entry, name: testCase.name, status: result.status, providerCalls })
  }
}

/* ------------------------- the two entry points agree on every behaviour */

for (const testCase of cases) {
  const deployed = rows.find((row) => row.entry === 'deployed' && row.name === testCase.name)
  const dev = rows.find((row) => row.entry === 'dev' && row.name === testCase.name)
  assert.equal(dev.status, deployed.status, `dev and deployed disagree on status for: ${testCase.name}`)
  assert.equal(dev.providerCalls, deployed.providerCalls, `dev and deployed disagree on provider calls for: ${testCase.name}`)
}

/* -------------------------------------------------- mode-specific framing */

upstream.calls.length = 0
await callDeployed({ mode: 'focused', question: 'Q', context: 'evidence' })
await callDeployed({ mode: 'synthesis', question: 'Q', context: 'evidence' })
const [focusedRequest, synthesisRequest] = upstream.calls
assert.match(focusedRequest.instructions, /grounded answer writer/)
assert.match(synthesisRequest.instructions, /validated evidence packet/)
assert.notEqual(focusedRequest.instructions, synthesisRequest.instructions)
assert.match(focusedRequest.instructions, /I could not find enough evidence/)
assert.match(synthesisRequest.instructions, /I could not find enough evidence/)
assert.match(synthesisRequest.instructions, /never present a claim|Never present a claim/)
assert.equal(focusedRequest.max_output_tokens, 700)
assert.equal(synthesisRequest.max_output_tokens, 1400)
assert.equal(focusedRequest.store, false)
assert.equal(synthesisRequest.store, false)

/* --------------------------------------------- adapter-level route behaviour */

const wrongMethod = await callDev(undefined, 'GET')
assert.equal(wrongMethod.status, 405)
assert.equal(wrongMethod.payload.error.code, 'method_not_allowed')

const malformed = await callDev('{ not json')
assert.equal(malformed.status, 400)
assert.equal(malformed.payload.error.code, 'invalid_request_body')

const deployedWrongMethod = await callDeployed(undefined, FAKE_ENV, 'GET')
assert.equal(deployedWrongMethod.status, 405)

const missingKey = await callDeployed({ mode: 'synthesis', question: 'Q', context: 'evidence' }, {})
assert.equal(missingKey.status, 503)
assert.equal(missingKey.payload.error.code, 'missing_generation_api_key')

/* ---------------------------------------- upstream failures stay distinguishable */

upstream.calls.length = 0
upstream.reply = () => ({ output_text: '' })
const emptyUpstream = await callDeployed({ mode: 'synthesis', question: 'Q', context: 'evidence' })
assert.equal(emptyUpstream.status, 502)
assert.equal(emptyUpstream.payload.error.code, 'malformed_response')
upstream.reply = () => ({ output_text: 'Answer [1].', model: 'stub-model' })

/* ------------------------------------------------- limit binding regression */

assert.equal(serverApi.SERVER_GENERATION_CONTEXT_LIMIT, SERVER_GENERATION_CONTEXT_LIMIT)
assert.ok(SERVER_GENERATION_CONTEXT_LIMIT >= SYNTHESIS_CONTEXT_CHARACTER_LIMIT)
assert.ok(FOCUSED_CONTEXT_CHARACTER_LIMIT < SYNTHESIS_CONTEXT_CHARACTER_LIMIT)

globalThis.fetch = realFetch

console.log(JSON.stringify({
  entryPoints: ['deployed handleGeneration', 'vite dev middleware (real config)'],
  sharedImplementation: true,
  cases: cases.map((testCase) => ({
    name: testCase.name,
    deployed: rows.find((row) => row.entry === 'deployed' && row.name === testCase.name),
    dev: rows.find((row) => row.entry === 'dev' && row.name === testCase.name),
  })).map((row) => ({ name: row.name, status: row.deployed.status, providerCalls: row.deployed.providerCalls, devAgrees: row.dev.status === row.deployed.status && row.dev.providerCalls === row.deployed.providerCalls })),
  limits: {
    focused: FOCUSED_CONTEXT_CHARACTER_LIMIT,
    synthesis: SYNTHESIS_CONTEXT_CHARACTER_LIMIT,
    ceiling: SERVER_GENERATION_CONTEXT_LIMIT,
  },
  stubbedUpstreamCalls: upstream.calls.length,
  liveProviderCalls: 0,
}, null, 2))
console.log('Phase 5E Step 10C generation-route tests passed / dev and deployed share one implementation and agree on every guard, with no real credential or network')
