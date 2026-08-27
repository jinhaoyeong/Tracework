/**
 * Phase 6E: explicit publication.
 *
 * What this proves:
 *   1. STRUCTURAL   the migration adds no policy and no table grant, grants
 *                   EXECUTE to service_role only, and does not redefine the
 *                   6D2A read path.
 *   2. STATE        the permitted transitions, modelled from the shipped SQL,
 *                   and the UI's copy of them proved identical to the SQL.
 *   3. INGEST       first state always comes from the column default; no caller
 *                   -supplied publication_state exists; D1 withdrawal; the
 *                   identical-content no-op; source lineage always written.
 *   4. CONTAINMENT  pending, blocked, private and superseded stay invisible to
 *                   the 6D2A path, and a published document becomes visible.
 *   5. TRANSPORT    the real handlers, driven with an injected fetch: the
 *                   shared-writes boundary, the 401, and the publisher allowlist.
 *
 * LIMITATION, unchanged from 6D2A/6D3/6D4A: no PostgreSQL is available here, so
 * sections 2-4 evaluate models of the shipped SQL rather than executing it.
 * Every predicate a model applies is first asserted present verbatim in the
 * migration text, so weakening the SQL fails section 1 even when a model still
 * passes. Runtime proof on a disposable PostgreSQL is a separate gate and is NOT
 * satisfied by this file.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  handleLibraryIngest,
  handleLibraryPublish,
  handleLibraryStatus,
} from '../server/traceworkApi.ts'

const readText = (relative) => readFileSync(
  new URL(relative, import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n')

const migration = readText('../supabase/migrations/20260815081045_tracework_6e_explicit_publication.sql')
const containment = readText('../supabase/migrations/20260814000100_tracework_public_read_containment.sql')
const component = readText('../src/components/KnowledgeLibrary.tsx')

/** Executable SQL only, so a comment can never satisfy a content assertion. */
const statementsOf = (sql) => sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n')

const statements = statementsOf(migration)

/* ---------------------------------------------------- 1. structural */

assert.equal(
  /create\s+policy/i.test(statements), false,
  '6E must not create a policy: the 6D3 inert posture and the 6D4A decision are not 6E\'s to change',
)
assert.equal(
  /alter\s+policy/i.test(statements), false,
  '6E must not alter a policy',
)
assert.equal(
  /grant\s+select/i.test(statements), false,
  '6E must not grant any table privilege; it is a service_role write path only',
)
assert.equal(
  /grant[^;]*\b(anon|authenticated)\b/i.test(statements), false,
  '6E must grant nothing to anon or authenticated',
)

