import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  createAuthSessionController,
  createEmailVerificationPendingState,
  createInitialAuthState,
  createPasswordRecoveryState,
  getCurrentAccessToken,
  isUsableSession,
} from '../src/auth/session.ts'
import { requestWithAuth } from '../src/lib/apiClient.ts'
import {
  getSupabaseBrowserClient,
  readSupabaseBrowserConfig,
} from '../src/lib/supabase.ts'

const require = createRequire(import.meta.url)
const serverPackage = require('@supabase/server/package.json')
const supabasePackage = require('@supabase/supabase-js/package.json')

assert.equal(serverPackage.version, '1.4.1')
assert.equal(supabasePackage.version, '2.112.3')

const server = await import('@supabase/server')
const serverCore = await import('@supabase/server/core')
for (const exportName of ['withSupabase', 'createSupabaseContext']) {
  assert.equal(typeof server[exportName], 'function', `${exportName} must be exported`)
}
for (const exportName of ['verifyAuth', 'verifyCredentials', 'extractCredentials', 'createContextClient', 'createAdminClient']) {
  assert.equal(typeof serverCore[exportName], 'function', `${exportName} must be exported`)
}

const extracted = serverCore.extractCredentials(new Request('https://tracework.invalid/api/test', {
  headers: { Authorization: 'Bearer spike-token', apikey: 'spike-publishable-key' },
}))
assert.deepEqual(extracted, { token: 'spike-token', apikey: 'spike-publishable-key' })
const wrapped = server.withSupabase({ auth: 'user', cors: 'disabled' }, async () => new Response(null, { status: 204 }))
assert.equal(typeof wrapped, 'function')

assert.equal(readSupabaseBrowserConfig({}), null)
assert.equal(readSupabaseBrowserConfig({ VITE_SUPABASE_URL: 'not-a-url', VITE_SUPABASE_PUBLISHABLE_KEY: 'public' }), null)
assert.deepEqual(
  readSupabaseBrowserConfig({
    VITE_SUPABASE_URL: ' https://example.supabase.co/// ',
    VITE_SUPABASE_PUBLISHABLE_KEY: ' public-key ',
  }),
  { url: 'https://example.supabase.co', publishableKey: 'public-key' },
)
assert.equal(getSupabaseBrowserClient(), null, 'Node test runtime must not invent browser Auth configuration')

const makeSession = (accessToken, userId = 'user-1', expiresAt = Math.floor(Date.now() / 1000) + 3600) => ({
  access_token: accessToken,
  refresh_token: 'refresh-token',
  expires_in: 3600,
  expires_at: expiresAt,
  token_type: 'bearer',
  user: {
    id: userId,
    aud: 'authenticated',
    role: 'authenticated',
    email: `${userId}@example.test`,
  },
})

assert.equal(createInitialAuthState().status, 'initializing')
assert.equal(isUsableSession(null), false)
assert.equal(isUsableSession(makeSession('expired'), Math.floor(Date.now() / 1000) + 7200), false)
assert.equal(createEmailVerificationPendingState(makeSession('unused').user).status, 'email-verification-pending')
assert.equal(createPasswordRecoveryState(null).status, 'password-recovery')

let currentSession = makeSession('token-1')
let authCallback = null
let unsubscribeCalled = false
let signOutScope = null
const fakeClient = {
  auth: {
    getSession: async () => ({ data: { session: currentSession }, error: null }),
    onAuthStateChange: (callback) => {
      authCallback = callback
      return { data: { subscription: { unsubscribe: () => { unsubscribeCalled = true } } } }
    },
    signOut: async (options) => {
      signOutScope = options.scope
      authCallback?.('SIGNED_OUT', null)
      return { error: null }
    },
  },
}

const controller = createAuthSessionController(fakeClient)
const observedStates = []
const unsubscribeListener = controller.subscribe((state) => observedStates.push(state.status))
assert.equal(controller.getState().status, 'initializing')
await controller.start()
assert.equal(controller.getState().status, 'signed-in')
assert.equal(controller.getState().user.id, 'user-1')

currentSession = makeSession('token-2', 'user-2')
authCallback('TOKEN_REFRESHED', currentSession)
assert.equal(controller.getState().session.access_token, 'token-2')
assert.equal(await controller.getCurrentAccessToken(), 'token-2')

authCallback('PASSWORD_RECOVERY', currentSession)
assert.equal(controller.getState().status, 'password-recovery')
authCallback('SIGNED_OUT', null)
assert.equal(controller.getState().status, 'signed-out')
await controller.signOut()
assert.equal(signOutScope, 'local')
assert.equal(controller.getState().status, 'signed-out')

unsubscribeListener()
controller.stop()
assert.equal(unsubscribeCalled, true)
const stateBeforeStoppedEvent = controller.getState()
authCallback('TOKEN_REFRESHED', makeSession('ignored'))
assert.equal(controller.getState(), stateBeforeStoppedEvent)
assert.ok(observedStates.includes('initializing'))
assert.ok(observedStates.includes('signed-in'))
assert.ok(observedStates.includes('signed-out'))

const noConfigController = createAuthSessionController(null)
assert.equal(await noConfigController.getCurrentAccessToken(), null)
await noConfigController.start()
assert.equal(noConfigController.getState().status, 'signed-out')

const originalFetch = globalThis.fetch
const capturedRequests = []
globalThis.fetch = async (input, init) => {
  const normalizedInput = typeof input === 'string' && input.startsWith('/')
    ? new URL(input, 'https://tracework.invalid').toString()
    : input
  capturedRequests.push(new Request(normalizedInput, init))
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
}
try {
  await requestWithAuth('/api/protected', { method: 'POST' }, { getAccessToken: async () => 'request-token' })
  assert.equal(capturedRequests.at(-1).headers.get('Authorization'), 'Bearer request-token')
  await requestWithAuth('/api/demo', { method: 'POST' }, {
    anonymous: true,
    getAccessToken: async () => 'must-not-be-used',
  })
  assert.equal(capturedRequests.at(-1).headers.has('Authorization'), false)
} finally {
  globalThis.fetch = originalFetch
}

console.log('Phase 6C2 local compatibility/session tests passed.')
