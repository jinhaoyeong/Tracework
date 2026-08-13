import { getCurrentAccessToken } from '../auth/session.ts'
import { isSupabaseAuthConfigured } from './supabase.ts'

/** The client-side code for "this route now needs an account". */
export const ACCOUNT_REQUIRED = 'account_required'
/** The server's fail-closed code for an authenticated caller without authority. */
export const AUTHORIZATION_PENDING = 'authorization_pending'

/**
 * Thrown before the request leaves the browser when a route requires an account
 * and no session exists. This is a UX shortcut only: the server is still the
 * enforcement boundary and answers 401 to anyone who calls it directly.
 */
export class AccountRequiredError extends Error {
  readonly code = ACCOUNT_REQUIRED

  constructor(message = 'Sign in to Tracework to use this feature.') {
    super(message)
    this.name = 'AccountRequiredError'
  }
}

export interface ApiRequestOptions {
  /** Explicitly omit the bearer token for a public/demo request. */
  anonymous?: boolean
  /**
   * Refuse to send the request at all when there is no session. Set on the
   * routes whose policy requires authentication, so a signed-out user gets an
   * account-required state instead of a predictable 401 round trip.
   */
  requireAccount?: boolean
  /** Test-only or adapter override; production reads the SDK session at call time. */
  getAccessToken?: () => Promise<string | null>
  /** Test-only or adapter override; production inspects the built Vite config. */
  isAuthConfigured?: () => boolean
}

export const requestWithAuth = async (
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: ApiRequestOptions = {},
): Promise<Response> => {
  const headers = new Headers(init.headers)
  if (!options.anonymous) {
    const token = await (options.getAccessToken ?? getCurrentAccessToken)()
    if (token) headers.set('Authorization', `Bearer ${token}`)
    else if (options.requireAccount && (options.isAuthConfigured ?? isSupabaseAuthConfigured)()) {
      // Only short-circuit where signing in is actually possible. In a build
      // with no Auth configured there is no account to require, so the request
      // still goes to the server, which is the real enforcement boundary and
      // answers 401 regardless of what this client believes.
      throw new AccountRequiredError()
    }
  }

  // Deliberately no retry. A 401 here must surface as a session problem rather
  // than silently becoming a second, anonymous provider call.
  return fetch(input, { ...init, headers })
}