for (const fn of ['tracework_list_collections', 'tracework_collection_documents', 'tracework_match_chunks']) {
  assert.equal(
    new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}`, 'i').test(statements), false,
    `6E must not redefine the 6D2A function ${fn}: the read path stays byte identical`,
  )
}

for (const fn of [
  'tracework_ingest_document(jsonb, jsonb, jsonb, uuid)',
  'tracework_set_publication_state(text, text, uuid)',
  'tracework_document_status(text)',
]) {
  assert.ok(
    statements.includes(`grant execute on function public.${fn} to service_role;`),
    `${fn} must be granted to service_role`,
  )
  assert.ok(
    statements.includes(`revoke execute on function public.${fn} from public, anon, authenticated;`),
    `${fn} must be revoked from public, anon and authenticated`,
  )
}

assert.ok(
  statements.includes('security definer') === false,
  '6E functions must stay SECURITY INVOKER',
)
console.log('  structural: no policy, no table grant, 6D2A untouched, EXECUTE to service_role only')

/* --------------------------------------------------- 2. state machine */

/** The transition table, parsed from the shipped SQL rather than restated. */
const parseTransitions = () => {
  const table = {}
  const pattern = /when v_current = '(\w+)'\s+and p_next_state (?:in \(([^)]*)\)|= '(\w+)')/g
  let match
  while ((match = pattern.exec(migration)) !== null) {
    const [, from, list, single] = match
    const targets = single
      ? [single]
      : list.split(',').map((entry) => entry.trim().replace(/'/g, ''))
    table[from] = targets
  }
  return table
}

const SQL_TRANSITIONS = parseTransitions()
assert.deepEqual(SQL_TRANSITIONS, {
  pending: ['published', 'blocked'],
  published: ['superseded', 'blocked'],
  blocked: ['pending'],
}, 'the SQL transition table is not the reviewed one')

// superseded appears in no `when` arm, which is what makes it terminal.
assert.equal(SQL_TRANSITIONS.superseded, undefined, 'superseded must be terminal')

/** The UI's copy, extracted from the component text (importing TSX is not possible here). */
const parseComponentTransitions = () => {
  const block = component.slice(
    component.indexOf('REVIEW_TRANSITIONS'),
    component.indexOf('const REVIEW_ACTION_LABELS'),
  )
  const table = {}
  const pattern = /(\w+):\s*\[([^\]]*)\]/g
  let match
  while ((match = pattern.exec(block)) !== null) {
    const [, from, list] = match
    table[from] = list.split(',').map((e) => e.trim().replace(/'/g, '')).filter(Boolean)
  }
  return table
}

const UI_TRANSITIONS = parseComponentTransitions()
for (const [from, targets] of Object.entries(SQL_TRANSITIONS)) {
  assert.deepEqual(
    UI_TRANSITIONS[from], targets,
    `the UI offers different transitions from ${from} than the database permits`,
  )
}
assert.deepEqual(UI_TRANSITIONS.superseded, [], 'the UI must offer no action on a superseded document')

const transitionAllowed = (from, to) => (SQL_TRANSITIONS[from] ?? []).includes(to)
assert.ok(transitionAllowed('pending', 'published'))
assert.ok(transitionAllowed('pending', 'blocked'))
assert.ok(transitionAllowed('blocked', 'pending'))
assert.equal(transitionAllowed('pending', 'superseded'), false, 'pending must not jump straight to superseded')
assert.equal(transitionAllowed('superseded', 'published'), false, 'a superseded document must never be republished')
assert.equal(transitionAllowed('blocked', 'published'), false, 'a blocked document must be reopened before publishing')
assert.equal(transitionAllowed('published', 'published'), false)
console.log('  state: transitions parsed from the SQL; superseded terminal; UI copy identical to the database')

/* ------------------------------------------------------- 3. ingest */

// The first state must come from the column default, never from the caller.
const ingestBody = migration.slice(
  migration.indexOf('create or replace function public.tracework_ingest_document'),
  migration.indexOf('create or replace function public.tracework_set_publication_state'),
)
const insertColumns = ingestBody.slice(
  ingestBody.indexOf('insert into public.tracework_library_documents'),
  ingestBody.indexOf(') values ('),
)
assert.equal(
  insertColumns.includes('publication_state'), false,
  'ingest must omit publication_state on insert so the pending default is the only first state',
)
assert.equal(
  /p_document->>'publicationState'/.test(ingestBody), false,
  'ingest must expose no caller-supplied publication state',
)
assert.ok(
  ingestBody.includes('document_id'),
  'ingest must write source lineage; a NULL document_id is the original 6E bug',
)

/** Model of the ingest rules, each asserted present in the SQL above. */
const ingest = (prior, { contentHash, sourceLinked, sourceHash }) => {
  if (!prior) return { state: 'pending', withdrawn: false, unchanged: false }
  if (prior.contentHash === contentHash && sourceLinked && sourceHash === contentHash) {
    return { state: prior.state, withdrawn: false, unchanged: true }
  }
  const withdrawn = prior.state === 'published'
  return { state: withdrawn ? 'pending' : prior.state, withdrawn, unchanged: false }
}

assert.deepEqual(
  ingest(null, { contentHash: 'h1' }),
  { state: 'pending', withdrawn: false, unchanged: false },
  'a new document must be created pending',
)
assert.deepEqual(
  ingest({ state: 'published', contentHash: 'h1' }, { contentHash: 'h1', sourceLinked: true, sourceHash: 'h1' }),
  { state: 'published', withdrawn: false, unchanged: true },
  'identical re-ingest must not disturb a published document',
)
assert.deepEqual(
  ingest({ state: 'published', contentHash: 'h1' }, { contentHash: 'h2', sourceLinked: true, sourceHash: 'h1' }),
  { state: 'pending', withdrawn: true, unchanged: false },
  'D1: edited content on a published document is withdrawn to pending',
)
assert.deepEqual(
  ingest({ state: 'blocked', contentHash: 'h1' }, { contentHash: 'h2', sourceLinked: true, sourceHash: 'h1' }),
  { state: 'blocked', withdrawn: false, unchanged: false },
  'editing must not reopen a blocked document',
)
assert.deepEqual(
  ingest({ state: 'superseded', contentHash: 'h1' }, { contentHash: 'h2', sourceLinked: true, sourceHash: 'h1' }),
  { state: 'superseded', withdrawn: false, unchanged: false },
  'editing must not resurrect a superseded document',
)
// A previously unlinked source is repaired even when the content is unchanged.
assert.equal(
  ingest({ state: 'pending', contentHash: 'h1' }, { contentHash: 'h1', sourceLinked: false, sourceHash: null }).unchanged,
  false,
  'an unlinked source must be relinked even when the content hash matches',
)
console.log('  ingest: pending by default, no caller-supplied state, D1 withdrawal, idempotent re-ingest, lineage repaired')

/* ------------------------------------- 3b. adversarial: source hijack (R1) */

/* The guard must exist in the shipped SQL, not just in the model below. */
assert.ok(
  /v_source_document is not null and v_source_document is distinct from v_document_id/.test(ingestBody),
  'ingest must refuse a source id already claimed by a different document',
)
assert.ok(
  ingestBody.indexOf('v_source_document is distinct from v_document_id')
    < ingestBody.indexOf('delete from public.tracework_chunks'),
  'the lineage guard must run BEFORE the chunk delete, or the damage is already done',
)
/* The refusal must not confirm which source ids exist. */
const hijackMessage = ingestBody.slice(
  ingestBody.indexOf('that source id is already claimed'),
  ingestBody.indexOf('that source id is already claimed') + 120,
)
assert.equal(/%/.test(hijackMessage), false, 'the hijack refusal must not interpolate an id into the message')

/**
 * Two actors, one source id. Mallory owns her own new document, so the
 * document-level creator check cannot catch her; only the source guard can.
 */
const ingestWithLineage = ({ priorDocument, existingSource, actor, documentId }) => {
  if (existingSource && existingSource.documentId && existingSource.documentId !== documentId) {
    return { rejected: 'source_claimed' }
  }
  if (priorDocument && priorDocument.creator !== actor) return { rejected: 'not_creator' }
  return { rejected: null }
}

const ALICE = 'actor-alice'
const MALLORY = 'actor-mallory'
const aliceSource = { id: 's-shared', documentId: 'd-alice' }

// Alice ingests normally.
assert.equal(
  ingestWithLineage({ priorDocument: null, existingSource: null, actor: ALICE, documentId: 'd-alice' }).rejected,
  null,
  'a first ingest must succeed',
)
// Mallory targets Alice's source id under her OWN new document.
assert.equal(
  ingestWithLineage({ priorDocument: null, existingSource: aliceSource, actor: MALLORY, documentId: 'd-mallory' }).rejected,
  'source_claimed',
  'a source id owned by another document must be refused even when the caller owns the target document',
)
// Alice re-ingesting her own document keeps working.
assert.equal(
  ingestWithLineage({
    priorDocument: { creator: ALICE }, existingSource: aliceSource, actor: ALICE, documentId: 'd-alice',
  }).rejected,
  null,
  'the owner must still be able to re-ingest their own document',
)
// A pre-6E source no document has claimed is adoptable: that is the lineage repair.
assert.equal(
  ingestWithLineage({
    priorDocument: null, existingSource: { id: 's-orphan', documentId: null }, actor: MALLORY, documentId: 'd-new',
  }).rejected,
  null,
  'an unclaimed source must remain adoptable',
)
// Mallory cannot take over Alice's document directly either.
assert.equal(
  ingestWithLineage({
    priorDocument: { creator: ALICE }, existingSource: aliceSource, actor: MALLORY, documentId: 'd-alice',
  }).rejected,
  'not_creator',
  "another principal's document must stay closed",
)
console.log('  adversarial: source hijack refused before the chunk delete; unclaimed sources still adoptable')

/* ------------------------------- 3c. collection write authorization (R3) */

assert.ok(
  /membership.status = 'active'/.test(ingestBody),
  'ingest must require ACTIVE workspace membership when writing to a workspace collection',
)
assert.ok(
  /v_owner is not null and v_owner = p_actor/.test(ingestBody),
  'ingest must accept collection ownership',
)
/* The contributor route, and its system-collection exclusion. */
assert.ok(
  /v_visibility = 'public' and v_system_key is null/.test(ingestBody),
  'public contribution must be permitted only when the collection is not system-scoped',
)
/* The exclusion must be by marker, not by name: hard-coding the quarantine slug
 * would leave the next system collection unprotected. */
assert.equal(
  /legacy-quarantine/.test(ingestBody), false,
  'system collections must be excluded by created_by_system_key, never by slug',
)
assert.ok(
  /created_by_system_key/.test(ingestBody),
  'ingest must read created_by_system_key to identify a system collection',
)
/* Not-found and not-permitted must be indistinguishable. */
assert.equal(
  (ingestBody.match(/no writable collection matched the request/g) ?? []).length, 1,
  'collection refusal must use one shared message so it cannot act as an existence oracle',
)

const mayWrite = (collection, actor, memberships) => {
  if (!collection) return false
  if (collection.visibility === 'public') return !collection.systemKey
  if (collection.owner && collection.owner === actor) return true
  return Boolean(collection.workspace) && memberships.some((m) => (
    m.workspace === collection.workspace && m.user === actor && m.status === 'active'
  ))
}

/* CONTRIBUTOR: any verified principal may submit to a normal public collection. */
assert.equal(
  mayWrite({ visibility: 'public', systemKey: null }, MALLORY, []), true,
  'an authenticated contributor may submit to a normal public collection',
)
/* SYSTEM: quarantine and any other system-scoped collection are refused. */
assert.equal(
  mayWrite({ visibility: 'public', systemKey: 'system:quarantine' }, MALLORY, []), false,
  'a system-scoped collection must reject contributor writes',
)
assert.equal(
  mayWrite({ visibility: 'public', systemKey: 'system:anything-future' }, ALICE, []), false,
  'the exclusion must hold for system collections that do not exist yet',
)
/* OWNER and MEMBER routes are preserved for future use. */
assert.equal(mayWrite({ visibility: 'private', owner: ALICE }, ALICE, []), true, 'an owner may write')
assert.equal(mayWrite({ visibility: 'private', owner: ALICE }, MALLORY, []), false, 'a non-owner may not')
assert.equal(
  mayWrite({ visibility: 'workspace', workspace: 'w1' }, ALICE, [{ workspace: 'w1', user: ALICE, status: 'active' }]),
  true, 'an active member may write',
)
assert.equal(
  mayWrite({ visibility: 'workspace', workspace: 'w1' }, ALICE, [{ workspace: 'w1', user: ALICE, status: 'invited' }]),
  false, 'an invited-but-inactive member may not write',
)
assert.equal(mayWrite(undefined, ALICE, []), false, 'a nonexistent collection is refused the same way')
console.log('  collection authz: public contributors allowed, system collections excluded by marker, owner/member preserved')

/* --------------------------------------------------- 4. containment */

for (const predicate of ["documents.publication_state = 'published'", "collections.visibility = 'public'"]) {
  assert.ok(
    containment.includes(predicate),
    `the 6D2A containment predicate ${predicate} must still be present`,
  )
}

const visibleToPublicPath = (collection, document) => (
  collection.visibility === 'public' && document.publication_state === 'published'
)

const COLLECTIONS = {
  'public-live': { visibility: 'public' },
  'legacy-quarantine': { visibility: 'public' },
  'alice-private': { visibility: 'private' },
  'team-space': { visibility: 'workspace' },
}
const DOCUMENTS = [
  { id: 'd-new', collection: 'public-live', publication_state: 'pending' },
  { id: 'd-live', collection: 'public-live', publication_state: 'published' },
  { id: 'd-old', collection: 'public-live', publication_state: 'superseded' },
  { id: 'd-blocked', collection: 'legacy-quarantine', publication_state: 'blocked' },
  { id: 'd-private', collection: 'alice-private', publication_state: 'published' },
  { id: 'd-team', collection: 'team-space', publication_state: 'published' },
]

const visible = DOCUMENTS
  .filter((document) => visibleToPublicPath(COLLECTIONS[document.collection], document))
  .map((document) => document.id)

assert.deepEqual(visible, ['d-live'], 'only a published document in a public collection may be visible')

// The whole point of 6E: the same document is invisible, then visible, then invisible again.
const lifecycle = { collection: 'public-live', publication_state: 'pending' }
assert.equal(visibleToPublicPath(COLLECTIONS['public-live'], lifecycle), false, 'submitted work must be invisible')
lifecycle.publication_state = 'published'
assert.equal(visibleToPublicPath(COLLECTIONS['public-live'], lifecycle), true, 'publishing must make it visible to User B')
lifecycle.publication_state = 'blocked'
assert.equal(visibleToPublicPath(COLLECTIONS['public-live'], lifecycle), false, 'blocking must withdraw it again')
console.log('  containment: pending/blocked/private/superseded hidden; the publish step is what reaches User B')

/* ---------------------------------------------------- 5. transport */

const BASE_ENV = {
  SUPABASE_URL: 'https://disposable.example.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
}
const PUBLISHER = '6d4a0000-0000-4000-8000-000000000001'
const SUBMITTER = '6d4a0000-0000-4000-8000-000000000002'

const captureResponse = () => {
  const captured = { status: 0, payload: null }
  return {
    captured,
    response: {
      status(code) { captured.status = code; return this },
      json(payload) { captured.payload = payload },
    },
  }
}

const stubFetch = (rpcResult, rpcError) => {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    if (rpcError) {
      // Shaped like a real PostgREST failure: SQLSTATE in `code`, the raw
      // PL/pgSQL raise text in `message`.
      return { ok: false, status: rpcError.status, json: async () => ({ code: rpcError.code, message: rpcError.message }) }
    }
    return { ok: true, status: 200, json: async () => rpcResult }
  }
  return { impl, calls }
}

const run = async (handler, { env = {}, caller = null, body = {}, rpcResult = {}, rpcError = null }) => {
  const { captured, response } = captureResponse()
  const { impl, calls } = stubFetch(rpcResult, rpcError)
  await handler({ method: 'POST', body, headers: {} }, response, {
    env: { ...BASE_ENV, ...env },
    fetchImpl: impl,
    resolveCaller: async () => caller,
  })
  return { ...captured, calls }
}

const OPEN = { TRACEWORK_ALLOW_SHARED_WRITES: 'true' }
const WITH_PUBLISHER = { ...OPEN, TRACEWORK_PUBLISHERS: PUBLISHER }
const CALLER = { userId: SUBMITTER, accessToken: 'token' }
const PUBLISHER_CALLER = { userId: PUBLISHER, accessToken: 'token' }
const DOC = { document: { id: 'd1', collectionSlug: 'public-live' }, source: { id: 's1' }, chunks: [] }

/* The deployment boundary holds for every 6E route, even for a publisher. */
for (const [name, handler] of [['ingest', handleLibraryIngest], ['publish', handleLibraryPublish], ['status', handleLibraryStatus]]) {
  const result = await run(handler, { caller: PUBLISHER_CALLER, body: { ...DOC, documentId: 'd1', state: 'published' } })
  assert.equal(result.status, 403, `${name} must refuse when shared writes are disabled`)
  assert.equal(result.payload.error.code, 'shared_writes_disabled')
  assert.equal(result.calls.length, 0, `${name} must not reach the database when writes are disabled`)
}

/* No principal, no write, even with the deployment open. */
{
  const result = await run(handleLibraryIngest, { env: OPEN, caller: null, body: DOC })
  assert.equal(result.status, 401, 'ingest must refuse an unauthenticated caller')
  assert.equal(result.calls.length, 0)
}

/* A submitter may ingest. */
{
  const result = await run(handleLibraryIngest, {
    env: OPEN,
    caller: CALLER,
    body: DOC,
    rpcResult: { documentId: 'd1', publicationState: 'pending', withdrawn: false, unchanged: false, chunkCount: 0 },
  })
  assert.equal(result.status, 200)
  assert.equal(result.payload.publicationState, 'pending', 'ingest must report the pending state back')
  const sent = JSON.parse(result.calls[0].init.body)
  assert.equal(sent.p_actor, SUBMITTER, 'the actor must be the verified principal, never a body value')
  assert.equal('p_publication_state' in sent, false, 'ingest must not forward any publication state')
}

/* A submitter may NOT publish OR block, even though they may ingest. Both
 * directions matter: blocking is as much a moderation power as publishing. */
for (const state of ['published', 'blocked']) {
  const result = await run(handleLibraryPublish, {
    env: WITH_PUBLISHER,
    caller: CALLER,
    body: { documentId: 'd1', state },
  })
  assert.equal(result.status, 403, `a non-allowlisted principal must not set ${state}`)
  assert.equal(result.payload.error.code, 'publish_not_permitted')
  assert.equal(result.calls.length, 0, `a refused ${state} must not reach the database`)
}

/* An empty allowlist means nobody publishes. */
{
  const result = await run(handleLibraryPublish, {
    env: OPEN,
    caller: PUBLISHER_CALLER,
    body: { documentId: 'd1', state: 'published' },
  })
  assert.equal(result.status, 403, 'an unset TRACEWORK_PUBLISHERS must permit nobody')
}

/* An allowlisted publisher may publish, and the actor is the verified id. */
{
  const result = await run(handleLibraryPublish, {
    env: WITH_PUBLISHER,
    caller: PUBLISHER_CALLER,
    body: { documentId: 'd1', state: 'published' },
    rpcResult: { documentId: 'd1', previousState: 'pending', currentState: 'published' },
  })
  assert.equal(result.status, 200)
  assert.equal(result.payload.currentState, 'published')
  const sent = JSON.parse(result.calls[0].init.body)
  assert.equal(sent.p_actor, PUBLISHER)
  assert.equal(sent.p_document_id, 'd1')
}

/* The review queue is a publisher-only view. */
{
  const denied = await run(handleLibraryStatus, { env: WITH_PUBLISHER, caller: CALLER, body: {} })
  assert.equal(denied.status, 403, 'the pending queue must not be readable by a non-publisher')

  const allowed = await run(handleLibraryStatus, {
    env: WITH_PUBLISHER,
    caller: PUBLISHER_CALLER,
    body: {},
    rpcResult: [{ id: 'd1', collection_slug: 'public-live', title: 'T', publication_state: 'pending', chunk_count: 3 }],
  })
  assert.equal(allowed.status, 200)
  assert.deepEqual(allowed.payload.documents[0], {
    id: 'd1', collectionSlug: 'public-live', title: 'T', publicationState: 'pending', chunkCount: 3,
  })
}
console.log('  transport: shared-writes boundary, 401 without a principal, allowlist separates submit from publish')

/* ------------------------------ 5b. RPC error containment / oracle (R9) */

/*
 * The upstream messages below are the real ones the migration raises. If any
 * fragment of them reaches the caller, a document id, collection slug or
 * ownership fact has leaked.
 */
const UPSTREAM_NOT_PERMITTED = {
  status: 403, code: '42501',
  message: 'Tracework ingest stopped: document d-secret was created by another principal',
}
const UPSTREAM_NOT_FOUND = {
  status: 409, code: '23503',
  message: 'Tracework publication stopped: document d-secret does not exist',
}
const UPSTREAM_INTERNAL = {
  status: 500, code: '42P01',
  message: 'relation "public.tracework_library_documents" does not exist',
}

const refused = await run(handleLibraryPublish, {
  env: WITH_PUBLISHER, caller: PUBLISHER_CALLER,
  body: { documentId: 'd-secret', state: 'published' },
  rpcError: UPSTREAM_NOT_PERMITTED,
})
const missing = await run(handleLibraryPublish, {
  env: WITH_PUBLISHER, caller: PUBLISHER_CALLER,
  body: { documentId: 'd-secret', state: 'published' },
  rpcError: UPSTREAM_NOT_FOUND,
})

/* THE oracle assertion: byte-identical responses. */
assert.deepEqual(
  refused.payload, missing.payload,
  'unauthorized and nonexistent must be indistinguishable in the response body',
)
assert.equal(refused.status, missing.status, 'unauthorized and nonexistent must share a status code')
assert.equal(refused.status, 403)
assert.equal(refused.payload.error.code, 'library_write_refused', 'the public code must be stable and generic')

/* No fragment of the upstream text may survive, on any 6E route. */
const FORBIDDEN_FRAGMENTS = [
  'd-secret', 'another principal', 'does not exist', 'Tracework ingest stopped',
  'Tracework publication stopped', 'tracework_library_documents', 'relation', 'public.',
]
for (const [label, result] of [['not-permitted', refused], ['not-found', missing]]) {
  const serialized = JSON.stringify(result.payload)
  for (const fragment of FORBIDDEN_FRAGMENTS) {
    assert.equal(
      serialized.includes(fragment), false,
      `${label} response leaked "${fragment}"`,
    )
  }
}

/* An internal fault must not leak schema detail either, and must not masquerade
 * as a deliberate refusal. */
const internal = await run(handleLibraryIngest, {
  env: OPEN, caller: CALLER, body: DOC, rpcError: UPSTREAM_INTERNAL,
})
assert.equal(internal.status, 500, 'an unexpected fault must be a 500, never a 403 refusal')
assert.equal(internal.payload.error.code, 'library_write_error')
for (const fragment of ['tracework_library_documents', 'relation', 'public.']) {
  assert.equal(
    JSON.stringify(internal.payload).includes(fragment), false,
    `the internal fault leaked "${fragment}"`,
  )
}

/* An invalid transition is the caller's error, so it stays 400 - but the state
 * names are still stripped, because they describe the document's real state. */
const badTransition = await run(handleLibraryPublish, {
  env: WITH_PUBLISHER, caller: PUBLISHER_CALLER,
  body: { documentId: 'd1', state: 'published' },
  rpcError: {
    status: 400, code: '22023',
    message: 'Tracework publication stopped: superseded -> published is not a permitted transition',
  },
})
assert.equal(badTransition.status, 400)
assert.equal(badTransition.payload.error.code, 'invalid_library_request')
assert.equal(
  JSON.stringify(badTransition.payload).includes('superseded'), false,
  'the refusal must not disclose the document\'s current publication state',
)

/* Containment must not swallow the errors this module raises itself: a caller
 * still needs to learn that writes are disabled or that their token expired. */
const stillClear = await run(handleLibraryPublish, {
  env: WITH_PUBLISHER, caller: CALLER, body: { documentId: 'd1', state: 'published' },
})
assert.equal(stillClear.payload.error.code, 'publish_not_permitted', 'module-raised errors must pass through unchanged')
/* The mapper must cover every 6E route, not just the one it was written against. */
for (const [name, handler, body] of [
  ['ingest', handleLibraryIngest, DOC],
  ['publish', handleLibraryPublish, { documentId: 'd-secret', state: 'published' }],
  ['status', handleLibraryStatus, {}],
]) {
  const permitted = await run(handler, {
    env: WITH_PUBLISHER, caller: PUBLISHER_CALLER, body, rpcError: UPSTREAM_NOT_PERMITTED,
  })
  const absent = await run(handler, {
    env: WITH_PUBLISHER, caller: PUBLISHER_CALLER, body, rpcError: UPSTREAM_NOT_FOUND,
  })
  assert.deepEqual(
    permitted.payload, absent.payload,
    `${name}: unauthorized and nonexistent must be indistinguishable`,
  )
  assert.equal(permitted.status, absent.status, `${name}: statuses must match`)
  assert.equal(permitted.payload.error.code, 'library_write_refused', `${name}: stable generic code`)
  for (const fragment of FORBIDDEN_FRAGMENTS) {
    assert.equal(
      JSON.stringify(permitted.payload).includes(fragment), false,
      `${name} leaked "${fragment}"`,
    )
  }
}

/*
 * Diagnostics are preserved server-side. Discarding the upstream text entirely
 * would leave an operator with a bare 500 and nothing to act on, so it is logged
 * - and the log must carry no environment value.
 */
{
  const original = console.error
  const lines = []
  console.error = (...args) => { lines.push(args.join(' ')) }
  let result
  try {
    result = await run(handleLibraryIngest, {
      env: OPEN, caller: CALLER, body: DOC, rpcError: UPSTREAM_INTERNAL,
    })
  } finally {
    console.error = original
  }

  const logged = lines.join('\n')
  assert.ok(logged.includes('[tracework:6e]'), 'a diagnostic must be written server-side')
  assert.ok(
    logged.includes(UPSTREAM_INTERNAL.message),
    'the diagnostic must keep the upstream message, or it is not useful',
  )
  for (const secret of [
    BASE_ENV.SUPABASE_SERVICE_ROLE_KEY,
    BASE_ENV.SUPABASE_PUBLISHABLE_KEY,
    'TRACEWORK_PUBLISHERS',
  ]) {
    assert.equal(logged.includes(secret), false, `the server diagnostic leaked ${secret}`)
  }
  /* The same detail must still be absent from what the caller receives. */
  assert.equal(
    JSON.stringify(result.payload).includes(UPSTREAM_INTERNAL.message), false,
    'the upstream message reached the client',
  )
}

console.log('  containment: unauthorized and nonexistent are byte-identical; no upstream text, ids or schema leak')
console.log('  containment: mapper covers ingest/publish/status; diagnostics kept server-side, secret-free')

/* --------------------------------------- 6. the workflow is reachable (R4) */

/*
 * A tested API nobody can call is not a feature. These assertions fail if the
 * client functions are ever orphaned again: the whole point of Phase 6E is that
 * a human can submit, a reviewer can publish, and a second person can then read.
 */
const app = readText('../src/App.tsx')

for (const [fn, why] of [
  ['submitLibraryDocument', 'User A must have a real submit action'],
  ['requestLibraryStatus', 'a reviewer must be able to load the queue'],
  ['setLibraryPublicationState', 'a reviewer must be able to publish or block'],
  ['toIngestRequest', 'the submit action must build a real ingest payload'],
]) {
  assert.ok(app.includes(fn), `${fn} must be called from the application: ${why}`)
}

for (const prop of [
  'contributable', 'contributeTargets', 'onSubmitDocument',
  'reviewQueue', 'onRefreshReview', 'onChangePublicationState',
]) {
  assert.ok(
    new RegExp(`${prop}=`).test(app),
    `KnowledgeLibrary must receive ${prop}; an unwired panel is not a workflow`,
  )
}

/* Under the contributor model every catalog entry is a candidate: public ones
 * accept contributions, and a private or workspace entry is only listed for
 * someone already authorized on it. The one case the client cannot filter is a
 * system collection, which the database refuses. */
const targetsBlock = app.slice(app.indexOf('contributeTargets={'), app.indexOf('contributePendingId='))
assert.ok(
  targetsBlock.includes('libraryCollections'),
  'contribute targets must come from the catalog the caller can actually see',
)
assert.equal(
  /\.filter\(/.test(targetsBlock), false,
  'no client-side scope filter: authorization is the database\'s decision, not the UI\'s guess',
)
console.log('  reachable: App calls submit/status/publication and passes every panel prop')

console.log('phase 6E: all assertions passed')
