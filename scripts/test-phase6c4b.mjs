/**
 * Phase 6C4B — sensitive route authentication cutover.
 *
 * This suite drives the real cutover path (server/routeAuth.ts as used by the
 * api/ entry points and the Vite middleware), not the gate helper in isolation.
 * The verifier is mocked so the whole matrix is deterministic and needs no
 * credential; every provider and database call is counted and asserted to be
 * zero unless a valid principal earned it.
 *
 * The invariant under test: authentication answers WHO, and for the two
 * mutation routes that is explicitly not enough to write to shared state.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  AUTHORIZATION_PENDING_CODE,
  AUTHORIZATION_PENDING_MESSAGE,
  enforceRouteAuthPolicy,
  getTraceworkRouteAuthPolicy,
  TRACEWORK_ROUTE_AUTH_POLICIES,
  withRouteAuth,
} from '../server/routeAuth.ts'
import { handleEmbedding, handleGeneration } from '../server/traceworkApi.ts'

const userA = '00000000-0000-0000-0000-00000000000a'
const userB = '00000000-0000-0000-0000-00000000000b'
const tokenA = 'verified-token-a'

const PROVIDER_ROUTES = ['/api/embed', '/api/generate']
const MUTATION_ROUTES = ['/api/vector/sync', '/api/vector/delete']
const ANONYMOUS_ROUTES = ['/api/library/collections', '/api/library/documents', '/api/vector/search']

/* ---------------------------------------------------------------- helpers */

const verifiedDependencies = (overrides = {}) => ({
  verifyAuth: async () => ({
    data: { authMode: 'user', token: tokenA, userClaims: { id: userA }, jwtClaims: null, keyName: null },
    error: null,
  }),
  createContextClient: () => ({ caller: userA, callerScoped: true }),
  ...overrides,
})

const invalidDependencies = verifiedDependencies({
  verifyAuth: async () => ({ data: null, error: { status: 401 } }),
})
const configFailureDependencies = verifiedDependencies({
  verifyAuth: async () => ({ data: null, error: { status: 500 } }),
})

const makeVercelResponse = () => {
  const captured = { status: 0, payload: null }
  return {
    captured,
    response: {
      status(statusCode) { captured.status = statusCode; return this },
      json(payload) { captured.payload = payload },
    },
  }
}

const makeViteResponse = () => {
  const captured = { status: 0, payload: null, headers: {} }
  return {
    captured,
    response: {
      statusCode: 0,
      setHeader(name, value) { captured.headers[name] = value },
      end(body) { captured.status = this.statusCode; captured.payload = JSON.parse(body) },
    },
  }
}

/** Every credential shape that must never reach a handler. */
const REJECTED_CREDENTIALS = [
  ['missing', { headers: {} }, verifiedDependencies(), 401, 'missing_auth'],
  ['malformed scheme', { headers: { authorization: 'Basic not-bearer' } }, verifiedDependencies(), 401, 'malformed_auth'],
  ['malformed empty', { headers: { authorization: 'Bearer ' } }, verifiedDependencies(), 401, 'malformed_auth'],
  ['duplicate bearer', { headers: { authorization: ['Bearer one', 'Bearer two'] } }, verifiedDependencies(), 401, 'malformed_auth'],
  ['invalid', { headers: { authorization: `Bearer ${tokenA}` } }, invalidDependencies, 401, 'invalid_auth'],
  ['config failure', { headers: { authorization: `Bearer ${tokenA}` } }, configFailureDependencies, 503, 'auth_configuration'],
]

const validRequest = (extra = {}) => ({
  headers: { authorization: `Bearer ${tokenA}` },
  method: 'POST',
  ...extra,
})

/* Counters shared by the whole matrix. */
let handlerEntries = 0
let providerCalls = 0
let databaseCalls = 0

const countingHandler = async () => { handlerEntries += 1 }

/* A fetch that fails loudly: nothing in this suite may reach the network. */
const originalFetch = globalThis.fetch
globalThis.fetch = async (input) => {
  const url = String(input)
  if (url.includes('openai.com')) providerCalls += 1
  else databaseCalls += 1
  throw new Error(`Unexpected outbound request in 6C4B tests: ${url}`)
}

