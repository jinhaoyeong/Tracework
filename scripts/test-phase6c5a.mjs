import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  BrowserAuthError,
  createAuthSessionController,
} from '../src/auth/session.ts'

const require = createRequire(import.meta.url)
const supabasePackage = require('@supabase/supabase-js/package.json')
assert.equal(supabasePackage.version, '2.112.3')

const userA = {
  id: '00000000-0000-0000-0000-00000000000a',
  email: 'a@example.test',
}
const sessionA = {
  access_token: 'phase6c5a-token-a',
  refresh_token: 'phase6c5a-refresh-a',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  token_type: 'bearer',
  user: userA,
}

const makeFakeClient = ({ initialSession = null, signupSession = null } = {}) => {
  let currentSession = initialSession
  let authCallback = null
  let unsubscribeCalls = 0
  const calls = []

  const client = {
    calls,
    get unsubscribeCalls() { return unsubscribeCalls },
    emit(event, session) {
      currentSession = session
      authCallback?.(event, session)
    },
    auth: {
      onAuthStateChange(callback) {
        authCallback = callback
        return {
          data: {
            subscription: {
              unsubscribe() {
                unsubscribeCalls += 1
              },
            },
          },
        }
      },
      async getSession() {
        calls.push({ method: 'getSession' })
        return { data: { session: currentSession }, error: null }
      },
      async signInWithPassword(input) {
        calls.push({ method: 'signInWithPassword', input })
        currentSession = sessionA
        return { data: { session: sessionA, user: userA }, error: null }
      },
      async signUp(input) {
        calls.push({ method: 'signUp', input })
        currentSession = signupSession
        return { data: { session: signupSession, user: userA }, error: null }
      },
      async resetPasswordForEmail(email, options) {
        calls.push({ method: 'resetPasswordForEmail', email, options })
        return { error: null }
      },
      async resend(input) {
        calls.push({ method: 'resend', input })
        return { error: null }
      },
      async updateUser(input) {
        calls.push({ method: 'updateUser', input })
        return { data: { user: userA }, error: null }
      },
      async signOut(input) {
        calls.push({ method: 'signOut', input })
        currentSession = null
        return { error: null }
      },
    },
  }
  return client
}

const originalWindow = globalThis.window
globalThis.window = { location: { origin: 'http://localhost:5173' } }

try {
  /* Missing configuration is an explicit signed-out state, never a fake user. */
  const unconfigured = createAuthSessionController(null)
  assert.equal(unconfigured.getState().status, 'initializing')
  await unconfigured.start()
  assert.equal(unconfigured.getState().status, 'signed-out')
  await assert.rejects(
    () => unconfigured.signIn('a@example.test', 'not-a-real-password'),
    (error) => error instanceof BrowserAuthError && error.code === 'auth_configuration',
  )
  assert.equal(unconfigured.getState().user, null)

  /* A restored session becomes signed-in and exposes only the current SDK token. */
  const restoredClient = makeFakeClient({ initialSession: sessionA })
  const restored = createAuthSessionController(restoredClient)
  const observedStatuses = []
  const unsubscribeObserver = restored.subscribe((state) => observedStatuses.push(state.status))
  await restored.start()
  assert.equal(restored.getState().status, 'signed-in')
  assert.equal(restored.getState().user.id, userA.id)
  assert.equal(await restored.getCurrentAccessToken(), sessionA.access_token)
  assert.deepEqual(observedStatuses.slice(0, 2), ['initializing', 'initializing'])
  assert.equal(observedStatuses.at(-1), 'signed-in')

  /* Password sign-in trims the email and does not accept a client-supplied identity. */
  await restored.signIn('  a@example.test  ', 'not-a-real-password')
  const signInCall = restoredClient.calls.find((call) => call.method === 'signInWithPassword')
  assert.deepEqual(signInCall.input, { email: 'a@example.test', password: 'not-a-real-password' })
  assert.equal(restored.getState().user.id, userA.id)

  /* Events replace the session reference and clear it on sign-out. */
  const refreshedSession = { ...sessionA, access_token: 'phase6c5a-token-refreshed' }
  restoredClient.emit('TOKEN_REFRESHED', refreshedSession)
  assert.equal(await restored.getCurrentAccessToken(), refreshedSession.access_token)
  assert.equal(restored.getState().session.access_token, refreshedSession.access_token)
  restoredClient.emit('SIGNED_OUT', null)
  assert.equal(restored.getState().status, 'signed-out')
  assert.equal(restored.getState().user, null)
  assert.equal(await restored.getCurrentAccessToken(), null)

  /* Sign-up without an immediate session enters email-verification-pending. */
  const signupClient = makeFakeClient()
  const signup = createAuthSessionController(signupClient)
  await signup.start()
  await signup.signUp(' new@example.test ', 'not-a-real-password')
  assert.equal(signup.getState().status, 'email-verification-pending')
  assert.equal(signup.getState().user.email, userA.email)
  const signupCall = signupClient.calls.find((call) => call.method === 'signUp')
  assert.equal(signupCall.input.email, 'new@example.test')
  assert.equal(signupCall.input.options.emailRedirectTo, 'http://localhost:5173/?auth=confirmed')

  await signup.resendConfirmation('new@example.test')
  const resendCall = signupClient.calls.find((call) => call.method === 'resend')
  assert.deepEqual(resendCall.input, {
    type: 'signup',
    email: 'new@example.test',
    options: { emailRedirectTo: 'http://localhost:5173/?auth=confirmed' },
  })

  /* Reset request uses the configured origin and does not reveal account existence. */
  await signup.requestPasswordReset(' reset@example.test ')
  const resetCall = signupClient.calls.find((call) => call.method === 'resetPasswordForEmail')
  assert.equal(resetCall.email, 'reset@example.test')
  assert.deepEqual(resetCall.options, { redirectTo: 'http://localhost:5173/?auth=recovery' })

  /* Recovery state permits password update and returns to a normal session state. */
  signupClient.emit('PASSWORD_RECOVERY', sessionA)
  assert.equal(signup.getState().status, 'password-recovery')
  await signup.updatePassword('new-not-a-real-password')
  const updateCall = signupClient.calls.find((call) => call.method === 'updateUser')
  assert.deepEqual(updateCall.input, { password: 'new-not-a-real-password' })
  assert.equal(signup.getState().status, 'signed-in')

  await signup.signOut()
  assert.equal(signup.getState().status, 'signed-out')
  assert.deepEqual(signupClient.calls.at(-1), { method: 'signOut', input: { scope: 'local' } })

  unsubscribeObserver()
  restored.stop()
  signup.stop()
  assert.equal(restoredClient.unsubscribeCalls, 1)
  assert.equal(signupClient.unsubscribeCalls, 1)

  /* No Auth operation logs credentials or creates an identity/workspace field. */
  const authSources = [
    'src/auth/session.ts',
    'src/auth/AuthProvider.tsx',
    'src/auth/AuthPanel.tsx',
    'src/App.tsx',
  ].map((path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))
  const authSource = authSources.join('\n')
  assert.equal(/SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|OPENAI_API_KEY|sb_secret_|sk-[A-Za-z0-9]{20,}/.test(authSource), false)
  assert.equal(/console\.(log|warn|error)\([^)]*(access_token|refresh_token|Bearer)/i.test(authSource), false)
  assert.equal(/name=["'](?:userId|ownerId|workspaceId)["']/.test(authSource), false)
} finally {
  if (originalWindow === undefined) delete globalThis.window
  else globalThis.window = originalWindow
}

console.log('Phase 6C5A account-flow/session tests passed.')
