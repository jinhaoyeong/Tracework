// Publishes the bundled seed collections into the shared knowledge library.
//
// The library lives in Postgres, so a fresh database starts empty and the app
// shows an empty catalog until this runs. It talks to Supabase directly with the
// service role key rather than through /api, because the read routes the browser
// uses are deliberately read-only: an unauthenticated write endpoint would let
// anyone rewrite the shared catalog.
//
//   npm run seed:library
//   npm run seed:library -- --dry-run

import { readFileSync } from 'node:fs'
import { libraryCollections } from '../src/data/libraryCollections.ts'

const loadEnvFile = (path) => {
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
    if (process.env[key] !== undefined) continue
    process.env[key] = rawValue.replace(/^["']|["']$/g, '')
  }
}

loadEnvFile('.env.local')
loadEnvFile('.env')

const dryRun = process.argv.includes('--dry-run')
const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, '')
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()

if (!dryRun && (!url || !serviceRoleKey)) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Add them to .env.local before seeding the library.')
  process.exit(1)
}

const callRpc = async (functionName, body) => {
  const response = await fetch(`${url}/rest/v1/rpc/${functionName}`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
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

const run = async () => {
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

    if (dryRun) {
      console.log(`would seed ${collection.slug} / ${documents.length} documents`)
      totalDocuments += documents.length
      continue
    }

    const result = await callRpc('tracework_upsert_collection', {
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

  console.log(`\n${dryRun ? 'dry run' : 'library seeded'}: ${libraryCollections.length} collections, ${totalDocuments} documents`)
}

run().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
