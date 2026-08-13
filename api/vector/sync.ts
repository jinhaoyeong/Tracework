import { handleVectorSync } from '../../server/traceworkApi.js'
import { withRouteAuth } from '../../server/routeAuth.js'

// Policy is authenticated-authorization-pending: a verified caller still stops
// at 403 here, so the service-role write path stays unreachable until Phase 6D
// establishes which sources a given user may replace.
export default withRouteAuth('/api/vector/sync', handleVectorSync)
