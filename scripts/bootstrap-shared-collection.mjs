/**
 * Phase 6E: bootstrap the first owner-backed public shared collection.
 *
 * WHY THIS IS NOT A MIGRATION.
 *
 * Migrations in this repository are schema; content is not. The reviewed corpus
 * arrives through the application's ingestion path, which is exactly why
 * 20260812000100 cannot replay on an empty project - it asserts content no
 * migration creates. A collection needs an owner_user_id, and that UUID differs
 * per environment, so putting it in a migration would either hard-code one
 * environment's identity into every environment, or make the migration's
 * behaviour depend on auth.users at apply time. The second option repeats the
 * defect above and can stop the whole chain on a fresh project.
 *
 * So: the PROCEDURE lives in git, the VALUE does not. Run once per environment,
 * outside the migration chain, after the chain has been applied.
 *
 * WHY THE COLLECTION IS NEEDED AT ALL.
 *
 * 20260812000100 backfilled created_by_system_key onto every collection existing
 * at that moment - the four bundled slugs as 'system:bundled-library', anything
 * else as 'system:legacy-import'. The 6E contributor rule permits ingest only
 * when visibility = 'public' AND created_by_system_key IS NULL, so after that
 * backfill NO collection accepts a contribution. This creates the first one.
 * The backfill is a one-time UPDATE, not a trigger, so a collection created
 * afterwards keeps created_by_system_key NULL permanently.
 *
 * USAGE
 *
 *   node scripts/bootstrap-shared-collection.mjs --project-ref <ref> --owner <uuid>
 *     Dry run. Reports exactly what it would do and changes nothing.
 *
 *   node scripts/bootstrap-shared-collection.mjs --project-ref <ref> --owner <uuid> --apply
 *     Creates the collection.
 *
 *   node scripts/bootstrap-shared-collection.mjs --project-ref <ref> --verify
 *     Read-only: checks an existing collection still has the required shape.
 *
 *   node scripts/bootstrap-shared-collection.mjs --project-ref <ref> --rollback --apply
 *     Deletes the collection, and REFUSES once it holds documents.
 *
 * The owner UUID is never stored in this file, in git, or in any migration. It
 * is supplied at runtime. --project-ref must match SUPABASE_URL, so the script
 * cannot be pointed at the wrong project by an inherited environment.
 *
 * Reads SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and TRACEWORK_PUBLISHERS from
 * the environment. Nothing is written to disk and no secret is printed.
 */

const SLUG = 'shared-library'
const TITLE = 'Shared Library'

/**
 * Slugs 20260812000100 stamps as system-scoped. Reusing one would make the new
 * collection unwritable the next time that migration runs on a fresh
 * environment - the trap that produced this whole situation.
 */
const RESERVED_SLUGS = new Set([
  'workshop-notes',
  'meridian-access-programme',
  'phase-5c-conflict-set',
  'phase-5c-authority-record',
  'legacy-quarantine',
])

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const argument = (name) => {
  const index = process.argv.indexOf(name)
  return index !== -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
    ? process.argv[index + 1]
    : null
}
const flag = (name) => process.argv.includes(name)

const fail = (message) => {
  console.error(`REFUSING TO PROCEED: ${message}`)
  process.exit(1)
}

const env = process.env
const url = env.SUPABASE_URL?.trim().replace(/\/+$/, '')
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim()
if (!url || !serviceKey) fail('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')

/* Target verification. The ref must be stated explicitly and must match the URL,
 * so an inherited SUPABASE_URL cannot silently redirect this at another
 * project. */
const projectRef = argument('--project-ref')
if (!projectRef) fail('--project-ref <ref> is required, and must match SUPABASE_URL')
if (!/^[a-z]{20}$/.test(projectRef)) fail(`"${projectRef}" does not look like a Supabase project ref`)
const host = (() => { try { return new URL(url).host } catch { return '' } })()
if (!host.includes(projectRef)) {
  fail(`--project-ref is "${projectRef}" but SUPABASE_URL points at "${host}"`)
}

const rest = async (path, init = {}) => {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let payload = null
  try { payload = text ? JSON.parse(text) : null } catch { payload = text }
  return { ok: response.ok, status: response.status, payload }
}

const readCollection = async () => {
  const result = await rest(
    `/rest/v1/tracework_collections?slug=eq.${SLUG}`
    + '&select=slug,title,visibility,owner_user_id,workspace_id,created_by_system_key',
  )
  if (!result.ok) fail(`could not read the collection (HTTP ${result.status})`)
  return Array.isArray(result.payload) && result.payload.length ? result.payload[0] : null
}

const documentCount = async () => {
  const result = await rest(
    `/rest/v1/tracework_library_documents?collection_slug=eq.${SLUG}&select=id&limit=1`,
    { headers: { Prefer: 'count=exact' } },
  )
  if (!result.ok) fail(`could not count documents (HTTP ${result.status})`)
  return Array.isArray(result.payload) ? result.payload.length : 0
}

/** Every invariant the 6E contributor rule depends on. */
const describe = (row) => {
  const checks = [
    ['visibility is public', row.visibility === 'public'],
    ['created_by_system_key IS NULL', row.created_by_system_key === null],
    ['has an owner', Boolean(row.owner_user_id)],
    ['no workspace', row.workspace_id === null],
  ]
  for (const [label, ok] of checks) console.log(`    ${ok ? 'OK  ' : 'FAIL'}  ${label}`)
  return checks.every(([, ok]) => ok)
}

