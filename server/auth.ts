import { createContextClient, verifyAuth } from '@supabase/server/core'
import type { SupabaseEnv } from '@supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The small request shape shared by the Vercel Node adapter, Vite middleware,
 * and the local resolver tests. Node's IncomingHttpHeaders use the same value
 * shapes, while a Web Headers instance is accepted for adapter parity.
 */
export type IncomingHeaderValue = string | readonly string[] | undefined
export type TraceworkHeaders = Headers | Readonly<Record<string, IncomingHeaderValue>>

export interface TraceworkAuthRequestLike {
  headers?: TraceworkHeaders
  /** Node's raw header pairs preserve duplicate values when available. */
  rawHeaders?: readonly string[]
}

export interface AuthenticatedPrincipal {
  readonly userId: string
  readonly accessToken: string
}

export interface AuthenticatedRequestContext {
  readonly principal: AuthenticatedPrincipal
  readonly supabase: SupabaseClient<unknown>
}

export type AuthFailureCode =
  | 'missing_auth'
  | 'malformed_auth'
  | 'invalid_auth'
  | 'auth_configuration'

const AUTH_FAILURES: Record<AuthFailureCode, { status: number; message: string }> = {
  missing_auth: { status: 401, message: 'Authentication is required.' },
  malformed_auth: { status: 401, message: 'Authentication credentials are malformed.' },
  invalid_auth: { status: 401, message: 'Authentication credentials are invalid.' },
  auth_configuration: { status: 503, message: 'Authentication is temporarily unavailable.' },
}

/** Public, credential-free error for an authentication boundary. */
export class AuthFailure extends Error {
  readonly code: AuthFailureCode
  readonly status: number

  constructor(code: AuthFailureCode) {
    super(AUTH_FAILURES[code].message)
    this.name = 'AuthFailure'
    this.code = code
    this.status = AUTH_FAILURES[code].status
  }
}

export const toAuthFailureResponse = (failure: AuthFailure) => ({
  status: failure.status,
  payload: {
    error: {
      code: failure.code,
      message: failure.message,
    },
  },
})

const failure = (code: AuthFailureCode): AuthFailure => new AuthFailure(code)

const isWebHeaders = (headers: TraceworkHeaders): headers is Headers => (
  typeof (headers as Headers).get === 'function'
)

const valuesFromHeaderValue = (value: IncomingHeaderValue): string[] => {
  if (value === undefined) return []
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return typeof value === 'string' ? [value] : []
}

const authorizationValues = (request: TraceworkAuthRequestLike): string[] => {
  const rawHeaders = request.rawHeaders
  if (rawHeaders && rawHeaders.length > 0) {
    const values: string[] = []
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
      if (rawHeaders[index].toLowerCase() === 'authorization') values.push(rawHeaders[index + 1])
    }
    return values
  }

  const headers = request.headers
  if (!headers) return []
  if (isWebHeaders(headers)) {
    const value = headers.get('authorization')
    return value === null ? [] : [value]
  }

  return Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === 'authorization')
    .flatMap(([, value]) => valuesFromHeaderValue(value))
}

/**
 * Strictly extracts one bearer credential without decoding or trusting it.
 * Supabase's verifier remains the source of truth for whether the token is
 * valid and which user it represents.
 */
export const extractBearerToken = (request: TraceworkAuthRequestLike): string => {
  const values = authorizationValues(request)
  if (values.length === 0) throw failure('missing_auth')
  if (values.length !== 1) throw failure('malformed_auth')

  const header = values[0].trim()
  const match = /^Bearer ([^\s]+)$/.exec(header)
  if (!match) throw failure('malformed_auth')
  return match[1]
}

const makeVerificationRequest = (token: string): Request => new Request('https://tracework.invalid/api/_auth', {
  headers: { Authorization: `Bearer ${token}` },
})

export interface AuthResolverDependencies {
  /** Injectable for deterministic local tests; production uses the pinned package. */
  verifyAuth?: typeof verifyAuth
  /** Injectable for deterministic local tests; production uses the pinned package. */
  createContextClient?: typeof createContextClient
  /** Package-native server environment overrides, primarily for tests. */
  env?: Partial<SupabaseEnv>
}

/**
 * Resolves one request into one verified principal and one caller-scoped
 * Supabase client. This function is intentionally not called by a production
 * route until Phase 6C4 chooses the first auth gates.
 */
export const resolveAuthenticatedRequestContext = async (
  request: TraceworkAuthRequestLike,
  dependencies: AuthResolverDependencies = {},
): Promise<AuthenticatedRequestContext> => {
  const token = extractBearerToken(request)
  const verifier = dependencies.verifyAuth ?? verifyAuth
  const contextClientFactory = dependencies.createContextClient ?? createContextClient
  const verificationRequest = makeVerificationRequest(token)
  const verifyOptions = dependencies.env === undefined
    ? { auth: 'user' as const }
    : { auth: 'user' as const, env: dependencies.env }

  let verified
  try {
    verified = await verifier(verificationRequest, verifyOptions)
  } catch {
    // Do not leak a verifier exception or its cause, which could contain the
    // bearer credential or remote JWKS details.
    throw failure('invalid_auth')
  }

  if (verified.error) {
    if (verified.error.status === 401) throw failure('invalid_auth')
    throw failure('auth_configuration')
  }

  const userId = verified.data.userClaims?.id
  const verifiedToken = verified.data.token
  if (verified.data.authMode !== 'user' || !userId || !verifiedToken) {
    throw failure('invalid_auth')
  }

  try {
    const clientOptions = dependencies.env === undefined
      ? { auth: { token: verifiedToken, keyName: verified.data.keyName } }
      : { auth: { token: verifiedToken, keyName: verified.data.keyName }, env: dependencies.env }
    const supabase = contextClientFactory(clientOptions)
    return {
      principal: { userId, accessToken: verifiedToken },
      supabase,
    }
  } catch {
    // createContextClient throws only for server configuration/client setup;
    // the public response must remain generic and credential-free.
    throw failure('auth_configuration')
  }
}
