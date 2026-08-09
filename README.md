# Tracework

Tracework is a learning laboratory for a personal AI knowledge brain. It turns notes and text/code files into inspectable chunks, gives each chunk a vector, ranks evidence for a question, and shows the source passage behind each result.

## Run it

```powershell
npm.cmd install
npm.cmd run dev
```

Open the local Vite URL. The first run contains three clearly labeled synthetic sources so the retrieval loop is visible immediately. Add your own text or supported files from the left rail; the browser stores the index in `localStorage`.

## Phase 2: hashed versus neural retrieval

Tracework now keeps two representations for the same chunk:

- `hashed-v1`: a deterministic 384-dimensional local vector built from tokens, trigrams, and adjacent word pairs. It is fast, private, and works without credentials.
- `text-embedding-3-small`: a provider-generated neural embedding requested through the local `/api/embed` route. OpenAI documents embeddings as floating-point vectors used to measure text relatedness; see the [embeddings guide](https://developers.openai.com/api/docs/guides/embeddings).

To enable the second mode, copy `.env.example` to `.env.local` and add your key:

```powershell
Copy-Item .env.example .env.local
```

Then edit `.env.local`:

```text
OPENAI_API_KEY=your-key-here
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

Restart `npm.cmd run dev` after changing the file. In the app, choose `neural embeddings` or press `compare`. The first neural run embeds any chunks that do not have a saved neural vector, then embeds the question. The comparison view runs both methods against the same query and lets you inspect the source behind either result.

## What is real right now

- Paragraph-aware chunking with source offsets.
- A local hashed baseline and an optional server-side neural embedding path.
- A visible engine switch and same-query comparison view.
- Extractive answer draft with clickable citations.
- Source inspector with the retrieved passage, score breakdown, vector model, dimensions, and provenance.
- Explicit missing-key, network, and provider error states.

The browser index remains local, but neural mode sends indexed chunk text and the current query to the configured embedding provider. The API key stays in the development server route and is not placed in the browser bundle. This is not yet a hosted vector database, reranker, or chat model; those are later phases.

## Phase 3: PostgreSQL + pgvector

Phase 3 adds a durable database retrieval path without removing the learning baselines:

```text
hashed baseline  -> browser vector loop
local neural     -> browser vector loop
pgvector         -> server sync -> PostgreSQL + pgvector similarity search
```

The migration at `supabase/migrations/20260809000100_tracework_pgvector.sql` creates:

- `tracework_sources` for source identity, title, path, kind, and full content.
- `tracework_chunks` for chunk text, offsets, chunk number, embedding model, and a `vector(1536)` embedding.
- An HNSW cosine index.
- Restricted server-only RPC functions for replacing a source, deleting sources, and top-K similarity search with a source-kind filter.

Apply the migration in the SQL Editor of a Supabase project, then add these server-only values to `.env.local`:

```text
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-server-only-key
```

Never prefix these variables with `VITE_`. The service-role key must stay in the Vite development server and must never be sent to browser JavaScript.

Restart Tracework and choose `pgvector`. It will embed missing chunks, sync their source metadata and vectors, embed the question, and ask PostgreSQL for the top-K matches. The **vector search / debug** panel exposes candidate count, top K, source filtering, cosine distance, similarity, model, and dimensions. `compare` now compares local neural search against pgvector using the same query and vectors.

If Supabase is not configured, hashed and local-neural retrieval still work. The pgvector button shows a clear configuration error instead of silently searching the browser array.

The vector schema is fixed at 1536 dimensions to match `text-embedding-3-small`. All stored and query vectors must use the same embedding model and dimensions; otherwise similarity values are not meaningful. See Supabase's [semantic search guide](https://supabase.com/docs/guides/ai/semantic-search) and [pgvector guide](https://supabase.com/docs/guides/database/extensions/pgvector).
