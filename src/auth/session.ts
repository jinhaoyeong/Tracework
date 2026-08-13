import type {
  AuthChangeEvent,
  Session,
  SupabaseClient,
  User,
} from '@supabase/supabase-js'
import { getSupabaseBrowserClient } from '../lib/supabase.ts'

export type BrowserAuthClient = Pick<SupabaseClient, 'auth'>

export type AuthStatus =
  | 'initializing'
  | 'signed-out'
  | 'signed-in'
  | 'session-expired'
  | 'email-verification-pending'
  | 'password-recovery'
  | 'error'

export interface AuthStateError {
  code: string
  message: string
}

export interface AuthSessionState {
  status: AuthStatus
  session: Session | null
  user: User | null
  error: AuthStateError | null
}

export interface AuthSessionController {
  getState: () => AuthSessionState
  subscribe: (listener: (state: AuthSessionState) => void) => () => void
  start: () => Promise<void>
  stop: () => void
  getCurrentSession: () => Promise<Session | null>
  getCurrentAccessToken: () => Promise<string | null>
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<void>
  requestPasswordReset: (email: string) => Promise<void>
  resendConfirmation: (email: string) => Promise<void>
  updatePassword: (password: string) => Promise<void>
  signOut: () => Promise<void>
}

const currentEpochSeconds = () => Math.floor(Date.now() / 1000)

export const isUsableSession = (
  session: Session | null,
  now = currentEpochSeconds(),
) => Boolean(
  session
  && session.access_token.trim()
  && session.user?.id
  && (session.expires_at === undefined || session.expires_at > now),
)

export const createInitialAuthState = (): AuthSessionState => ({
  status: 'initializing',
  session: null,
  user: null,
  error: null,
})

export const createSignedOutState = (): AuthSessionState => ({
  status: 'signed-out',
  session: null,
  user: null,
  error: null,
})

export const createSessionExpiredState = (error?: AuthStateError): AuthSessionState => ({
  status: 'session-expired',
  session: null,
  user: null,
  error: error ?? null,
})

export const createEmailVerificationPendingState = (user: User): AuthSessionState => ({
  status: 'email-verification-pending',
  session: null,
  user,
  error: null,
})

const createErrorState = (error: AuthStateError): AuthSessionState => ({
  status: 'error',
  session: null,
  user: null,
  error,
})

export const createPasswordRecoveryState = (session: Session | null): AuthSessionState => ({
  status: 'password-recovery',
  session,
  user: session?.user ?? null,
  error: null,
})

export const stateFromSession = (session: Session | null): AuthSessionState => {
  if (!session) return createSignedOutState()
  if (!isUsableSession(session)) return createSessionExpiredState()
  return {
    status: 'signed-in',
    session,
    user: session.user,
    error: null,
  }
}

export const reduceAuthEvent = (
  previous: AuthSessionState,
  event: AuthChangeEvent,
  session: Session | null,
): AuthSessionState => {
  switch (event) {
    case 'SIGNED_OUT':
      return createSignedOutState()
    case 'PASSWORD_RECOVERY':
      return createPasswordRecoveryState(session)
    case 'TOKEN_REFRESHED':
      return session ? stateFromSession(session) : createSessionExpiredState()
    case 'INITIAL_SESSION':
    case 'SIGNED_IN':
    case 'USER_UPDATED':
    case 'MFA_CHALLENGE_VERIFIED':
      return session ? stateFromSession(session) : previous.status === 'initializing'
        ? createSignedOutState()
        : previous
    default:
      return previous
  }
}

const toAuthStateError = (error: unknown): AuthStateError => {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown }
    return {
      code: typeof candidate.code === 'string' && candidate.code ? candidate.code : 'auth_error',
      message: typeof candidate.message === 'string' && candidate.message ? candidate.message : 'The Auth session could not be resolved.',
    }
  }
  return { code: 'auth_error', message: 'The Auth session could not be resolved.' }
}

export class BrowserAuthError extends Error {
  code: string

  constructor(error: AuthStateError) {
    super(error.message)
    this.name = 'BrowserAuthError'
    this.code = error.code
  }
}

const getAuthRedirectUrl = (path: string): string | undefined => {
  if (typeof window === 'undefined' || !window.location.origin) return undefined
  return new URL(path, window.location.origin).toString()
}

const requireAuthClient = (client: BrowserAuthClient | null): BrowserAuthClient => {
  if (client) return client
  throw new BrowserAuthError({
    code: 'auth_configuration',
    message: 'Account sign-in is not configured in this environment.',
  })
}

export const signInWithPassword = async (
  email: string,
  password: string,
  client: BrowserAuthClient | null = getSupabaseBrowserClient(),
): Promise<Session | null> => {
  const authClient = requireAuthClient(client)
  const { data, error } = await authClient.auth.signInWithPassword({
    email: email.trim(),
    password,
  })
  if (error) throw new BrowserAuthError(toAuthStateError(error))
  return data.session
}

