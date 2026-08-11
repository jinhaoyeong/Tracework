import { buildLibraryCollection } from './libraryCollections.ts'

/** The local copy of the workshop-notes collection, used as the first-run index. */
export const buildSampleCorpus = () => buildLibraryCollection('workshop-notes')
