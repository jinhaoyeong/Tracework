export const PHASE5C_CORPUS = [
  {
    title: 'changelog.md',
    content: 'Tracework was invented in Japan in 2019.\nThis changelog entry has no attached project-history authority record.',
    provenance: {
      origin: 'synthetic-fixture',
      authority: 'unknown',
      basis: 'Changelog entry with no declared authority record.',
    },
  },
  {
    title: 'project-history.md',
    content: 'Tracework was created in Malaysia in 2026.\nThis historical note is also unverified and carries no authority declaration.',
    provenance: {
      origin: 'synthetic-fixture',
      authority: 'unknown',
      basis: 'Historical note with no declared authority record.',
    },
  },
  {
    title: 'README.md',
    content: 'Project metadata: Tracework was created in Malaysia in 2026.\nThis repository metadata is the declared authoritative record for the project origin.',
    provenance: {
      origin: 'synthetic-fixture',
      authority: 'authoritative',
      basis: 'Repository project metadata explicitly designated as authoritative for project origin.',
    },
  },
]

export const PHASE5C_QUESTIONS = [
  {
    id: 'Q9-CONFLICT',
    question: 'Where was Tracework invented?',
    corpus: 'unresolved',
    expectedStatus: 'conflicted',
  },
  {
    id: 'Q9-AUTHORITY',
    question: 'Where was Tracework invented?',
    corpus: 'authority',
    expectedStatus: 'authority-supported',
  },
]
