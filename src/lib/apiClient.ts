import { getCurrentAccessToken } from '../auth/session.ts'

export interface ApiRequestOptions {
  /** Explicitly omit the bearer token for a public/demo request. */
  anonymous?: boolean
  /** Test-only or adapter override; production reads the SDK session at call time. */
  getAccessToken?: () => Promise<string | null>
}

export const requestWithAuth = async (
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: ApiRequestOptions = {},
): Promise<Response> => {
  const headers = new Headers(init.headers)
  if (!options.anonymous) {
    const token = await (options.getAccessToken ?? getCurrentAccessToken)()
    if (token) headers.set('Authorization', `Bearer ${token}`)
  }

  return fetch(input, { ...init, headers })
}
