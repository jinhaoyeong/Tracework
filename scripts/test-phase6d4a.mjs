/**
 * Phase 6D4A - authenticated private/workspace library reads.
 *
 * This suite analyses the COMPLETE chain, 6D3 (20260814045002) followed by 6D4A
 * (20260815000100), because 6D4A on its own proves nothing. PostgreSQL combines
 * permissive policies on one table with OR, so a 6D4A policy sitting beside the
 * 6D3 one could only ever widen access. Section 4 encodes that failure mode
 * directly: it shows the 6D3 baseline leaking pending and blocked documents to
 * an active workspace member, shows that a parallel 6D4A policy would still leak
 * them, and shows that replacing the predicate does not.
 *
 * The invariants under test:
 *
 *   1. After the chain, every table carries exactly ONE policy.
 *   2. An active workspace member cannot read a pending or blocked document.
 *   3. A private owner still reads every publication state of their own.
 *   4. No policy anywhere has a visibility = 'public' branch, so the 6D2A
 *      containment cannot be routed around by signing in.
 *   5. The ACL delta is exactly three grants, none to anon, none on sources,
 *      chunks, or workspaces - which is what keeps the other 6D3 policies inert.
 *   6. 6D4A creates no policy, no function, no view, nothing SECURITY DEFINER,
 *      and leaves the 6D2A functions untouched.
 *   7. The ANONYMOUS HTTP contract is byte-identical to pre-6D4A.
 *
 * Sections:
 *   1. STRUCTURAL   assertions against both migration files.
 *   2. GRAPH        the combined policy dependency graph, proved acyclic.
 *   3. ACL          the grant delta, parsed out of the 6D4A SQL.
 *   4. RELATIONAL   fixture evaluation, including the leak witness.
 *   5. TRANSPORT    the real route handlers, driven with an injected fetch.
 *
 * LIMITATION, stated explicitly and unchanged from 6D2A/6D3: no PostgreSQL is
 * available in this environment, so sections 2-4 evaluate models of the shipped
 * SQL rather than executing it. Every predicate a model applies is first
 * asserted present verbatim in the migration text, so weakening the SQL fails
 * section 1 even when a model still passes. Runtime proof on a disposable
 * PostgreSQL is the next gate and is NOT satisfied by this file.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  LIBRARY_CATALOG_MAX_COLLECTIONS,
  handleLibraryCollections,
  handleLibraryDocuments,
  mergeCatalogEntries,
} from '../server/traceworkApi.ts'

/* This repository checks out CRLF on Windows; an assertion about what the SQL
 * says must not depend on which line ending git handed us. */
