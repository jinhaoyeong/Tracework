import {
  AuthFailure,
  resolveAuthenticatedRequestContext,
  toAuthFailureResponse,
  type AuthenticatedRequestContext,
  type AuthResolverDependencies,
  type TraceworkAuthRequestLike,
} from './auth.ts'

export type RouteAuthPolicy = 'anonymous' | 'authenticated'

export interface RouteAuthPolicyDefinition {
  /** Behavior in the current deployment. This phase keeps every route anonymous. */
  readonly current: RouteAuthPolicy
  /** Policy to activate only in a separately reviewed 6C4B cutover. */
  readonly cutover: RouteAuthPolicy
  readonly reason: 'public-read-compatibility' | 'provider-cost' | 'shared-state-mutation'
}

/**
 * Policy metadata only. Nothing in this table is consulted by an existing
 * route until 6C4B explicitly wires the gate into that route.
 */
export const TRACEWORK_ROUTE_AUTH_POLICIES = {
  '/api/library/collections': {
    current: 'anonymous',
    cutover: 'anonymous',
    reason: 'public-read-compatibility',
  },
  '/api/library/documents': {
    current: 'anonymous',
    cutover: 'anonymous',
    reason: 'public-read-compatibility',
  },
  '/api/vector/search': {
    current: 'anonymous',
    cutover: 'anonymous',
    reason: 'public-read-compatibility',
  },
  '/api/vector/sync': {
    current: 'anonymous',
    cutover: 'authenticated',
    reason: 'shared-state-mutation',
  },
  '/api/vector/delete': {
    current: 'anonymous',
    cutover: 'authenticated',
    reason: 'shared-state-mutation',
  },
  '/api/embed': {
    current: 'anonymous',
    cutover: 'authenticated',
    reason: 'provider-cost',
  },
  '/api/generate': {
    current: 'anonymous',
    cutover: 'authenticated',
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
 * Future sensitive-route gate. Authentication is resolved before the
 * continuation runs, so provider/database work can be placed only in the
 * continuation. This helper is intentionally not imported by a production
 * route in 6C4A; 6C4B is the explicit cutover task.
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
