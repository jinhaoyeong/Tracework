import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const sqlPath = resolve(root, 'scripts/phase6b-catalog-preflight.sql')
const migrationPath = resolve(root, 'supabase/migrations/20260812000100_tracework_phase6b_ownership_compatibility.sql')
const sql = readFileSync(sqlPath, 'utf8')
const migration = readFileSync(migrationPath, 'utf8')
const withoutComments = sql
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/--[^\r\n]*/g, '')
  .trim()
const withoutCommentsOrLiterals = withoutComments.replace(/'(?:''|[^'])*'/g, "''")
const failures = []

const requireText = (label, value) => {
  if (!sql.toLowerCase().includes(value.toLowerCase())) failures.push(label + ': missing "' + value + '"')
}

const statements = withoutComments
  .split(';')
  .map((statement) => statement.trim())
  .filter(Boolean)

if (statements.length < 20) failures.push('expected the complete phase-aware catalog/data preflight query set')

for (const [index, statement] of statements.entries()) {
  if (!/^(select|with)\b/i.test(statement)) {
    failures.push('statement ' + (index + 1) + ' is not SELECT-only')
  }
}

for (const keyword of [
  'create',
  'alter',
  'drop',
  'truncate',
  'insert',
  'update',
  'delete',
  'merge',
  'grant',
  'revoke',
  'do',
  'call',
  'execute',
  'set',
  'reset',
  'refresh',
  'vacuum',
  'analyze',
  'copy',
]) {
  if (new RegExp('\\b' + keyword + '\\b', 'i').test(withoutCommentsOrLiterals)) {
    failures.push('forbidden mutating/control keyword found: ' + keyword)
  }
}

const compactSql = withoutComments.replace(/\s+/g, ' ').trim().toLowerCase()
const compactMigration = migration.replace(/\s+/g, ' ').trim().toLowerCase()
if (compactSql.includes(compactMigration)) failures.push('catalog preflight contains the migration SQL')
if (/supabase[\\/]migrations[\\/]20260812000100_tracework_phase6b_ownership_compatibility\.sql/i.test(sql)) {
  failures.push('catalog preflight references the migration file')
}
if (/\b(?:sources|documents)\.document_id\b/i.test(withoutComments)) {
  failures.push('future document_id is referenced as an unconditional SQL column')
}

for (const value of [
  'pg_extension',
  'pg_class',
  'pg_attribute',
  'pg_constraint',
  'pg_indexes',
  'pg_policy',
  'pg_proc',
  'pg_namespace',
  'to_regnamespace',
  'to_regprocedure',
  'pg_get_userbyid',
  'information_schema.role_table_grants',
  'information_schema.role_routine_grants',
  'pg_get_functiondef',
  'pg_get_function_identity_arguments',
  'owner',
  'prosecdef',
  'proconfig',
  'relrowsecurity',
  'relforcerowsecurity',
  'tracework_list_collections',
  'tracework_upsert_collection',
  'tracework_collection_documents',
  'tracework_replace_source',
  'tracework_delete_sources',
  'tracework_match_chunks',
  'PRE_6B2C',
  'POST_6B2C',
  'PARTIAL_6B2C',
  'PRE-MIGRATION EXPECTED',
  'digest(text,text)',
  'gen_random_uuid()',
  'availability',
  'overload_count',
  'orphan_chunk_count',
  'source_without_document_count',
  'source_with_missing_document_count',
  'duplicate_document_parent_count',
  'extensions.vector_dims',
]) requireText('catalog preflight coverage', value)

const report = [
  'Phase 6B2D.1 read-only catalog preflight validation',
  '',
  'sql file: ' + sqlPath,
  'statements: ' + statements.length,
  'schema phase detection: PRE_6B2C / POST_6B2C / PARTIAL_6B2C',
  'future-column checks: catalog-safe and JSON-row guarded',
  'function availability and RPC owners: queried',
  'live catalog executed: NO',
  'DDL/DML: none',
  'provider calls: 0',
]

if (failures.length) {
  console.error(report.concat(['', 'FAILURES:']).concat(failures.map((failure) => '- ' + failure)).join('\n'))
  process.exitCode = 1
} else {
  console.log(report.concat(['', 'validation: PASS']).join('\n'))
}