const readMigration = (name) => readFileSync(
  new URL(`../supabase/migrations/${name}`, import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n')

const baseline = readMigration('20260814045002_tracework_inert_rls_policies.sql')
const migration = readMigration('20260815000100_tracework_6d4a_authenticated_library_read.sql')

/** Executable SQL only, with string literals blanked. Comments must not satisfy
 * a content assertion, and a literal inside a `raise exception` message must not
 * trip a "must not contain" one. */
const statementsOf = (sql) => sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n')
  .replace(/'[^']*'/g, "''")

const statements = statementsOf(migration)
const baselineStatements = statementsOf(baseline)

/* ----------------------------------------------------- 1. structural */

/* The 6D3 baseline must be the file this suite thinks it is. */
const BASELINE_POLICIES = {
  workspace_members_select: 'workspace_members',
  workspaces_select: 'workspaces',
  tracework_collections_select: 'tracework_collections',
  tracework_library_documents_select: 'tracework_library_documents',
  tracework_sources_select: 'tracework_sources',
  tracework_chunks_select: 'tracework_chunks',
}

const statementBody = (sql, opening) => {
  const start = sql.indexOf(opening)
  assert.notEqual(start, -1, `expected statement not found: ${opening}`)
  const end = sql.indexOf(';', start)
  assert.notEqual(end, -1, `${opening} must terminate`)
  return sql.slice(start, end)
}

for (const [policy, table] of Object.entries(BASELINE_POLICIES)) {
  const body = statementBody(baseline, `create policy ${policy}`)
  assert.ok(body.includes(`on public.${table}`), `6D3 ${policy} must be attached to ${table}`)
  assert.ok(/\bfor select\b/.test(body), `6D3 ${policy} must be a SELECT policy`)
  assert.ok(/\bto authenticated\b/.test(body), `6D3 ${policy} must apply to authenticated only`)
}

/* 6D4A must NOT add a policy. This is the correction: a parallel permissive
 * policy ORs with the 6D3 one and cannot narrow it. */
assert.equal(
  /create\s+policy/i.test(statements),
  false,
  '6D4A must not create a policy: permissive policies combine with OR and can only widen access',
)
assert.ok(/alter\s+policy\s+tracework_library_documents_select/i.test(statements),
  '6D4A must alter the existing documents policy in place')

/* Exactly one policy is altered, and it is the only one that needed changing. */
assert.equal(
  (statements.match(/alter\s+policy/gi) ?? []).length,
  1,
  '6D4A must alter exactly one policy; the other two 6D3 predicates already meet their spec',
)
for (const untouched of ['workspace_members_select', 'tracework_collections_select', 'workspaces_select', 'tracework_sources_select', 'tracework_chunks_select']) {
  assert.equal(
    new RegExp(`(alter|drop|create)\\s+policy\\s+${untouched}`, 'i').test(statements),
    false,
    `6D4A must leave 6D3 policy ${untouched} alone`,
  )
}

/**
 * Static proof of one policy per table across the whole chain: 6D3 creates six,
 * one per table; 6D4A creates none and drops none. The migration re-proves this
 * at apply time against pg_policy, which also catches a policy created outside
 * these two files.
 */
const createdPolicies = [...baselineStatements.matchAll(/create\s+policy\s+(\w+)\s*\n?\s*on\s+public\.(\w+)/gi)]
  .map((match) => ({ policy: match[1], table: match[2] }))
assert.equal(createdPolicies.length, 6, '6D3 must create exactly six policies')
assert.equal(
  new Set(createdPolicies.map((entry) => entry.table)).size,
  6,
  '6D3 must create exactly one policy per table',
)
assert.equal(/drop\s+policy/i.test(statements), false, '6D4A must drop no policy')
assert.deepEqual(
  Object.fromEntries(createdPolicies.map((entry) => [entry.policy, entry.table])),
  BASELINE_POLICIES,
  'the parsed 6D3 policy set must match the documented baseline',
)

/* 6D4A creates no callable object at all. */
assert.equal(/security\s+definer/i.test(statements), false, '6D4A must create no SECURITY DEFINER object')
assert.equal(/create\s+(or\s+replace\s+)?function/i.test(statements), false, '6D4A must create no function')
assert.equal(/create\s+(or\s+replace\s+)?view/i.test(statements), false, '6D4A must create no view (D8-a defers the caller-count view)')

/* The 6D2A read path must not be redefined, re-owned, or re-granted. */
for (const untouched of ['tracework_list_collections', 'tracework_collection_documents', 'tracework_match_chunks']) {
  for (const pattern of ['create\\s+(or\\s+replace\\s+)?function\\s+public\\.', 'grant\\s+execute[^;]*', 'alter\\s+function[^;]*']) {
    assert.equal(
      new RegExp(`${pattern}${untouched}`, 'i').test(statements),
      false,
      `6D4A must not touch ${untouched}`,
    )
  }
}

/* No schema surgery in a read-enablement stage. */
for (const forbidden of [/alter\s+table/i, /drop\s+/i, /create\s+table/i, /create\s+index/i, /insert\s+into/i, /delete\s+from/i]) {
  assert.equal(forbidden.test(statements), false, `6D4A must not contain ${forbidden}`)
}

/* Preconditions must assert the 6D3 baseline, not that the names are free. */
for (const precondition of [
  'pg_policy',
  'polname',
  'carries more than one policy',
  'pg_get_expr(polqual, polrelid)',
  'conrelid',
  "has_table_privilege('anon'",
  "has_any_column_privilege('anon'",
  "has_table_privilege('authenticated'",
  "has_any_column_privilege('authenticated'",
  'relrowsecurity',
  'prosecdef',
]) {
  assert.ok(migration.includes(precondition), `preconditions must check ${precondition}`)
}
/* Constraint checks must be scoped by relation as well as name. */
const constraintCheck = statementBody(migration, 'for expected in')
assert.ok(constraintCheck.includes('conrelid = expected.relation::regclass'), 'constraint checks must be scoped by conrelid')
assert.ok(constraintCheck.includes('conname  = expected.constraint_name'), 'constraint checks must be scoped by conname')
assert.ok(
  (statements.match(/raise exception/g) ?? []).length >= 10,
  'the precondition block must abort on each unmet assumption',
)
/* It must refuse to run on an already-corrected predicate. */
assert.ok(
  migration.includes('already gates on publication_state'),
  'preconditions must refuse to run twice',
)

/* 6D3 must sort before 6D4A, so the chain applies in the intended order. */
assert.ok(
  '20260814045002_tracework_inert_rls_policies.sql' < '20260815000100_tracework_6d4a_authenticated_library_read.sql',
  '6D3 must precede 6D4A in migration order',
)
assert.ok(
  migration.includes('20260814045002'),
  '6D4A must name the 6D3 migration it depends on',
)

/**
 * Extracts a balanced `using ( ... )` expression, then normalises whitespace so
 * two spellings of the same predicate compare equal.
 */
const usingExpression = (text) => {
  const open = text.indexOf('using (')
  assert.notEqual(open, -1, 'expected a using ( ... ) clause')
  let depth = 0
  for (let index = open + 6; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1
    if (text[index] === ')') {
      depth -= 1
      if (depth === 0) return text.slice(open + 6, index + 1).replace(/\s+/g, ' ').trim().toLowerCase()
    }
  }
  throw new Error('unbalanced using ( ... ) clause')
}

/* Rollback must restore the 6D3 predicate EXACTLY, not merely mention it. The
 * rollback lives in comments, so the comment markers are stripped first. */
const rollbackText = migration
  .slice(migration.indexOf('-- ROLLBACK'))
  .split('\n')
  .map((line) => line.replace(/^--\s?/, ''))
  .join('\n')

assert.equal(
  usingExpression(rollbackText.slice(rollbackText.indexOf('alter policy tracework_library_documents_select'))),
  usingExpression(statementBody(baseline, 'create policy tracework_library_documents_select')),
  'the rollback predicate must be exactly the 6D3 predicate',
)

const commentLiteral = (text) => {
  const match = /is\s*\n?\s*'((?:[^']|'')*)'/.exec(text)
  assert.ok(match, 'expected a comment literal')
  return match[1].replace(/\s+/g, ' ').trim()
}
assert.equal(
  commentLiteral(rollbackText.slice(rollbackText.indexOf('comment on policy'))),
  commentLiteral(baseline.slice(baseline.indexOf('comment on policy tracework_library_documents_select'))),
  'the rollback must restore the exact 6D3 policy comment',
)