/* ------------------------------------------- 1. the frozen route matrix */

for (const route of PROVIDER_ROUTES) {
  assert.equal(getTraceworkRouteAuthPolicy(route).policy, 'authenticated', `${route} must require auth`)
}
for (const route of MUTATION_ROUTES) {
  assert.equal(
    getTraceworkRouteAuthPolicy(route).policy,
    'authenticated-authorization-pending',
    `${route} must not be labelled simply authenticated/enabled`,
  )
}
for (const route of ANONYMOUS_ROUTES) {
  assert.equal(getTraceworkRouteAuthPolicy(route).policy, 'anonymous', `${route} must stay anonymous`)
}
assert.equal(Object.keys(TRACEWORK_ROUTE_AUTH_POLICIES).length, 7)
/* An unpolicied route fails closed rather than defaulting to public. */
{
  const { response, captured } = makeVercelResponse()
  const outcome = await enforceRouteAuthPolicy('/api/not-a-route', validRequest(), response, verifiedDependencies())
  assert.equal(outcome.allowed, false)
  assert.equal(captured.status, 403)
}

/* ------------------------- 2. rejected credentials, both adapter shapes */

for (const route of [...PROVIDER_ROUTES, ...MUTATION_ROUTES]) {
  for (const [label, request, dependencies, expectedStatus, expectedCode] of REJECTED_CREDENTIALS) {
    for (const [shape, factory] of [['vercel', makeVercelResponse], ['vite', makeViteResponse]]) {
      const { response, captured } = factory()
      await withRouteAuth(route, countingHandler, dependencies)({ ...request, method: 'POST' }, response)

      assert.equal(captured.status, expectedStatus, `${route} ${label} (${shape}) status`)
      assert.equal(captured.payload.error.code, expectedCode, `${route} ${label} (${shape}) code`)
      /* The safe error never carries the credential or verifier internals. */
      const serialized = JSON.stringify(captured.payload)
      assert.equal(serialized.includes(tokenA), false, `${route} ${label} leaked the token`)
      assert.equal(serialized.includes('userClaims'), false, `${route} ${label} leaked claims`)
    }
  }
}
assert.equal(handlerEntries, 0, 'No rejected credential may reach a route handler')
assert.equal(providerCalls, 0, 'No rejected credential may reach a provider')
assert.equal(databaseCalls, 0, 'No rejected credential may reach the database')

/* ------------------ 3. valid auth: providers continue, mutations refuse */

for (const route of PROVIDER_ROUTES) {
  for (const [shape, factory] of [['vercel', makeVercelResponse], ['vite', makeViteResponse]]) {
    handlerEntries = 0
    const { response, captured } = factory()
    await withRouteAuth(route, countingHandler, verifiedDependencies())(validRequest(), response)
    assert.equal(handlerEntries, 1, `${route} (${shape}) must reach its handler once`)
    assert.equal(captured.status, 0, `${route} (${shape}) must not write an auth error`)
  }
}

for (const route of MUTATION_ROUTES) {
  for (const [shape, factory] of [['vercel', makeVercelResponse], ['vite', makeViteResponse]]) {
    handlerEntries = 0
    const { response, captured } = factory()
    await withRouteAuth(route, countingHandler, verifiedDependencies())(validRequest(), response)

    assert.equal(captured.status, 403, `${route} (${shape}) must fail closed for a verified caller`)
    assert.equal(captured.payload.error.code, AUTHORIZATION_PENDING_CODE)
    assert.equal(captured.payload.error.message, AUTHORIZATION_PENDING_MESSAGE)
    assert.equal(handlerEntries, 0, `${route} (${shape}) privileged handler must stay unreachable`)
    /* 403, never 401: the credential was accepted, so "sign in again" is wrong. */
    assert.notEqual(captured.status, 401, `${route} must not tell a valid user to re-authenticate`)
  }
}
assert.equal(providerCalls, 0, 'Mutation refusal must not call a provider')
assert.equal(databaseCalls, 0, 'Mutation refusal must not touch the database')

/* --------------- 4. the real privileged handlers are never even invoked */

