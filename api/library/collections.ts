import { handleLibraryCollections } from '../../server/traceworkApi.js'
import type { VercelRequestLike, VercelResponseLike } from '../../server/traceworkApi.js'
import { resolveOptionalPrincipal } from '../../server/routeAuth.js'

// The route policy stays 'anonymous': a request without a credential reads the
// public catalog through the unchanged 6D2A service_role path. When a verified
// principal is present AND TRACEWORK_AUTHENTICATED_LIBRARY_READS is exactly
// "true", the handler additionally composes in that caller's private and
// workspace collections, read under their own JWT so RLS applies.
export default (request: VercelRequestLike, response: VercelResponseLike) => (
  handleLibraryCollections(request, response, { resolveCaller: resolveOptionalPrincipal })
)