for (const reversal of [
  'revoke select on table public.tracework_library_documents from authenticated',
  'revoke select on table public.tracework_collections from authenticated',
  'revoke select (workspace_id, user_id, role, status)',
]) {
  assert.ok(migration.includes(reversal), `rollback must include: ${reversal}`)
}

/* The decisive predicate assertions. */
const correctedDocuments = statementBody(migration, 'alter policy tracework_library_documents_select')
assert.ok(correctedDocuments.includes("publication_state = 'published'"), 'the corrected predicate must gate the workspace branch on published')
assert.ok(correctedDocuments.includes("collections.visibility = 'private'"), 'the corrected predicate must carry a private branch')
assert.ok(correctedDocuments.includes("collections.visibility = 'workspace'"), 'the corrected predicate must carry a workspace branch')
assert.ok(
  correctedDocuments.includes('tracework_library_documents.collection_slug'),
  'outer columns inside the subquery must be table-qualified, per the 6D3 rebinding rule',
)

/* No public branch anywhere in the whole chain. Literals are needed here, so
 * this reads the comment-stripped text rather than the literal-blanked text. */
for (const [name, sql] of [['6D3', baseline], ['6D4A', migration]]) {
  const policyText = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
  assert.equal(
    /visibility\s*=\s*'public'/.test(policyText),
    false,
    `${name} must contain no visibility = 'public' policy branch`,
  )
}

/* The 6D3 baseline predicate this migration corrects had no publication gate.
 * If that ever stops being true the correction is aimed at the wrong thing. */
const baselineDocuments = statementBody(baseline, 'create policy tracework_library_documents_select')
assert.equal(
  baselineDocuments.includes('publication_state'),
  false,
  'the 6D3 documents predicate is expected to have no publication gate; that is what 6D4A corrects',
)

console.log('  structural: 6D4A alters exactly one 6D3 policy, creates none, and leaves 6D2A untouched')

/* ---------------------------------------------------------- 2. graph */

/* Edges from the 6D3 policies, with the documents edge replaced by 6D4A's. */
const edgesFrom = (body, table) => [...body.matchAll(/from\s+public\.(\w+)/g)].map((match) => [table, match[1]])

const edges = []
for (const [policy, table] of Object.entries(BASELINE_POLICIES)) {
  if (policy === 'tracework_library_documents_select') {
    edges.push(...edgesFrom(correctedDocuments, table))
    continue
  }
  edges.push(...edgesFrom(statementBody(baseline, `create policy ${policy}`), table))
}

const RANK = {
  workspace_members: 0,
  workspaces: 1,
  tracework_collections: 1,
  tracework_library_documents: 2,
  tracework_sources: 3,
  tracework_chunks: 4,
}

