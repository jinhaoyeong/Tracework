import { handleLibraryDocuments } from '../../server/traceworkApi.js'
import type { VercelRequestLike, VercelResponseLike } from '../../server/traceworkApi.js'
import { resolveOptionalPrincipal } from '../../server/routeAuth.js'

// See api/library/collections.ts. The public path runs first here; the caller
// path is consulted only when it returns nothing, and a 404 is raised only after
// both are exhausted so an unauthorized slug and a nonexistent one look alike.
export default (request: VercelRequestLike, response: VercelResponseLike) => (
  handleLibraryDocuments(request, response, { resolveCaller: resolveOptionalPrincipal })
)
