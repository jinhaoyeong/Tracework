import assert from 'node:assert/strict'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import {
  AuthFailure,
  extractBearerToken,
  resolveAuthenticatedRequestContext,
  toAuthFailureResponse,
} from '../server/auth.ts'

const require = createRequire(import.meta.url)
const serverPackage = require('@supabase/server/package.json')
const supabasePackage = require('@supabase/supabase-js/package.json')
assert.equal(serverPackage.version, '1.4.1')
assert.equal(supabasePackage.version, '2.112.3')

const serverCore = await import('@supabase/server/core')
for (const exportName of ['verifyAuth', 'createContextClient']) {
  assert.equal(typeof serverCore[exportName], 'function', `${exportName} must be exported`)
}

const makeKeyPair = (kid) => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    privateKey,
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' },
  }
}

const primary = makeKeyPair('phase6c3-primary')
const foreign = makeKeyPair('phase6c3-primary')

const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

const signJwt = (privateKey, claims) => {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'phase6c3-primary' }
  const payload = {
    aud: 'authenticated',
    role: 'authenticated',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  }
  const unsigned = `${base64url(header)}.${base64url(payload)}`
  const signer = createSign('RSA-SHA256')
  signer.update(unsigned)
  signer.end()
  return `${unsigned}.${signer.sign(privateKey).toString('base64url')}`
}

const userA = '00000000-0000-0000-0000-00000000000a'
const userB = '00000000-0000-0000-0000-00000000000b'
const tokenA = signJwt(primary.privateKey, { sub: userA, email: 'a@example.test' })
const tokenB = signJwt(primary.privateKey, { sub: userB, email: 'b@example.test' })
const expiredToken = signJwt(primary.privateKey, {
  sub: userA,
  exp: Math.floor(Date.now() / 1000) - 60,
})
const wrongProjectToken = signJwt(foreign.privateKey, {
  sub: userA,
  iss: 'https://foreign-project.supabase.co',
})

const testEnv = {
  url: 'https://tracework.invalid',
  publishableKeys: { default: 'sb_publishable_phase6c3_test' },
  secretKeys: {},
  jwks: { keys: [primary.jwk] },
}

const requestWithToken = (token, extra = {}) => ({
  headers: { authorization: `Bearer ${token}` },
  ...extra,
})

const expectFailure = async (label, operation, code, status) => {
  let caught = null
  try {
    await operation()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof AuthFailure, `${label} must throw AuthFailure`)
  assert.equal(caught.code, code, `${label} code`)
  assert.equal(caught.status, status, `${label} status`)
  return caught
}

/* Strict extraction happens before the package verifier and never calls it. */
assert.throws(() => extractBearerToken({ headers: {} }), (error) => error instanceof AuthFailure && error.code === 'missing_auth')
assert.throws(() => extractBearerToken({ headers: { authorization: 'Basic not-a-bearer' } }), (error) => error instanceof AuthFailure && error.code === 'malformed_auth')
assert.throws(() => extractBearerToken({ headers: { authorization: 'Bearer' } }), (error) => error instanceof AuthFailure && error.code === 'malformed_auth')
assert.throws(() => extractBearerToken({ headers: { authorization: 'Bearer    ' } }), (error) => error instanceof AuthFailure && error.code === 'malformed_auth')
assert.throws(() => extractBearerToken({ headers: { authorization: 'Bearer has whitespace' } }), (error) => error instanceof AuthFailure && error.code === 'malformed_auth')
assert.throws(() => extractBearerToken({ headers: { authorization: ['Bearer one', 'Bearer two'] } }), (error) => error instanceof AuthFailure && error.code === 'malformed_auth')
assert.throws(() => extractBearerToken({ rawHeaders: ['Authorization', 'Bearer one', 'authorization', 'Bearer two'] }), (error) => error instanceof AuthFailure && error.code === 'malformed_auth')
assert.throws(() => extractBearerToken({ headers: new Headers({ Authorization: 'Bearer one, Bearer two' }) }), (error) => error instanceof AuthFailure && error.code === 'malformed_auth')
assert.equal(extractBearerToken({ headers: new Headers({ Authorization: `Bearer ${tokenA}` }) }), tokenA)

