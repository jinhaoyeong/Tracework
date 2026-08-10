import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { buildSampleCorpus } from './data/sampleCorpus'
import { Icon } from './components/Icon'
import { buildAnswer, createDocument, formatBytes, searchDocuments, tokenize } from './lib/rag'
import { buildGroundedContext, buildInsufficientAnswer, classifyGeneratedAnswer, evaluateEvidence, type GroundedContext, type GroundedSession } from './lib/grounded'
import { GenerationError, requestGroundedAnswer } from './lib/generation'
import { buildLexicalIndex, searchLexical, toLexicalResults } from './lib/lexical'
import { fuseRankings, RRF_K } from './lib/fusion'
import { buildCandidateUnion, DEFAULT_PHASE5B_CANDIDATE_LIMIT, DEFAULT_PHASE5B_CONTEXT_LIMIT, pruneCandidates, rerank, type RankedCandidate } from './lib/reranker'
import { NeuralEmbeddingError, requestNeuralEmbeddings } from './lib/semantic'
import { PGVECTOR_DIMENSIONS, PgvectorError, requestPgvectorDelete, requestPgvectorSearch, requestPgvectorSync, type PgvectorMatch } from './lib/vectorDb'
import type { DocumentRecord, RetrievalEngine, SearchResult, SourceKind } from './types'

const STORAGE_KEY = 'tracework.documents.v1'
const INITIAL_QUERY = 'Where did I implement Japanese Pokémon card matching logic?'

const examples = [
  'Where did I implement Japanese Pokémon card matching logic?',
  'What protects locked itinerary places from a planner proposal?',
  'What should I measure before adding reranking?',
]

type NeuralStatus = 'idle' | 'indexing' | 'ready' | 'error'

interface NeuralState {
  status: NeuralStatus
  model: string | null
  progress: number
  message: string | null
}

type PgvectorStatus = 'idle' | 'syncing' | 'searching' | 'ready' | 'error'

interface PgvectorState {
  status: PgvectorStatus
  database: string | null
  candidateCount: number
  topK: number
  message: string | null
}

type AnswerMode = 'retrieval' | 'grounded'
type GenerationStatus = 'idle' | 'generating' | 'ready' | 'blocked' | 'refused' | 'error'

interface GenerationState {
  status: GenerationStatus
  model: string | null
  message: string | null
}

const loadDocuments = (): DocumentRecord[] => {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (!saved) return buildSampleCorpus()
    const parsed = JSON.parse(saved) as unknown
    return Array.isArray(parsed) ? parsed as DocumentRecord[] : buildSampleCorpus()
  } catch {
    return buildSampleCorpus()
  }
}

