import { buildLibraryCollection } from './libraryCollections.ts'

/**
 * The conflict set and its authority record are two separate library
 * collections, so the authority variant can be added on top of the unresolved
 * pair to move the resolution boundary.
 */
export const buildPhase5cConflictCorpus = (includeAuthority = false) => [
  ...buildLibraryCollection('phase-5c-conflict-set'),
  ...(includeAuthority ? buildLibraryCollection('phase-5c-authority-record') : []),
]