assert.deepEqual(
  [...new Set(edges.map((edge) => edge.join(' -> ')))].sort(),
  [
    'tracework_chunks -> tracework_sources',
    'tracework_collections -> workspace_members',
    'tracework_library_documents -> tracework_collections',
    'tracework_sources -> tracework_library_documents',
    'workspaces -> workspace_members',
  ],
  'the combined edge set must match the documented chain',
)

for (const [source, target] of edges) {
  assert.ok(source in RANK && target in RANK, `unranked relation in edge ${source} -> ${target}: the graph has grown`)
  assert.ok(RANK[source] > RANK[target], `edge ${source} -> ${target} does not strictly decrease rank`)
}

const adjacency = new Map()
for (const [source, target] of edges) {
  if (!adjacency.has(source)) adjacency.set(source, [])
  adjacency.get(source).push(target)
}
const walk = (node, stack) => {
  assert.equal(stack.includes(node), false, `cycle detected: ${[...stack, node].join(' -> ')}`)
  for (const next of adjacency.get(node) ?? []) walk(next, [...stack, node])
}
for (const node of Object.keys(RANK)) walk(node, [])

console.log('  graph: 6 relations, 5 distinct edges, strictly decreasing rank, no cycle (42P17 unreachable)')

/* ------------------------------------------------------------ 3. ACL */

const grants = [...statements.matchAll(/grant\s+select\s*(\(([^)]*)\))?\s*\n?\s*on\s+table\s+public\.(\w+)\s+to\s+(\w+)/gi)]
  .map((match) => ({
    table: match[3],
    grantee: match[4],
    columns: match[2] ? match[2].split(',').map((column) => column.trim()).sort() : null,
  }))
  .sort((left, right) => left.table.localeCompare(right.table))

assert.deepEqual(grants, [
  { table: 'tracework_collections', grantee: 'authenticated', columns: null },
  { table: 'tracework_library_documents', grantee: 'authenticated', columns: null },
  { table: 'workspace_members', grantee: 'authenticated', columns: ['role', 'status', 'user_id', 'workspace_id'] },
], 'the ACL delta must be exactly three grants, all to authenticated')

assert.equal(/grant[^;]*\banon\b/i.test(statements), false, '6D4A must grant anon nothing, anywhere')
assert.equal(/grant/i.test(baselineStatements), false, '6D3 must remain grant-free')

/* The three ungranted tables are what keep the remaining 6D3 policies inert. */
for (const withheld of ['tracework_sources', 'tracework_chunks', 'workspaces']) {
  assert.equal(
    new RegExp(`grant[^;]*public\\.${withheld}\\b`, 'i').test(statements),
    false,
    `6D4A must not grant ${withheld}; its 6D3 policy must stay inert`,
  )
}
assert.equal(
  grants.find((grant) => grant.table === 'workspace_members').columns.includes('invited_by_user_id'),
  false,
  'the membership grant must withhold invited_by_user_id',
)

console.log('  acl: 3 grants, 0 to anon, sources/chunks/workspaces ungranted so their 6D3 policies stay inert')

/* ----------------------------------------------------- 4. relational */

const ALICE = 'user-alice'
const BOB = 'user-bob'
const WORKSPACE = 'ws-1'

const collections = [
  { slug: 'public-live', visibility: 'public', owner_user_id: null, workspace_id: null },
  { slug: 'legacy-quarantine', visibility: 'public', owner_user_id: null, workspace_id: null },
  { slug: 'public-pending', visibility: 'public', owner_user_id: null, workspace_id: null },
  { slug: 'public-empty', visibility: 'public', owner_user_id: null, workspace_id: null },
  { slug: 'alice-private', visibility: 'private', owner_user_id: ALICE, workspace_id: null },
  { slug: 'alice-private-empty', visibility: 'private', owner_user_id: ALICE, workspace_id: null },
  { slug: 'bob-private', visibility: 'private', owner_user_id: BOB, workspace_id: null },
  { slug: 'team-space', visibility: 'workspace', owner_user_id: null, workspace_id: WORKSPACE },
]

const documents = [
  { id: 'd1', collection_slug: 'public-live', publication_state: 'published' },
  { id: 'd2', collection_slug: 'legacy-quarantine', publication_state: 'blocked' },
  { id: 'd3', collection_slug: 'public-pending', publication_state: 'pending' },
  { id: 'd4', collection_slug: 'alice-private', publication_state: 'published' },
  { id: 'd5', collection_slug: 'alice-private', publication_state: 'pending' },
  { id: 'd6', collection_slug: 'alice-private', publication_state: 'blocked' },
  { id: 'd7', collection_slug: 'bob-private', publication_state: 'published' },
  { id: 'd8', collection_slug: 'team-space', publication_state: 'published' },
  { id: 'd9', collection_slug: 'team-space', publication_state: 'pending' },
  { id: 'd10', collection_slug: 'team-space', publication_state: 'blocked' },
]

