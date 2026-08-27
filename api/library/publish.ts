import { handleLibraryPublish } from '../../server/traceworkApi.js'
import type { VercelRequestLike, VercelResponseLike } from '../../server/traceworkApi.js'
import { resolveOptionalPrincipal, withRouteAuth } from '../../server/routeAuth.js'

// Policy 'authenticated' gets the caller past the gate; it is deliberately not
// sufficient. The handler additionally requires membership of the
// TRACEWORK_PUBLISHERS allowlist, so submitting knowledge and releasing it to
// every reader stay separate powers. The permitted state transitions themselves
// are enforced in the database.
export default withRouteAuth(
  '/api/library/publish',
  (request: VercelRequestLike, response: VercelResponseLike) => (
    handleLibraryPublish(request, response, { resolveCaller: resolveOptionalPrincipal })
  ),
)
