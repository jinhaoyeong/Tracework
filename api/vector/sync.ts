import { createVercelFetchHandler, handleVectorSync } from '../../server/traceworkApi'

export default createVercelFetchHandler(handleVectorSync)
