import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  AuthFailure,
} from '../server/auth.ts'
import {
  getTraceworkRouteAuthPolicy,
  requireAuthenticatedRequest,
  TRACEWORK_ROUTE_AUTH_POLICIES,
  writeAuthFailure,
} from '../server/routeAuth.ts'

const require = createRequire(import.meta.url)
const serverPackage = require('@supabase/server/package.json')
const supabasePackage = require('@supabase/supabase-js/package.json')
assert.equal(serverPackage.version, '1.4.1')
assert.equal(supabasePackage.version, '2.112.3')

const userA = '00000000-0000-0000-0000-00000000000a'
const userB = '00000000-0000-0000-0000-00000000000b'
const tokenA = 'verified-token-a'

const makeVerifiedDependencies = (overrides = {}) => ({
  verifyAuth: async () => ({
    data: {
      authMode: 'user',
      token: tokenA,
      userClaims: { id: userA },
      jwtClaims: null,
      keyName: null,
    },
    error: null,
  }),
  createContextClient: () => ({
    caller: userA,
    callerScoped: true,
  }),
  ...overrides,
})

const makeVercelResponse = () => {
  const captured = { status: 0, payload: null }
  return {
    captured,
    response: {
      status(statusCode) {
        captured.status = statusCode
        return this
      },
      json(payload) {
        captured.payload = payload
      },
    },
  }
}

const makeViteResponse = () => {
  const captured = { status: 0, payload: null, headers: {} }
  return {
    captured,
    response: {
      statusCode: 0,
      setHeader(name, value) {
        captured.headers[name] = value
      },
      end(body) {
        captured.status = this.statusCode
        captured.payload = JSON.parse(body)
      },
    },
  }
}

const assertSafeFailure = (captured, status, code, secret = tokenA) => {
  assert.equal(captured.status, status)
  assert.deepEqual(captured.payload, {
    error: {
      code,
      message: code === 'missing_auth'
        ? 'Authentication is required.'
        : code === 'malformed_auth'
          ? 'Authentication credentials are malformed.'
          : code === 'auth_configuration'
            ? 'Authentication is temporarily unavailable.'
            : 'Authentication credentials are invalid.',
    },
  })
  assert.equal(JSON.stringify(captured.payload).includes(secret), false)
  assert.equal(JSON.stringify(captured.payload).includes('userClaims'), false)
}

let providerCalls = 0
let mutationWrites = 0
let continuationCalls = 0
const sensitiveContinuation = async (context, request) => {
  continuationCalls += 1
  assert.equal(context.principal.userId, userA)
  assert.equal(context.supabase.callerScoped, true)
  assert.equal(request.body.userId, userB)
  if (request.routeKind === 'provider') providerCalls += 1
  if (request.routeKind === 'mutation') mutationWrites += 1
}

/* Missing and malformed credentials stop before any downstream work. */
for (const [label, request, expectedCode, responseFactory] of [
  ['missing auth', { headers: {} }, 'missing_auth', makeVercelResponse],
  ['wrong scheme', { headers: { authorization: 'Basic not-bearer' } }, 'malformed_auth', makeVercelResponse],
  ['empty bearer', { headers: { authorization: 'Bearer ' } }, 'malformed_auth', makeViteResponse],
  ['duplicate bearer', { headers: { authorization: ['Bearer one', 'Bearer two'] } }, 'malformed_auth', makeVercelResponse],
]) {
  const { response, captured } = responseFactory()
  const ran = await requireAuthenticatedRequest(
    request,
    response,
    async () => {
      continuationCalls += 1
      providerCalls += 1
      mutationWrites += 1
    },
    makeVerifiedDependencies(),
  )
  assert.equal(ran, false, `${label} must stop the route`)
  assertSafeFailure(captured, 401, expectedCode)
}
assert.equal(providerCalls, 0, 'Auth failures must not call a provider')
assert.equal(mutationWrites, 0, 'Auth failures must not write to the database')

/* Invalid credentials and server configuration map to safe errors first. */
for (const [label, dependencies, expectedCode, expectedStatus] of [
  ['invalid auth', makeVerifiedDependencies({ verifyAuth: async () => ({ data: null, error: { status: 401 } }) }), 'invalid_auth', 401],
  ['auth configuration', makeVerifiedDependencies({ verifyAuth: async () => ({ data: null, error: { status: 500 } }) }), 'auth_configuration', 503],
]) {
  const { response, captured } = makeVercelResponse()
  const ran = await requireAuthenticatedRequest(
    { headers: { authorization: `Bearer ${tokenA}` } },
    response,
    async () => {
      providerCalls += 1
      mutationWrites += 1
    },
    dependencies,
  )
  assert.equal(ran, false, `${label} must stop the route`)
  assertSafeFailure(captured, expectedStatus, expectedCode)
}
assert.equal(providerCalls, 0, 'Invalid/config Auth must not call a provider')
assert.equal(mutationWrites, 0, 'Invalid/config Auth must not write to the database')

