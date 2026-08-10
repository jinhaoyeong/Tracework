import type { AnswerDraft, ChunkRecord, DocumentRecord, LocalRetrievalEngine, SearchResult, SourceKind, SourceProvenance } from '../types'

const VECTOR_SIZE = 384
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'did', 'do', 'for', 'from', 'how',
  'i', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'what',
  'where', 'which', 'who', 'with', 'you',
])

const hash = (value: string) => {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return Math.abs(result) % VECTOR_SIZE
}

export const tokenize = (value: string) => {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
}

export const embedLocal = (value: string) => {
  const tokens = tokenize(value)
  const vector = Array.from({ length: VECTOR_SIZE }, () => 0)

  tokens.forEach((token, index) => {
    vector[hash(`token:${token}`)] += 1
    if (token.length > 4) {
      for (let offset = 0; offset < token.length - 2; offset += 1) {
        vector[hash(`tri:${token.slice(offset, offset + 3)}`)] += 0.18
      }
    }
    if (tokens[index + 1]) {
      vector[hash(`pair:${token}:${tokens[index + 1]}`)] += 0.45
    }
  })

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
  return vector.map((value) => value / magnitude)
}

const cosine = (left: number[], right: number[]) => {
  let total = 0
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    total += left[index] * right[index]
  }
  return Math.max(0, Math.min(1, total))
}

const chunkText = (content: string, maxCharacters = 720) => {
  const blocks = content.split(/\n{2,}/g).map((block) => block.trim()).filter(Boolean)
  const chunks: Array<{ text: string; start: number; end: number }> = []
  let cursor = 0
  let pending = ''
  let pendingStart = 0

  for (const block of blocks) {
    const blockStart = content.indexOf(block, cursor)
    cursor = blockStart + block.length
    if (block.length > maxCharacters) {
      const lines = block.split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        if (pending && pending.length + line.length + 1 > maxCharacters) {
          chunks.push({ text: pending.trim(), start: pendingStart, end: pendingStart + pending.length })
          pending = ''
        }
        if (!pending) pendingStart = blockStart + block.indexOf(line)
        pending += `${line}\n`
      }
      continue
    }

    if (pending && pending.length + block.length + 2 > maxCharacters) {
      chunks.push({ text: pending.trim(), start: pendingStart, end: pendingStart + pending.length })
      pending = ''
    }
    if (!pending) pendingStart = blockStart
    pending += `${block}\n\n`
  }

  if (pending.trim()) {
    chunks.push({ text: pending.trim(), start: pendingStart, end: pendingStart + pending.trim().length })
  }

  return chunks.length ? chunks : [{ text: content.trim(), start: 0, end: content.length }]
}

export const createDocument = (
  title: string,
  source: string,
  content: string,
  kind: SourceKind = 'note',
  options: { provenance?: SourceProvenance; id?: string } = {},
): DocumentRecord => {
  // Chunk ids are the last tie-breaker in ranking and fusion, so random ids make
  // marginal ties resolve differently on every run. Benchmarks pass a stable id
  // to keep a before/after comparison free of noise that belongs to neither
  // side; the app keeps the random id, which must stay unique per capture.
  const id = options.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const chunks = chunkText(content).map((item, index): ChunkRecord => ({
    id: `${id}-chunk-${index + 1}`,
    documentId: id,
    index,
    text: item.text,
    start: item.start,
    end: item.end,
    tokens: tokenize(item.text),
    vector: embedLocal(item.text),
  }))

  return {
    id,
    title: title.trim() || 'Untitled note',
    source: source.trim() || 'pasted note',
    kind,
    provenance: options.provenance ?? {
      origin: kind === 'sample' ? 'synthetic-fixture' : kind === 'file' ? 'indexed-file' : 'user-note',
      authority: 'unknown',
      basis: 'No authority metadata was supplied.',
    },
    content,
    createdAt: new Date().toISOString(),
    chunks,
  }
}

export const searchDocuments = (
  documents: DocumentRecord[],
  query: string,
  options: { engine?: LocalRetrievalEngine; limit?: number; queryVector?: number[] } = {},
): SearchResult[] => {
  const engine = options.engine ?? 'hashed'
  const limit = options.limit ?? 8
  const queryTokens = tokenize(query)
  if (!queryTokens.length) return []
  const queryVector = options.queryVector ?? (engine === 'hashed' ? embedLocal(query) : null)
  if (!queryVector) return []

  const candidates: Array<SearchResult | null> = documents
    .flatMap((document) => document.chunks.map((chunk) => {
      const matchedTerms = [...new Set(queryTokens.filter((term) => chunk.tokens.includes(term)))]
      const keywordScore = matchedTerms.length / queryTokens.length
      const vector = engine === 'neural' ? chunk.neuralEmbedding?.vector : chunk.vector
      if (!vector) return null
      const semanticScore = cosine(queryVector, vector)
      const score = engine === 'neural' ? semanticScore : semanticScore * 0.68 + keywordScore * 0.32
      return { chunk, document, score, semanticScore, keywordScore, matchedTerms, engine }
    }))

  return candidates
    .filter((result): result is SearchResult => result !== null)
    .filter((result) => result.score > 0.12)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
}

const selectSnippet = (text: string, terms: string[]) => {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim()).filter(Boolean)
  const scored = sentences.map((sentence, index) => ({
    sentence,
    index,
    hits: terms.filter((term) => sentence.toLocaleLowerCase().includes(term)).length,
  }))
  return scored
    .sort((left, right) => right.hits - left.hits || left.index - right.index)
    .slice(0, 2)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.sentence)
    .join(' ')
}

export const buildAnswer = (query: string, results: SearchResult[]): AnswerDraft => {
  if (!results.length) {
    return {
      title: 'No evidence found yet',
      body: 'This index has no passage that clears the retrieval threshold. Add a source, try a more specific phrase, or inspect the ingestion state before trusting a blank result.',
      citations: [],
    }
  }

  const citations = results.slice(0, 3)
  const lead = citations[0]
  const sourcePhrase = citations.length === 1
    ? `The strongest match is in ${lead.document.title}.`
    : `The strongest matches are spread across ${citations.length} indexed passages, led by ${lead.document.title}.`
  const evidence = citations
    .map((result, index) => `[${index + 1}] ${selectSnippet(result.chunk.text, tokenize(query)) || result.chunk.text.slice(0, 180)}`)
    .join(' ')

  return {
    title: `${citations.length} grounded ${citations.length === 1 ? 'passage' : 'passages'} found`,
    body: `${sourcePhrase} ${evidence}`,
    citations,
  }
}

export const formatBytes = (value: number) => {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}
