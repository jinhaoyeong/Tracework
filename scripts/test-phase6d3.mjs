/**
 * Phase 6D3 - inert RLS policy authoring (Option 3).
 *
 * Structural half: assertions against the real migration SQL, including a
 * policy-dependency graph that must match the approved acyclic chain.
 * Relational half: the same USING predicates, evaluated against fixtures.
 * A separate 6D2A half proves public+published containment still lives in
 * the hardened RPC SQL, which this phase does not replace.
 *
 * This suite is offline. It reads migration files from the worktree and
 * evaluates fixtures in process. It does not spawn subprocesses, call WSL,
 * invoke psql, probe ports, connect to a database, or use the network.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const readSql = (relativePath) => (
  readFileSync(new URL(relativePath, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
)

const migration = readSql('../supabase/migrations/20260814045002_tracework_inert_rls_policies.sql')
const containment = readSql('../supabase/migrations/20260814000100_tracework_public_read_containment.sql')
const executableSql = migration.replace(/--[^\n]*/g, '')

const D2A_FILE_MD5 = '9b2ae15a0226fb1f5866c5095bf89e23'
const D2A_FUNCTION_MD5 = {
  tracework_list_collections: '43965f9c5bec939218a97e12967576cf',
  tracework_collection_documents: '9ad8e7802261b5a8eb79e2226aef4200',
  tracework_match_chunks: '61c465baed2edf6dd2d1d04f27c45aed',
}

const requireSql = (label, snippet) => {
  assert.ok(executableSql.toLowerCase().includes(snippet.toLowerCase()), label)
}

const forbidSql = (label, pattern) => {
  assert.equal(pattern.test(executableSql), false, label)
}

const md5 = (text) => createHash('md5').update(text).digest('hex')

const functionBody = (sql, name) => {
  const start = sql.indexOf(`create or replace function public.${name}`)
  assert.notEqual(start, -1, `${name} must remain in the 6D2A migration`)
  const end = sql.indexOf('$$;', start)
  assert.notEqual(end, -1, `${name} body must terminate`)
  return sql.slice(start, end + 3)
}

/* ------------------------------------------------------- 1. structural */

const POLICY_TABLES = [
  ['workspace_members_select', 'public.workspace_members'],
  ['workspaces_select', 'public.workspaces'],
  ['tracework_collections_select', 'public.tracework_collections'],
  ['tracework_library_documents_select', 'public.tracework_library_documents'],
  ['tracework_sources_select', 'public.tracework_sources'],
  ['tracework_chunks_select', 'public.tracework_chunks'],
]

for (const [name, table] of POLICY_TABLES) {
  requireSql(`${name} created`, `create policy ${name}\non ${table}\nfor select\nto authenticated`)
}

requireSql('identity is auth.uid()', 'auth.uid()')
requireSql('private owner predicate', 'owner_user_id = auth.uid()')
requireSql('active membership status', "membership.status = 'active'")
requireSql('own membership visibility', 'user_id = auth.uid()')

/* --------------------------------- 1a. qualified outer-column references */

/*
 * PostgreSQL resolves an unqualified column to the innermost scope that
 * declares it. A lineage subquery written `where documents.id = document_id`
 * is correct only while tracework_library_documents has no `document_id`
 * column of its own; the day a migration adds one, the comparison silently
 * rebinds to the subquery's own row, the EXISTS becomes always-true, and the
 * policy authorizes every row. No error is raised, the policy count is
 * unchanged, and the dependency graph still looks correct -- so every other
 * gate in this suite would still pass. These assertions remove the dependency
 * on that schema coincidence.
 */

const QUALIFIED_REFERENCES = [
  ['workspaces', 'membership.workspace_id = workspaces.id', /membership\.workspace_id\s*=\s*id\b/i],
  ['documents', 'collections.slug = tracework_library_documents.collection_slug', /collections\.slug\s*=\s*collection_slug\b/i],
  ['sources', 'documents.id = tracework_sources.document_id', /documents\.id\s*=\s*document_id\b/i],
  ['chunks', 'sources.id = tracework_chunks.source_id', /sources\.id\s*=\s*source_id\b/i],
]