const main = async () => {
  console.log(`target: ${url}  (ref ${projectRef})`)

  if (RESERVED_SLUGS.has(SLUG)) {
    fail(`"${SLUG}" is a reserved slug that 20260812000100 stamps system-scoped`)
  }

  /* ---------------------------------------------------------- verify mode */
  if (flag('--verify')) {
    const row = await readCollection()
    if (!row) fail(`"${SLUG}" does not exist on this project`)
    console.log(`\nexisting collection "${SLUG}":`)
    const ok = describe(row)
    console.log(ok
      ? '\nVERIFIED: the collection satisfies the 6E contributor rule.'
      : '\nMISMATCH: the collection does NOT satisfy the 6E contributor rule.')
    process.exit(ok ? 0 : 1)
  }

  /* -------------------------------------------------------- rollback mode */
  if (flag('--rollback')) {
    const row = await readCollection()
    if (!row) { console.log(`"${SLUG}" does not exist; nothing to roll back.`); return }

    const documents = await documentCount()
    if (documents > 0) {
      fail(
        `"${SLUG}" holds at least one document. Deleting it would CASCADE through `
        + 'tracework_library_documents_collection_slug_fkey and destroy contributor '
        + 'submissions. Rollback is safe only while the collection is empty.',
      )
    }
    if (!flag('--apply')) {
      console.log(`\nDRY RUN: would delete "${SLUG}" (currently empty). Re-run with --apply.`)
      return
    }
    const deleted = await rest(`/rest/v1/tracework_collections?slug=eq.${SLUG}`, { method: 'DELETE' })
    if (!deleted.ok) fail(`delete failed (HTTP ${deleted.status})`)
    console.log(`deleted "${SLUG}".`)
    return
  }

  /* --------------------------------------------------------- create mode */
  const owner = argument('--owner')
  if (!owner) fail('--owner <uuid> is required; it is never hard-coded in this script')
  if (!UUID_PATTERN.test(owner)) fail('--owner must be a UUID')

  // Allowlist first: it is a purely local check, so it fails fast and without
  // spending a request. Owner and moderator must be the same identity - an owner
  // outside the allowlist could not publish into the collection it owns.
  const publishers = new Set((env.TRACEWORK_PUBLISHERS ?? '').split(',').map((e) => e.trim()).filter(Boolean))
  if (publishers.size === 0) {
    fail('TRACEWORK_PUBLISHERS is empty; configure the publisher allowlist before bootstrapping')
  }
  if (!publishers.has(owner)) {
    fail('--owner is not in TRACEWORK_PUBLISHERS; the collection owner must also be an approved publisher')
  }
  console.log('  owner is in the TRACEWORK_PUBLISHERS allowlist')

  // Then confirm it is a real account. created_by_system_key's own comment is
  // explicit that a controlled contributor is "never a fake auth.users row".
  const user = await rest(`/auth/v1/admin/users/${owner}`)
  if (!user.ok) fail(`no auth user exists with id ${owner} (HTTP ${user.status})`)
  console.log(`  owner account exists: ${user.payload?.email ?? '(email withheld)'}`)

  const existing = await readCollection()
  if (existing) {
    // Never overwrite. An existing collection's owner, visibility and system
    // marker are load-bearing; silently rewriting them could hand ownership to a
    // different account or un-protect a system collection.
    console.log(`\n"${SLUG}" already exists. This script never modifies it. Current shape:`)
    const ok = describe(existing)
    if (!ok) fail('the existing collection does not satisfy the 6E contributor rule; resolve manually')
    console.log('\nALREADY BOOTSTRAPPED: nothing to do.')
    return
  }

  if (!flag('--apply')) {
    console.log('\nDRY RUN. Would insert:')
    console.log(`    slug                  ${SLUG}`)
    console.log(`    title                 ${TITLE}`)
    console.log('    visibility            public')
    console.log(`    owner_user_id         ${owner}`)
    console.log('    created_by_system_key omitted, so it stays NULL')
    console.log('\nRe-run with --apply to create it.')
    return
  }

  const created = await rest('/rest/v1/tracework_collections', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    // created_by_system_key is omitted, never set to null explicitly, so the
    // column default applies and the row stays non-system.
    body: JSON.stringify([{
      slug: SLUG,
      title: TITLE,
      description: 'Shared knowledge contributed by signed-in users. Submissions are reviewed before they become visible.',
      kind: 'note',
      visibility: 'public',
      owner_user_id: owner,
      sort_order: 0,
    }]),
  })
  if (!created.ok) fail(`insert failed (HTTP ${created.status}): ${JSON.stringify(created.payload).slice(0, 200)}`)

  const row = await readCollection()
  if (!row) fail('the collection was not readable after insert')
  console.log(`\ncreated "${SLUG}". Verifying:`)
  if (!describe(row)) fail('the created collection does not satisfy the 6E contributor rule')
  console.log('\nBOOTSTRAP COMPLETE. Contributors may now submit to this collection; submissions land pending.')
}

await main()