for (const [route, handler] of [
  ['/api/vector/sync', async () => { throw new Error('sync handler must be unreachable in 6C4B') }],
  ['/api/vector/delete', async () => { throw new Error('delete handler must be unreachable in 6C4B') }],
]) {
  const { response, captured } = makeVercelResponse()
  await withRouteAuth(route, handler, verifiedDependencies())(
    validRequest({ body: { documents: [], sourceIds: ['anything'] } }),
    response,
  )
  assert.equal(captured.status, 403, `${route} must refuse before the privileged handler`)
}

/* ------------------------------- 5. impersonation cannot move identity */

let observedContext = null
await withRouteAuth('/api/embed', async (request) => {
  observedContext = request.__context
}, verifiedDependencies())(
  validRequest({ body: { userId: userB, ownerId: userB, workspaceId: 'workspace-b' } }),
  makeVercelResponse().response,
)
/* The gate resolves identity from the verified token, never from the body. */
{
  const { response } = makeVercelResponse()
  const outcome = await enforceRouteAuthPolicy(
    '/api/embed',
    validRequest({ body: { userId: userB, ownerId: userB, workspaceId: 'workspace-b' }, query: { userId: userB } }),
    response,
    verifiedDependencies(),
  )
  assert.equal(outcome.allowed, true)
  assert.equal(outcome.context.principal.userId, userA, 'Body identity must never become the principal')
  assert.equal(outcome.context.supabase.caller, userA)
}
/* Impersonation attempts on a mutation route still write nothing. */
for (const route of MUTATION_ROUTES) {
  const { response, captured } = makeVercelResponse()
  handlerEntries = 0
  await withRouteAuth(route, countingHandler, verifiedDependencies())(
    validRequest({ body: { userId: userB, ownerId: userB, sourceIds: ['victim-source'] } }),
    response,
  )
  assert.equal(captured.status, 403)
  assert.equal(handlerEntries, 0)
}
assert.equal(databaseCalls, 0, 'Impersonation attempts must not write')

/* ------------------------------- 6. anonymous routes are still anonymous */

for (const route of ANONYMOUS_ROUTES) {
  const { response, captured } = makeVercelResponse()
  const outcome = await enforceRouteAuthPolicy(route, { headers: {} }, response, verifiedDependencies())
  assert.equal(outcome.allowed, true, `${route} must not require an account`)
  assert.equal(outcome.context, null, `${route} must not manufacture a principal`)
  assert.equal(captured.status, 0, `${route} must not write an auth error`)
}

/* ------- 7. valid auth reaches the real handler, provider mocked exactly once */

{
  let generationCalls = 0
  const fakeFetch = async () => {
    generationCalls += 1
    return {
      ok: true,
      status: 200,
      json: async () => ({ output_text: 'grounded answer [1]', model: 'mock-model', id: 'resp_1', usage: {} }),
    }
  }
  const { response, captured } = makeVercelResponse()
  await withRouteAuth(
    '/api/generate',
    (request, res) => handleGeneration(request, res, { env: { OPENAI_API_KEY: 'test-key' }, fetchImpl: fakeFetch }),
    verifiedDependencies(),
  )(
    validRequest({ body: { question: 'q', context: 'evidence' } }),
    response,
  )
  assert.equal(captured.status, 200, 'A verified caller reaches the real generation handler')
  assert.equal(captured.payload.answer, 'grounded answer [1]')
  assert.equal(generationCalls, 1, 'Exactly one mocked provider call for a valid principal')
}

{
  /* handleEmbedding reads process.env and global fetch, so both are stubbed. */
  let embeddingCalls = 0
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'test-key'
  const stubbed = globalThis.fetch
  globalThis.fetch = async () => {
    embeddingCalls += 1
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ index: 0, embedding: Array.from({ length: 1536 }, () => 0.001) }],
        model: 'text-embedding-3-small',
        usage: {},
      }),
    }
  }
  try {
    const { response, captured } = makeVercelResponse()
    await withRouteAuth('/api/embed', handleEmbedding, verifiedDependencies())(
      validRequest({ body: { input: ['hello'] } }),
      response,
    )
    assert.equal(captured.status, 200, 'A verified caller reaches the real embedding handler')
    assert.equal(embeddingCalls, 1, 'Exactly one mocked provider call for a valid principal')
  } finally {
    globalThis.fetch = stubbed
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  }
}

