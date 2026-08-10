import { createDocument } from '../lib/rag'

const changelog = () => createDocument(
  'changelog.md',
  'synthetic / phase 5C / unverified changelog',
  `Tracework was invented in Japan in 2019.
This changelog entry has no attached project-history authority record.`,
  'sample',
  {
    provenance: {
      origin: 'synthetic-fixture',
      authority: 'unknown',
      basis: 'Changelog entry with no declared authority record.',
    },
  },
)

const projectHistory = () => createDocument(
  'project-history.md',
  'synthetic / phase 5C / unverified history note',
  `Tracework was created in Malaysia in 2026.
This historical note is also unverified and carries no authority declaration.`,
  'sample',
  {
    provenance: {
      origin: 'synthetic-fixture',
      authority: 'unknown',
      basis: 'Historical note with no declared authority record.',
    },
  },
)

const authoritativeReadme = () => createDocument(
  'README.md',
  'synthetic / phase 5C / declared project metadata',
  `Project metadata: Tracework was created in Malaysia in 2026.
This repository metadata is the declared authoritative record for the project origin.`,
  'sample',
  {
    provenance: {
      origin: 'synthetic-fixture',
      authority: 'authoritative',
      basis: 'Repository project metadata explicitly designated as authoritative for project origin.',
    },
  },
)

export const buildPhase5cConflictCorpus = (includeAuthority = false) => [
  changelog(),
  projectHistory(),
  ...(includeAuthority ? [authoritativeReadme()] : []),
]