export const signUpWithPassword = async (
  email: string,
  password: string,
  client: BrowserAuthClient | null = getSupabaseBrowserClient(),
): Promise<{ session: Session | null; user: User | null }> => {
  const authClient = requireAuthClient(client)
  const { data, error } = await authClient.auth.signUp({
    email: email.trim(),
    password,
    options: {
      emailRedirectTo: getAuthRedirectUrl('/?auth=confirmed'),
    },
  })
  if (error) throw new BrowserAuthError(toAuthStateError(error))
  return { session: data.session, user: data.user }
}

export const requestPasswordReset = async (
  email: string,
  client: BrowserAuthClient | null = getSupabaseBrowserClient(),
): Promise<void> => {
  const authClient = requireAuthClient(client)
  const { error } = await authClient.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: getAuthRedirectUrl('/?auth=recovery'),
  })
  if (error) throw new BrowserAuthError(toAuthStateError(error))
}

export const resendSignupConfirmation = async (
  email: string,
  client: BrowserAuthClient | null = getSupabaseBrowserClient(),
): Promise<void> => {
  const authClient = requireAuthClient(client)
  const { error } = await authClient.auth.resend({
    type: 'signup',
    email: email.trim(),
    options: {
      emailRedirectTo: getAuthRedirectUrl('/?auth=confirmed'),
    },
  })
  if (error) throw new BrowserAuthError(toAuthStateError(error))
}

export const updatePassword = async (
  password: string,
  client: BrowserAuthClient | null = getSupabaseBrowserClient(),
): Promise<void> => {
  const authClient = requireAuthClient(client)
  const { error } = await authClient.auth.updateUser({ password })
  if (error) throw new BrowserAuthError(toAuthStateError(error))
}

export const getCurrentSession = async (
  client: BrowserAuthClient | null = getSupabaseBrowserClient(),
): Promise<Session | null> => {
  if (!client) return null
  const { data, error } = await client.auth.getSession()
  if (error) throw new BrowserAuthError(toAuthStateError(error))
  return isUsableSession(data.session) ? data.session : null
}

export const getCurrentAccessToken = async (
  client: BrowserAuthClient | null = getSupabaseBrowserClient(),
): Promise<string | null> => {
  const session = await getCurrentSession(client)
  return session?.access_token ?? null
}

export const signOut = async (
  client: BrowserAuthClient | null = getSupabaseBrowserClient(),
): Promise<void> => {
  if (!client) return
  const { error } = await client.auth.signOut({ scope: 'local' })
  if (error) throw new BrowserAuthError(toAuthStateError(error))
}

export const createAuthSessionController = (
  client: BrowserAuthClient | null,
): AuthSessionController => {
  let state = createInitialAuthState()
  let running = false
  let unsubscribe: (() => void) | null = null
  const listeners = new Set<(nextState: AuthSessionState) => void>()

  const publish = (nextState: AuthSessionState) => {
    state = nextState
    for (const listener of listeners) listener(state)
  }

  const subscribe = (listener: (nextState: AuthSessionState) => void) => {
    listeners.add(listener)
    listener(state)
    return () => listeners.delete(listener)
  }

  const stop = () => {
    running = false
    unsubscribe?.()
    unsubscribe = null
  }

  const start = async () => {
    if (running) return
    running = true
    publish(createInitialAuthState())

    if (!client) {
      publish(createSignedOutState())
      return
    }

    const subscription = client.auth.onAuthStateChange((event, session) => {
      if (!running) return
      publish(reduceAuthEvent(state, event, session))
    })
    unsubscribe = () => subscription.data.subscription.unsubscribe()

    try {
      const { data, error } = await client.auth.getSession()
      if (!running) return
      if (error) {
        const authError = toAuthStateError(error)
        publish(createErrorState(authError))
        return
      }
      publish(stateFromSession(data.session))
    } catch (error) {
      if (running) publish(createErrorState(toAuthStateError(error)))
    }
  }

  const currentSession = () => getCurrentSession(client)
  const currentAccessToken = () => getCurrentAccessToken(client)
  const localSignIn = async (email: string, password: string) => {
    const session = await signInWithPassword(email, password, client)
    if (running) publish(stateFromSession(session))
  }
  const localSignUp = async (email: string, password: string) => {
    const result = await signUpWithPassword(email, password, client)
    if (!running) return
    if (result.session) {
      publish(stateFromSession(result.session))
    } else if (result.user) {
      publish(createEmailVerificationPendingState(result.user))
    } else {
      publish(createSignedOutState())
    }
  }
  const localRequestPasswordReset = (email: string) => requestPasswordReset(email, client)
  const localResendConfirmation = (email: string) => resendSignupConfirmation(email, client)
  const localUpdatePassword = async (password: string) => {
    await updatePassword(password, client)
    if (running && state.status === 'password-recovery') publish(stateFromSession(state.session))
  }
  const localSignOut = async () => {
    await signOut(client)
    if (running) publish(createSignedOutState())
  }

  return {
    getState: () => state,
    subscribe,
    start,
    stop,
    getCurrentSession: currentSession,
    getCurrentAccessToken: currentAccessToken,
    signIn: localSignIn,
    signUp: localSignUp,
    requestPasswordReset: localRequestPasswordReset,
    resendConfirmation: localResendConfirmation,
    updatePassword: localUpdatePassword,
    signOut: localSignOut,
  }
}

export const createBrowserAuthSessionController = () => (
  createAuthSessionController(getSupabaseBrowserClient())
)
