import { createVercelFetchHandler, handleGeneration } from '../server/traceworkApi'

export default createVercelFetchHandler(handleGeneration)