let verifierCalls = 0
let clientFactoryCalls = 0
const parserDependencies = {
  verifyAuth: async () => {
    verifierCalls += 1
    return { data: null, error: { status: 401 } }
  },
  createContextClient: () => {
    clientFactoryCalls += 1
    return {}
  },
}

for (const [label, request, code] of [
  ['missing auth', { headers: {} }, 'missing_auth'],
  ['wrong scheme', { headers: { authorization: 'Basic no' } }, 'malformed_auth'],
  ['empty bearer', { headers: { authorization: 'Bearer ' } }, 'malformed_auth'],
  ['duplicate bearer', { headers: { authorization: ['Bearer one', 'Bearer two'] } }, 'malformed_auth'],
]) {
  const beforeVerifier = verifierCalls
  const beforeClientFactory = clientFactoryCalls
  const error = await expectFailure(label, () => resolveAuthenticatedRequestContext(request, parserDependencies), code, 401)
  assert.equal(verifierCalls, beforeVerifier, `${label} must not verify`)
  assert.equal(clientFactoryCalls, beforeClientFactory, `${label} must not create a client`)
  assert.equal(JSON.stringify(toAuthFailureResponse(error)).includes('Bearer'), false, `${label} must not echo credentials`)
}

/* Real installed verification, using an in-memory JWKS and no network. */
let fetchCalls = 0
const originalFetch = globalThis.fetch
globalThis.fetch = async () => {
  fetchCalls += 1
  throw new Error('Phase 6C3 forbids network access')
}

try {
  const actualA = await resolveAuthenticatedRequestContext(requestWithToken(tokenA), { env: testEnv })
  assert.equal(actualA.principal.userId, userA)
  assert.equal(actualA.principal.accessToken, tokenA)
  assert.equal(actualA.supabase.supabaseKey, testEnv.publishableKeys.default)
  assert.equal(actualA.supabase.rest.headers.get('Authorization'), `Bearer ${tokenA}`)
  assert.equal(actualA.supabase.auth.persistSession, false)

  const actualB = await resolveAuthenticatedRequestContext(requestWithToken(tokenB), { env: testEnv })
  assert.equal(actualB.principal.userId, userB)
  assert.equal(actualB.supabase.rest.headers.get('Authorization'), `Bearer ${tokenB}`)
  assert.notEqual(actualA.supabase, actualB.supabase)

  await expectFailure('expired token', () => resolveAuthenticatedRequestContext(requestWithToken(expiredToken), { env: testEnv }), 'invalid_auth', 401)
  await expectFailure('wrong-project token', () => resolveAuthenticatedRequestContext(requestWithToken(wrongProjectToken), { env: testEnv }), 'invalid_auth', 401)

  const impersonation = await resolveAuthenticatedRequestContext(requestWithToken(tokenA, {
    body: { userId: userB, ownerId: userB, workspaceId: 'workspace-b', memberRole: 'owner' },
    query: { userId: userB },
  }), { env: testEnv })
  assert.equal(impersonation.principal.userId, userA)

  /* Vercel and Vite Node headers, plus a Web Headers adapter, use the same resolver. */
  const vercelContext = await resolveAuthenticatedRequestContext({
    headers: { authorization: [`Bearer ${tokenA}`] },
    rawHeaders: ['Authorization', `Bearer ${tokenA}`],
  }, { env: testEnv })
  const viteContext = await resolveAuthenticatedRequestContext({
    headers: { authorization: `Bearer ${tokenB}` },
  }, { env: testEnv })
  const webContext = await resolveAuthenticatedRequestContext({
    headers: new Headers({ Authorization: `Bearer ${tokenB}` }),
  }, { env: testEnv })
  assert.equal(vercelContext.principal.userId, userA)
  assert.equal(viteContext.principal.userId, userB)
  assert.equal(webContext.principal.userId, userB)

  /* An invalid request after a valid one cannot inherit the prior principal. */
  await expectFailure('invalid request after valid request', () => resolveAuthenticatedRequestContext({ headers: { authorization: 'Bearer definitely-invalid' } }, { env: testEnv }), 'invalid_auth', 401)
  const afterFailure = await resolveAuthenticatedRequestContext(requestWithToken(tokenB), { env: testEnv })
  assert.equal(afterFailure.principal.userId, userB)

  /* Missing publishable-key configuration is a server config failure, not a fake user. */
  await expectFailure('missing caller client configuration', () => resolveAuthenticatedRequestContext(requestWithToken(tokenA), {
    env: { ...testEnv, publishableKeys: {} },
  }), 'auth_configuration', 503)
} finally {
  globalThis.fetch = originalFetch
}

