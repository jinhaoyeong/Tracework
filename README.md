# Tracework

Tracework is a learning laboratory for a personal AI knowledge brain. It turns notes and text/code files into inspectable chunks, gives each chunk a vector, ranks evidence for a question, and shows the source passage behind each result.

## Run it

```powershell
npm.cmd install
npm.cmd run dev
```

Open the local Vite URL. The first run contains three clearly labeled synthetic sources so the retrieval loop is visible immediately. Add your own text or supported files from the left rail; the browser stores the index in `localStorage`.

## Add it to an iPhone Home Screen

Tracework includes a branded `apple-touch-icon`, web manifest, and standalone web-app metadata. After deploying a new version, remove any older Tracework shortcut from the iPhone Home Screen and add it again from Safari so iOS refreshes the icon:

1. Open the deployed Tracework URL in Safari.
2. Tap **Share** → **Add to Home Screen**.
3. Keep **Open as Web App** enabled, then tap **Add**.

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

The browser index remains local, but neural mode sends indexed chunk text and the current query to the configured embedding provider. The API key stays in the development server route and is not placed in the browser bundle. This is the Phase 2 learning boundary; the database path is documented below and grounded generation is documented in Phase 4.

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

## Phase 3.5: end-to-end verification

Phase 3.5 is complete only when the real provider and the real database have both participated in one retrieval:

```text
source -> chunks -> OpenAI embedding -> 1536d vector
      -> Supabase/pgvector -> query embedding -> ranked top-K result
```

The server now fails closed when provider output is malformed, not 1536-dimensional, or from a different model than the cached chunks. It also keeps the service-role key on the Vite server and never exposes it to browser code.

To verify the real-provider path locally:

1. Apply the migration to the Supabase project.
2. Add `OPENAI_API_KEY`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` to `.env.local`.
3. Restart `npm.cmd run dev`, select **pgvector**, and run a specific query.
4. Confirm the debug panel shows `1536d`, a database candidate count, cosine distance, similarity, and the same source passage in the inspector.

Without `OPENAI_API_KEY`, the database route can still report its configuration and reject invalid vectors clearly, but Tracework cannot honestly populate pgvector with real neural embeddings. The remaining Phase 3.5 smoke-test proof is a real natural-language corpus, a real OpenAI embedding response, and a semantically related query retrieved from Supabase; the schema, RPC, lifecycle, and failure paths are already covered by the local verification work.

## Phase 4: grounded RAG answer generation

Phase 4 adds an optional generation stage after retrieval:

```text
question -> embed -> retrieve Top-K -> evaluate evidence
        -> build exact context -> Responses API -> answer + citations
```

The answer sheet keeps two modes:

- **Retrieval only** shows the existing extractive draft and source trail. It never calls a generation model.
- **Grounded answer** sends the question and the exact retrieved chunks to the server-side `/api/generate` route. The default model is `gpt-5.6-luna`, with the lowest reasoning effort (`none`) for low-cost, low-latency testing. Change the model with `OPENAI_GENERATION_MODEL` or try `low` reasoning with `OPENAI_REASONING_EFFORT` in `.env.local`. The route uses OpenAI's Responses API, keeps `store: false`, and never exposes the API key to browser code.

### Retrieval versus generation

Retrieval asks, “Which stored passages might answer this question?” Generation asks, “How should those passages be explained?” They are separate on purpose. A bad answer can come from a bad embedding, a bad ranking, poor chunk selection, malformed context, or the model itself. The inspector lets those stages be examined independently.

### What RAG means

Retrieval-augmented generation supplies selected passages in the model input at request time. It does not train or update the model. The model sees the question plus a bounded evidence snapshot, then writes an answer under instructions to use only that snapshot.

### Context construction and grounding

`buildGroundedContext()` formats each selected result as a numbered evidence block containing its citation number, source, type, chunk offsets, similarity, distance, embedding model/dimensions, and exact text. The generation route receives that string, not every document in the browser index. An answer is grounded when its factual claims are supported by those supplied blocks and its markers map to the blocks the user can inspect.

### Citations are not proof by themselves

Tracework validates that citation markers point to retrieved chunks, but a valid `[1]` does not automatically mean the sentence is supported by chunk 1. Citation correctness still requires reading the cited passage. This is why clicking a citation opens the exact source chunk and why the context inspector shows the complete model input.

### Evidence sufficiency and refusal

The UI calculates evidence state from observable retrieval data, not an invented model confidence percentage. A result score below `0.42` is **insufficient**. At least one result at or above `0.62` is **strong**; other usable results are **partial**. The calculation also reports the number of supporting chunks, distinct supporting sources, and a bounded coverage score. For insufficient evidence, Tracework skips generation and says that it could not find enough evidence in the knowledge base. Weak but plausible near-matches therefore do not become confident fabricated answers.

### Failure diagnosis

The pipeline keeps stage-specific errors visible: missing embedding credentials, Supabase configuration or RPC failures, no matching evidence, missing generation credentials, provider/network errors, malformed model output, and invalid citation markers are different states. The grounded inspector exposes the question, knowledge-base size, retrieved count, sent count, context characters and approximate tokens, retrieval engine, embedding model/dimensions, generation model/status, and the exact numbered blocks supplied to the model.

### The request path

When **Search** is pressed in grounded mode, Tracework embeds the question if the selected engine needs it, retrieves and ranks chunks, evaluates evidence, and snapshots the first five results into numbered context blocks. If the evidence floor is not met, it returns a deterministic refusal. Otherwise the server sends the question and context to the Responses API, extracts the returned text, and the client validates every citation marker against the snapshot. The answer, validated source list, and exact context then appear together in the playground.

Run the focused logic checks with:

```powershell
npm.cmd run test:grounded
npm.cmd run check
npm.cmd run build
```

The real generation smoke test still requires a valid `OPENAI_API_KEY`; until then, retrieval-only mode and the deterministic insufficient-evidence path remain fully usable.