console.log('=== qualified outer-column references ===')
for (const [label, required, unqualified] of QUALIFIED_REFERENCES) {
  requireSql(`${label} lineage must be table-qualified: ${required}`, required)
  forbidSql(
    `${label} lineage must not rely on unqualified outer-column resolution`,
    unqualified,
  )
  console.log(`  ${label.padEnd(12)} ${required}`)
}

/*
 * Schema-drift resistance: re-run the reference gate against a mutated copy of
 * the migration in which each qualification has been stripped back to the bare
 * outer column. Every one of those copies must be rejected. This proves the
 * gate detects the regression rather than merely matching today's text.
 */
const driftRejections = QUALIFIED_REFERENCES.map(([label, required, unqualified]) => {
  const bareColumn = required.split('=')[1].trim().split('.').pop()
  const regressed = executableSql.replace(required, `${required.split('=')[0].trim()} = ${bareColumn}`)
  assert.notEqual(regressed, executableSql, `${label} drift fixture must differ from the migration`)
  const detected = unqualified.test(regressed) && !regressed.toLowerCase().includes(required.toLowerCase())
  assert.ok(detected, `${label} gate must reject an unqualified regression`)
  return `${label} -> rejected`
})
console.log('=== schema-drift resistance ===')
for (const line of driftRejections) console.log(`  ${line}`)

