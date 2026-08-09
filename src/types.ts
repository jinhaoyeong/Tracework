export type SourceKind = 'note' | 'file' | 'sample'
export type RetrievalEngine = 'hashed' | 'neural' | 'pgvector'
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
}

export interface AnswerDraft {
  title: string
  body: string
  citations: SearchResult[]
}
