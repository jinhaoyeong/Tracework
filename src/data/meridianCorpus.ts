import { buildLibraryCollection } from './libraryCollections.ts'

export { meridianEssay } from './meridianEssay.ts'

/** The local copy of the Meridian collection, used by scripts/test-meridian.mjs. */
export const buildMeridianCorpus = () => buildLibraryCollection('meridian-access-programme')
