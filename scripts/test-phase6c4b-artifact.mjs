/**
 * Phase 6C4B-R — production ARTIFACT validation.
 *
 * Source-level tests import server modules directly under Node type stripping,
 * where `.ts` specifiers resolve. Vercel instead transpiles each `.ts` file to
 * `.js` and leaves relative specifiers verbatim, so a module graph that passes
 * every source test can still fail to load in production. Commit ba4cb37 did
 * exactly that and returned 500 from all four protected routes.
 *
 * This validator therefore tests what Vercel will actually run:
 *
 *   built serverless function -> can Node import it? -> anonymous request -> 401
 *
 * It reads a prepared Vercel output directory and needs no credential and no
 * Vercel login, so it stays reproducible:
 *
 *   npm.cmd run test:phase6c4b-artifact -- --output <path-to-.vercel/output>
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const outputDir = path.resolve(argument('--output', path.join(process.cwd(), '.vercel', 'output')))
const functionsDir = path.join(outputDir, 'functions')

if (!existsSync(functionsDir)) {
  console.error(`No Vercel function output at ${functionsDir}`)
  console.error('Build first (in a scratch copy), then pass --output <dir>.')
  process.exit(2)
}

/** The routes whose policy requires a credential; all must answer 401 anonymously. */
const PROTECTED_ROUTES = ['api/embed', 'api/generate', 'api/vector/sync', 'api/vector/delete']
/** Present for completeness: these must stay reachable without a credential. */
const ANONYMOUS_ROUTES = ['api/library/collections', 'api/library/documents', 'api/vector/search']

/* ------------------------------------------- 1. locate the real entrypoints */

const findFunctionDirs = (dir, found = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = path.join(dir, entry.name)
    if (entry.name.endsWith('.func')) { found.push(full); continue }
    findFunctionDirs(full, found)
  }
  return found
}

const entrypoints = new Map()
for (const funcDir of findFunctionDirs(functionsDir)) {
  const configPath = path.join(funcDir, '.vc-config.json')
  if (!existsSync(configPath)) continue
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  // The route name is the .func path relative to functions/, minus the suffix.
  const route = path.relative(functionsDir, funcDir).replace(/\\/g, '/').replace(/\.func$/, '')
  // `handler` is authoritative — never assume the filename.
  entrypoints.set(route, { funcDir, handler: path.join(funcDir, config.handler), runtime: config.runtime })
}

console.log('=== built function entrypoints ===')
for (const [route, info] of entrypoints) {
  console.log(`  ${route.padEnd(26)} ${path.relative(functionsDir, info.handler).replace(/\\/g, '/')}  (${info.runtime})`)
}

for (const route of [...PROTECTED_ROUTES, ...ANONYMOUS_ROUTES]) {
  assert.ok(entrypoints.has(route), `missing built function for ${route}`)
  assert.ok(existsSync(entrypoints.get(route).handler), `handler file missing for ${route}`)
}

/* ------ 2. executable relative import scan (source maps are NOT executable) */

const RELATIVE_SPECIFIER = /(?:\bfrom\s*|<%=%>|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](\.[^'"]*)['"]/g

const collectEmittedFiles = (dir, found = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // node_modules is vendored by the platform and is not our emitted graph.
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      collectEmittedFiles(path.join(dir, entry.name), found)
      continue
    }
    if (/\.(js|mjs|cjs)$/.test(entry.name)) found.push(path.join(dir, entry.name))
  }
  return found
}

const resolvesOnDisk = (fromFile, specifier) => {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, 'index.js')]
  return candidates.some((candidate) => existsSync(candidate) && statSync(candidate).isFile())
}