const memberships = [
  { workspace_id: WORKSPACE, user_id: ALICE, status: 'active' },
  { workspace_id: WORKSPACE, user_id: BOB, status: 'invited' },
]

/* 6D2A service_role path: public AND published, INNER JOIN so a collection with
 * nothing published disappears entirely. */
const publicCollections = () => collections
  .filter((collection) => collection.visibility === 'public')
  .filter((collection) => documents.some((document) => (
    document.collection_slug === collection.slug && document.publication_state === 'published'
  )))
  .map((collection) => collection.slug)

/* 6D3 workspace_members_select, unchanged by 6D4A. */
const visibleMemberships = (uid) => memberships.filter((member) => member.user_id === uid)

/* 6D3 tracework_collections_select, unchanged by 6D4A. */
const scopedCollections = (uid) => collections.filter((collection) => (
  (collection.visibility === 'private' && uid !== null && collection.owner_user_id === uid)
  || (
    collection.visibility === 'workspace'
    && collection.workspace_id !== null
    && visibleMemberships(uid).some((member) => (
      member.workspace_id === collection.workspace_id && member.status === 'active'
    ))
  )
))

/* 6D3 tracework_library_documents_select: parent visible, NO publication gate. */
const documentsBaseline = (uid) => {
  const visible = new Set(scopedCollections(uid).map((collection) => collection.slug))
  return documents.filter((document) => visible.has(document.collection_slug))
}

/* 6D4A replacement: private owner every state, workspace published only. */
const documents6D4A = (uid) => {
  const visible = new Map(scopedCollections(uid).map((collection) => [collection.slug, collection]))
  return documents.filter((document) => {
    const parent = visible.get(document.collection_slug)
    if (!parent) return false
    if (parent.visibility === 'private') return true
    return document.publication_state === 'published'
  })
}

/* PostgreSQL ORs permissive policies. This is what the rejected design produced. */
const documentsParallelPolicies = (uid) => {
  const corrected = new Set(documents6D4A(uid).map((document) => document.id))
  return documents.filter((document) => (
    corrected.has(document.id) || documentsBaseline(uid).some((baselineDoc) => baselineDoc.id === document.id)
  ))
}

const ids = (rows) => rows.map((row) => row.id).sort()

assert.deepEqual(publicCollections(), ['public-live'], 'the public path lists only public collections holding published documents')

/* THE LEAK WITNESS: the 6D3 baseline hands an active workspace member the
 * pending and blocked documents, which is why 6D4A must replace it. */
assert.deepEqual(
  ids(documentsBaseline(ALICE)),
  ['d10', 'd4', 'd5', 'd6', 'd8', 'd9'],
  'witness: under the 6D3 baseline an active workspace member reads pending and blocked workspace documents',
)
assert.ok(ids(documentsBaseline(ALICE)).includes('d9'), 'witness: d9 is pending and leaks under the baseline')
assert.ok(ids(documentsBaseline(ALICE)).includes('d10'), 'witness: d10 is blocked and leaks under the baseline')

/* A parallel 6D4A policy would NOT have fixed it. */
assert.deepEqual(
  ids(documentsParallelPolicies(ALICE)),
  ids(documentsBaseline(ALICE)),
  'a parallel permissive policy ORs with the baseline and changes nothing; replacement is required',
)

/* The correction. */
assert.deepEqual(
  ids(documents6D4A(ALICE)),
  ['d4', 'd5', 'd6', 'd8'],
  'D4-b: alice reads every state of her own private collection, published only in the workspace',
)
for (const leaked of ['d9', 'd10']) {
  assert.equal(
    ids(documents6D4A(ALICE)).includes(leaked),
    false,
    `an active workspace member must not read ${leaked}`,
  )
}
assert.deepEqual(ids(documents6D4A(BOB)), ['d7'], 'an invited-not-active member reaches only their own private document')
assert.deepEqual(documents6D4A(null), [], 'a NULL principal reaches no document')

/* Public containment holds on the caller path for every principal. */
for (const uid of [ALICE, BOB, null]) {
  const reachableCollections = scopedCollections(uid).map((collection) => collection.slug)
  for (const contained of ['public-live', 'legacy-quarantine', 'public-pending', 'public-empty']) {
    assert.equal(reachableCollections.includes(contained), false, `${uid ?? 'anonymous'} must not reach public collection ${contained}`)
  }
  for (const contained of ['d1', 'd2', 'd3']) {
    assert.equal(ids(documents6D4A(uid)).includes(contained), false, `${uid ?? 'anonymous'} must not reach public document ${contained}`)
  }
}

