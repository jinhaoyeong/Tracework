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

### Shared knowledge library

The bundled corpora are no longer buttons that replay a fixture into one browser. They are rows in the database, listed in the capture rail under **knowledge library**, and read from Postgres every time Tracework opens. A collection seeded from any machine is visible to every reader of the same database.

The migration at `supabase/migrations/20260811000100_tracework_knowledge_library.sql` adds:

- `tracework_collections` for collection identity, description, kind, and provenance.
- `tracework_library_documents` for the raw catalog text. Library documents are stored without embeddings on purpose: the catalog has to be listable before an embedding provider is configured, and chunking still happens client-side.
- A `provenance` column on `tracework_sources`, so a source synced by one reader reaches the next with the authority record Phase 5C adjudication depends on. `tracework_match_chunks` now returns it.
- Server-only RPCs for upserting a collection, listing the catalog, and reading one collection's documents.

Apply it in the Supabase SQL Editor after the pgvector migration, then publish the bundled collections:

```powershell
npm run seed:library            # add --dry-run to see what would be written
```

The seeder talks to Supabase directly with the service-role key from `.env.local`. The browser routes `/api/library/collections` and `/api/library/documents` are read-only by design: an unauthenticated write endpoint would let anyone rewrite the shared catalog.

Adding a collection chunks its documents into the local index under the database's own document ids, so two devices indexing the same collection produce one row in the shared vector table rather than a duplicate per device. **remove from this index** and **clear index** are local operations — a library row belongs to every reader, so neither deletes shared state. Choose **pgvector** after adding a collection to sync its neural chunks; another device can then retrieve those passages without a local copy.

Without Supabase configured, the library panel reports that it is unavailable and the browser-local engines still work over whatever is already indexed.

This is a **system-seeded** library, not a user-contributed one. An operator seeds it; every device consumes it. Ownership, visibility, and contribution by ordinary users are Phase 6 work — see [docs/phase6-permissions.md](docs/phase6-permissions.md).

### Shared writes are opt-in

Every route in `api/` runs on the Supabase service role and has no notion of a caller. `/api/vector/sync` and `/api/vector/delete` are therefore gated by `TRACEWORK_ALLOW_SHARED_WRITES`:

- Deployed handlers refuse with `403 shared_writes_disabled` unless it is exactly `true`. The default is deny, so a deployment that forgets the variable is safe rather than open.
- The local Vite dev server allows writes unless it is set to `false`, which lets you rehearse a locked-down deployment.

When writes are refused, pgvector retrieval falls back to searching the existing library read-only rather than failing, so a public demo still works. Reading, searching, and grounded answers are unaffected.

This closes the anonymous poisoning and deletion paths. It does not establish identity, so `/api/embed` and `/api/generate` remain consumable on an enabled deployment — use Vercel deployment protection until the Phase 6 permission model exists, and keep private data out of the shared production library until then.

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

### Retrieved text is untrusted input

Chunk text arrives from whatever the user indexed, so `buildGroundedContext()` treats it as hostile data before sending it. Lines that imitate an evidence block header are escaped, so a source cannot forge a sixth numbered block that the citation validator would reject and the inspector could never show. Instruction-shaped passages are redacted. Oversized chunks are trimmed to a shared character budget instead of failing the whole request. Every one of these edits is recorded on the chunk and shown in the inspector, so the context stays verbatim unless the UI says otherwise — a redaction that hides a document legitimately discussing prompt injection is a visible cost, not a silent one.

### Citations are not proof by themselves

Tracework validates that citation markers point to retrieved chunks, but a valid `[1]` does not automatically mean the sentence is supported by chunk 1. Citation correctness still requires reading the cited passage. This is why clicking a citation opens the exact source chunk and why the context inspector shows the complete model input.

### Evidence sufficiency and refusal

The UI calculates evidence state from observable retrieval data, not an invented model confidence percentage. A result score below `0.42` is **insufficient**. A result at or above `0.62` is **strong** only when the candidate chunks span at least two distinct sources; a high score backed by a single source stays **partial**, because five near-identical chunks from one document are one claim restated rather than a corroborated one. Other usable results are **partial**. Scores are read as a maximum over the retrieved set rather than from the first row, so no engine's ordering is trusted, and non-finite scores are discarded instead of falling through the comparisons into `partial`. The calculation also reports the number of **candidate chunks above the evidence floor**, distinct sources among them, and a bounded coverage score. Candidate is not the same as supporting: the score threshold measures similarity only, so a chunk can clear the floor without containing anything that answers the question. Measuring real support is reranking work, not retrieval scoring. For insufficient evidence, Tracework skips generation and says that it could not find enough evidence in the knowledge base. Weak but plausible near-matches therefore do not become confident fabricated answers.

### Answered, refused, failed

Generation has three distinct outcomes and they must not be collapsed:

- **Answered** — the model made claims, so every claim must carry a citation marker that resolves to a supplied block.
- **Refused** — the model reported that the evidence does not answer the question. A refusal makes no claim, so it requires no citations, and it is a successful safety outcome rather than an error.
- **Failed** — a provider, network, or malformed-output problem, or a claim returned with no citations or with markers pointing outside the supplied evidence.

`classifyGeneratedAnswer()` in `src/lib/grounded.ts` decides which of the three occurred, and only the third is reported as a generation failure.

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

The adversarial suite is separate, and reports every finding rather than stopping at the first:

```powershell
npm.cmd run stress:grounded
npm.cmd run stress:grounded -- --strict
```

`docs/stress-test.md` documents both halves, including the live corpus for a credentialed run.

The real generation smoke test still requires a valid `OPENAI_API_KEY`; until then, retrieval-only mode and the deterministic insufficient-evidence path remain fully usable.

## Deploy the API routes to Vercel

The files in `api/` are Vercel serverless functions. They provide the same server-side contracts as local Vite middleware for `/api/embed`, `/api/generate`, `/api/vector/sync`, `/api/vector/search`, `/api/vector/delete`, `/api/library/collections`, and `/api/library/documents`. The browser never receives the OpenAI or Supabase service-role keys.

In the Vercel project settings, add these variables to the environments you deploy (`Production` and/or `Preview`):

```text
OPENAI_API_KEY=your-key-here
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_GENERATION_MODEL=gpt-5.6-luna
OPENAI_REASONING_EFFORT=none
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-server-only-key
```

After saving environment variables, redeploy. Changing a Vercel variable does not update an already-built deployment until a new deployment is created. Do not use `VITE_` prefixes for these values.

To test a deployed embedding route from PowerShell, keep the URL quoted and do not include a trailing space:

```powershell
$BaseUrl = "https://your-deployment.vercel.app"
$embedBody = @{ input = @("Tracework uses pgvector for semantic retrieval.") } | ConvertTo-Json
$embed = Invoke-RestMethod -Uri "$BaseUrl/api/embed" -Method Post -ContentType "application/json" -Body $embedBody
[pscustomobject]@{ Model = $embed.model; Dimensions = $embed.dimensions; VectorLength = $embed.embeddings[0].Count }
```

The expected embedding result is `text-embedding-3-small`, `1536`, and `1536`. A `NOT_FOUND` response means the deployment does not contain the `api/` functions yet; redeploy the commit that added them. A `missing_api_key` or `missing_supabase_config` response means the route exists but its Vercel environment variables are not configured for that deployment.
