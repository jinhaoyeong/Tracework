/*
 * Phase 6B M1 inventory preparation.
 *
 * Default mode emits read-only catalog SQL and does not contact Supabase.
 * --fetch performs only GET requests against the four existing Data API
 * tables. There is deliberately no POST, PATCH, PUT, DELETE, RPC execution,
 * SQL execution, migration application, or write-capable code path here.
 *
 * Future use:
 *   node scripts/phase6b-inventory.mjs --plan
 *   node scripts/phase6b-inventory.mjs --fetch --include-vectors
 *   node scripts/phase6b-inventory.mjs --fetch --post-migration --include-vectors
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { libraryCollections } from '../src/data/libraryCollections.ts'

const args = new Set(process.argv.slice(2))
const shouldFetch = args.has('--fetch')
const postMigration = args.has('--post-migration')
const includeVectors = args.has('--include-vectors')
const root = process.cwd()
const supabaseUrl = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
const knownCollectionSlugs = new Set(libraryCollections.map((collection) => collection.slug))
const knownDocumentIds = new Set(
  libraryCollections.flatMap((collection) => collection.documents.map((document) => document.id)),
)

const sha256 = (value) => createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')

const unique = (rows, field) => new Set(rows.map((row) => row?.[field]).filter(Boolean))

const parseVector = (value) => {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/^[[(]|[\])]$/g, '')
  if (!trimmed) return []
  const values = trimmed.split(',').map((item) => Number(item.trim()))
  return values.every((item) => Number.isFinite(item)) ? values : null
}

const inventoryPlan = [
  'Phase 6B M1 read-only inventory plan',
  '',
  'The following statements are SELECT-only and are emitted for a future read-only SQL/catalog connection.',
  'This script never executes them.',
  '',
  'select current_database(), current_user;',
  'select table_schema, table_name, table_type',
  'from information_schema.tables',
  'where table_schema in (\'public\', \'auth\')',
  '  and table_name in (\'tracework_collections\', \'tracework_library_documents\', \'tracework_sources\', \'tracework_chunks\', \'workspaces\', \'workspace_members\');',
  '',
  'select n.nspname as schema_name, p.proname, pg_get_function_identity_arguments(p.oid) as arguments, pg_get_functiondef(p.oid) as definition',
  'from pg_proc as p',
  'join pg_namespace as n on n.oid = p.pronamespace',
  'where n.nspname = \'public\' and p.proname like \'tracework_%\'',
  'order by p.proname, arguments;',
  '',
  'select grantee, table_schema, table_name, privilege_type',
  'from information_schema.role_table_grants',
  'where table_schema = \'public\'',
  '  and table_name in (\'tracework_collections\', \'tracework_library_documents\', \'tracework_sources\', \'tracework_chunks\', \'workspaces\', \'workspace_members\')',
  'order by grantee, table_name, privilege_type;',
  '',
  'select grantee, routine_schema, routine_name, specific_name, privilege_type',
  'from information_schema.role_routine_grants',
  'where routine_schema = \'public\' and routine_name like \'tracework_%\'',
  'order by grantee, routine_name, specific_name;',
  '',
  'No mutation statement is part of this inventory plan.',
].join('\n')

const restRows = async (table, select) => {
  const url = new URL(supabaseUrl + '/rest/v1/' + table)
  url.searchParams.set('select', select)
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      apikey: serviceRoleKey,
      Authorization: 'Bearer ' + serviceRoleKey,
      Prefer: 'count=exact',
      Range: '0-999999',
    },
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error('Read-only inventory GET failed for ' + table + ' with HTTP ' + response.status)
  }
  if (!Array.isArray(payload)) {
    throw new Error('Read-only inventory GET returned a non-array payload for ' + table)
  }
  return {
    rows: payload,
    contentRange: response.headers.get('content-range'),
  }
}

const localRpcInventory = () => {
  const migrationDirectory = resolve(root, 'supabase/migrations')
  return readdirSync(migrationDirectory)
    .filter((name) => name.endsWith('.sql'))
    .flatMap((name) => {
      const source = readFileSync(resolve(migrationDirectory, name), 'utf8')
      return [...source.matchAll(/create(?: or replace)? function public\.(tracework_[a-z0-9_]+)/gi)]
        .map((match) => ({ migration: name, functionName: match[1] }))
    })
}

const summarize = (collections, documents, sources, chunks) => {
  const collectionIds = unique(collections, 'slug')
  const documentIds = unique(documents, 'id')
  const sourceIds = unique(sources, 'id')
  const chunkIds = unique(chunks, 'id')
  const hasCanonicalDocumentParent = sources.some((row) => Object.prototype.hasOwnProperty.call(row, 'document_id'))
  const hasCanonicalCollectionParent = documents.some((row) => Object.prototype.hasOwnProperty.call(row, 'collection_id'))
  const sourceDocumentIds = new Set(sources.map((row) => row.document_id).filter(Boolean))
  const sourceIdsWithChunks = new Set(chunks.map((row) => row.source_id).filter(Boolean))
  const vectors = includeVectors
    ? chunks.map((row) => ({ id: row.id, vector: parseVector(row.embedding), model: row.embedding_model }))
    : []

  const contentHashRows = {
    collections: collections.map((row) => ({ id: row.slug, hash: sha256(JSON.stringify(row.provenance ?? {})) })),
    documents: documents.map((row) => ({ id: row.id, hash: sha256(row.content) })),
    sources: sources.map((row) => ({ id: row.id, hash: sha256(row.content) })),
  }

  const embeddingModels = [...new Set(chunks.map((row) => row.embedding_model).filter(Boolean))].sort()
  const dimensions = [...new Set(vectors.map((row) => row.vector?.length).filter(Boolean))]
  const embeddingDigest = includeVectors
    ? sha256(vectors.map((row) => row.id + ':' + (row.vector ?? []).join(',')).sort().join('|'))
    : null
  const hasVisibility = collections.some((row) => Object.prototype.hasOwnProperty.call(row, 'visibility'))
  const hasPublicationState = documents.some((row) => Object.prototype.hasOwnProperty.call(row, 'publication_state'))
  const scopeShapeViolations = hasVisibility
    ? collections
      .filter((row) => (
        (row.visibility === 'private' && (!row.owner_user_id || row.workspace_id))
        || (row.visibility === 'workspace' && (!row.workspace_id || row.owner_user_id))
        || (row.visibility === 'public' && (row.owner_user_id || row.workspace_id))
        || !['private', 'workspace', 'public'].includes(row.visibility)
      ))
      .map((row) => row.slug)
    : 'not available before Phase 6B2A migration'
  const creatorBothPresent = {
    collections: collections.filter((row) => row.created_by_user_id && row.created_by_system_key).map((row) => row.slug),
    documents: documents.filter((row) => row.created_by_user_id && row.created_by_system_key).map((row) => row.id),
  }

  return {
    counts: {
      collections: collections.length,
      documents: documents.length,
      sources: sources.length,
      chunks: chunks.length,
    },
    stableIdSets: {
      collections: [...collectionIds].sort(),
      documents: [...documentIds].sort(),
      sources: [...sourceIds].sort(),
      chunks: [...chunkIds].sort(),
    },
    orphans: {
      documents: documents
        .filter((row) => !collectionIds.has(row.collection_id ?? row.collection_slug))
        .map((row) => row.id),
      sources: hasCanonicalDocumentParent
        ? sources.filter((row) => row.document_id && !documentIds.has(row.document_id)).map((row) => row.id)
        : 'not available before collection-to-source lineage migration',
      chunks: chunks.filter((row) => !sourceIds.has(row.source_id)).map((row) => row.id),
    },
    sourceDocumentCoverage: hasCanonicalDocumentParent
      ? {
        documentsWithSource: documents.filter((row) => sourceDocumentIds.has(row.id)).length,
        documentsWithoutSource: documents.filter((row) => !sourceDocumentIds.has(row.id)).map((row) => row.id),
        sourcesWithChunks: sources.filter((row) => sourceIdsWithChunks.has(row.id)).length,
        sourcesWithoutChunks: sources.filter((row) => !sourceIdsWithChunks.has(row.id)).map((row) => row.id),
      }
      : 'not available before collection-to-source lineage migration',
    duplicateContent: {
      documents: contentHashRows.documents.length - new Set(contentHashRows.documents.map((row) => row.hash)).size,
      sources: contentHashRows.sources.length - new Set(contentHashRows.sources.map((row) => row.hash)).size,
    },
    embedding: {
      chunkCount: chunks.length,
      models: embeddingModels,
      dimensions,
      preservationDigest: embeddingDigest ?? 'not collected; rerun with --include-vectors',
    },
    schemaFields: {
      collection_id: hasCanonicalCollectionParent,
      source_document_id: hasCanonicalDocumentParent,
      collection_visibility: hasVisibility,
      document_publication_state: hasPublicationState,
    },
    visibilityCounts: hasVisibility
      ? Object.fromEntries(
        [...new Set(collections.map((row) => row.visibility ?? 'NULL'))]
          .sort()
          .map((value) => [value, collections.filter((row) => (row.visibility ?? 'NULL') === value).length]),
      )
      : 'not available before Phase 6B2A migration',
    publicationStateCounts: hasPublicationState
      ? Object.fromEntries(
        [...new Set(documents.map((row) => row.publication_state ?? 'NULL'))]
          .sort()
          .map((value) => [value, documents.filter((row) => (row.publication_state ?? 'NULL') === value).length]),
      )
      : 'not available before Phase 6B2A migration',
    systemContributorCounts: Object.fromEntries(
      [...new Set(
        collections.map((row) => row.created_by_system_key)
          .concat(documents.map((row) => row.created_by_system_key))
          .filter(Boolean),
      )]
        .sort()
        .map((value) => [value, collections.filter((row) => row.created_by_system_key === value).length
          + documents.filter((row) => row.created_by_system_key === value).length]),
    ),
    knownSeedMatches: {
      collections: [...knownCollectionSlugs].filter((slug) => collectionIds.has(slug)).sort(),
      documents: [...knownDocumentIds].filter((id) => documentIds.has(id)).sort(),
    },
    contractChecks: {
      scopeShapeViolations,
      creatorBothPresent,
      creatorExactlyOneMissing: hasPublicationState
        ? {
          collections: collections.filter((row) => !row.created_by_user_id && !row.created_by_system_key).map((row) => row.slug),
          documents: documents.filter((row) => !row.created_by_user_id && !row.created_by_system_key).map((row) => row.id),
        }
        : 'not available before Phase 6B2A migration',
      blockedDocumentsExcludedByFutureSearch: hasPublicationState
        ? documents.filter((row) => row.publication_state !== 'published').length
        : 'not available before Phase 6B2A migration',
      blockedDocumentsWouldQualify: hasPublicationState ? 0 : 'not available before Phase 6B2A migration',
      searchPredicateReminder: 'authorized collection AND document.publication_state = published',
    },
    localRpcInventory: localRpcInventory(),
    liveRpcAndGrantCatalog: 'not queried by REST; use the SELECT-only plan above',
  }
}

if (!shouldFetch) {
  console.log(inventoryPlan)
  console.log('')
  console.log('No network request made. Use --fetch for the pre-migration inventory; add --post-migration only after 6B2A is applied.')
} else if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for explicit read-only inventory.')
  process.exitCode = 1
} else {
  const run = async () => {
    const collections = await restRows(
      'tracework_collections',
      postMigration
        ? 'slug,title,kind,provenance,visibility,workspace_id,owner_user_id,created_by_user_id,created_by_system_key'
        : 'slug,title,kind,provenance,sort_order,created_at,updated_at',
    )
    const documents = await restRows(
      'tracework_library_documents',
      postMigration
        ? 'id,collection_slug,collection_id,title,source_path,content,content_hash,publication_state,created_by_user_id,created_by_system_key'
        : 'id,collection_slug,title,source_path,kind,content,provenance,sort_order,created_at',
    )
    const sources = await restRows(
      'tracework_sources',
      postMigration
        ? 'id,document_id,title,source_path,content,indexed_content_hash,provenance'
        : 'id,title,source_path,kind,content,file_type,provenance,created_at',
    )
    const chunkSelect = includeVectors
      ? 'id,source_id,chunk_index,embedding,embedding_model'
      : 'id,source_id,chunk_index,embedding_model'
    const chunks = await restRows('tracework_chunks', chunkSelect)

    const report = summarize(collections.rows, documents.rows, sources.rows, chunks.rows)
    console.log(JSON.stringify({
      readOnly: true,
      method: 'GET',
      schemaView: postMigration ? 'post-Phase-6B2A' : 'pre-Phase-6B2A',
      countsFromContentRange: {
        collections: collections.contentRange,
        documents: documents.contentRange,
        sources: sources.contentRange,
        chunks: chunks.contentRange,
      },
      ...report,
    }, null, 2))
  }

  run().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
