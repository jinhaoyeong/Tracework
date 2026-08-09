import { createDocument } from '../lib/rag'

export const buildSampleCorpus = () => [
  createDocument(
    'marketIdentity.ts',
    'synthetic / pokedex code note',
    `export function resolveMarketIdentity(input: CardInput): MarketIdentity {
  const officialCardId = normalizeOfficialCardId(input.setCode, input.number)
  const language = input.language === 'ja' ? 'Japanese' : 'English'

  // Japanese cards use the official catalog identity first. The image matcher only resolves a candidate; it does not replace the source identity.
  return { officialCardId, language, source: 'official-catalog' }
}

The Japanese Pokémon card matching logic lives in the market identity boundary. It normalizes the official set code and card number before visual candidates are compared, so a translated name cannot silently merge two language variants.`,
    'sample',
  ),
  createDocument(
    'tripIntelligence.ts',
    'synthetic / travel planner code note',
    `The itinerary planner creates a deterministic proposal before anything is applied. Locked places, manually scheduled items, and the unscheduled inbox remain protected unless the user explicitly selects them.

The preview carries the baseProfileRevision and itineraryRevision that produced it. Applying a stale preview is rejected, while selective apply and operation-level undo keep the user's itinerary recoverable. Route confidence and opening-hour warnings remain visible beside the proposal.`,
    'sample',
  ),
  createDocument(
    'rag-lab-notes.md',
    'synthetic / learning notebook',
    `A useful retrieval experiment compares paragraph chunks with fixed-size chunks. Store the source path, chunk offsets, token count, and embedding version with every passage so a result can be audited later.

The first local prototype uses a deterministic hashed embedding so the browser works without credentials. The next experiment should swap in a hosted embedding provider, compare top-k recall, then add reranking and a small evaluation set before adding chat history.`,
    'sample',
  ),
]