assert.ok(
  scopedCollections(ALICE).some((collection) => collection.slug === 'alice-private-empty'),
  'an authorized collection with no published documents must remain listable',
)
assert.deepEqual(visibleMemberships(ALICE).map((member) => member.user_id), [ALICE], 'a caller must not enumerate co-members')

console.log('  relational: 6D3 baseline leak reproduced, parallel-policy fix shown ineffective, replacement proved correct')

/* ------------------------------------------------------ 5. transport */

const BASE_ENV = {
  SUPABASE_URL: 'https://project.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
}

const collectRow = (slug, sortOrder, extra = {}) => ({
  slug,
  title: slug,
  description: '',
  kind: 'note',
  provenance: {},
  sort_order: sortOrder,
  updated_at: null,
  ...extra,
})

const captureResponse = () => {
  const captured = { status: 0, payload: null }
  return {
    captured,
    response: {
      status(statusCode) {
        captured.status = statusCode
        return this
      },
      json(payload) {
        captured.payload = payload
      },
    },
  }
}

const stubFetch = (options) => {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('/rest/v1/rpc/')) {
      return { ok: true, status: 200, json: async () => options.publicRows ?? [] }
    }
    if (typeof options.scopedRows === 'function') return options.scopedRows()
    return { ok: true, status: 200, json: async () => options.scopedRows ?? [] }
  }
  return { impl, calls }
}

const runCollections = async ({ env = {}, publicRows = [], scopedRows = [], caller = null }) => {
  const { captured, response } = captureResponse()
  const { impl, calls } = stubFetch({ publicRows, scopedRows })
  await handleLibraryCollections({ method: 'POST', headers: {} }, response, {
    env: { ...BASE_ENV, ...env },
    fetchImpl: impl,
    resolveCaller: async () => caller,
  })
  return { ...captured, calls }
}

const CALLER = { userId: ALICE, accessToken: 'caller-token' }
const LEGACY_KEYS = ['slug', 'title', 'description', 'kind', 'provenance', 'documentCount', 'characterCount', 'updatedAt']

/* THE ANONYMOUS CONTRACT: byte-identical to pre-6D4A. No scope key, numeric
 * counts, no ceiling, and the order the 6D2A function returned. */
{
  const result = await runCollections({
    env: { TRACEWORK_AUTHENTICATED_LIBRARY_READS: 'true' },
    publicRows: [
      collectRow('zebra', 5, { document_count: 1, character_count: 10 }),
      collectRow('alpha', 5, { document_count: 2, character_count: 20 }),
    ],
    caller: null,
  })
  assert.equal(result.status, 200)
  assert.deepEqual(Object.keys(result.payload), ['database', 'collections'])
  assert.deepEqual(Object.keys(result.payload.collections[0]), LEGACY_KEYS, 'an anonymous row must carry exactly the pre-6D4A keys, in order')
  assert.equal('scope' in result.payload.collections[0], false, 'an anonymous row must not gain a scope field')
  assert.deepEqual(
    result.payload.collections.map((collection) => collection.slug),
    ['zebra', 'alpha'],
    'an anonymous response must preserve the order the 6D2A function returned',
  )
  assert.equal(result.calls.length, 1, 'an anonymous request must issue no caller-context read')
}

/* Flag default-off: the credential is never even inspected. */
{
  const result = await runCollections({
    publicRows: [collectRow('public-live', 0, { document_count: 3, character_count: 900 })],
    scopedRows: [collectRow('alice-private', 1, { visibility: 'private' })],
    caller: CALLER,
  })
  assert.deepEqual(Object.keys(result.payload.collections[0]), LEGACY_KEYS, 'with the flag off the legacy contract must hold')
  assert.equal(result.calls.length, 1, 'with the flag off only the service_role RPC may be called')
}

/* The anonymous path is not subject to the composed-path ceiling. */
{
  const oversized = Array.from({ length: LIBRARY_CATALOG_MAX_COLLECTIONS + 5 }, (unused, index) => (
    collectRow(`c-${index}`, index, { document_count: 0, character_count: 0 })
  ))
  const result = await runCollections({ publicRows: oversized })
  assert.equal(result.status, 200, 'the anonymous contract carries no row ceiling; that is a separate API decision')
  assert.equal(result.payload.collections.length, LIBRARY_CATALOG_MAX_COLLECTIONS + 5)
}

