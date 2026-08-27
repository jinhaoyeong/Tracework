import { handleLibraryStatus } from '../../server/traceworkApi.js'
import type { VercelRequestLike, VercelResponseLike } from '../../server/traceworkApi.js'
import { resolveOptionalPrincipal, withRouteAuth } from '../../server/routeAuth.js'

// The reviewer's view of what is waiting. The 6D2A catalog cannot show it,
// because that path returns published rows only by design. Restricted to
// allowlisted publishers: pending submissions are not public information.
export default withRouteAuth(
  '/api/library/status',
  (request: VercelRequestLike, response: VercelResponseLike) => (
    handleLibraryStatus(request, response, { resolveCaller: resolveOptionalPrincipal })
  ),
)
