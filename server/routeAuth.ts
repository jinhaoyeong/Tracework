/**
 * Tracework server authentication - principal verification, route policy, and
 * response mapping in one deployable module.
 *
 * DEPLOYMENT CONSTRAINT (learned the hard way in commit ba4cb37):
 * Vercel transpiles each server .ts file to .js individually and leaves relative
 * import specifiers verbatim. A "./auth.ts" specifier therefore survives into
 * the emitted routeAuth.js and fails at runtime with ERR_MODULE_NOT_FOUND,
 * taking the whole function down before the handler is ever reached. Local
 * suites missed it because Node type stripping resolves .ts specifiers happily.
 *
 * This module is imported by the deployed api/ entry points, so it must contain
 * NO relative imports at all. Package specifiers are fine; a relative one is not.
 * scripts/test-phase6c4b-artifact.mjs enforces that against the built output.
 *
 * The three concerns stay logically separated by section below, even though
 * they now share one physical file:
 *   1. principal verification
 *   2. route policy
 *   3. response mapping and the route gate
 */
import { createContextClient, verifyAuth } from '@supabase/server/core'
import type { SupabaseEnv } from '@supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'

/* ---------------------------------------------------------------------- */
/* 1. Principal verification                                              */
/* ---------------------------------------------------------------------- */

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

/**
 * Phase 6D4A: resolve a principal only when the request presents one.
 *
 * The library routes stay anonymous. A request with no Authorization header is
 * not a failure - it is the ordinary public read, and it must behave exactly as
 * it did before 6D4A - so `missing_auth` maps to null rather than to a 401.
 *
 * Every other failure still throws. A malformed or expired credential must not
 * silently fall back to the anonymous service_role path, because that would hand
 * a signed-in caller a wider-privileged execution path precisely when their own
 * one failed.
 *
 * Verification is delegated rather than reimplemented, so there is still exactly
 * one verifier. The caller-scoped client it builds is unused by the 6D4A library
 * composition, which reads PostgREST directly with the verified token; keeping
 * the shared resolver is worth more than skipping that construction.
 */
export const resolveOptionalPrincipal = async (
  request: TraceworkAuthRequestLike,
  dependencies: AuthResolverDependencies = {},
): Promise<AuthenticatedPrincipal | null> => {
  try {
    extractBearerToken(request)
  } catch (error) {
    if (error instanceof AuthFailure && error.code === 'missing_auth') return null
    throw error
  }

  const context = await resolveAuthenticatedRequestContext(request, dependencies)
  return context.principal
}

/* ---------------------------------------------------------------------- */
/* 2. Route policy, response mapping, and the shared route gate           */
/* ---------------------------------------------------------------------- */

/**
 * Authentication answers WHO is calling. It does not answer WHICH shared
 * resource that caller may change, so a verified principal is not by itself a
 * licence to mutate. The third policy exists to keep those two questions
 * separate in the type system: a route can require a verified identity and
 * still refuse the operation because resource authorization does not exist yet.
 */
export type RouteAuthPolicy =
  /** No credential required; the handler runs for anyone. */
  | 'anonymous'
  /** A verified principal is required, and is sufficient to run the handler. */
  | 'authenticated'
  /**
   * A verified principal is required and is explicitly NOT sufficient. The
   * request fails closed with 403 before the handler runs. Phase 6D replaces
   * this with real ownership/workspace authorization.
   */
  | 'authenticated-authorization-pending'

export interface RouteAuthPolicyDefinition {
  /** Behavior actually enforced by the adapters in the current deployment. */
  readonly policy: RouteAuthPolicy
  readonly reason: 'public-read-compatibility' | 'provider-cost' | 'shared-state-mutation'
}

/**
 * The enforced route matrix. Both the Vercel entry points and the Vite dev
 * middleware read this same table through enforceRouteAuthPolicy, so there is
 * one policy and one authentication implementation rather than one per runtime.
 */
export const TRACEWORK_ROUTE_AUTH_POLICIES = {
  '/api/library/collections': {
    policy: 'anonymous',
    reason: 'public-read-compatibility',
  },
  '/api/library/documents': {
    policy: 'anonymous',
    reason: 'public-read-compatibility',
  },
  '/api/vector/search': {
    policy: 'anonymous',
    reason: 'public-read-compatibility',
  },
  // Writes to shared knowledge stay closed to every caller: authentication is
  // live, resource authorization is not, and service-role mutation on behalf of
  // "any signed-in user" would be authorization theatre.
  '/api/vector/sync': {
    policy: 'authenticated-authorization-pending',
    reason: 'shared-state-mutation',
  },
  '/api/vector/delete': {
    policy: 'authenticated-authorization-pending',
    reason: 'shared-state-mutation',
  },
  // Authentication is the spend boundary here: the caller's identity is all
  // that is needed to justify a metered provider call.
  '/api/embed': {
    policy: 'authenticated',
    reason: 'provider-cost',
  },
  '/api/generate': {
    policy: 'authenticated',
    reason: 'provider-cost',
  },
} as const satisfies Record<string, RouteAuthPolicyDefinition>

export type TraceworkRoutePath = keyof typeof TRACEWORK_ROUTE_AUTH_POLICIES