/* Composed path: scope, nullable counts, deterministic order, ceiling. */
{
  const result = await runCollections({
    env: { TRACEWORK_AUTHENTICATED_LIBRARY_READS: 'true' },
    publicRows: [
      collectRow('zebra-public', 5, { document_count: 1, character_count: 10 }),
      collectRow('alpha-public', 5, { document_count: 2, character_count: 20 }),
    ],
    scopedRows: [
      collectRow('team-space', 1, { visibility: 'workspace' }),
      collectRow('alice-private', 9, { visibility: 'private' }),
    ],
    caller: CALLER,
  })
  assert.equal(result.status, 200)
  assert.deepEqual(
    result.payload.collections.map((collection) => collection.slug),
    ['team-space', 'alpha-public', 'zebra-public', 'alice-private'],
    'the composed catalog orders by sort_order, then title, then slug',
  )
  assert.deepEqual(result.payload.collections.map((collection) => collection.scope), ['workspace', 'public', 'public', 'private'])
  for (const collection of result.payload.collections) {
    if (collection.scope === 'public') {
      assert.equal(typeof collection.documentCount, 'number')
    } else {
      assert.equal(collection.documentCount, null, 'a scoped entry must not reuse the public document count')
      assert.equal(collection.characterCount, null, 'a scoped entry must not reuse the public character count')
    }
  }

  const scopedCall = result.calls.find((call) => !call.url.includes('/rpc/'))
  assert.equal(scopedCall.init.headers.Authorization, 'Bearer caller-token', 'the caller path must use the caller JWT')
  assert.equal(scopedCall.init.headers.apikey, 'publishable-key', 'the caller path must not present the service role key')
  assert.ok(scopedCall.url.includes(`limit=${LIBRARY_CATALOG_MAX_COLLECTIONS + 1}`), 'the caller read must ask one row past the ceiling')
}

/* A public row on the caller path means the collections policy has been widened. */
{
  const result = await runCollections({
    env: { TRACEWORK_AUTHENTICATED_LIBRARY_READS: 'true' },
    scopedRows: [collectRow('public-live', 0, { visibility: 'public' })],
    caller: CALLER,
  })
  assert.equal(result.status, 500)
  assert.equal(result.payload.error.code, 'catalog_scope_violation')
}

/* A slug on both paths is a broken invariant, not something to deduplicate. */
{
  const result = await runCollections({
    env: { TRACEWORK_AUTHENTICATED_LIBRARY_READS: 'true' },
    publicRows: [collectRow('same-slug', 0, { document_count: 1, character_count: 1 })],
    scopedRows: [collectRow('same-slug', 0, { visibility: 'private' })],
    caller: CALLER,
  })
  assert.equal(result.status, 500)
  assert.equal(result.payload.error.code, 'catalog_scope_collision')
}

/* The composed-path ceiling refuses rather than truncating. */
{
  const oversized = Array.from({ length: LIBRARY_CATALOG_MAX_COLLECTIONS + 1 }, (unused, index) => (
    collectRow(`c-${index}`, index, { document_count: 0, character_count: 0 })
  ))
  const result = await runCollections({
    env: { TRACEWORK_AUTHENTICATED_LIBRARY_READS: 'true' },
    publicRows: oversized,
    caller: CALLER,
  })
  assert.equal(result.status, 503)
  assert.equal(result.payload.error.code, 'catalog_too_large')

  const atLimit = await runCollections({
    env: { TRACEWORK_AUTHENTICATED_LIBRARY_READS: 'true' },
    publicRows: oversized.slice(0, LIBRARY_CATALOG_MAX_COLLECTIONS),
    caller: CALLER,
  })
  assert.equal(atLimit.status, 200, 'exactly the ceiling must still succeed')
}

assert.throws(
  () => mergeCatalogEntries(Array.from({ length: LIBRARY_CATALOG_MAX_COLLECTIONS + 1 }, (unused, index) => ({
    sortOrder: index,
    collection: { slug: `x-${index}`, title: `x-${index}`, scope: 'public' },
  }))),
  /catalog holds/,
  'the merge must enforce the ceiling directly',
)

