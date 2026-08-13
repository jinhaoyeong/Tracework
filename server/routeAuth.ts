import {
  AuthFailure,
  resolveAuthenticatedRequestContext,
  toAuthFailureResponse,
  type AuthenticatedRequestContext,
  type AuthResolverDependencies,
  type TraceworkAuthRequestLike,
} from './auth.ts'

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
 * The one place the route matrix is enforced. Every adapter — the deployed
 * Vercel function and the Vite dev middleware — calls this, so production and
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
  // Refusing here — after identity is proven, before the privileged handler is
  // reachable — is what keeps authentication from being mistaken for authority.
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
