import { handleLibraryIngest } from '../../server/traceworkApi.js'
import type { VercelRequestLike, VercelResponseLike } from '../../server/traceworkApi.js'
import { resolveOptionalPrincipal, withRouteAuth } from '../../server/routeAuth.js'

// Policy 'authenticated': the gate rejects an unverified caller before the
// handler runs. The handler then re-resolves the principal because it needs the
// user id to stamp created_by_user_id, and applies the
// TRACEWORK_ALLOW_SHARED_WRITES boundary. Ingested content lands as 'pending',
// which the 6D2A read path cannot return to anyone.
export default withRouteAuth(
  '/api/library/ingest',
  (request: VercelRequestLike, response: VercelResponseLike) => (
    handleLibraryIngest(request, response, { resolveCaller: resolveOptionalPrincipal })
  ),
)