/* Error mapping. */
{
  const expired = await runCollections({
    env: { TRACEWORK_AUTHENTICATED_LIBRARY_READS: 'true' },
    scopedRows: () => ({ ok: false, status: 401, json: async () => ({ code: 'PGRST301', message: 'JWT expired' }) }),
    caller: CALLER,
  })
  assert.equal(expired.status, 401)
  assert.equal(expired.payload.error.code, 'invalid_auth')
  assert.equal(expired.payload.error.message.includes('JWT'), false, 'the upstream message must not be forwarded')

  const denied = await runCollections({
    env: { TRACEWORK_AUTHENTICATED_LIBRARY_READS: 'true' },
    scopedRows: () => ({ ok: false, status: 403, json: async () => ({ code: '42501', message: 'permission denied for table tracework_collections' }) }),
    caller: CALLER,
  })
  assert.equal(denied.status, 500)
  assert.equal(denied.payload.error.code, 'caller_context_misconfigured')
  assert.notEqual(denied.payload.error.code, 'authorization_pending', 'a broken ACL must not masquerade as a policy decision')
  assert.equal(denied.payload.error.message.includes('permission denied'), false, 'the upstream message must not be forwarded')
}

/* An AuthFailure raised while resolving an optional caller keeps its 401. */
{
  const { captured, response } = captureResponse()
  const { impl } = stubFetch({ publicRows: [] })
  await handleLibraryCollections({ method: 'POST', headers: {} }, response, {
    env: { ...BASE_ENV, TRACEWORK_AUTHENTICATED_LIBRARY_READS: 'true' },
    fetchImpl: impl,
    resolveCaller: async () => {
      throw Object.assign(new Error('Authentication credentials are malformed.'), { code: 'malformed_auth', status: 401 })
    },
  })
  assert.equal(captured.status, 401)
  assert.equal(captured.payload.error.code, 'malformed_auth')
}

/* Documents: shape unchanged, public first, caller path only on empty. */
const runDocuments = async ({ env = {}, publicRows = [], scopedRows = [], caller = null, slug = 'alice-private' }) => {
  const { captured, response } = captureResponse()
  const { impl, calls } = stubFetch({ publicRows, scopedRows })
  await handleLibraryDocuments({ method: 'POST', body: { slug }, headers: {} }, response, {
    env: { ...BASE_ENV, ...env },
    fetchImpl: impl,
    resolveCaller: async () => caller,
  })
  return { ...captured, calls }
}

const documentRow = (id, slug) => ({ id, collection_slug: slug, title: 't', source_path: 'p', kind: 'note', content: 'c', provenance: {} })

{
  const result = await runDocuments({
    env: { TRACEWORK_AUTHENTICATED_LIBRARY_READS: 'true' },
    publicRows: [documentRow('d1', 'public-live')],
    scopedRows: [documentRow('d4', 'alice-private')],
    caller: CALLER,
    slug: 'public-live',
  })
  assert.equal(result.status, 200)
  assert.deepEqual(
    Object.keys(result.payload.documents[0]),
    ['id', 'collectionSlug', 'title', 'sourcePath', 'kind', 'content', 'provenance'],
    'the documents contract is unchanged',
  )
  assert.equal(result.calls.length, 1, 'the caller path must not run when the public path answered')
}

{
  const result = await runDocuments({
    env: { TRACEWORK_AUTHENTICATED_LIBRARY_READS: 'true' },
    scopedRows: [documentRow('d4', 'alice-private')],
    caller: CALLER,
  })
  assert.equal(result.status, 200)
  assert.deepEqual(result.payload.documents.map((document) => document.id), ['d4'])
  assert.equal(result.calls.length, 2, 'the caller path must run when the public path returned nothing')
}

/* Unauthorized and nonexistent must be indistinguishable, message included. */
{
  const unauthorized = await runDocuments({
    env: { TRACEWORK_AUTHENTICATED_LIBRARY_READS: 'true' },
    caller: CALLER,
    slug: 'bob-private',
  })
  const missing = await runDocuments({ slug: 'bob-private' })
  assert.equal(unauthorized.status, 404)
  assert.equal(missing.status, 404)
  assert.deepEqual(unauthorized.payload, missing.payload, 'an unauthorized slug must be indistinguishable from a nonexistent one')
  assert.ok(missing.payload.error.message.includes('npm run seed:library'), 'the anonymous 404 message is unchanged')
}

/* The catalog is no longer one shared list, so the UI must not claim it is. */
{
  const component = readFileSync(new URL('../src/components/KnowledgeLibrary.tsx', import.meta.url), 'utf8')
  const intro = component.slice(component.indexOf('className="library-intro"'), component.indexOf('{status === \'error\''))
  assert.equal(
    /anyone opening tracework reads the same catalog/i.test(intro),
    false,
    'the intro must not claim every user sees the same catalog',
  )
  assert.ok(/public collections/i.test(intro), 'the intro must distinguish public collections')
  assert.ok(/workspace/i.test(intro) && /you own/i.test(intro), 'the intro must mention owned and workspace collections')
}

console.log('  transport: anonymous contract byte-identical, composed path scoped/ordered/ceilinged, error mapping stable')
console.log('phase 6D4A: all assertions passed')
