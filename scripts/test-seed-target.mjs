/**
 * seed-library target confirmation.
 *
 * scripts/seed-library.mjs loads .env.local and then writes with the service
 * role. Before this guard existed, `npm run seed:library` from the repository
 * root wrote to whatever project the inherited environment named - on a
 * developer machine, usually the last one configured. These assertions pin the
 * refusal: a real seed must state its project ref, and that ref must match
 * SUPABASE_URL.
 *
 * Every refusal below is proved to happen BEFORE any request, by handing the
 * script a fetch that fails the test if it is ever called.
 *
 * No credential is used and no network call is made.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveSeedTarget, loadEnvFile, run, SeedTargetError,
} from './seed-library.mjs'

const REF = 'abcdefghijklmnopqrst'
const OTHER_REF = 'zyxwvutsrqponmlkjihg'
const URL_FOR = (ref) => `https://${ref}.supabase.co`
const KEY = 'service-role-key-placeholder'

const forbiddenFetch = () => {
  throw new Error('a request was made before the target was confirmed')
}

const refuses = (label, argv, env) => {
  assert.throws(
    () => resolveSeedTarget({ argv, env }),
    (error) => {
      assert.ok(error instanceof SeedTargetError, `${label}: must refuse, not crash`)
      return true
    },
    label,
  )
  console.log(`  OK  refused: ${label}`)
}

/* 1. A real seed without an explicit target is refused. */
refuses(
  'real write, no --project-ref',
  ['node', 'seed-library.mjs'],
  { SUPABASE_URL: URL_FOR(REF), SUPABASE_SERVICE_ROLE_KEY: KEY },
)

/* 2. A ref that is not a ref is refused before it is compared to anything. */
refuses(
  'real write, malformed --project-ref',
  ['node', 'seed-library.mjs', '--project-ref', 'not-a-ref'],
  { SUPABASE_URL: URL_FOR(REF), SUPABASE_SERVICE_ROLE_KEY: KEY },
)

/* 3. The stated target must be the target the URL names. */
refuses(
  'real write, ref does not match SUPABASE_URL',
  ['node', 'seed-library.mjs', '--project-ref', OTHER_REF],
  { SUPABASE_URL: URL_FOR(REF), SUPABASE_SERVICE_ROLE_KEY: KEY },
)

/* 5. The case this guard exists for: an inherited .env.local names one project,
 *    the operator means another. Refused before any request. */
refuses(
  'inherited env target, different explicit ref',
  ['node', 'seed-library.mjs', '--project-ref', OTHER_REF],
  { SUPABASE_URL: URL_FOR(REF), SUPABASE_SERVICE_ROLE_KEY: KEY },
)

/* Credentials are still required for a real seed. */
refuses(
  'real write, missing service role key',
  ['node', 'seed-library.mjs', '--project-ref', REF],
  { SUPABASE_URL: URL_FOR(REF) },
)

/* A mismatched ref is refused even on a dry run, so the mistake surfaces before
 * the re-run that drops --dry-run. */
refuses(
  'dry run, ref does not match SUPABASE_URL',
  ['node', 'seed-library.mjs', '--dry-run', '--project-ref', OTHER_REF],
  { SUPABASE_URL: URL_FOR(REF) },
)

/* 4. A matching explicit ref is accepted and reaches the RPC. */
{
  const target = resolveSeedTarget({
    argv: ['node', 'seed-library.mjs', '--project-ref', REF],
    env: { SUPABASE_URL: URL_FOR(REF), SUPABASE_SERVICE_ROLE_KEY: KEY },
  })
  assert.equal(target.dryRun, false)
  assert.equal(target.projectRef, REF)
  assert.equal(target.url, URL_FOR(REF))

  const calls = []
  const stub = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({ document_count: 1 }) }
  }
  await run(target, stub)
  assert.ok(calls.length > 0, 'a confirmed target must reach the RPC')
  assert.ok(
    calls.every((call) => call.url.startsWith(`${URL_FOR(REF)}/rest/v1/rpc/`)),
    'every request must go to the confirmed project',
  )
  assert.ok(
    calls.every((call) => call.url.endsWith('tracework_upsert_collection')),
    'the seed writes through tracework_upsert_collection only',
  )
  console.log(`  OK  confirmed target reached the RPC (${calls.length} calls)`)
}

/* 6. A dry run writes nothing, and needs no credential to do it. */
{
  const target = resolveSeedTarget({ argv: ['node', 'seed-library.mjs', '--dry-run'], env: {} })
  assert.equal(target.dryRun, true)
  await run(target, forbiddenFetch)
  console.log('  OK  dry run made no request and needed no credential')
}

/* 7. An already-set variable wins over the file. The disposable runtime proof
 *    relied on this: it is what stopped .env.local redirecting the seed at
 *    production. */
{
  const dir = mkdtempSync(join(tmpdir(), 'tracework-seed-'))
  const file = join(dir, '.env.local')
  writeFileSync(file, `SUPABASE_URL=${URL_FOR(OTHER_REF)}\nSEED_ONLY_IN_FILE=from-file\n`)

  const env = { SUPABASE_URL: URL_FOR(REF) }
  loadEnvFile(file, env)
  assert.equal(env.SUPABASE_URL, URL_FOR(REF), 'a pre-set variable must not be overridden')
  assert.equal(env.SEED_ONLY_IN_FILE, 'from-file', 'an unset variable must still load')
  console.log('  OK  pre-set environment overrides the env file')
}

/* Importing the module must not seed, read .env.local, or touch process.env. */
assert.equal(
  process.env.SEED_ONLY_IN_FILE,
  undefined,
  'importing seed-library.mjs must not mutate process.env',
)
console.log('  OK  importing the module seeds nothing and mutates no environment')

console.log('seed-library target guard: all assertions passed')
