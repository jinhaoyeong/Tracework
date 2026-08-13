import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export interface SupabaseBrowserConfig {
  url: string
  publishableKey: string
}

const asTrimmedString = (value: unknown) => (
  typeof value === 'string' ? value.trim() : ''
)

export const readSupabaseBrowserConfig = (
  env: Record<string, unknown> | undefined,
): SupabaseBrowserConfig | null => {
  const url = asTrimmedString(env?.VITE_SUPABASE_URL).replace(/\/+$/, '')
  const publishableKey = asTrimmedString(env?.VITE_SUPABASE_PUBLISHABLE_KEY)
  if (!url || !publishableKey) return null

  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
  } catch {
    return null
  }

  return { url, publishableKey }
}

const viteEnvironment = () => (
  (import.meta as ImportMeta & { env?: Record<string, unknown> }).env
)

export const getSupabaseBrowserConfig = (
  env: Record<string, unknown> | undefined = viteEnvironment(),
) => readSupabaseBrowserConfig(env)

export const isSupabaseAuthConfigured = () => (
  getSupabaseBrowserConfig() !== null
)

export const createSupabaseBrowserClient = (config: SupabaseBrowserConfig): SupabaseClient => (
  createClient(config.url, config.publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  })
)

let browserClient: SupabaseClient | null = null
let browserClientFingerprint: string | null = null

/**
 * Returns the one browser Auth client for the current Vite configuration.
 * Missing or invalid public configuration is a supported local/demo state.
 */
export const getSupabaseBrowserClient = (): SupabaseClient | null => {
  const config = getSupabaseBrowserConfig()
  if (!config) return null

  const fingerprint = `${config.url}\u0000${config.publishableKey}`
  if (!browserClient || browserClientFingerprint !== fingerprint) {
    browserClient = createSupabaseBrowserClient(config)
    browserClientFingerprint = fingerprint
  }
  return browserClient
}
