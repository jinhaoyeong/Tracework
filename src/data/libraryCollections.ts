import { createDocument } from '../lib/rag.ts'
import { meridianEssay } from './meridianEssay.ts'
import type { DocumentRecord, SourceKind, SourceProvenance } from '../types'

/**
 * The seed definition of the shared knowledge library.
 *
 * These records are not the library itself. The library lives in Postgres
 * (`tracework_collections` / `tracework_library_documents`) so that a source
 * indexed on one device is readable from another; this module is the seed the
 * database is populated from, and the local corpus the evaluation scripts run
 * against without needing a database at all.
 *
 * Document ids are stable and hand-written rather than generated. Two readers
 * who index the same library document must produce the same source id, or the
 * shared vector table collects a duplicate row per device.
 */

export interface LibraryDocumentSeed {
  id: string
  title: string
  sourcePath: string
  kind: SourceKind
  content: string
  provenance?: SourceProvenance
  sortOrder: number
}

export interface LibraryCollectionSeed {
  slug: string
  title: string
  description: string
  kind: SourceKind
  provenance: SourceProvenance
  sortOrder: number
  documents: LibraryDocumentSeed[]
}

const syntheticProvenance = (basis: string): SourceProvenance => ({
  origin: 'synthetic-fixture',
  authority: 'unknown',
  basis,
})

export const libraryCollections: LibraryCollectionSeed[] = [
  {
    slug: 'workshop-notes',
    title: 'Workshop notes',
    description: 'Three short code and notebook sources used to demonstrate a retrieval trace end to end.',
    kind: 'sample',
    provenance: syntheticProvenance('Synthetic workshop sources supplied for Tracework retrieval exercises.'),
    sortOrder: 10,
    documents: [
      {
        id: 'library-workshop-market-identity',
        title: 'marketIdentity.ts',
        sourcePath: 'synthetic / pokedex code note',
        kind: 'sample',
        sortOrder: 10,
        content: `export function resolveMarketIdentity(input: CardInput): MarketIdentity {
  const officialCardId = normalizeOfficialCardId(input.setCode, input.number)
  const language = input.language === 'ja' ? 'Japanese' : 'English'

  // Japanese cards use the official catalog identity first. The image matcher only resolves a candidate; it does not replace the source identity.
  return { officialCardId, language, source: 'official-catalog' }
}

The Japanese Pokémon card matching logic lives in the market identity boundary. It normalizes the official set code and card number before visual candidates are compared, so a translated name cannot silently merge two language variants.`,
      },
      {
        id: 'library-workshop-trip-intelligence',
        title: 'tripIntelligence.ts',
        sourcePath: 'synthetic / travel planner code note',
        kind: 'sample',
        sortOrder: 20,
        content: `The itinerary planner creates a deterministic proposal before anything is applied. Locked places, manually scheduled items, and the unscheduled inbox remain protected unless the user explicitly selects them.

The preview carries the baseProfileRevision and itineraryRevision that produced it. Applying a stale preview is rejected, while selective apply and operation-level undo keep the user's itinerary recoverable. Route confidence and opening-hour warnings remain visible beside the proposal.`,
      },
      {
        id: 'library-workshop-rag-lab-notes',
        title: 'rag-lab-notes.md',
        sourcePath: 'synthetic / learning notebook',
        kind: 'sample',
        sortOrder: 30,
        content: `A useful retrieval experiment compares paragraph chunks with fixed-size chunks. Store the source path, chunk offsets, token count, and embedding version with every passage so a result can be audited later.

The first local prototype uses a deterministic hashed embedding so the browser works without credentials. The next experiment should swap in a hosted embedding provider, compare top-k recall, then add reranking and a small evaluation set before adding chat history.`,
      },
    ],
  },
  {
    slug: 'meridian-access-programme',
    title: 'Meridian access programme',
    description: 'A long synthetic policy history where prices, thresholds, and eligibility rules supersede each other across three years.',
    kind: 'sample',
    provenance: syntheticProvenance('Synthetic evaluation essay supplied for Tracework retrieval testing.'),
    sortOrder: 20,
    documents: [
      {
        id: 'library-meridian-access-programme',
        title: 'meridian-access-programme.md',
        sourcePath: 'synthetic / Meridian evaluation essay',
        kind: 'sample',
        sortOrder: 10,
        content: meridianEssay,
        provenance: syntheticProvenance('Synthetic evaluation essay supplied for Tracework retrieval testing.'),
      },
    ],
  },
  {
    slug: 'phase-5c-conflict-set',
    title: 'Phase 5C conflict set',
    description: 'Two unverified sources that place the same fact in different countries and years, with no authority record to settle it.',
    kind: 'sample',
    provenance: syntheticProvenance('Conflicting sources with no declared authority record.'),
    sortOrder: 30,
    documents: [
      {
        id: 'library-phase5c-changelog',
        title: 'changelog.md',
        sourcePath: 'synthetic / phase 5C / unverified changelog',
        kind: 'sample',
        sortOrder: 10,
        content: `Tracework was invented in Japan in 2019.
This changelog entry has no attached project-history authority record.`,
        provenance: syntheticProvenance('Changelog entry with no declared authority record.'),
      },
      {
        id: 'library-phase5c-project-history',
        title: 'project-history.md',
        sourcePath: 'synthetic / phase 5C / unverified history note',
        kind: 'sample',
        sortOrder: 20,
        content: `Tracework was created in Malaysia in 2026.
This historical note is also unverified and carries no authority declaration.`,
        provenance: syntheticProvenance('Historical note with no declared authority record.'),
      },
    ],
  },
  {
    slug: 'phase-5c-authority-record',
    title: 'Phase 5C authority record',
    description: 'The declared authoritative metadata for the same fact. Add it on top of the conflict set to watch the resolution boundary move.',
    kind: 'sample',
    provenance: {
      origin: 'synthetic-fixture',
      authority: 'authoritative',
      basis: 'Repository project metadata explicitly designated as authoritative for project origin.',
    },
    sortOrder: 40,
    documents: [
      {
        id: 'library-phase5c-authoritative-readme',
        title: 'README.md',
        sourcePath: 'synthetic / phase 5C / declared project metadata',
        kind: 'sample',
        sortOrder: 10,
        content: `Project metadata: Tracework was created in Malaysia in 2026.
This repository metadata is the declared authoritative record for the project origin.`,
        provenance: {
          origin: 'synthetic-fixture',
          authority: 'authoritative',
          basis: 'Repository project metadata explicitly designated as authoritative for project origin.',
        },
      },
    ],
  },
]

export const findLibraryCollection = (slug: string) => libraryCollections.find((collection) => collection.slug === slug)

/** Turns a seed document into the chunked record the local pipeline indexes. */
export const buildLibraryDocument = (seed: LibraryDocumentSeed, collectionSlug: string): DocumentRecord => ({
  ...createDocument(seed.title, seed.sourcePath, seed.content, seed.kind, {
    id: seed.id,
    provenance: seed.provenance,
  }),
  libraryCollection: collectionSlug,
})

/** The local, database-free copy of one collection. Used by the eval scripts. */
export const buildLibraryCollection = (slug: string): DocumentRecord[] => {
  const collection = findLibraryCollection(slug)
  if (!collection) return []
  return collection.documents.map((seed) => buildLibraryDocument(seed, collection.slug))
}