const sourceLabel = (document: DocumentRecord) => {
  if (document.kind === 'sample') return 'synthetic source'
  if (document.kind === 'file') return 'local file'
  return 'pasted note'
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function HighlightedText({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>
  const expression = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi')
  return <>{text.split(expression).map((part, index) => {
    const isMatch = terms.some((term) => term.toLocaleLowerCase() === part.toLocaleLowerCase())
    return isMatch ? <mark key={`${part}-${index}`}>{part}</mark> : <span key={`${part}-${index}`}>{part}</span>
  })}</>
}

function ComparisonColumn({
  title,
  description,
  results,
  tone,
  emptyMessage,
  onSelect,
}: {
  title: string
  description: string
  results: SearchResult[]
  tone: 'baseline' | 'neural' | 'pgvector'
  emptyMessage: string
  onSelect: (chunkId: string) => void
}) {
  return (
    <div className={`comparison-column comparison-${tone}`}>
      <div className="comparison-column-heading">
        <div><span className="comparison-marker" /> <strong>{title}</strong></div>
        <span>{results.length ? `${results.length} hits` : 'not ready'}</span>
      </div>
      <p>{description}</p>
      {results.length ? <ol className="comparison-results">
        {results.slice(0, 3).map((result, index) => (
          <li key={result.chunk.id}>
            <button type="button" onClick={() => onSelect(result.chunk.id)}>
              <span className="comparison-rank">{String(index + 1).padStart(2, '0')}</span>
              <span className="comparison-result-copy"><strong>{result.document.title}</strong><small>chunk {String(result.chunk.index + 1).padStart(2, '0')}</small></span>
              <span className="comparison-score">{Math.round(result.score * 100)}%</span>
            </button>
          </li>
        ))}
      </ol> : <div className="comparison-empty">{emptyMessage}</div>}
    </div>
  )
}

interface Phase5BListItem {
  id: string
  rank: number
  title: string
  detail: string
  score?: string
  status?: string
  isRejected?: boolean
}

function Phase5BList({
  title,
  description,
  items,
  emptyMessage,
  onSelect,
}: {
  title: string
  description: string
  items: Phase5BListItem[]
  emptyMessage: string
  onSelect: (chunkId: string) => void
}) {
  return (
    <div className="phase5b-column">
      <div className="phase5b-column-heading">
        <h3>{title}</h3>
        <span>{items.length ? `${items.length} rows` : 'empty'}</span>
      </div>
      <p>{description}</p>
      {items.length ? <ol className="phase5b-list">
        {items.map((item) => (
          <li key={`${title}-${item.id}`} className={item.isRejected ? 'is-rejected' : ''}>
            <button type="button" onClick={() => onSelect(item.id)}>
              <span className="phase5b-rank">{String(item.rank).padStart(2, '0')}</span>
              <span className="phase5b-row-copy"><strong>{item.title}</strong><small>{item.detail}</small></span>
              <span className="phase5b-row-score">{item.score ?? item.status ?? '—'}</span>
            </button>
          </li>
        ))}
      </ol> : <div className="phase5b-empty">{emptyMessage}</div>}
    </div>
  )
}

function App() {
  const [documents, setDocuments] = useState<DocumentRecord[]>(loadDocuments)
  const [query, setQuery] = useState(INITIAL_QUERY)
  const [activeQuery, setActiveQuery] = useState(INITIAL_QUERY)
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(null)
  const [noteTitle, setNoteTitle] = useState('')
  const [noteSource, setNoteSource] = useState('')
  const [noteContent, setNoteContent] = useState('')
  const [isReadingFiles, setIsReadingFiles] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'success' | 'info' | 'error'; text: string } | null>(null)
  const [persistenceWarningShown, setPersistenceWarningShown] = useState(false)
  const [engine, setEngine] = useState<RetrievalEngine>('hashed')
  const [compareMode, setCompareMode] = useState(false)
  const [neuralQueryVector, setNeuralQueryVector] = useState<number[] | null>(null)
  const [neuralState, setNeuralState] = useState<NeuralState>({ status: 'idle', model: null, progress: 0, message: null })
  const [pgvectorResults, setPgvectorResults] = useState<SearchResult[]>([])
  const [pgvectorState, setPgvectorState] = useState<PgvectorState>({ status: 'idle', database: null, candidateCount: 0, topK: 5, message: null })
  const [topK, setTopK] = useState(DEFAULT_PHASE5B_CONTEXT_LIMIT)
  const [candidateLimit, setCandidateLimit] = useState(DEFAULT_PHASE5B_CANDIDATE_LIMIT)
  const [pruningEnabled, setPruningEnabled] = useState(false)
  const [sourceKindFilter, setSourceKindFilter] = useState<SourceKind | 'all'>('all')
  const [answerMode, setAnswerMode] = useState<AnswerMode>('retrieval')
  const [generationState, setGenerationState] = useState<GenerationState>({ status: 'idle', model: null, message: null })
  const [groundedSession, setGroundedSession] = useState<GroundedSession | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const neuralIndexPromiseRef = useRef<Promise<DocumentRecord[]> | null>(null)

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(documents))
    } catch {
      if (!persistenceWarningShown) {
        setPersistenceWarningShown(true)
        setNotice({ tone: 'error', text: 'This index is too large for browser storage. It will remain available until you clear or reduce it.' })
      }
    }
  }, [documents, persistenceWarningShown])

  useEffect(() => {
    if (!notice) return undefined
    const timeout = window.setTimeout(() => setNotice(null), 4200)
    return () => window.clearTimeout(timeout)
  }, [notice])

  const hashedResults = useMemo(() => searchDocuments(documents, activeQuery, { engine: 'hashed' }), [documents, activeQuery])
  const neuralResults = useMemo(() => searchDocuments(documents, activeQuery, { engine: 'neural', limit: candidateLimit, queryVector: neuralQueryVector ?? undefined }), [documents, activeQuery, candidateLimit, neuralQueryVector])
  const lexicalIndex = useMemo(() => buildLexicalIndex(documents), [documents])
  const lexicalResults = useMemo(
    () => toLexicalResults(searchLexical(lexicalIndex, activeQuery, candidateLimit), documents),
    [documents, lexicalIndex, activeQuery, candidateLimit],
  )
  // The dense side of a fusion is whichever real dense ranking exists: the
  // database ranking when pgvector has run, the local neural ranking otherwise.
  const denseResultsForFusion = pgvectorResults.length ? pgvectorResults : neuralResults
  const denseSourceLabel = pgvectorResults.length ? 'pgvector' : 'local neural'
  const hybridResults = useMemo(
    () => fuseRankings({ dense: denseResultsForFusion, lexical: lexicalResults }, 8),
    [denseResultsForFusion, lexicalResults],
  )
  const retrievalResults = engine === 'neural'
    ? neuralResults
    : engine === 'pgvector'
      ? pgvectorResults
      : engine === 'lexical'
        ? lexicalResults
        : engine === 'hybrid'
        ? hybridResults
          : hashedResults
  const phase5bDenseResults = engine === 'rerank' ? neuralResults : neuralResults.length ? neuralResults : pgvectorResults
  const phase5bUnion = useMemo(
    () => buildCandidateUnion({ dense: phase5bDenseResults, lexical: lexicalResults, limit: candidateLimit }),
    [candidateLimit, lexicalResults, phase5bDenseResults],
  )
  const phase5bRankedCandidates = useMemo(
    () => rerank(activeQuery, phase5bUnion),
    [activeQuery, phase5bUnion],
  )
  const phase5bPruning = useMemo(
    () => pruneCandidates(phase5bRankedCandidates, { maxChunks: topK }),
    [phase5bRankedCandidates, topK],
  )
  const phase5bContextCandidates = pruningEnabled ? phase5bPruning.selected : phase5bRankedCandidates
  const phase5bContextResults = phase5bContextCandidates.map((candidate) => candidate.result)
  const phase5bRankedResults = phase5bRankedCandidates.map((candidate) => candidate.result)
  const results = engine === 'rerank' ? phase5bContextResults : retrievalResults
  const inspectableResults = engine === 'rerank' ? phase5bRankedResults : results
  const phase5bDecisionByChunkId = useMemo(
    () => new Map(phase5bPruning.decisions.map((decision) => [decision.candidate.result.chunk.id, decision])),
    [phase5bPruning],
  )
  const answer = useMemo(() => buildAnswer(activeQuery, results), [activeQuery, results])
  const evidenceAssessment = useMemo(() => evaluateEvidence(activeQuery, results), [activeQuery, results])
  const groundedPreviewContext = useMemo(() => buildGroundedContext(activeQuery, results, {
    retrievalEngine: engine === 'rerank' ? 'union-rerank' : engine,
    requestedTopK: engine === 'rerank' ? phase5bContextResults.length : engine === 'pgvector' ? topK : 8,
    limit: engine === 'rerank' ? phase5bContextResults.length : undefined,
  }), [activeQuery, engine, phase5bContextResults.length, results, topK])
  const contextForInspector: GroundedContext = groundedSession?.context ?? groundedPreviewContext
  const groundedAnswer = groundedSession?.answer ?? null
  const groundedContextWasSent = groundedSession !== null && generationState.status !== 'blocked'
  const groundedContextStateLabel = groundedSession
    ? generationState.status === 'blocked' ? 'generation skipped' : 'context sent'
    : 'context preview'
  const generationDebugLabel = generationState.status === 'idle'
    ? 'not called'
    : `${generationState.model ?? 'server model'} / ${generationState.status}`
  const visibleCitations = answerMode === 'grounded' ? groundedAnswer?.citations ?? [] : answer.citations
  const visibleCitationNumbers = answerMode === 'grounded'
    ? groundedAnswer?.validCitationNumbers ?? []
    : answer.citations.map((_citation, index) => index + 1)
  const visibleAnswerTitle = answerMode === 'retrieval'
    ? answer.title
    : groundedAnswer?.title
      ?? (generationState.status === 'generating' ? 'Building a grounded answer' : generationState.status === 'error' ? 'Generation failed' : 'Grounded answer not run')
  const visibleAnswerBody = answerMode === 'retrieval'
    ? answer.body
    : groundedAnswer?.body
      ?? (generationState.status === 'generating'
        ? 'The model is receiving the exact retrieved context shown below.'
        : generationState.status === 'error'
          ? generationState.message ?? 'The generation stage failed before an answer was returned.'
          : 'Choose grounded answer mode and run a question to send retrieved evidence to the generation model.')
  const selectedResult = inspectableResults.find((result) => result.chunk.id === selectedChunkId) ?? inspectableResults[0]
  const selectedPhase5bCandidate: RankedCandidate | undefined = engine === 'rerank'
    ? phase5bRankedCandidates.find((candidate) => candidate.result.chunk.id === selectedResult?.chunk.id)
    : undefined
  const selectedPhase5bDecision = selectedPhase5bCandidate
    ? phase5bDecisionByChunkId.get(selectedPhase5bCandidate.result.chunk.id)
    : undefined
  const chunkCount = documents.reduce((total, document) => total + document.chunks.length, 0)
  const wordCount = documents.reduce((total, document) => total + tokenize(document.content).length, 0)
  const indexedTerms = new Set(documents.flatMap((document) => tokenize(document.content))).size
  const missingNeuralEmbeddings = documents.reduce((total, document) => total + document.chunks.filter((chunk) => !chunk.neuralEmbedding).length, 0)
  const activeStatus = engine === 'pgvector' ? pgvectorState.status : neuralState.status
  const activeStatusMessage = engine === 'pgvector'
    ? pgvectorState.message ?? (pgvectorState.status === 'error' ? 'pgvector provider unavailable' : 'database search is ready to run')
    : neuralState.message ?? (neuralState.status === 'error' ? 'neural provider unavailable' : engine === 'neural' || engine === 'rerank' ? `${missingNeuralEmbeddings} chunks waiting for neural vectors` : 'local and credential-free')
  const hasPgvectorSearch = pgvectorState.status === 'ready'
  const vectorStepComplete = engine === 'pgvector' ? pgvectorState.status === 'ready' : engine === 'neural' || engine === 'rerank' ? neuralState.status === 'ready' : Boolean(chunkCount)
  const vectorStepActive = engine === 'pgvector' ? ['syncing', 'searching'].includes(pgvectorState.status) : (engine === 'neural' || engine === 'rerank') && neuralState.status === 'indexing'
  const vectorStepLabel = engine === 'pgvector' ? 'pgvector' : engine === 'rerank' ? 'neural + rerank' : engine === 'neural' ? 'neural embed' : 'embed'
  const topPgvectorResult = pgvectorResults[0]

  useEffect(() => {
    if (!inspectableResults.length) {
      setSelectedChunkId(null)
      return
    }
    if (!selectedChunkId || !inspectableResults.some((result) => result.chunk.id === selectedChunkId)) {
      setSelectedChunkId(inspectableResults[0].chunk.id)
    }
  }, [inspectableResults, selectedChunkId])

  const showNotice = (tone: 'success' | 'info' | 'error', text: string) => setNotice({ tone, text })

  const resetNeuralState = () => {
    setNeuralQueryVector(null)
    setNeuralState({ status: 'idle', model: null, progress: 0, message: null })
  }

  const resetPgvectorState = () => {
    setPgvectorResults([])
    setPgvectorState({ status: 'idle', database: null, candidateCount: 0, topK, message: null })
  }

  const resetGroundedState = () => {
    setGroundedSession(null)
    setGenerationState({ status: 'idle', model: null, message: null })
  }

  const resetRetrievalState = () => {
    resetNeuralState()
    resetPgvectorState()
    resetGroundedState()
  }

  const indexNeuralDocuments = async (
    currentDocuments: DocumentRecord[],
    expectedModel: string,
    expectedDimensions: number,
  ) => {
    if (neuralIndexPromiseRef.current) return neuralIndexPromiseRef.current

    const pendingChunks = currentDocuments.flatMap((document) => document.chunks.filter((chunk) => {
      const embedding = chunk.neuralEmbedding
      return !embedding
        || embedding.model !== expectedModel
        || embedding.dimensions !== expectedDimensions
        || !Array.isArray(embedding.vector)
        || embedding.vector.length !== expectedDimensions
    }))
    if (!pendingChunks.length) {
      setNeuralState((current) => ({
        status: 'ready',
        model: current.model ?? expectedModel,
        progress: 100,
        message: `All indexed chunks use ${expectedModel} / ${expectedDimensions}d.`,
      }))
      return currentDocuments
    }

    const task = (async () => {
      setNeuralState((current) => ({
        status: 'indexing',
        model: current.model,
        progress: 0,
        message: `Embedding ${pendingChunks.length} chunks...`,
      }))

      try {
        const response = await requestNeuralEmbeddings(
          pendingChunks.map((chunk) => chunk.text),
          (completed, total) => setNeuralState((current) => ({
            ...current,
            status: 'indexing',
            progress: Math.round((completed / total) * 100),
            message: `Embedding ${completed} of ${total} chunks...`,
          })),
        )
        const embeddingByChunkId = new Map(pendingChunks.map((chunk, index) => [chunk.id, response.vectors[index]]))
        const updatedDocuments = currentDocuments.map((document) => ({
          ...document,
          chunks: document.chunks.map((chunk) => {
            const vector = embeddingByChunkId.get(chunk.id)
            if (!vector) return chunk
            return {
              ...chunk,
              neuralEmbedding: {
                vector,
                model: response.model,
                dimensions: response.dimensions,
                createdAt: new Date().toISOString(),
              },
            }
          }),
        }))
        if (response.model !== expectedModel || response.dimensions !== expectedDimensions) {
          throw new NeuralEmbeddingError(
            'embedding_contract_mismatch',
            `The chunk embeddings use ${response.model} / ${response.dimensions}d, but the query uses ${expectedModel} / ${expectedDimensions}d.`,
          )
        }
        setDocuments(updatedDocuments)
        setNeuralState({
          status: 'ready',
          model: response.model,
          progress: 100,
          message: `Indexed ${pendingChunks.length} chunks with ${response.model}.`,
        })
        return updatedDocuments
      } catch (error) {
        const message = error instanceof NeuralEmbeddingError
          ? error.message
          : 'Neural embedding failed before the source vectors were saved.'
        setNeuralState((current) => ({ ...current, status: 'error', message }))
        throw error
      } finally {
        neuralIndexPromiseRef.current = null
      }
    })()

    neuralIndexPromiseRef.current = task
    return task
  }

  const prepareNeuralQuery = async (nextQuery: string) => {
    setNeuralQueryVector(null)
    setNeuralState((current) => ({ ...current, status: 'indexing', progress: 100, message: 'Embedding query...' }))
    const response = await requestNeuralEmbeddings([nextQuery])
    const queryVector = response.vectors[0]
    if (!queryVector) throw new NeuralEmbeddingError('empty_vector', 'The embedding provider returned no query vector.')
    if (response.dimensions !== PGVECTOR_DIMENSIONS) {
      throw new NeuralEmbeddingError(
        'invalid_dimensions',
        `Tracework requires ${PGVECTOR_DIMENSIONS}-dimensional embeddings for local/database comparison; the provider returned ${response.dimensions}d.`,
      )
    }
    const indexedDocuments = await indexNeuralDocuments(documents, response.model, response.dimensions)
    setNeuralQueryVector(queryVector)
    setNeuralState({ status: 'ready', model: response.model, progress: 100, message: `Neural query ready / ${response.model}` })
    return { indexedDocuments, queryVector, response }
  }

  const runNeuralRetrieval = async (nextQuery: string): Promise<SearchResult[] | null> => {
    try {
      const { indexedDocuments, queryVector } = await prepareNeuralQuery(nextQuery)
      const nextResults = searchDocuments(indexedDocuments, nextQuery, { engine: 'neural', queryVector })
      setActiveQuery(nextQuery)
      return nextResults
    } catch (error) {
      const message = error instanceof NeuralEmbeddingError
        ? error.message
        : 'Neural retrieval failed before the query could be compared.'
      setNeuralState((current) => ({ ...current, status: 'error', message }))
      showNotice('error', message)
      return null
    }
  }

  const mapPgvectorResults = (matches: PgvectorMatch[], currentDocuments: DocumentRecord[], database: string, nextQuery: string): SearchResult[] => {
    const documentsById = new Map(currentDocuments.map((document) => [document.id, document]))
    const queryTokens = tokenize(nextQuery)
    return matches.map((match) => {
      const localDocument = documentsById.get(match.sourceId)
      const localChunk = localDocument?.chunks.find((chunk) => chunk.id === match.id)
      const chunk = localChunk ?? {
        id: match.id,
        documentId: match.sourceId,
        index: match.chunkIndex,
        text: match.content,
        start: match.startOffset,
        end: match.endOffset,
        tokens: tokenize(match.content),
        vector: [],
      }
      const document = localDocument ?? {
        id: match.sourceId,
        title: match.title,
        source: match.sourcePath,
        kind: match.kind,
        content: match.sourceContent,
        createdAt: new Date().toISOString(),
        chunks: [chunk],
      }
      const matchedTerms = [...new Set(queryTokens.filter((term) => chunk.tokens.includes(term)))]
      return {
        chunk,
        document,
        score: Math.max(0, Math.min(1, match.similarity)),
        semanticScore: Math.max(0, Math.min(1, match.similarity)),
        keywordScore: matchedTerms.length / (queryTokens.length || 1),
        matchedTerms,
        engine: 'pgvector',
        distance: match.distance,
        embeddingModel: match.embeddingModel,
        embeddingDimensions: match.embeddingDimensions,
        candidateCount: match.candidateCount,
        database,
      }
    })
  }

  const runGroundedGeneration = async (
    nextQuery: string,
    retrievedResults: SearchResult[],
    options: { retrievalEngine?: string; contextLimit?: number; requestedTopK?: number } = {},
  ) => {
    const assessment = evaluateEvidence(nextQuery, retrievedResults)
    const context = buildGroundedContext(nextQuery, retrievedResults, {
      retrievalEngine: options.retrievalEngine ?? retrievedResults[0]?.engine ?? engine,
      requestedTopK: options.requestedTopK ?? (engine === 'pgvector' ? topK : 8),
      limit: options.contextLimit ?? 5,
    })
    const session: GroundedSession = { context, assessment, answer: null }
    setGroundedSession(session)

    if (assessment.status === 'insufficient') {
      setGroundedSession({ ...session, answer: buildInsufficientAnswer(assessment) })
      setGenerationState({
        status: 'blocked',
        model: null,
        message: 'Generation skipped because the retrieved evidence is insufficient.',
      })
      return
    }

    setGenerationState({ status: 'generating', model: null, message: 'Sending the exact retrieved context to the generation model...' })
    try {
      const response = await requestGroundedAnswer(context)
      const classified = classifyGeneratedAnswer(response.answer, context, {
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        totalTokens: response.totalTokens,
      })

      // An unusable response is a real generation failure. A refusal is not:
      // the model judged the evidence inadequate, which is the outcome the
      // grounding rules are asking for, so it must not require citations.
      if (classified.outcome === 'unusable') {
        throw new GenerationError('invalid_citations', classified.reason)
      }

      setGroundedSession({ ...session, answer: classified.answer })
      setGenerationState({
        status: classified.outcome === 'refused' ? 'refused' : 'ready',
        model: response.model,
        message: classified.reason,
      })
      if (classified.outcome === 'refused') {
        showNotice('info', 'The model refused to answer from the retrieved evidence. Nothing was invented.')
      }
    } catch (error) {
      const message = error instanceof GenerationError
        ? error.message
        : 'The generation stage failed before a grounded answer was returned.'
      setGenerationState((current) => ({ ...current, status: 'error', message }))
      showNotice('error', message)
    }
  }

  const runPgvectorRetrieval = async (nextQuery: string, nextTopK = topK, nextFilter: SourceKind | 'all' = sourceKindFilter): Promise<SearchResult[] | null> => {
    resetGroundedState()
    setPgvectorResults([])
    setPgvectorState((current) => ({ ...current, status: 'syncing', topK: nextTopK, message: 'Preparing neural vectors for database sync...' }))
    try {
      const { indexedDocuments, queryVector, response } = await prepareNeuralQuery(nextQuery)
      setPgvectorState((current) => ({ ...current, status: 'syncing', message: `Syncing ${indexedDocuments.length} sources to pgvector...` }))
      const sync = await requestPgvectorSync(indexedDocuments)
      setPgvectorState((current) => ({ ...current, status: 'searching', database: sync.database, message: `Searching ${sync.syncedChunks} stored chunks...` }))
      const search = await requestPgvectorSearch(queryVector, { limit: nextTopK, sourceKind: nextFilter })
      const nextResults = mapPgvectorResults(search.results, indexedDocuments, search.database, nextQuery)
      setPgvectorResults(nextResults)
      setActiveQuery(nextQuery)
      setPgvectorState({
        status: 'ready',
        database: search.database,
        candidateCount: search.results[0]?.candidateCount ?? 0,
        topK: search.topK,
        message: `${search.results.length} result${search.results.length === 1 ? '' : 's'} returned / ${response.model}`,
      })
      return nextResults
    } catch (error) {
      const message = error instanceof NeuralEmbeddingError || error instanceof PgvectorError
        ? error.message
        : 'Pgvector retrieval failed before the database results were returned.'
      if (error instanceof NeuralEmbeddingError) setNeuralState((current) => ({ ...current, status: 'error', message }))
      setPgvectorState((current) => ({ ...current, status: 'error', message }))
      showNotice('error', message)
      return null
    }
  }

  const runRetrieval = async (nextQuery: string, shouldGenerate = false) => {
    resetGroundedState()
    if (shouldGenerate && compareMode) {
      showNotice('info', 'Choose one retrieval engine before generating so the evidence-to-answer path stays unambiguous.')
      shouldGenerate = false
    }

    let retrievedResults: SearchResult[] | null = null
    if (engine === 'rerank') {
      const dense = await runNeuralRetrieval(nextQuery)
      if (dense) {
        const lexical = toLexicalResults(searchLexical(lexicalIndex, nextQuery, candidateLimit), documents)
        const union = buildCandidateUnion({ dense, lexical, limit: candidateLimit })
        const ranked = rerank(nextQuery, union)
        const contextCandidates = pruningEnabled ? pruneCandidates(ranked, { maxChunks: topK }).selected : ranked
        retrievedResults = contextCandidates.map((candidate) => candidate.result)
      }
    } else if (engine === 'pgvector' || compareMode) {
      retrievedResults = await runPgvectorRetrieval(nextQuery)
    } else if (engine === 'neural') {
      retrievedResults = await runNeuralRetrieval(nextQuery)
    } else {
      retrievedResults = searchDocuments(documents, nextQuery, { engine: 'hashed' })
      setActiveQuery(nextQuery)
    }

    if (shouldGenerate && retrievedResults) {
      await runGroundedGeneration(nextQuery, retrievedResults, engine === 'rerank'
        ? {
            retrievalEngine: 'union-rerank',
            contextLimit: retrievedResults.length,
            requestedTopK: pruningEnabled ? topK : retrievedResults.length,
          }
        : undefined)
    }
  }

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextQuery = query.trim()
    if (!nextQuery) {
      showNotice('info', 'Ask a specific question so the index has something to retrieve.')
      return
    }
    void runRetrieval(nextQuery, answerMode === 'grounded')
  }

  const handleIndexNote = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!noteContent.trim()) {
      showNotice('error', 'Paste a note or code excerpt before indexing it.')
      return
    }
    const document = createDocument(noteTitle, noteSource, noteContent, 'note')
    setDocuments((current) => [document, ...current])
    resetRetrievalState()
    setNoteTitle('')
    setNoteSource('')
    setNoteContent('')
    showNotice('success', `${document.title} indexed as ${document.chunks.length} searchable ${document.chunks.length === 1 ? 'chunk' : 'chunks'}.`)
  }

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    if (!files.length) return
    setIsReadingFiles(true)
    try {
      const imported = await Promise.all(files.map(async (file) => {
        const content = await file.text()
        return createDocument(file.name, file.name, content, 'file')
      }))
      setDocuments((current) => [...imported, ...current])
      resetRetrievalState()
      showNotice('success', `${imported.length} ${imported.length === 1 ? 'file' : 'files'} indexed locally.`)
    } catch {
      showNotice('error', 'The file could not be read in this browser. Try pasting its text instead.')
    } finally {
      setIsReadingFiles(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleLoadSamples = () => {
    const hasSamples = documents.some((document) => document.kind === 'sample')
    if (hasSamples) {
      showNotice('info', 'The synthetic workshop sources are already in this index.')
      return
    }
    setDocuments((current) => [...buildSampleCorpus(), ...current])
    resetRetrievalState()
    showNotice('success', 'Three synthetic workshop sources added for the retrieval exercise.')
  }

  const handleClear = () => {
    const sourceIds = documents.map((document) => document.id)
    setDocuments([])
    setCompareMode(false)
    if (pgvectorState.database) {
      void requestPgvectorDelete(sourceIds).catch((error) => {
        if (error instanceof PgvectorError) showNotice('error', `Local index cleared, but database cleanup failed: ${error.message}`)
      })
    }
    resetRetrievalState()
    showNotice('info', 'Index cleared. Your browser copy is empty; imported files on disk are untouched.')
  }

  const handleExample = (example: string) => {
    setQuery(example)
    void runRetrieval(example, answerMode === 'grounded')
  }

  const handleEngineChange = (nextEngine: RetrievalEngine) => {
    setEngine(nextEngine)
    setCompareMode(false)
    resetGroundedState()
    if (nextEngine === 'hashed') {
      setActiveQuery(activeQuery)
      return
    }
    if (nextEngine === 'pgvector') {
      void runPgvectorRetrieval(activeQuery)
      return
    }
    if (nextEngine === 'rerank') {
      void runNeuralRetrieval(activeQuery)
      return
    }
    void runNeuralRetrieval(activeQuery)
  }

  const handleAnswerModeChange = (nextMode: AnswerMode) => {
    setAnswerMode(nextMode)
    resetGroundedState()
  }

  const handleCompare = () => {
    setEngine('neural')
    setCompareMode(true)
    resetGroundedState()
    void runPgvectorRetrieval(activeQuery)
  }

  const handleTopKChange = (nextValue: string) => {
    const nextTopK = Number(nextValue)
    if (![1, 3, 5, 10, 20].includes(nextTopK)) return
    setTopK(nextTopK)
    if (engine === 'pgvector' || compareMode) void runPgvectorRetrieval(activeQuery, nextTopK)
  }

  const handleCandidateLimitChange = (nextValue: string) => {
    const nextLimit = Number(nextValue)
    if (![5, 8, 10, 15, 20].includes(nextLimit)) return
    setCandidateLimit(nextLimit)
  }

  const handleSourceKindFilterChange = (nextValue: string) => {
    if (nextValue !== 'all' && !['note', 'file', 'sample'].includes(nextValue)) return
    const nextFilter = nextValue as SourceKind | 'all'
    setSourceKindFilter(nextFilter)
    if (engine === 'pgvector' || compareMode) void runPgvectorRetrieval(activeQuery, topK, nextFilter)
  }

  const selectComparisonResult = (nextEngine: RetrievalEngine, chunkId: string) => {
    setEngine(nextEngine)
    resetGroundedState()
    setSelectedChunkId(chunkId)
  }

  const removeDocument = (documentId: string) => {
    const document = documents.find((item) => item.id === documentId)
    setDocuments((current) => current.filter((item) => item.id !== documentId))
    if (document && pgvectorState.database) {
      void requestPgvectorDelete([document.id]).catch((error) => {
        if (error instanceof PgvectorError) showNotice('error', `Source removed locally, but database cleanup failed: ${error.message}`)
      })
    }
    resetRetrievalState()
    if (document) showNotice('info', `${document.title} removed from the local index.`)
  }

  return (
    <div className="app-frame">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Tracework home">
          <span className="brand-mark"><Icon name="target" size={22} /></span>
          <span className="brand-copy">
            <span className="brand-name">Tracework</span>
            <span className="brand-subtitle">personal knowledge brain</span>
          </span>
        </a>
        <div className="topbar-status">
          <span className="live-dot" aria-hidden="true" />
          <span>local index</span>
          <span className="status-divider" aria-hidden="true" />
          <span>{documents.length} sources / {chunkCount} chunks</span>
          <button className="clear-button" type="button" onClick={handleClear} disabled={!documents.length}>clear index</button>
        </div>
      </header>

      <div className="workspace-grid">
        <aside className="capture-rail" aria-label="Ingest sources">
          <div className="rail-heading">
            <span className="rail-code">capture / 01</span>
            <h2>Feed the index</h2>
            <p>Start with one note or a text-based file. Every passage keeps its source trail.</p>
          </div>

          <form className="capture-form" onSubmit={handleIndexNote}>
            <label>
              <span>title</span>
              <input value={noteTitle} onChange={(event) => setNoteTitle(event.target.value)} placeholder="e.g. search-notes.md" />
            </label>
            <label>
              <span>source path / context</span>
              <input value={noteSource} onChange={(event) => setNoteSource(event.target.value)} placeholder="e.g. personal / project" />
            </label>
            <label>
              <span>content</span>
              <textarea value={noteContent} onChange={(event) => setNoteContent(event.target.value)} placeholder="Paste a note, code excerpt, or documentation..." rows={7} />
            </label>
            <button className="primary-button" type="submit">
              <Icon name="plus" size={17} />
              index note
              <Icon name="arrow" size={17} />
            </button>
          </form>

          <div className="file-actions">
            <label className="secondary-button">
              <Icon name="upload" size={16} />
              {isReadingFiles ? 'reading files...' : 'choose text files'}
              <input ref={fileInputRef} type="file" multiple accept=".txt,.md,.mdx,.ts,.tsx,.js,.jsx,.json,.css,.html,.py,.sql,.yaml,.yml,.csv" onChange={handleFiles} disabled={isReadingFiles} />
            </label>
            <button className="text-button" type="button" onClick={handleLoadSamples}>
              <Icon name="spark" size={15} />
              load synthetic sources
            </button>
          </div>

          <div className="loop-block">
            <span className="rail-code">the loop</span>
            <ol className="pipeline-list">
              <li className={documents.length ? 'is-complete' : ''}><span className="pipeline-index">01</span><span>capture</span><Icon name={documents.length ? 'check' : 'arrow'} size={15} /></li>
              <li className={chunkCount ? 'is-complete' : ''}><span className="pipeline-index">02</span><span>split</span><Icon name={chunkCount ? 'check' : 'arrow'} size={15} /></li>
              <li className={vectorStepComplete ? 'is-complete' : vectorStepActive ? 'is-active' : ''}><span className="pipeline-index">03</span><span>{vectorStepLabel}</span><Icon name={vectorStepActive ? 'spark' : vectorStepComplete ? 'check' : 'arrow'} size={15} /></li>
              <li className={results.length ? 'is-active' : ''}><span className="pipeline-index">04</span><span>retrieve</span><Icon name={results.length ? 'check' : 'arrow'} size={15} /></li>
            </ol>
          </div>

          <div className="rail-footer">
            <div><span>engine</span><strong>{engine === 'pgvector' ? 'supabase pgvector' : engine === 'neural' ? neuralState.model ?? 'local neural embeddings' : engine === 'lexical' ? 'bm25 lexical index' : engine === 'hybrid' ? `rrf / ${denseSourceLabel} + bm25` : engine === 'rerank' ? 'union / transparent-v1' : compareMode ? 'local neural + pgvector' : 'local hashed vectors'}</strong></div>
            <div><span>vocabulary</span><strong>{indexedTerms.toLocaleString()} terms</strong></div>
            <div><span>memory</span><strong>{formatBytes(new Blob([JSON.stringify(documents)]).size)}</strong></div>
          </div>
        </aside>

        <main className="main-workbench">
          <section className="query-section" aria-labelledby="page-title">
            <div className="section-marker"><span className="marker-line" /> question / retrieve <span className="marker-line short" /></div>
            <h1 id="page-title">Ask your material<br /><em>a better question.</em></h1>
            <p className="intro-copy">A local, source-grounded memory for the things you have already built, read, and learned.</p>
            <form className="query-form" onSubmit={handleSearch}>
              <Icon name="search" size={21} />
              <input aria-label="Search your indexed material" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ask your indexed material..." />
              <button type="submit">retrieve <Icon name="arrow" size={17} /></button>
            </form>
            <div className="example-row" aria-label="Example questions">
              <span>try a trace</span>
              {examples.map((example) => <button key={example} type="button" onClick={() => handleExample(example)}>{example}</button>)}
            </div>
          </section>

          <section className="answer-sheet" aria-labelledby="answer-title">
            <div className="sheet-topline">
              <div className="signal-label"><span className="signal-dot" /> retrieval lab</div>
              <div className="sheet-controls">
                <div className="engine-controls" role="group" aria-label="Retrieval engine">
                  <span className="engine-label">engine</span>
                  <button className={`engine-option ${engine === 'hashed' ? 'is-active' : ''}`} type="button" onClick={() => handleEngineChange('hashed')}>hashed baseline</button>
                  <button className={`engine-option ${engine === 'neural' ? 'is-active' : ''}`} type="button" onClick={() => handleEngineChange('neural')}>local neural</button>
                  <button className={`engine-option ${engine === 'pgvector' ? 'is-active' : ''}`} type="button" onClick={() => handleEngineChange('pgvector')}>pgvector</button>
                  <button className={`engine-option ${engine === 'lexical' ? 'is-active' : ''}`} type="button" onClick={() => handleEngineChange('lexical')}>lexical bm25</button>
                  <button className={`engine-option ${engine === 'hybrid' ? 'is-active' : ''}`} type="button" onClick={() => handleEngineChange('hybrid')}>hybrid rrf</button>
                  <button className={`engine-option ${engine === 'rerank' ? 'is-active' : ''}`} type="button" onClick={() => handleEngineChange('rerank')}>union rerank</button>
                  <button className={`compare-button ${compareMode ? 'is-active' : ''}`} type="button" onClick={handleCompare} disabled={neuralState.status === 'indexing' || ['syncing', 'searching'].includes(pgvectorState.status)}>compare</button>
                </div>
                <span className="control-divider" aria-hidden="true" />
                <div className="answer-mode-controls" role="group" aria-label="Answer mode">
                  <span className="engine-label">answer</span>
                  <button className={`engine-option ${answerMode === 'retrieval' ? 'is-active' : ''}`} type="button" onClick={() => handleAnswerModeChange('retrieval')}>retrieval only</button>
                  <button className={`engine-option ${answerMode === 'grounded' ? 'is-active' : ''}`} type="button" onClick={() => handleAnswerModeChange('grounded')}>grounded answer</button>
                </div>
              </div>
            </div>
            <div className="neural-status-row" role="status" aria-live="polite">
              <span className="method-label">{engine === 'pgvector' ? 'pgvector / database cosine search' : engine === 'neural' ? 'local neural / semantic similarity' : engine === 'lexical' ? 'lexical / bm25 over title, path, and body' : engine === 'hybrid' ? `hybrid / reciprocal rank fusion of ${denseSourceLabel} + bm25` : engine === 'rerank' ? 'phase 5B / dense + lexical union / relevance-only rerank' : 'baseline / hashed vector + term overlap'}</span>
              <span className={`neural-state-label is-${activeStatus}`}>
                {activeStatus === 'indexing'
                  ? `${neuralState.progress}% / ${activeStatusMessage}`
                  : activeStatus === 'syncing' || activeStatus === 'searching'
                    ? activeStatusMessage
                    : activeStatusMessage}
              </span>
            </div>
            <div className="answer-layout">
              <div className="answer-copy">
                <div className="answer-count">{answerMode === 'grounded' ? 'grounded answer' : 'retrieval draft'} / {String(visibleCitations.length).padStart(2, '0')}</div>
                <div className={`evidence-badge is-${evidenceAssessment.status}`}><span /> evidence / {evidenceAssessment.status}<small>best {Math.round(evidenceAssessment.bestScore * 100)}% · {evidenceAssessment.candidateChunksAboveFloor} candidate</small></div>
                <h2 id="answer-title">{visibleAnswerTitle}</h2>
                <p className={answerMode === 'grounded' ? 'grounded-answer-body' : undefined}>{visibleAnswerBody}</p>
              </div>
              <div className="citation-stack" aria-label="Answer sources">
                {visibleCitations.length ? visibleCitations.map((result, index) => (
                  <button className="citation-line" key={result.chunk.id} type="button" onClick={() => setSelectedChunkId(result.chunk.id)}>
                    <span className="citation-number">[{visibleCitationNumbers[index] ?? index + 1}]</span>
                    <span><strong>{result.document.title}</strong><small>chunk {String(result.chunk.index + 1).padStart(2, '0')} · {Math.round(result.score * 100)}% match</small></span>
                    <span className="citation-extra-meta"><small>{result.document.source} Â· {result.document.kind}</small><small>similarity {result.score.toFixed(4)} Â· distance {result.distance === undefined ? 'n/a' : result.distance.toFixed(4)}</small><small>{result.embeddingModel ?? result.chunk.neuralEmbedding?.model ?? 'local'} / {result.embeddingDimensions ?? result.chunk.neuralEmbedding?.dimensions ?? result.chunk.vector.length}d</small></span>
                    <Icon name="arrow" size={16} />
                  </button>
                )) : <div className="citation-empty">{answerMode === 'grounded' ? 'Validated citations will appear here after generation.' : 'Results will leave a visible source trail here.'}</div>}
              </div>
            </div>
          </section>

          {(engine === 'lexical' || engine === 'hybrid') && <section className="retrieval-explain-section" aria-labelledby="retrieval-explain-title">
            <div className="grounded-debug-heading">
              <div>
                <div className="section-marker"><span className="marker-line" /> retrieval / why it ranked <span className="marker-line short" /></div>
                <h2 id="retrieval-explain-title">Two rankers, side by side.</h2>
              </div>
              <span className="grounded-debug-state is-sent">rrf k={RRF_K}</span>
            </div>
            <div className="retrieval-explain-grid">
              <div className="retrieval-column">
                <h3>dense / {denseSourceLabel}</h3>
                {denseResultsForFusion.slice(0, 5).map((result, index) => (
                  <div className="retrieval-row" key={`dense-${result.chunk.id}`}>
                    <span className="retrieval-rank">{index + 1}</span>
                    <span><strong>{result.document.title}</strong><small>similarity {result.score.toFixed(4)}{result.distance === undefined ? '' : ` · distance ${result.distance.toFixed(4)}`}</small></span>
                  </div>
                ))}
                {denseResultsForFusion.length ? null : <div className="retrieval-empty">No dense ranking yet. Run pgvector or local neural retrieval.</div>}
              </div>
              <div className="retrieval-column">
                <h3>lexical / bm25</h3>
                {lexicalResults.slice(0, 5).map((result, index) => (
                  <div className="retrieval-row" key={`lexical-${result.chunk.id}`}>
                    <span className="retrieval-rank">{index + 1}</span>
                    <span>
                      <strong>{result.document.title}</strong>
                      <small>bm25 {result.lexicalScore?.toFixed(4) ?? 'n/a'} · title {result.lexicalFieldHits?.title ?? 0} · path {result.lexicalFieldHits?.path ?? 0} · body {result.lexicalFieldHits?.body ?? 0}</small>
                      <small>matched: {result.matchedTerms.join(', ') || 'none'}</small>
                    </span>
                  </div>
                ))}
                {lexicalResults.length ? null : <div className="retrieval-empty">No lexical match for this query.</div>}
              </div>
              <div className="retrieval-column">
                <h3>hybrid / rrf</h3>
                {hybridResults.slice(0, 5).map((result, index) => (
                  <div className="retrieval-row" key={`hybrid-${result.chunk.id}`}>
                    <span className="retrieval-rank">{index + 1}</span>
                    <span>
                      <strong>{result.document.title}</strong>
                      <small>rrf {result.fusion?.rrfScore.toFixed(6) ?? 'n/a'} = dense {result.fusion?.denseContribution.toFixed(6) ?? '0'} + lexical {result.fusion?.lexicalContribution.toFixed(6) ?? '0'}</small>
                      <small>dense rank {result.fusion?.denseRank ?? 'absent'} · lexical rank {result.fusion?.lexicalRank ?? 'absent'}</small>
                    </span>
                  </div>
                ))}
                {hybridResults.length ? null : <div className="retrieval-empty">Nothing to fuse yet.</div>}
              </div>
            </div>
            <p className="grounded-debug-note">Reciprocal rank fusion scores each chunk as the sum of 1 / (k + rank) across both rankings, with k = {RRF_K}. A chunk found by only one ranker keeps a single contribution, which is why a strong lexical-only hit can still lose to a chunk both rankers placed moderately well. BM25 scores are unbounded and are not comparable to cosine similarity.</p>
          </section>}

          {engine === 'rerank' && <section className="phase5b-section" aria-labelledby="phase5b-title">
            <div className="phase5b-heading">
              <div>
                <div className="section-marker"><span className="marker-line" /> phase 5B / candidate inspection <span className="marker-line short" /></div>
                <h2 id="phase5b-title">Keep the evidence union intact.</h2>
              </div>
              <span className="phase5b-badge">transparent-v1 / relevance only</span>
            </div>
            <div className="phase5b-controls">
              <label><span>dense / lexical top N</span><select value={candidateLimit} onChange={(event) => handleCandidateLimitChange(event.target.value)}><option value="5">5</option><option value="8">8</option><option value="10">10</option><option value="15">15</option><option value="20">20</option></select></label>
              <label><span>context top K</span><select value={topK} onChange={(event) => handleTopKChange(event.target.value)}><option value="1">1</option><option value="3">3</option><option value="5">5</option><option value="10">10</option><option value="20">20</option></select></label>
              <label className="phase5b-toggle"><input type="checkbox" checked={pruningEnabled} onChange={(event) => setPruningEnabled(event.target.checked)} /><span>prune context</span><small>{pruningEnabled ? 'relevance floor + context cap' : 'send the full reranked pool'}</small></label>
            </div>
            {!phase5bDenseResults.length && <div className="phase5b-warning" role="status">The lexical side is ready, but the dense side has no neural vectors yet. Run the query again after configuring the neural provider to measure the full union.</div>}
            <div className="phase5b-stat-grid">
              <div><span>candidates considered</span><strong>{phase5bUnion.length}</strong><small>dense {Math.min(candidateLimit, phase5bDenseResults.length)} + lexical {Math.min(candidateLimit, lexicalResults.length)} before dedupe</small></div>
              <div><span>reranked candidates</span><strong>{phase5bRankedCandidates.length}</strong><small>every union row keeps its original ranks</small></div>
              <div><span>context selected</span><strong>{phase5bContextCandidates.length}</strong><small>{pruningEnabled ? 'after relevance pruning' : 'no pruning applied'}</small></div>
              <div><span>chunks rejected</span><strong>{pruningEnabled ? phase5bPruning.rejected.length : 0}</strong><small>{pruningEnabled ? 'inspect rejection reasons below' : 'full reranked pool remains available'}</small></div>
            </div>
            <div className="phase5b-lists">
              <Phase5BList
                title={`DENSE / ${phase5bDenseResults[0]?.engine ?? 'neural'}`}
                description="Raw dense order. No fusion or reranking is applied here."
                items={phase5bDenseResults.slice(0, candidateLimit).map((result, index) => ({
                  id: result.chunk.id,
                  rank: index + 1,
                  title: result.document.title,
                  detail: `chunk ${String(result.chunk.index + 1).padStart(2, '0')} · similarity ${result.score.toFixed(4)}`,
                  score: `${Math.round(result.score * 100)}%`,
                }))}
                emptyMessage="No dense candidates."
                onSelect={setSelectedChunkId}
              />
              <Phase5BList
                title="LEXICAL / BM25"
                description="Raw lexical order, including title and path field hits."
                items={lexicalResults.slice(0, candidateLimit).map((result, index) => ({
                  id: result.chunk.id,
                  rank: index + 1,
                  title: result.document.title,
                  detail: `bm25 ${result.lexicalScore?.toFixed(4) ?? 'n/a'} · matched ${result.matchedTerms.join(', ') || 'none'}`,
                  score: `${Math.round(result.score * 100)}%`,
                }))}
                emptyMessage="No lexical candidates."
                onSelect={setSelectedChunkId}
              />
              <Phase5BList
                title="UNION / DEDUPED"
                description="First-seen inspection order. A chunk appears once, with both rankers' metadata attached."
                items={phase5bUnion.map((candidate) => ({
                  id: candidate.result.chunk.id,
                  rank: candidate.unionRank,
                  title: candidate.result.document.title,
                  detail: `dense ${candidate.retrieval.denseRank ?? '—'} · lexical ${candidate.retrieval.lexicalRank ?? '—'} · ${candidate.retrieval.appearedIn}`,
                  score: candidate.retrieval.appearedIn,
                }))}
                emptyMessage="The candidate union is empty."
                onSelect={setSelectedChunkId}
              />
              <Phase5BList
                title="RERANKED / RELEVANCE"
                description="Every candidate is scored for this question only. Trust, recency, and contradiction are deliberately absent."
                items={phase5bRankedCandidates.map((candidate) => {
                  const decision = phase5bDecisionByChunkId.get(candidate.result.chunk.id)
                  return {
                    id: candidate.result.chunk.id,
                    rank: candidate.rerankedRank,
                    title: candidate.result.document.title,
                    detail: `from union #${candidate.originalUnionRank} · dense ${candidate.retrieval.denseRank ?? '—'} · lexical ${candidate.retrieval.lexicalRank ?? '—'}`,
                    score: `${Math.round(candidate.relevanceScore * 100)}%`,
                    status: pruningEnabled ? decision?.selected ? 'selected' : 'rejected' : candidate.relevanceLabel,
                    isRejected: pruningEnabled && decision ? !decision.selected : false,
                  }
                })}
                emptyMessage="Nothing was reranked."
                onSelect={setSelectedChunkId}
              />
              <Phase5BList
                title="CONTEXT / SELECTED"
                description={pruningEnabled ? 'The separate pruning decision sent only these rows toward generation.' : 'Pruning is off: the complete reranked pool remains available to generation.'}
                items={phase5bContextCandidates.map((candidate, index) => ({
                  id: candidate.result.chunk.id,
                  rank: index + 1,
                  title: candidate.result.document.title,
                  detail: `rerank #${candidate.rerankedRank} · ${candidate.relevanceReason}`,
                  score: `[${index + 1}] ${Math.round(candidate.relevanceScore * 100)}%`,
                }))}
                emptyMessage="No candidates cleared the context selection floor. Grounded generation will refuse."
                onSelect={setSelectedChunkId}
              />
            </div>
            {pruningEnabled && phase5bPruning.rejected.length ? <div className="phase5b-rejection-log">
              <span className="phase5b-rejection-label">rejection log</span>
              {phase5bPruning.rejected.map((decision) => <button key={decision.candidate.result.chunk.id} type="button" onClick={() => setSelectedChunkId(decision.candidate.result.chunk.id)}><strong>{decision.candidate.result.document.title}</strong><span>rerank #{decision.candidate.rerankedRank} · {decision.reason}</span></button>)}
            </div> : null}
            <p className="grounded-debug-note">The reranker is a deterministic relevance experiment, not a source-trust, recency, or contradiction model. Use the inspector to see why a row moved from its union position to its new rank.</p>
          </section>}

          {answerMode === 'grounded' && <section className="grounded-debug-section" aria-labelledby="grounded-debug-title">
            <div className="grounded-debug-heading">
              <div>
                <div className="section-marker"><span className="marker-line" /> grounded pipeline / context <span className="marker-line short" /></div>
                <h2 id="grounded-debug-title">What the model actually sees.</h2>
              </div>
              <span className={`grounded-debug-state is-${groundedContextWasSent ? 'sent' : groundedSession ? 'blocked' : 'preview'}`}>{groundedContextStateLabel}</span>
            </div>
            <div className="grounded-debug-grid">
              <div className="grounded-debug-query"><span>question</span><strong>{contextForInspector.question}</strong></div>
              <div><span>knowledge base</span><strong>{documents.length} sources / {chunkCount} chunks</strong></div>
              <div><span>retrieved</span><strong>{results.length} chunks</strong></div>
              <div><span>sent to LLM</span><strong>{groundedContextWasSent ? contextForInspector.chunks.length : 'not yet'}</strong></div>
              <div><span>context size</span><strong>{contextForInspector.characters.toLocaleString()} chars / ~{contextForInspector.approximateTokens.toLocaleString()} tokens</strong></div>
              <div><span>evidence status</span><strong className={`evidence-text is-${evidenceAssessment.status}`}>{evidenceAssessment.status}</strong></div>
              <div><span>embedding</span><strong>{contextForInspector.embeddingModel ?? 'local / unknown'}{contextForInspector.embeddingDimensions ? ` / ${contextForInspector.embeddingDimensions}d` : ''}</strong></div>
              <div><span>generation</span><strong>{generationDebugLabel}</strong></div>
            </div>
            <div className="grounded-context-list">
              {contextForInspector.chunks.length ? contextForInspector.chunks.map((chunk) => (
                <div className="grounded-context-chunk" key={chunk.result.chunk.id}>
                  <button type="button" onClick={() => setSelectedChunkId(chunk.result.chunk.id)}>
                    <span className="citation-number">[{chunk.citation}]</span>
                    <span><strong>{chunk.result.document.title}</strong><small>{chunk.result.document.source} · chunk {String(chunk.result.chunk.index + 1).padStart(2, '0')} · similarity {chunk.result.score.toFixed(4)}{chunk.result.distance === undefined ? '' : ` · distance ${chunk.result.distance.toFixed(4)}`}</small></span>
                    <Icon name="arrow" size={15} />
                  </button>
                  {chunk.warnings.length ? <div className="grounded-chunk-warning">source text was modified before sending: {chunk.warnings.join('; ')}</div> : null}
                  <pre>{chunk.formatted}</pre>
                </div>
              )) : <div className="grounded-context-empty">No retrieved chunks are available. Generation will refuse to invent an answer.</div>}
            </div>
            <p className="grounded-debug-note">{groundedContextWasSent ? 'This is the exact context snapshot supplied to the generation route.' : groundedSession ? 'Generation was skipped because the evidence was insufficient; this is the context that was evaluated.' : 'Preview only: these chunks will be sent after you press retrieve in grounded answer mode.'} Evidence status is calculated from observable retrieval scores, the number of candidate chunks above the evidence floor, and distinct source count; it is not an LLM confidence percentage, and it does not yet measure whether a candidate chunk answers the question.</p>
          </section>}

          {compareMode && <section className="comparison-section" aria-labelledby="comparison-title">
            <div className="comparison-heading">
              <div>
                <div className="section-marker"><span className="marker-line" /> comparison / same query <span className="marker-line short" /></div>
                <h2 id="comparison-title">One vector, two homes.</h2>
              </div>
              <span>{activeQuery}</span>
            </div>
            <div className="comparison-grid">
              <ComparisonColumn
                tone="neural"
                title="local neural"
                description="The same provider-generated vectors searched in browser memory. This is the local semantic baseline."
                results={neuralResults}
                emptyMessage={neuralState.status === 'error' ? neuralState.message ?? 'The local neural provider returned an error.' : 'Run local neural retrieval to populate this column.'}
                onSelect={(chunkId) => selectComparisonResult('neural', chunkId)}
              />
              <ComparisonColumn
                tone="pgvector"
                title="pgvector"
                description="Those vectors persisted in PostgreSQL and ranked by the database with cosine distance."
                results={pgvectorResults}
                emptyMessage={pgvectorState.status === 'error' ? pgvectorState.message ?? 'The pgvector provider returned an error.' : 'Run pgvector to populate this column.'}
                onSelect={(chunkId) => selectComparisonResult('pgvector', chunkId)}
              />
            </div>
            <p className="comparison-note">The vectors should usually rank similarly because both methods use the same embedding model. If they differ, inspect the database filter, top-K, distance, and source metadata.</p>
          </section>}

          {hasPgvectorSearch && <section className="vector-debug-section" aria-labelledby="vector-debug-title">
            <div className="vector-debug-heading">
              <div>
                <div className="section-marker"><span className="marker-line" /> vector search / debug <span className="marker-line short" /></div>
                <h2 id="vector-debug-title">The database is visible.</h2>
              </div>
              <span>{pgvectorState.database}</span>
            </div>
            <div className="vector-debug-grid">
              <div className="vector-debug-query"><span>query</span><strong>{activeQuery}</strong></div>
              <div><span>embedding generated</span><strong className="debug-ok">yes / {PGVECTOR_DIMENSIONS}d</strong></div>
              <div><span>database</span><strong>PostgreSQL + pgvector</strong></div>
              <div><span>candidate chunks</span><strong>{pgvectorState.candidateCount}</strong></div>
              <label><span>top K</span><select value={topK} onChange={(event) => handleTopKChange(event.target.value)}><option value="1">1</option><option value="3">3</option><option value="5">5</option><option value="10">10</option><option value="20">20</option></select></label>
              <label><span>source filter</span><select value={sourceKindFilter} onChange={(event) => handleSourceKindFilterChange(event.target.value)}><option value="all">all sources</option><option value="note">pasted notes</option><option value="file">local files</option><option value="sample">synthetic sources</option></select></label>
            </div>
            {topPgvectorResult && <div className="vector-debug-result">
              <div><span>result #1</span><strong>{topPgvectorResult.document.title} / chunk {String(topPgvectorResult.chunk.index + 1).padStart(2, '0')}</strong></div>
              <div><span>vector distance</span><strong>{topPgvectorResult.distance?.toFixed(4) ?? 'n/a'}</strong></div>
              <div><span>similarity</span><strong>{Math.round(topPgvectorResult.score * 100)}%</strong></div>
              <div><span>embedding</span><strong>{topPgvectorResult.embeddingModel ?? 'unknown'} / {topPgvectorResult.embeddingDimensions ?? PGVECTOR_DIMENSIONS}d</strong></div>
            </div>}
          </section>}

          <section className="results-section" aria-labelledby="evidence-title">
            <div className="results-heading">
              <div>
                <div className="section-marker"><span className="marker-line" /> evidence / ranked <span className="marker-line short" /></div>
                <h2 id="evidence-title">The evidence stream</h2>
              </div>
              <span className="result-count">{results.length ? `top ${String(results.length).padStart(2, '0')} passages` : 'nothing retrieved'}</span>
            </div>

            {results.length ? <div className="results-list">
              {results.map((result, index) => {
                const isSelected = selectedResult?.chunk.id === result.chunk.id
                return (
                  <button className={`result-row ${isSelected ? 'is-selected' : ''}`} key={result.chunk.id} type="button" onClick={() => setSelectedChunkId(result.chunk.id)}>
                    <span className="result-rank">{String(index + 1).padStart(2, '0')}</span>
                    <span className="result-body">
                      <span className="result-meta"><span>{sourceLabel(result.document)}</span><span className="result-source">{result.document.source}</span></span>
                      <strong>{result.document.title}<span className="chunk-mark"> / chunk {String(result.chunk.index + 1).padStart(2, '0')}</span></strong>
                      <span className="result-snippet"><HighlightedText text={result.chunk.text.slice(0, 280)} terms={result.matchedTerms} /></span>
                      <span className="result-tags">{result.matchedTerms.slice(0, 5).map((term) => <span key={term}>{term}</span>)}</span>
                    </span>
                    <span className="result-score"><strong>{Math.round(result.score * 100)}%</strong><small>match</small></span>
                    <Icon name="chevron" size={17} className="result-chevron" />
                  </button>
                )
              })}
            </div> : <div className="empty-results">
              <div className="empty-icon"><Icon name="search" size={23} /></div>
              <div><h3>The stream is quiet.</h3><p>Index a note or load the synthetic sources, then ask a question with a named concept or file.</p></div>
            </div>}
          </section>
        </main>

        <aside className="inspector-panel" aria-label="Selected evidence inspector">
          <div className="inspector-header">
            <div>
              <span className="rail-code">inspect / 03</span>
              <h2>Source inspector</h2>
            </div>
            <span className="inspector-state">{selectedResult ? 'selected' : 'waiting'}</span>
          </div>

          {selectedResult ? <>
            <div className="selected-source">
              <span className="source-type"><Icon name="file" size={15} /> {sourceLabel(selectedResult.document)}</span>
              <h3>{selectedResult.document.title}</h3>
              <p>{selectedResult.document.source}</p>
              <button type="button" onClick={() => removeDocument(selectedResult.document.id)}><Icon name="close" size={14} /> remove from index</button>
            </div>

            <div className="inspector-section">
              <div className="inspector-label"><span>retrieved passage</span><span>{selectedResult.chunk.start}—{selectedResult.chunk.end} chars</span></div>
              <div className="passage-text"><HighlightedText text={selectedResult.chunk.text} terms={selectedResult.matchedTerms} /></div>
            </div>

            <div className="inspector-section score-section">
              <div className="inspector-label"><span>why this matched</span><span>{selectedResult.engine === 'hashed' ? 'hybrid score' : selectedResult.engine === 'pgvector' ? 'database score' : 'semantic score'}</span></div>
              <div className="score-row"><span>{selectedResult.engine === 'hashed' ? 'local vector' : selectedResult.engine === 'pgvector' ? 'pgvector similarity' : 'neural vector'}</span><strong>{Math.round(selectedResult.semanticScore * 100)}%</strong><span className="score-track"><span style={{ width: `${Math.round(selectedResult.semanticScore * 100)}%` }} /></span></div>
              {selectedResult.engine === 'pgvector' && <div className="score-row"><span>cosine distance</span><strong>{selectedResult.distance?.toFixed(4) ?? 'n/a'}</strong><span className="score-track"><span className="is-secondary" style={{ width: `${Math.round((1 - (selectedResult.distance ?? 1)) * 100)}%` }} /></span></div>}
              {selectedResult.engine !== 'pgvector' && <div className="score-row"><span>{selectedResult.engine === 'neural' ? 'term diagnostic' : 'term overlap'}</span><strong>{Math.round(selectedResult.keywordScore * 100)}%</strong><span className="score-track"><span className="is-secondary" style={{ width: `${Math.round(selectedResult.keywordScore * 100)}%` }} /></span></div>}
            </div>

            {selectedPhase5bCandidate && <div className="inspector-section phase5b-inspector-section">
              <div className="inspector-label"><span>phase 5B relevance</span><span>{selectedPhase5bDecision?.selected ? 'context selected' : pruningEnabled ? 'context rejected' : 'full pool'}</span></div>
              <div className="phase5b-inspector-score"><strong>{Math.round(selectedPhase5bCandidate.relevanceScore * 100)}%</strong><span className={`phase5b-label is-${selectedPhase5bCandidate.relevanceLabel}`}>{selectedPhase5bCandidate.relevanceLabel}</span></div>
              <div className="score-track"><span style={{ width: `${Math.round(selectedPhase5bCandidate.relevanceScore * 100)}%` }} /></div>
              <dl className="phase5b-inspector-grid">
                <div><dt>union rank</dt><dd>#{selectedPhase5bCandidate.originalUnionRank}</dd></div>
                <div><dt>reranked rank</dt><dd>#{selectedPhase5bCandidate.rerankedRank}</dd></div>
                <div><dt>dense rank</dt><dd>{selectedPhase5bCandidate.retrieval.denseRank ?? 'absent'}</dd></div>
                <div><dt>lexical rank</dt><dd>{selectedPhase5bCandidate.retrieval.lexicalRank ?? 'absent'}</dd></div>
                <div><dt>candidate pool</dt><dd>{selectedPhase5bCandidate.retrieval.appearedIn}</dd></div>
                <div><dt>context</dt><dd>{selectedPhase5bDecision?.selected ? 'selected' : pruningEnabled ? 'rejected' : 'not pruned'}</dd></div>
              </dl>
              <p className="phase5b-reason">{selectedPhase5bCandidate.relevanceReason}</p>
              {selectedPhase5bDecision && !selectedPhase5bDecision.selected && <p className="phase5b-rejection-reason">pruning: {selectedPhase5bDecision.reason}</p>}
            </div>}

            <div className="inspector-section provenance-section">
              <div className="inspector-label"><span>provenance</span><span>stable</span></div>
              <dl>
                <div><dt>document id</dt><dd>{selectedResult.document.id.slice(-8)}</dd></div>
                <div><dt>chunk id</dt><dd>{String(selectedResult.chunk.index + 1).padStart(2, '0')} / {selectedResult.document.chunks.length}</dd></div>
                <div><dt>embedding</dt><dd>{selectedResult.engine === 'pgvector' ? `${selectedResult.embeddingModel ?? 'unknown'} / ${selectedResult.embeddingDimensions ?? PGVECTOR_DIMENSIONS}d` : selectedResult.engine === 'neural' && selectedResult.chunk.neuralEmbedding ? `${selectedResult.chunk.neuralEmbedding.model} / ${selectedResult.chunk.neuralEmbedding.dimensions}d` : `hashed-v1 / ${selectedResult.chunk.vector.length}d`}</dd></div>
                {selectedResult.engine === 'pgvector' && <div><dt>database</dt><dd>{selectedResult.database ?? 'Supabase pgvector'}</dd></div>}
              </dl>
            </div>

            <div className="inspector-note"><Icon name="link" size={16} /><span>{engine === 'rerank' ? 'This row was selected from the dense + lexical union by a relevance-only score. The score does not decide whether the source is trustworthy, current, or true.' : selectedResult.engine === 'pgvector' ? 'PostgreSQL ranked this stored embedding with cosine distance. The passage and source metadata still determine whether the result is useful.' : selectedResult.engine === 'neural' ? 'Neural similarity helps find related wording, but it is not proof. Inspect the source passage before trusting the grounded draft.' : 'Hashed retrieval is the baseline: fast and local, but more dependent on shared words. Answer text is extractive in this first slice.'}</span></div>
          </> : <div className="inspector-empty"><Icon name="target" size={28} /><h3>Nothing selected.</h3><p>Choose an evidence line to see the exact passage, score breakdown, and source offsets.</p></div>}
        </aside>
      </div>

      {notice && <div className={`notice notice-${notice.tone}`} role="status"><span className="notice-pip" /><span>{notice.text}</span><button type="button" aria-label="Dismiss notification" onClick={() => setNotice(null)}><Icon name="close" size={15} /></button></div>}
    </div>
  )
}

export default App