export const getTraceworkRouteAuthPolicy = (path: string): RouteAuthPolicyDefinition | null => (
  TRACEWORK_ROUTE_AUTH_POLICIES[path as TraceworkRoutePath] ?? null
)

export interface AuthGateResponseLike {
  status?: (statusCode: number) => AuthGateResponseLike
  json?: (payload: unknown) => void
  statusCode?: number
  setHeader?: (name: string, value: string) => void
  end?: (body?: string) => void
}

export type AuthenticatedRouteContinuation = (
  context: AuthenticatedRequestContext,
  request: TraceworkAuthRequestLike,
) => void | Promise<void>

const writeJson = (response: AuthGateResponseLike, status: number, payload: unknown) => {
  if (typeof response.status === 'function' && typeof response.json === 'function') {
    response.status(status).json?.(payload)
    return
  }

  if (typeof response.statusCode === 'number' || typeof response.end === 'function') {
    response.statusCode = status
    response.setHeader?.('Content-Type', 'application/json')
    response.end?.(JSON.stringify(payload))
    return
  }

  throw new TypeError('The route response does not support JSON output.')
}

/** Maps the resolver's safe AuthFailure into either Vercel or Node-style JSON. */
export const writeAuthFailure = (response: AuthGateResponseLike, error: AuthFailure) => {
  const safe = toAuthFailureResponse(error)
  writeJson(response, safe.status, safe.payload)
}

/**
 * The single fail-closed refusal for an authenticated caller whose right to
 * change a specific shared resource has not been established. It is deliberately
 * not a 401: the credential was accepted, so telling the user to sign in again
 * would be wrong and would invite a pointless re-authentication loop.
 */
export const AUTHORIZATION_PENDING_CODE = 'authorization_pending'
export const AUTHORIZATION_PENDING_STATUS = 403
export const AUTHORIZATION_PENDING_MESSAGE = 'This operation is not available until access controls are enabled.'

export const writeAuthorizationPending = (response: AuthGateResponseLike) => {
  writeJson(response, AUTHORIZATION_PENDING_STATUS, {
    error: { code: AUTHORIZATION_PENDING_CODE, message: AUTHORIZATION_PENDING_MESSAGE },
  })
}

export type RouteAuthOutcome =
  /** The adapter may run the route handler. `context` is null on anonymous routes. */
  | { readonly allowed: true; readonly context: AuthenticatedRequestContext | null }
  /** The gate has already written the whole response; the adapter must return. */
  | { readonly allowed: false }

const DENIED: RouteAuthOutcome = { allowed: false }

/**
 * The one place the route matrix is enforced. Every adapter ??? the deployed
 * Vercel function and the Vite dev middleware ??? calls this, so production and
 * local development cannot drift into different authentication behavior.
 *
 * An unknown path fails closed rather than defaulting to anonymous, so adding a
 * route without adding a policy cannot silently publish it.
 */
export const enforceRouteAuthPolicy = async (
  path: string,
  request: TraceworkAuthRequestLike,
  response: AuthGateResponseLike,
  dependencies: AuthResolverDependencies = {},
): Promise<RouteAuthOutcome> => {
  const definition = getTraceworkRouteAuthPolicy(path)
  if (!definition) {
    writeAuthorizationPending(response)
    return DENIED
  }

  if (definition.policy === 'anonymous') return { allowed: true, context: null }

  let context: AuthenticatedRequestContext
  try {
    context = await resolveAuthenticatedRequestContext(request, dependencies)
  } catch (error) {
    if (!(error instanceof AuthFailure)) throw error
    writeAuthFailure(response, error)
    return DENIED
  }

  // Authenticated, but this route's resource authorization does not exist yet.
  // Refusing here ??? after identity is proven, before the privileged handler is
  // reachable ??? is what keeps authentication from being mistaken for authority.
  if (definition.policy === 'authenticated-authorization-pending') {
    writeAuthorizationPending(response)
    return DENIED
  }

  return { allowed: true, context }
}

export type RouteHandlerLike<Request, Response> = (
  request: Request,
  response: Response,
) => unknown | Promise<unknown>

/**
 * Wraps a deployed route handler in its policy. The handler keeps its existing
 * signature and stays free of auth concerns, which is also why the Phase 5E
 * suites can still drive the handlers directly without credentials.
 */
export const withRouteAuth = <
  Request extends TraceworkAuthRequestLike,
  Response extends AuthGateResponseLike,
>(
  path: string,
  handler: RouteHandlerLike<Request, Response>,
  dependencies: AuthResolverDependencies = {},
) => async (request: Request, response: Response): Promise<void> => {
  const outcome = await enforceRouteAuthPolicy(path, request, response, dependencies)
  if (!outcome.allowed) return
  await handler(request, response)
}

/**
 * Lower-level continuation form of the same gate, kept for callers that want the
 * verified context handed to them directly.
 */
export const requireAuthenticatedRequest = async (
  request: TraceworkAuthRequestLike,
  response: AuthGateResponseLike,
  continuation: AuthenticatedRouteContinuation,
  dependencies: AuthResolverDependencies = {},
): Promise<boolean> => {
  let context: AuthenticatedRequestContext
  try {
    context = await resolveAuthenticatedRequestContext(request, dependencies)
  } catch (error) {
    if (!(error instanceof AuthFailure)) throw error
    writeAuthFailure(response, error)
    return false
  }

  await continuation(context, request)
  return true
}