/* An unauthenticated embed request must not reach the provider even though the
   handler itself would otherwise have a usable key. */
{
  let leaked = 0
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'test-key'
  const stubbed = globalThis.fetch
  globalThis.fetch = async () => { leaked += 1; throw new Error('provider must not be reached') }
  try {
    const { response, captured } = makeVercelResponse()
    await withRouteAuth('/api/embed', handleEmbedding, verifiedDependencies())(
      { method: 'POST', headers: {}, body: { input: ['hello'] } },
      response,
    )
    assert.equal(captured.status, 401)
    assert.equal(leaked, 0, 'Unauthenticated embed must never reach the provider')
  } finally {
    globalThis.fetch = stubbed
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  }
}

/* ------------------------ 8. both adapters are actually wired to the gate */

const readSource = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

for (const [file, route] of [
  ['api/embed.ts', '/api/embed'],
  ['api/generate.ts', '/api/generate'],
  ['api/vector/sync.ts', '/api/vector/sync'],
  ['api/vector/delete.ts', '/api/vector/delete'],
]) {
  const source = readSource(file)
  assert.equal(source.includes('withRouteAuth'), true, `${file} must be cut over`)
  assert.equal(source.includes(`'${route}'`), true, `${file} must gate its own path`)
}

const viteSource = readSource('vite.config.ts')
for (const route of [...PROVIDER_ROUTES, ...MUTATION_ROUTES]) {
  assert.equal(
    viteSource.includes(`enforceRouteAuthPolicy('${route}'`),
    true,
    `vite.config.ts must enforce ${route} through the shared gate`,
  )
}
/* Parity: the dev server must not grow its own verifier. */
assert.equal(viteSource.includes('jwtVerify'), false)
assert.equal(viteSource.includes('createRemoteJWKSet'), false)

/* The read/search routes stay ungated in both adapters. */
for (const route of ANONYMOUS_ROUTES) {
  assert.equal(viteSource.includes(`enforceRouteAuthPolicy('${route}'`), false, `${route} must stay anonymous in dev`)
}
for (const file of ['api/library/collections.ts', 'api/library/documents.ts', 'api/vector/search.ts']) {
  assert.equal(readSource(file).includes('withRouteAuth'), false, `${file} must stay anonymous`)
}

/* ---------------------- 9. the gate never becomes a service-role bypass */

const routeAuthSource = readSource('server/routeAuth.ts')
assert.equal(routeAuthSource.includes('createAdminClient'), false)
assert.equal(routeAuthSource.includes('SUPABASE_SERVICE_ROLE_KEY'), false)
/* No environment variable may switch the mutation boundary off. */
assert.equal(/process\.env/.test(routeAuthSource), false, 'routeAuth must not read an env bypass')

/* -------------------------- 10. client transport does not retry anonymously */

{
  const { AccountRequiredError, requestWithAuth } = await import('../src/lib/apiClient.ts')
  let fetches = 0
  let seenAuthorization = null
  const stubbed = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    fetches += 1
    seenAuthorization = new Headers(init?.headers).get('authorization')
    return { ok: true, status: 200, json: async () => ({}) }
  }
  try {
    const authConfigured = { isAuthConfigured: () => true }

    /* Signed out on a require-account route: refused locally, nothing sent. */
    await assert.rejects(
      () => requestWithAuth('/api/embed', {}, { ...authConfigured, requireAccount: true, getAccessToken: async () => null }),
      (error) => error instanceof AccountRequiredError,
    )
    assert.equal(fetches, 0, 'A signed-out require-account request must not be sent at all')

    /* Signed in: exactly one request, carrying the bearer credential once. */
    await requestWithAuth('/api/embed', {}, { ...authConfigured, requireAccount: true, getAccessToken: async () => 'tok' })
    assert.equal(fetches, 1, 'A failed authenticated request must not be retried')
    assert.equal(seenAuthorization, 'Bearer tok')

    /* An anonymous route still works with no session and sends no credential. */
    await requestWithAuth('/api/vector/search', {}, { ...authConfigured, getAccessToken: async () => null })
    assert.equal(fetches, 2)
    assert.equal(seenAuthorization, null, 'Anonymous routes must not invent a credential')

    /*
     * Where Auth is not configured at all there is no account to demand, so the
     * client must not invent one; the server still refuses. This is what keeps
     * the guard a UX affordance rather than a second enforcement boundary.
     */
    await requestWithAuth('/api/embed', {}, {
      requireAccount: true,
      getAccessToken: async () => null,
      isAuthConfigured: () => false,
    })
    assert.equal(fetches, 3, 'Unconfigured Auth must not block the request client-side')
    assert.equal(seenAuthorization, null)
  } finally {
    globalThis.fetch = stubbed
  }
}