const unresolved = []
for (const [route, info] of entrypoints) {
  for (const file of collectEmittedFiles(info.funcDir)) {
    const text = readFileSync(file, 'utf8')
    // Strip the inline source map so `.ts` filenames recorded as metadata are
    // not mistaken for executable specifiers.
    const executable = text.replace(/\/\/# sourceMappingURL=[^\n]*/g, '')
    for (const match of executable.matchAll(RELATIVE_SPECIFIER)) {
      const specifier = match[1]
      if (resolvesOnDisk(file, specifier)) continue
      unresolved.push({
        route,
        file: path.relative(info.funcDir, file).replace(/\\/g, '/'),
        specifier,
      })
    }
  }
}

console.log('\n=== executable relative import scan ===')
if (unresolved.length === 0) {
  console.log('  no unresolved executable relative specifiers')
} else {
  for (const hit of unresolved) console.log(`  UNRESOLVED  ${hit.route}  ${hit.file} -> ${hit.specifier}`)
}

/* ---------------------------------------------- 3. module load + 401 proof */

const makeResponse = () => {
  const captured = { status: 0, payload: null }
  const response = {
    statusCode: 0,
    setHeader() {},
    status(code) { captured.status = code; return this },
    json(payload) { captured.payload = payload },
    end(body) {
      if (!captured.status) captured.status = response.statusCode
      if (body && captured.payload === null) {
        try { captured.payload = JSON.parse(body) } catch { captured.payload = body }
      }
    },
  }
  return { captured, response }
}

/* Any outbound call would mean the gate did not stop the request. */
let providerCalls = 0
let databaseCalls = 0
const realFetch = globalThis.fetch
globalThis.fetch = async (input) => {
  const url = String(input)
  if (url.includes('openai.com')) providerCalls += 1
  else databaseCalls += 1
  throw new Error(`artifact test forbids outbound request to ${url}`)
}

const results = []
for (const route of PROTECTED_ROUTES) {
  const { handler } = entrypoints.get(route)
  const record = { route, imported: false, status: null, code: null, error: null }
  try {
    const module = await import(pathToFileURL(handler).href)
    record.imported = true
    const fn = module.default ?? module.handler
    assert.equal(typeof fn, 'function', `${route} built module must export a handler function`)

    const { captured, response } = makeResponse()
    await fn({ method: 'POST', headers: {}, body: {} }, response)
    record.status = captured.status
    record.code = captured.payload?.error?.code ?? null
  } catch (error) {
    record.error = `${error?.code ?? error?.name ?? 'Error'}: ${String(error?.message ?? error).split('\n')[0]}`
  }
  results.push(record)
}
globalThis.fetch = realFetch

console.log('\n=== artifact import + anonymous request ===')
for (const r of results) {
  console.log(
    `  ${r.route.padEnd(26)} import=${r.imported ? 'PASS' : 'FAIL'}  status=${r.status ?? '-'}  code=${r.code ?? '-'}${r.error ? `  ${r.error}` : ''}`,
  )
}

/* ------------------------------------------------------------ assertions */

let failures = 0
const fail = (message) => { failures += 1; console.error(`  FAIL: ${message}`) }

console.log('\n=== verdict ===')
for (const r of results) {
  if (!r.imported) fail(`${r.route} built artifact failed to import (${r.error})`)
  else if (r.status === 500) fail(`${r.route} built artifact returned 500`)
  else if (r.status !== 401) fail(`${r.route} anonymous request returned ${r.status}, expected 401`)
  else if (r.code !== 'missing_auth') fail(`${r.route} returned ${r.code}, expected missing_auth`)
}
for (const hit of unresolved) fail(`${hit.route}: unresolved executable import ${hit.file} -> ${hit.specifier}`)
if (providerCalls !== 0) fail(`anonymous artifact requests made ${providerCalls} provider call(s)`)
if (databaseCalls !== 0) fail(`anonymous artifact requests made ${databaseCalls} database call(s)`)

if (failures > 0) {
  console.error(`\nPhase 6C4B artifact validation FAILED (${failures} problem(s)).`)
  process.exit(1)
}

console.log('  all four built functions import and answer 401 anonymously')
console.log('  provider calls 0 / database calls 0 / unresolved executable imports 0')
console.log('\nPhase 6C4B artifact validation passed.')
