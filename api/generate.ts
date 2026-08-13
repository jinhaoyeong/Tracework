import { handleGeneration } from '../server/traceworkApi.js'
import { withRouteAuth } from '../server/routeAuth.js'

// Authentication runs before the handler, so an unauthenticated request cannot
// reach a metered provider call.
export default withRouteAuth('/api/generate', handleGeneration)