/* ---- 11. authentication runs before method validation on protected routes */

/*
 * Intentional 6C4B behavior change: an unauthenticated GET to a protected route
 * answers 401, where the previously ungated implementation answered 405. Nothing
 * about the request may be revealed before the credential is judged.
 */
for (const route of [...PROVIDER_ROUTES, ...MUTATION_ROUTES]) {
  const { response, captured } = makeVercelResponse()
  await withRouteAuth(route, countingHandler, verifiedDependencies())({ method: 'GET', headers: {} }, response)
  assert.equal(captured.status, 401, `${route} must authenticate before validating the method`)
  assert.equal(captured.payload.error.code, 'missing_auth')
}

/* -------- 12. the dev verifier seam defaults to the real Phase 6C3 resolver */

{
  const viteModule = await import('../vite.config.ts')
  const middlewares = new Map()
  /* Constructed exactly as the production default export does: one argument. */
  viteModule
    .traceworkDevPlugin({})
    .configureServer({ middlewares: { use: (route, handler) => middlewares.set(route, handler) } })

  const callGate = async (route, headers) => {
    const captured = { status: 0, payload: null }
    const response = {
      statusCode: 0,
      setHeader() {},
      end(body) { captured.status = this.statusCode; captured.payload = JSON.parse(body) },
    }
    await middlewares.get(route)({ method: 'POST', headers }, response)
    return captured
  }

  /* No credential: refused, proving no permissive stub is wired in by default. */
  assert.equal((await callGate('/api/embed', {})).payload.error.code, 'missing_auth')

  /*
   * A bogus bearer must NOT be accepted. Under the stub verifier used elsewhere
   * in this suite it would resolve to a principal; under the real resolver it
   * cannot. Anything other than a refusal here would mean the test seam had
   * become the default.
   */
  const bogus = await callGate('/api/embed', { authorization: 'Bearer not.a.real.token' })
  assert.equal([401, 503].includes(bogus.status), true, 'default construction must use the real verifier')
  assert.equal(['invalid_auth', 'auth_configuration'].includes(bogus.payload.error.code), true)
  assert.notEqual(bogus.status, 200)

  /* The seam is a construction-time argument, never selected by a request. */
  const viteSourceText = readSource('vite.config.ts')
  for (const selector of ['request.headers', 'request.query', 'request.body', 'cookie']) {
    assert.equal(
      new RegExp(`authDependencies[^\\n]*${selector.replace('.', '\\.')}`).test(viteSourceText),
      false,
      `authDependencies must not be selectable via ${selector}`,
    )
  }
  assert.equal(viteSourceText.includes('traceworkDevPlugin(env)'), true, 'production default passes no auth override')
}

/* ------- 13. a signed-out configured client sends nothing on either family */

{
  const { requestWithAuth, AccountRequiredError } = await import('../src/lib/apiClient.ts')
  let sent = 0
  const stubbed = globalThis.fetch
  globalThis.fetch = async () => { sent += 1; return { ok: true, status: 200, json: async () => ({}) } }
  try {
    for (const route of [...PROVIDER_ROUTES, ...MUTATION_ROUTES]) {
      await assert.rejects(
        () => requestWithAuth(route, {}, {
          requireAccount: true,
          getAccessToken: async () => null,
          isAuthConfigured: () => true,
        }),
        (error) => error instanceof AccountRequiredError,
        `${route} must not be sent while signed out`,
      )
    }
    assert.equal(sent, 0, 'A signed-out configured client must send zero provider and zero mutation requests')
  } finally {
    globalThis.fetch = stubbed
  }
}

globalThis.fetch = originalFetch
console.log('Phase 6C4B route cutover tests passed.')