assert.equal(fetchCalls, 0, 'local Auth verification and client construction must not make network calls')

/* Injected verification boundaries prove error handling without credentials in messages/logs. */
const secretMarker = 'Bearer test-bearer-must-not-leak'
const thrownVerifier = async () => {
  throw new Error(`verification failed for ${secretMarker}`)
}
const logCalls = []
const originalConsole = {
  error: console.error,
  warn: console.warn,
  log: console.log,
}
for (const method of Object.keys(originalConsole)) console[method] = (...args) => logCalls.push(args.join(' '))
let thrownError
try {
  thrownError = await expectFailure('verification exception', () => resolveAuthenticatedRequestContext({ headers: { authorization: secretMarker } }, {
    verifyAuth: thrownVerifier,
  }), 'invalid_auth', 401)
} finally {
  console.error = originalConsole.error
  console.warn = originalConsole.warn
  console.log = originalConsole.log
}
const serializedThrownError = JSON.stringify(toAuthFailureResponse(thrownError))
assert.equal(serializedThrownError.includes(secretMarker), false)
assert.equal(thrownError.message.includes(secretMarker), false)
assert.equal(logCalls.some((entry) => entry.includes(secretMarker)), false)

let capturedClientOptions = null
const injectedContext = await resolveAuthenticatedRequestContext({
  headers: { authorization: 'Bearer verified-token-only' },
  body: { userId: userB },
}, {
  verifyAuth: async () => ({
    data: {
      authMode: 'user',
      token: 'verified-token-only',
      userClaims: { id: userA },
      jwtClaims: null,
      keyName: null,
    },
    error: null,
  }),
  createContextClient: (options) => {
    capturedClientOptions = options
    return { injected: true }
  },
})
assert.equal(injectedContext.principal.userId, userA)
assert.equal(capturedClientOptions.auth.token, 'verified-token-only')
assert.equal(capturedClientOptions.auth.keyName, null)
assert.deepEqual(injectedContext.supabase, { injected: true })

/* The resolver must not carry or construct the privileged admin client. */
const resolverSource = readFileSync(new URL('../server/auth.ts', import.meta.url), 'utf8')
assert.equal(/createAdminClient|supabaseAdmin|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY/.test(resolverSource), false)

/* No existing route or adapter was switched to auth in 6C3. */
const routeSources = [
  'server/traceworkApi.ts',
  'vite.config.ts',
  'api/embed.ts',
  'api/generate.ts',
  'api/library/collections.ts',
  'api/library/documents.ts',
  'api/vector/search.ts',
  'api/vector/sync.ts',
  'api/vector/delete.ts',
].map((path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))
assert.equal(routeSources.some((source) => source.includes('resolveAuthenticatedRequestContext')), false)
assert.equal(routeSources.some((source) => source.includes('extractBearerToken')), false)

console.log('Phase 6C3 server principal/resolver tests passed.')
