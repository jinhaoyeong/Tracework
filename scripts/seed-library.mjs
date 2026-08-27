// Publishes the bundled seed collections into the shared knowledge library.
//
// The library lives in Postgres, so a fresh database starts empty and the app
// shows an empty catalog until this runs. It talks to Supabase directly with the
// service role key rather than through /api, because the read routes the browser
// uses are deliberately read-only: an unauthenticated write endpoint would let
// anyone rewrite the shared catalog.
//
//   npm run seed:library -- --project-ref <ref>
//   npm run seed:library -- --dry-run
//
// TARGET CONFIRMATION. This script loads .env.local, and that file names a real
// project with a real service role key. Without an explicit target the command
// writes wherever the inherited environment happens to point, which on a
// developer machine is whatever was configured last - production, very often.
// So a real seed must state its project ref, and that ref must match
// SUPABASE_URL. The same principle as scripts/bootstrap-shared-collection.mjs:
// an inherited environment must not be able to choose the target silently.
//
// The guard is against ACCIDENTAL targeting, not against any one project. No ref
// is banned; seeding production is legitimate when someone means it and says so.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { libraryCollections } from '../src/data/libraryCollections.ts'

/** A refusal to run, as opposed to a failure while running. */
export class SeedTargetError extends Error {}

const PROJECT_REF_PATTERN = /^[a-z]{20}$/

const argument = (argv, name) => {
  const index = argv.indexOf(name)
  return index !== -1 && argv[index + 1] && !argv[index + 1].startsWith('--')
    ? argv[index + 1]
    : null
}

/**
 * Decide which project this run may write to, or refuse.
 *
 * Pure: it reads the argv and env it is handed and touches neither the network
 * nor the filesystem, so the refusals below are testable without credentials.
 */
export const resolveSeedTarget = ({ argv = [], env = {} } = {}) => {
  const dryRun = argv.includes('--dry-run')
  const url = env.SUPABASE_URL?.trim().replace(/\/+$/, '') ?? ''
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ''
  const projectRef = argument(argv, '--project-ref')
  const host = (() => { try { return new URL(url).host } catch { return '' } })()

  // Checked whenever a ref is supplied, dry run included. A dry run that names a
  // different project than SUPABASE_URL is a mistake worth catching now, rather
  // than on the re-run that drops --dry-run.
  if (projectRef) {
    if (!PROJECT_REF_PATTERN.test(projectRef)) {
      throw new SeedTargetError(`"${projectRef}" does not look like a Supabase project ref`)
    }
    if (url && !host.includes(projectRef)) {
      throw new SeedTargetError(
        `--project-ref is "${projectRef}" but SUPABASE_URL points at "${host}"`,
      )
    }
  }

  // A dry run performs no write, so it needs no credential and no target. This
  // keeps `--dry-run` usable for checking what would be seeded.
  if (dryRun) return { dryRun: true, url, serviceRoleKey, projectRef }

  if (!url || !serviceRoleKey) {
    throw new SeedTargetError(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Add them to .env.local before seeding the library.',
    )
  }
  if (!projectRef) {
    throw new SeedTargetError(
      '--project-ref <ref> is required for a real seed, and must match SUPABASE_URL. '
      + 'Re-run with --dry-run to see what would be written.',
    )
  }
  return { dryRun: false, url, serviceRoleKey, projectRef }
}

export const loadEnvFile = (path, env = process.env) => {
  let contents = ''
  try {
    contents = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of contents.split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
    if (!match) continue
    const [, key, rawValue] = match
    // An already-set variable wins, so an explicit export overrides the file.
    // The disposable runtime proof depended on exactly this precedence.
    if (env[key] !== undefined) continue
    env[key] = rawValue.replace(/^["']|["']$/g, '')
  }
}

const callRpc = async (target, fetchImpl, functionName, body) => {
  const response = await fetchImpl(`${target.url}/rest/v1/rpc/${functionName}`, {
    method: 'POST',
    headers: {
      apikey: target.serviceRoleKey,
      Authorization: `Bearer ${target.serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = payload?.message ?? `Supabase rejected ${functionName} with status ${response.status}.`
    throw new Error(message)
  }
  return payload
}

export const run = async (target, fetchImpl = fetch) => {
  if (!target.dryRun) console.log(`target: ${target.url}  (ref ${target.projectRef})`)
  let totalDocuments = 0
  for (const collection of libraryCollections) {
    const documents = collection.documents.map((document) => ({
      id: document.id,
      title: document.title,
      sourcePath: document.sourcePath,
      kind: document.kind,
      content: document.content,
      provenance: document.provenance ?? collection.provenance,
      sortOrder: document.sortOrder,
    }))

    if (target.dryRun) {
      console.log(`would seed ${collection.slug} / ${documents.length} documents`)
      totalDocuments += documents.length
      continue
    }

    const result = await callRpc(target, fetchImpl, 'tracework_upsert_collection', {
      p_collection: {
        slug: collection.slug,
        title: collection.title,
        description: collection.description,
        kind: collection.kind,
        provenance: collection.provenance,
        sortOrder: collection.sortOrder,
      },
      p_documents: documents,
    })
    const seeded = Number(result?.document_count ?? documents.length)
    totalDocuments += seeded
    console.log(`seeded ${collection.slug} / ${seeded} documents`)
  }

  console.log(`\n${target.dryRun ? 'dry run' : 'library seeded'}: ${libraryCollections.length} collections, ${totalDocuments} documents`)
}

// Only when executed directly. Importing this module for its guard must not read
// .env.local, mutate process.env, or seed anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnvFile('.env.local')
  loadEnvFile('.env')
  let target
  try {
    target = resolveSeedTarget({ argv: process.argv, env: process.env })
  } catch (error) {
    if (error instanceof SeedTargetError) {
      console.error(`REFUSING TO PROCEED: ${error.message}`)
      process.exit(1)
    }
    throw error
  }
  run(target).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
