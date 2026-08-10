import { createVercelFetchHandler, handleVectorSearch } from '../../server/traceworkApi'

export default createVercelFetchHandler(handleVectorSearch)