/* Valid context reaches a mocked downstream provider operation only after Auth. */
const providerResponse = makeVercelResponse()
const providerRan = await requireAuthenticatedRequest(
  {
    headers: { authorization: `Bearer ${tokenA}` },
    routeKind: 'provider',
    body: { userId: userB, ownerId: userB, workspaceId: 'workspace-b' },
  },
  providerResponse.response,
  sensitiveContinuation,
  makeVerifiedDependencies(),
)
assert.equal(providerRan, true)
assert.equal(providerCalls, 1)
assert.equal(continuationCalls, 1)

/* The same gate handles a Vite-style response and mutation continuation. */
const mutationResponse = makeViteResponse()
const mutationRan = await requireAuthenticatedRequest(
  {
    headers: new Headers({ Authorization: `Bearer ${tokenA}` }),
    routeKind: 'mutation',
    body: { userId: userB, ownerId: userB, workspaceId: 'workspace-b' },
  },
  mutationResponse.response,
  sensitiveContinuation,
  makeVerifiedDependencies(),
)
assert.equal(mutationRan, true)
assert.equal(mutationWrites, 1)
assert.equal(mutationResponse.captured.status, 0, 'successful continuation does not write an auth error')

/* The gate propagates the resolver's verified principal, never body identity. */
let receivedContext = null
await requireAuthenticatedRequest(
  {
    headers: { authorization: `Bearer ${tokenA}` },
    body: { userId: userB, ownerId: userB, workspaceId: 'workspace-b' },
  },
  makeVercelResponse().response,
  async (context) => { receivedContext = context },
  makeVerifiedDependencies(),
)
assert.equal(receivedContext.principal.userId, userA)
assert.equal(receivedContext.supabase.caller, userA)

/* Direct serialization remains safe if a caller maps an AuthFailure itself. */
const directResponse = makeViteResponse()
writeAuthFailure(directResponse.response, new AuthFailure('invalid_auth'))
assertSafeFailure(directResponse.captured, 401, 'invalid_auth')
assert.equal(directResponse.captured.headers['Content-Type'], 'application/json')

/*
 * Policy metadata stays well-formed: every route carries a known policy and a
 * reason. The enforced route matrix itself belongs to the cutover phase and is
 * asserted in scripts/test-phase6c4b.mjs rather than duplicated here.
 */
const VALID_POLICIES = new Set(['anonymous', 'authenticated', 'authenticated-authorization-pending'])
for (const [route, definition] of Object.entries(TRACEWORK_ROUTE_AUTH_POLICIES)) {
  assert.equal(VALID_POLICIES.has(definition.policy), true, `${route} needs a known policy`)
  assert.equal(typeof definition.reason === 'string' && definition.reason.length > 0, true, `${route} needs a reason`)
}
assert.equal(Object.keys(TRACEWORK_ROUTE_AUTH_POLICIES).length, 7)
assert.equal(getTraceworkRouteAuthPolicy('/api/not-a-route'), null)

/* The public read/search surface was not part of the cutover. */
for (const route of ['/api/library/collections', '/api/library/documents', '/api/vector/search']) {
  assert.equal(getTraceworkRouteAuthPolicy(route).policy, 'anonymous')
}

/*
 * However a route is gated, it must reach the resolver through
 * server/routeAuth.ts. No adapter or handler may verify a token itself, which
 * is what keeps one authentication implementation across Vercel and Vite.
 */
const routeFiles = [
  'server/traceworkApi.ts',
  'vite.config.ts',
  'api/embed.ts',
  'api/generate.ts',
  'api/library/collections.ts',
  'api/library/documents.ts',
  'api/vector/search.ts',
  'api/vector/sync.ts',
  'api/vector/delete.ts',
]
for (const file of routeFiles) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  assert.equal(source.includes('resolveAuthenticatedRequestContext'), false, `${file} must not verify tokens itself`)
  assert.equal(source.includes('jwtVerify'), false, `${file} must not implement a second verifier`)
}

const routeAuthSource = readFileSync(new URL('../server/routeAuth.ts', import.meta.url), 'utf8')
const authSource = readFileSync(new URL('../server/auth.ts', import.meta.url), 'utf8')
assert.equal(routeAuthSource.includes('resolveAuthenticatedRequestContext'), true)
assert.equal(routeAuthSource.includes('createAdminClient'), false)
assert.equal(authSource.includes('createAdminClient'), false)
assert.equal(authSource.includes('SUPABASE_SERVICE_ROLE_KEY'), false)

console.log('Phase 6C4A gate/readiness tests passed.')
