import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const PGVECTOR_DIMENSIONS = 1536

const sendJson = (response: any, status: number, payload: unknown) => {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify(payload))
}

const readJson = async (request: any) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>
}

class ServerVectorError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status = 502) {
    super(message)
    this.name = 'ServerVectorError'
    this.code = code
    this.status = status
  }
}

const getSupabaseConfig = (env: Record<string, string>) => {
  const url = env.SUPABASE_URL?.trim().replace(/\/+$/, '')
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !serviceRoleKey) {
    throw new ServerVectorError(
      'missing_supabase_config',
      'Pgvector is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env.local, then restart Tracework.',
      503,
    )
  }
  return { url, serviceRoleKey }
}

const callSupabaseRpc = async (env: Record<string, string>, functionName: string, body: unknown) => {
  const config = getSupabaseConfig(env)
  let response: Response
  try {
    response = await fetch(`${config.url}/rest/v1/rpc/${functionName}`, {
      method: 'POST',
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch {
    throw new ServerVectorError('supabase_network_error', 'The Supabase database could not be reached.')
  }

  let payload: any = null
  try {
    payload = await response.json()
  } catch {
    throw new ServerVectorError('supabase_invalid_response', 'Supabase returned an unreadable database response.')
  }

  if (!response.ok) {
    throw new ServerVectorError(
      payload?.code ?? 'supabase_rpc_error',
      payload?.message ?? 'Supabase rejected the vector database request.',
      response.status || 502,
    )
  }

  return payload
}

const validateVector = (value: unknown, label: string) => {
  if (!Array.isArray(value) || value.length !== PGVECTOR_DIMENSIONS || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new ServerVectorError(
      'invalid_vector_dimensions',
      `${label} must be a finite ${PGVECTOR_DIMENSIONS}-dimension vector. Use text-embedding-3-small for this database schema.`,
      400,
    )
  }
}

const sendServerError = (response: any, error: unknown, fallback: string) => {
  if (error instanceof ServerVectorError) {
    sendJson(response, error.status, { error: { code: error.code, message: error.message } })
    return
  }
  sendJson(response, 500, { error: { code: 'vector_route_error', message: fallback } })
}

const neuralEmbeddingsPlugin = (env: Record<string, string>): Plugin => ({
  name: 'tracework-neural-embeddings',
  configureServer(server) {
    server.middlewares.use('/api/embed', async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: { code: 'method_not_allowed', message: 'Use POST /api/embed.' } })
        return
      }

      const apiKey = env.OPENAI_API_KEY
      if (!apiKey) {
        sendJson(response, 503, {
          error: {
            code: 'missing_api_key',
            message: 'Neural embeddings are not configured. Add OPENAI_API_KEY to .env.local, then restart Tracework.',
          },
        })
        return
      }

      try {
        const body = await readJson(request)
        const input = Array.isArray(body.input) ? body.input : [body.input]
        if (!input.length || input.some((item) => typeof item !== 'string' || !item.trim())) {
          sendJson(response, 400, { error: { code: 'invalid_input', message: 'Embedding input must be one or more non-empty strings.' } })
          return
        }
        if (input.length > 64) {
          sendJson(response, 400, { error: { code: 'batch_too_large', message: 'Send at most 64 chunks per embedding request.' } })
          return
        }

        const model = env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'
        const upstream = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model, input, encoding_format: 'float' }),
        })
        const payload = await upstream.json() as { data?: Array<{ index: number; embedding: number[] }>; model?: string; error?: { message?: string; code?: string } }

        if (!upstream.ok || !payload.data?.length) {
          sendJson(response, upstream.status || 502, {
            error: {
              code: payload.error?.code ?? 'provider_error',
              message: payload.error?.message ?? 'The OpenAI embeddings request failed.',
            },
          })
          return
        }

        const ordered = [...payload.data].sort((left, right) => left.index - right.index).map((item) => item.embedding)
        sendJson(response, 200, {
          embeddings: ordered,
          model: payload.model ?? model,
          dimensions: ordered[0].length,
        })
      } catch (error) {
        sendJson(response, 500, {
          error: {
            code: 'proxy_error',
            message: error instanceof SyntaxError ? 'The embedding request body was not valid JSON.' : 'The local embedding proxy failed before receiving a provider response.',
          },
        })
      }
    })

    server.middlewares.use('/api/vector/sync', async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: { code: 'method_not_allowed', message: 'Use POST /api/vector/sync.' } })
        return
      }

      try {
        const body = await readJson(request)
        const documents = Array.isArray(body.documents) ? body.documents : []
        if (!documents.length) {
          sendJson(response, 400, { error: { code: 'invalid_documents', message: 'Send at least one document with neural chunks to sync.' } })
          return
        }

        let syncedSources = 0
        let syncedChunks = 0
        for (const document of documents) {
          if (!document || typeof document.id !== 'string' || !Array.isArray(document.chunks)) {
            throw new ServerVectorError('invalid_document', 'Each synced document needs an id and chunks array.', 400)
          }
          const chunks = document.chunks
          if (!chunks.length) continue
          for (const chunk of chunks) validateVector(chunk?.neuralEmbedding?.vector, `Chunk ${chunk?.id ?? 'unknown'}`)

          await callSupabaseRpc(env, 'tracework_replace_source', {
            p_source: document,
            p_chunks: chunks,
          })
          syncedSources += 1
          syncedChunks += chunks.length
        }

        sendJson(response, 200, {
          database: 'supabase postgres / pgvector',
          embeddingDimensions: PGVECTOR_DIMENSIONS,
          syncedSources,
          syncedChunks,
        })
      } catch (error) {
        sendServerError(response, error, 'The vector database could not sync these sources.')
      }
    })

    server.middlewares.use('/api/vector/search', async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: { code: 'method_not_allowed', message: 'Use POST /api/vector/search.' } })
        return
      }

      try {
        const body = await readJson(request)
        validateVector(body.queryVector, 'The query')
        const limit = Math.min(Math.max(Number(body.limit) || 5, 1), 20)
        const sourceKind = body.sourceKind === null || body.sourceKind === undefined ? null : body.sourceKind
        if (sourceKind !== null && !['note', 'file', 'sample'].includes(sourceKind)) {
          throw new ServerVectorError('invalid_filter', 'Source type filter must be note, file, sample, or all.', 400)
        }

        const rows = await callSupabaseRpc(env, 'tracework_match_chunks', {
          query_embedding: `[${body.queryVector.join(',')}]`,
          match_threshold: 0.12,
          match_count: limit,
          filter_kind: sourceKind,
        }) as Array<Record<string, any>>

        const results = (Array.isArray(rows) ? rows : []).map((row) => ({
          id: row.id,
          sourceId: row.source_id,
          content: row.content,
          sourceContent: row.source_content,
          chunkIndex: Number(row.chunk_index),
          startOffset: Number(row.start_offset),
          endOffset: Number(row.end_offset),
          title: row.title,
          sourcePath: row.source_path,
          kind: row.kind,
          embeddingModel: row.embedding_model,
          embeddingDimensions: Number(row.embedding_dimensions ?? PGVECTOR_DIMENSIONS),
          distance: Number(row.distance),
          similarity: Number(row.similarity),
          candidateCount: Number(row.candidate_count ?? 0),
        }))

        sendJson(response, 200, {
          database: 'supabase postgres / pgvector',
          distanceMetric: 'cosine distance',
          embeddingDimensions: PGVECTOR_DIMENSIONS,
          results,
          topK: limit,
        })
      } catch (error) {
        sendServerError(response, error, 'The vector database search failed.')
      }
    })

    server.middlewares.use('/api/vector/delete', async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: { code: 'method_not_allowed', message: 'Use POST /api/vector/delete.' } })
        return
      }

      try {
        const body = await readJson(request)
        const sourceIds = Array.isArray(body.sourceIds) ? body.sourceIds : []
        if (!sourceIds.length || sourceIds.some((id) => typeof id !== 'string' || !id.trim())) {
          sendJson(response, 400, { error: { code: 'invalid_source_ids', message: 'Send one or more source ids to delete.' } })
          return
        }
        const deletedSources = await callSupabaseRpc(env, 'tracework_delete_sources', { p_source_ids: sourceIds })
        sendJson(response, 200, { deletedSources: Number(deletedSources ?? 0) })
      } catch (error) {
        sendServerError(response, error, 'The vector database could not delete these sources.')
      }
    })
  },
})

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), neuralEmbeddingsPlugin(env)],
  }
})
