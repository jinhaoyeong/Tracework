export type SourceKind = 'note' | 'file' | 'sample'
export type RetrievalEngine = 'hashed' | 'neural' | 'pgvector' | 'lexical' | 'hybrid'
export type LocalRetrievalEngine = 'hashed' | 'neural'

export interface NeuralEmbedding {
  vector: number[]
  model: string
  dimensions: number
  createdAt: string
}

export interface ChunkRecord {
  id: string
  documentId: string
  index: number
  text: string
  start: number
  end: number
  tokens: string[]
  vector: number[]
  neuralEmbedding?: NeuralEmbedding
}

export interface DocumentRecord {
  id: string
  title: string
  source: string
  kind: SourceKind
  content: string
  createdAt: string
  chunks: ChunkRecord[]
}

export interface SearchResult {
  chunk: ChunkRecord
  document: DocumentRecord
  score: number
  semanticScore: number
  keywordScore: number
  matchedTerms: string[]
  engine: RetrievalEngine
  distance?: number
  embeddingModel?: string
  embeddingDimensions?: number
  candidateCount?: number
  database?: string
  /** Raw BM25 score. Unbounded, and not comparable to a cosine similarity. */
  lexicalScore?: number
  lexicalFieldHits?: { body: number; title: number; path: number }
  /** Set on fused results so a hybrid rank can be explained by its inputs. */
  fusion?: {
    rrfScore: number
    denseRank: number | null
    lexicalRank: number | null
    denseContribution: number
    lexicalContribution: number
  }
}

export interface AnswerDraft {
  title: string
  body: string
  citations: SearchResult[]
}