forbidSql('must not target anon', /\bto\s+anon\b/i)
forbidSql('must not use auth.role()', /auth\.role\s*\(/i)
forbidSql('must not use client ownerId', /\bownerid\b/i)
forbidSql('must not use client userId', /\buserid\b/i)
forbidSql('must not use client workspaceId', /\bworkspaceid\b/i)
forbidSql('must not GRANT', /\bgrant\b/i)
forbidSql('must not REVOKE', /\brevoke\b/i)
forbidSql('must not SECURITY DEFINER', /security\s+definer/i)
forbidSql('must not write data', /\b(insert\s+into|update\s+\w+\s+set|delete\s+from|merge\s+into|truncate)\b/i)
forbidSql('must not replace functions', /create\s+or\s+replace\s+function/i)
forbidSql('must not alter schema', /\balter\s+table\b/i)
forbidSql('must not toggle RLS', /row\s+level\s+security/i)
forbidSql('must not create indexes', /\bcreate\s+index\b/i)
forbidSql('must not WITH CHECK (writes)', /with\s+check/i)
forbidSql('must not FOR INSERT', /for\s+insert/i)
forbidSql('must not FOR UPDATE', /for\s+update/i)
forbidSql('must not FOR DELETE', /for\s+delete/i)
forbidSql('must not FOR ALL', /for\s+all/i)
forbidSql('system key is not an equality grant', /created_by_system_key\s*=/i)

assert.equal((executableSql.match(/create\s+policy/gi) || []).length, 6, 'exactly six SELECT policies')
assert.equal((executableSql.match(/\bto authenticated\b/gi) || []).length, 6, 'every policy is authenticated-only')

assert.ok(
  /anonymous[\s\S]*6d2a|6d2a[\s\S]*anonymous/i.test(migration),
  'migration must document that anonymous reads stay on 6D2A RPCs',
)
assert.ok(
  /must not grant anonymous direct table access/i.test(migration),
  'migration must forbid later anonymous table grants without review',
)
assert.ok(
  /legacy-quarantine stays hidden/i.test(migration),
  'migration must document that legacy-quarantine remains RPC-hidden',
)

/* ------------------------------------------ 1b. policy dependency graph */

const GRAPH_TABLES = [
  'workspace_members',
  'workspaces',
  'tracework_collections',
  'tracework_library_documents',
  'tracework_sources',
  'tracework_chunks',
]

const KNOWLEDGE_TABLES = [
  'tracework_collections',
  'tracework_library_documents',
  'tracework_sources',
  'tracework_chunks',
]

const EXPECTED_EDGES = [
  'tracework_chunks -> tracework_sources',
  'tracework_collections -> workspace_members',
  'tracework_library_documents -> tracework_collections',
  'tracework_sources -> tracework_library_documents',
  'workspaces -> workspace_members',
]

const extractUsingBody = (block) => {
  const match = block.match(/using\s*\(/i)
  if (!match) return ''
  const start = match.index + match[0].length - 1
  let depth = 0
  for (let index = start; index < block.length; index += 1) {
    if (block[index] === '(') depth += 1
    else if (block[index] === ')') {
      depth -= 1
      if (depth === 0) return block.slice(start + 1, index)
    }
  }
  return ''
}

const parsePolicies = (sql) => (
  sql.split(/create\s+policy/i).slice(1).map((block) => {
    const name = block.match(/^\s*(\w+)/)?.[1] ?? ''
    const table = block.match(/\bon\s+(?:public\.)?(\w+)/i)?.[1] ?? ''
    const roles = block.match(/\bto\s+([^\n]+)/i)?.[1]?.trim() ?? ''
    const using = extractUsingBody(block)
    const refs = new Set()
    const pattern = /\b(?:from|join)\s+(?:only\s+)?(?:public\.)?(\w+)/gi
    let match
    while ((match = pattern.exec(using))) {
      if (GRAPH_TABLES.includes(match[1])) refs.add(match[1])
    }
    return { name, table, roles, using, refs: [...refs] }
  })
)

const mergeAdjacency = (policies) => {
  const adjacency = new Map(GRAPH_TABLES.map((table) => [table, new Set()]))
  for (const policy of policies) {
    if (!adjacency.has(policy.table)) adjacency.set(policy.table, new Set())
    for (const ref of policy.refs) adjacency.get(policy.table).add(ref)
  }
  return adjacency
}

const normalizeCycle = (path) => {
  const core = path.slice(0, -1)
  const rotations = core.map((_, index) => {
    const rotated = [...core.slice(index), ...core.slice(0, index)]
    return [...rotated, rotated[0]].join(' -> ')
  })
  return rotations.sort()[0]
}

const findCycles = (adjacency) => {
  const cycles = []
  const visiting = new Set()
  const visited = new Set()
  const stack = []
  const walk = (node) => {
    if (visiting.has(node)) {
      const start = stack.indexOf(node)
      if (start >= 0) cycles.push([...stack.slice(start), node])
      return
    }
    if (visited.has(node)) return
    visiting.add(node)
    stack.push(node)
    for (const next of adjacency.get(node) ?? []) walk(next)
    stack.pop()
    visiting.delete(node)
    visited.add(node)
  }
  for (const node of adjacency.keys()) walk(node)
  return [...new Set(cycles.map(normalizeCycle))]
}

const parsedPolicies = parsePolicies(executableSql)
const policyAdjacency = mergeAdjacency(parsedPolicies)
const policyCycles = findCycles(policyAdjacency)
const policyEdges = [...policyAdjacency.entries()]
  .flatMap(([from, tos]) => [...tos].sort().map((to) => `${from} -> ${to}`))
  .sort()

console.log('=== policy dependency graph ===')
for (const policy of parsedPolicies) {
  const refs = policy.refs.length > 0 ? policy.refs.join(', ') : '(none)'
  console.log(`  ${policy.name} on ${policy.table} to ${policy.roles}: ${refs}`)
}
console.log('edges:')
for (const edge of policyEdges) console.log(`  ${edge}`)
if (policyEdges.length === 0) console.log('  (none)')
console.log(policyCycles.length === 0 ? 'cycles: none (acyclic)' : `cycles:\n${policyCycles.map((cycle) => `  ${cycle}`).join('\n')}`)

assert.deepEqual(policyEdges, EXPECTED_EDGES, 'policy graph must match the approved acyclic chain')
assert.equal(policyCycles.length, 0, `circular RLS policy dependency: ${policyCycles.join(' | ') || '(none)'}`)

for (const policy of parsedPolicies) {
  assert.equal(policy.roles, 'authenticated', `${policy.name} must target authenticated only`)
  if (KNOWLEDGE_TABLES.includes(policy.table)) {
    assert.equal(
      /visibility\s*=\s*'public'/i.test(policy.using),
      false,
      `${policy.name} must not encode a public visibility branch`,
    )
    assert.equal(
      /publication_state/i.test(policy.using),
      false,
      `${policy.name} must not encode a publication branch`,
    )
  }
}

/* ------------------------------------------------------- 2. relational model */

const activeMember = (members, uid, workspaceId) => (
  uid != null
  && members.some((row) => (
    row.workspace_id === workspaceId
    && row.user_id === uid
    && row.status === 'active'
  ))
)

const privateOwner = (collection, uid) => (
  uid != null
  && collection.visibility === 'private'
  && collection.owner_user_id === uid
)

const workspaceMember = (collection, uid, members) => (
  collection.visibility === 'workspace'
  && collection.workspace_id != null
  && activeMember(members, uid, collection.workspace_id)
)

const canReadCollection = (collection, uid, members) => (
  privateOwner(collection, uid)
  || workspaceMember(collection, uid, members)
)

const canReadDocument = (document, collection, uid, members) => (
  collection != null
  && collection.slug === document.collection_slug
  && canReadCollection(collection, uid, members)
)

const canReadSource = (source, document, collection, uid, members) => (
  document != null
  && source.document_id === document.id
  && canReadDocument(document, collection, uid, members)
)

const canReadChunk = (chunk, source, document, collection, uid, members) => (
  source != null
  && chunk.source_id === source.id
  && canReadSource(source, document, collection, uid, members)
)

const canReadWorkspace = (workspace, uid, members) => (
  activeMember(members, uid, workspace.id)
)

const canReadMembership = (membership, uid) => uid != null && membership.user_id === uid

const owner = 'user-owner'
const other = 'user-other'
const viewer = 'user-viewer'
const member = 'user-member'
const invited = 'user-invited'
const suspended = 'user-suspended'
const outsider = 'user-outsider'
const ws = 'workspace-1'
const otherWs = 'workspace-2'

const members = [
  { workspace_id: ws, user_id: owner, status: 'active', role: 'owner' },
  { workspace_id: ws, user_id: member, status: 'active', role: 'member' },
  { workspace_id: ws, user_id: viewer, status: 'active', role: 'viewer' },
  { workspace_id: ws, user_id: invited, status: 'invited', role: 'member' },
  { workspace_id: ws, user_id: suspended, status: 'suspended', role: 'member' },
  { workspace_id: otherWs, user_id: outsider, status: 'active', role: 'member' },
]

const collections = {
  publicPublished: {
    slug: 'public-published',
    visibility: 'public',
    owner_user_id: null,
    workspace_id: null,
    created_by_system_key: 'system:bundled-library',
  },
  publicBlocked: {
    slug: 'legacy-quarantine',
    visibility: 'public',
    owner_user_id: null,
    workspace_id: null,
    created_by_system_key: 'system:legacy-import',
  },
  publicOwner: {
    slug: 'public-owner',
    visibility: 'public',
    owner_user_id: owner,
    workspace_id: null,
    created_by_system_key: null,
  },
  privateOwned: {
    slug: 'private-owned',
    visibility: 'private',
    owner_user_id: owner,
    workspace_id: null,
    created_by_system_key: null,
  },
  workspaceCol: {
    slug: 'workspace-col',
    visibility: 'workspace',
    owner_user_id: null,
    workspace_id: ws,
    created_by_system_key: null,
  },
}

const documents = {
  pub: { id: 'd-pub', collection_slug: 'public-published', publication_state: 'published' },
  blocked: { id: 'd-blocked', collection_slug: 'legacy-quarantine', publication_state: 'blocked' },
  publicOwnerDoc: { id: 'd-public-owner', collection_slug: 'public-owner', publication_state: 'published' },
  privateDoc: { id: 'd-private', collection_slug: 'private-owned', publication_state: 'published' },
  privatePending: { id: 'd-private-pending', collection_slug: 'private-owned', publication_state: 'pending' },
  workspaceDoc: { id: 'd-workspace', collection_slug: 'workspace-col', publication_state: 'published' },
}

const sources = {
  pub: { id: 's-pub', document_id: 'd-pub' },
  blocked: { id: 's-blocked', document_id: 'd-blocked' },
  private: { id: 's-private', document_id: 'd-private' },
  workspace: { id: 's-workspace', document_id: 'd-workspace' },
  dangling: { id: 's-dangling', document_id: 'missing-doc' },
}

const chunks = {
  pub: { id: 'c-pub', source_id: 's-pub' },
  blocked: { id: 'c-blocked', source_id: 's-blocked' },
  private: { id: 'c-private', source_id: 's-private' },
  workspace: { id: 'c-workspace', source_id: 's-workspace' },
}

const collectionBySlug = (slug) => Object.values(collections).find((row) => row.slug === slug)
const documentById = (id) => Object.values(documents).find((row) => row.id === id)
const sourceById = (id) => Object.values(sources).find((row) => row.id === id)

const readCollection = (collection, uid) => canReadCollection(collection, uid, members)

const readDocument = (document, uid) => canReadDocument(
  document,
  collectionBySlug(document.collection_slug),
  uid,
  members,
)

const readSource = (source, uid) => {
  const document = documentById(source.document_id)
  return canReadSource(source, document, document && collectionBySlug(document.collection_slug), uid, members)
}

const readChunk = (chunk, uid) => {
  const source = sourceById(chunk.source_id)
  const document = source && documentById(source.document_id)
  return canReadChunk(
    chunk,
    source,
    document,
    document && collectionBySlug(document.collection_slug),
    uid,
    members,
  )
}

const membershipFor = (uid) => members.find((row) => row.user_id === uid)

const allowed = [
  ['private owner collection', () => readCollection(collections.privateOwned, owner), true],
  ['private owner document', () => readDocument(documents.privateDoc, owner), true],
  ['private owner pending document', () => readDocument(documents.privatePending, owner), true],
  ['private owner source', () => readSource(sources.private, owner), true],
  ['private owner chunk/embedding', () => readChunk(chunks.private, owner), true],
  ['active workspace owner document', () => readDocument(documents.workspaceDoc, owner), true],
  ['active workspace member document', () => readDocument(documents.workspaceDoc, member), true],
  ['active workspace viewer document', () => readDocument(documents.workspaceDoc, viewer), true],
  ['active workspace viewer chunk lineage', () => readChunk(chunks.workspace, viewer), true],
  ['active member reads workspace row', () => canReadWorkspace({ id: ws }, owner, members), true],
  ['viewer reads own active membership row', () => canReadMembership(membershipFor(viewer), viewer), true],
  ['caller reads own invited membership row', () => canReadMembership(membershipFor(invited), invited), true],
  ['caller reads own suspended membership row', () => canReadMembership(membershipFor(suspended), suspended), true],
]

const rejected = [
  ['anonymous collection table read', () => readCollection(collections.privateOwned, null), false],
  ['anonymous document table read', () => readDocument(documents.pub, null), false],
  ['anonymous source table read', () => readSource(sources.pub, null), false],
  ['anonymous chunk table read', () => readChunk(chunks.pub, null), false],
  ['anonymous workspace table read', () => canReadWorkspace({ id: ws }, null, members), false],
  ['anonymous membership table read', () => canReadMembership(membershipFor(owner), null), false],
  ['authenticated direct public collection', () => readCollection(collections.publicPublished, other), false],
  ['authenticated direct public document', () => readDocument(documents.pub, other), false],
  ['authenticated direct public source', () => readSource(sources.pub, other), false],
  ['authenticated direct public chunk', () => readChunk(chunks.pub, other), false],
  ['authenticated owner cannot table-read own public collection', () => readCollection(collections.publicOwner, owner), false],
  ['legacy-quarantine table read', () => readCollection(collections.publicBlocked, other), false],
  ['private non-owner', () => readDocument(documents.privateDoc, other), false],
  ['workspace non-member', () => readDocument(documents.workspaceDoc, other), false],
  ['invited workspace content', () => readDocument(documents.workspaceDoc, invited), false],
  ['suspended workspace content', () => readDocument(documents.workspaceDoc, suspended), false],
  ['membership in another workspace', () => readDocument(documents.workspaceDoc, outsider), false],
  ['forged owner identifier ignored', () => {
    const forgedRequest = { ownerId: owner, userId: owner, workspaceId: ws, created_by_system_key: 'system:bundled-library' }
    void forgedRequest
    return readDocument(documents.privateDoc, other)
  }, false],
  ['chunk from unauthorized parent', () => readChunk(chunks.private, other), false],
  ['blocked source from public quarantine', () => readSource(sources.blocked, other), false],
  ['dangling source document', () => readSource(sources.dangling, owner), false],
  ['invited cannot read workspace row', () => canReadWorkspace({ id: ws }, invited, members), false],
  ['suspended cannot read workspace row', () => canReadWorkspace({ id: ws }, suspended, members), false],
  ['cannot read another principal\'s membership', () => canReadMembership(membershipFor(owner), viewer), false],
]

console.log('\n=== allowed table-read predicates ===')
for (const [label, run, expected] of allowed) {
  const actual = run()
  assert.equal(actual, expected, `${label} expected ${expected}`)
  console.log(`  ${label.padEnd(58)} -> ALLOWED`)
}

console.log('\n=== rejected table-read predicates ===')
for (const [label, run, expected] of rejected) {
  const actual = run()
  assert.equal(actual, expected, `${label} expected ${expected}`)
  console.log(`  ${label.padEnd(58)} -> REJECTED`)
}

/* ------------------------------------------ 3. 6D2A public RPC contract */

const VISIBILITY_PREDICATE = "collections.visibility = 'public'"
const PUBLICATION_PREDICATE = "documents.publication_state = 'published'"

assert.equal(md5(containment), D2A_FILE_MD5, '6D2A migration file hash must remain unchanged')
assert.equal(/create\s+or\s+replace\s+function/i.test(executableSql), false, '6D3 must not replace RPCs')

const rpcCollections = [
  { slug: 'public-published', visibility: 'public' },
  { slug: 'legacy-quarantine', visibility: 'public' },
  { slug: 'private-col', visibility: 'private' },
  { slug: 'workspace-col', visibility: 'workspace' },
]
const rpcDocuments = [
  { id: 'd-pub', collection_slug: 'public-published', publication_state: 'published' },
  { id: 'd-blocked', collection_slug: 'legacy-quarantine', publication_state: 'blocked' },
  { id: 'd-private', collection_slug: 'private-col', publication_state: 'published' },
  { id: 'd-workspace', collection_slug: 'workspace-col', publication_state: 'published' },
]
const rpcSources = [
  { id: 's-pub', document_id: 'd-pub' },
  { id: 's-blocked', document_id: 'd-blocked' },
]
const rpcChunks = [
  { id: 'c-pub', source_id: 's-pub' },
  { id: 'c-blocked', source_id: 's-blocked' },
]

const rpcCollectionBySlug = (slug) => rpcCollections.find((row) => row.slug === slug)
const rpcDocumentById = (id) => rpcDocuments.find((row) => row.id === id)

const rpcReadDocuments = (slug) => rpcDocuments.filter((document) => {
  const collection = rpcCollectionBySlug(document.collection_slug)
  return Boolean(collection)
    && document.collection_slug === slug
    && collection.visibility === 'public'
    && document.publication_state === 'published'
})

const rpcListCollections = () => rpcCollections
  .filter((collection) => collection.visibility === 'public')
  .map((collection) => ({
    slug: collection.slug,
    document_count: rpcDocuments.filter((document) => (
      document.collection_slug === collection.slug
      && document.publication_state === 'published'
    )).length,
  }))
  .filter((row) => row.document_count > 0)

const rpcSearchCandidates = () => rpcChunks.filter((chunk) => {
  const source = rpcSources.find((row) => row.id === chunk.source_id)
  if (!source) return false
  const document = rpcDocumentById(source.document_id)
  if (!document) return false
  const collection = rpcCollectionBySlug(document.collection_slug)
  if (!collection) return false
  return collection.visibility === 'public' && document.publication_state === 'published'
})

/*
 * Two different representations, deliberately reported separately.
 *
 * D2A_FUNCTION_MD5 hashes the whole `create or replace function ... $$;`
 * statement. pg_proc.prosrc, by contrast, stores ONLY the text between the
 * dollar quotes -- no header, no argument list, no returns/language/set
 * search_path clause, no surrounding comments. A statement hash can therefore
 * never equal a prosrc hash even when the deployed code is byte-identical, so
 * the two must never be compared to each other or read as drift evidence.
 *
 * The body hashes below are the offline half of a future canonical comparison
 * (CR stripped on both sides, i.e. md5(replace(prosrc, chr(13), '')) server
 * side). They are recorded, not asserted against production: this suite has no
 * database access, and no production prosrc hash has ever been captured.
 */
const dollarBody = (statement) => {
  const open = statement.indexOf('$$')
  const close = statement.lastIndexOf('$$')
  assert.ok(open !== -1 && close > open, 'function statement must be dollar-quoted')
  return statement.slice(open + 2, close).replace(/\r/g, '')
}

console.log('\n=== 6D2A public RPC contract ===')
console.log(`  6D2A migration file                         ${D2A_FILE_MD5}`)
console.log('  representation: whole statement (NOT comparable to pg_proc.prosrc)')
const bodyHashes = []
for (const [name, expectedHash] of Object.entries(D2A_FUNCTION_MD5)) {
  const body = functionBody(containment, name)
  assert.ok(body.includes(VISIBILITY_PREDICATE), `${name} must require ${VISIBILITY_PREDICATE}`)
  assert.ok(body.includes(PUBLICATION_PREDICATE), `${name} must require ${PUBLICATION_PREDICATE}`)
  assert.equal(/security\s+definer/i.test(body), false, `${name} must not become SECURITY DEFINER`)
  const actualHash = md5(body)
  assert.equal(actualHash, expectedHash, `${name} worktree hash must remain ${expectedHash}`)
  console.log(`  ${name.padEnd(34)} ${actualHash}`)
  bodyHashes.push([name, md5(dollarBody(body))])
}

console.log('  representation: extracted body, CR-normalized (offline half of the canonical pair)')
for (const [name, hash] of bodyHashes) console.log(`  ${name.padEnd(34)} ${hash}`)
console.log('  recorded production prosrc hashes                   none captured')
console.log('  same representation compared                       NO')
console.log('  canonical production comparison                    NOT PROVEN')
console.log('  production drift                                   NOT ESTABLISHED')

assert.deepEqual(rpcReadDocuments('public-published').map((row) => row.id), ['d-pub'])
assert.deepEqual(rpcReadDocuments('legacy-quarantine'), [])
assert.deepEqual(rpcListCollections().map((row) => row.slug), ['public-published'])
assert.deepEqual(rpcSearchCandidates().map((row) => row.id), ['c-pub'])
assert.equal(rpcReadDocuments('legacy-quarantine').length, 0, 'legacy-quarantine documents remain hidden')
assert.equal(
  rpcSearchCandidates().some((chunk) => chunk.id === 'c-blocked'),
  false,
  'blocked chunks remain zero',
)
console.log('  public + published via RPC                         -> d-pub / c-pub')
console.log('  legacy-quarantine via RPC                          -> hidden')
console.log('  blocked documents / chunks                         -> 0 / 0')

console.log('\nLIMITATION: JavaScript fixtures simulate predicates only; they do not execute PostgreSQL RLS.')
console.log('PostgreSQL runtime proof: NOT PROVEN')
console.log('  this suite does not spawn WSL, psql, or any database connection')

console.log('\nPhase 6D3 inert RLS policy tests passed.')
console.log('LIMITATION: policies remain ungranted; this suite does not mutate production.')
