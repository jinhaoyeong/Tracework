import { createSupabaseContext, withSupabase } from '@supabase/server'
import {
  createAdminClient,
  createContextClient,
  extractCredentials,
  verifyAuth,
  verifyCredentials,
} from '@supabase/server/core'
import type { AuthMode, SupabaseContext } from '@supabase/server'

interface VercelNodeRequestLike {
  headers: Record<string, string | string[] | undefined>
}

const firstHeader = (value: string | string[] | undefined) => (
  Array.isArray(value) ? value[0] : value
)

const credentialsFromVercelRequest = (request: VercelNodeRequestLike) => ({
  token: firstHeader(request.headers.authorization)?.replace(/^Bearer\s+/i, '') || null,
  apikey: firstHeader(request.headers.apikey) ?? null,
})

// This file is a type-only compatibility spike. It is intentionally not
// imported by a production route and none of the handlers are invoked.
const wrappedUserHandler = withSupabase({ auth: 'user', cors: 'disabled' }, async (_request, context) => {
  const userId: string | undefined = context.userClaims?.id
  const caller = context.supabase
  const admin = context.supabaseAdmin
  const mode: AuthMode = context.authMode
  void userId
  void caller
  void admin
  void mode
  return new Response(null, { status: 204 })
})

const directContextHandler = async (request: Request) => {
  const result = await createSupabaseContext(request, { auth: 'user', cors: 'disabled' })
  if (result.error) return new Response(null, { status: result.error.status })
  const context: SupabaseContext = result.data
  const userId: string | undefined = context.userClaims?.id
  void userId
  return new Response(null, { status: 204 })
}

const corePrimitiveHandler = async (request: Request) => {
  const verified = await verifyAuth(request, { auth: 'user' })
  if (verified.error) return new Response(null, { status: verified.error.status })

  const caller = createContextClient({
    auth: { token: verified.data.token, keyName: verified.data.keyName },
  })
  const admin = createAdminClient({ auth: { keyName: verified.data.keyName } })
  const userId: string | undefined = verified.data.userClaims?.id
  void caller
  void admin
  void userId
  return new Response(null, { status: 204 })
}

const credentialsHandler = async (credentials: { token: string | null; apikey: string | null }) => {
  const verified = await verifyCredentials(credentials, { auth: 'user' })
  if (verified.error) return verified.error.status
  const caller = createContextClient({ auth: { token: verified.data.token, keyName: verified.data.keyName } })
  void caller
  return verified.data.userClaims?.id ?? null
}

const currentVercelHandlerShape = async (request: VercelNodeRequestLike) => {
  const verified = await verifyCredentials(credentialsFromVercelRequest(request), { auth: 'user' })
  if (verified.error) return verified.error.status
  const caller = createContextClient({ auth: { token: verified.data.token, keyName: verified.data.keyName } })
  void caller
  return verified.data.userClaims?.id ?? null
}

const extracted = extractCredentials(new Request('https://tracework.invalid/api/test', {
  headers: { Authorization: 'Bearer test-token' },
}))

void wrappedUserHandler
void directContextHandler
void corePrimitiveHandler
void credentialsHandler
void currentVercelHandlerShape
void extracted
