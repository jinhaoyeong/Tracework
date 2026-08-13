import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react'
import { getSupabaseBrowserClient, getSupabaseBrowserConfig } from '../lib/supabase.ts'
import {
  createAuthSessionController,
  type AuthSessionController,
  type AuthSessionState,
} from './session.ts'

export interface AuthContextValue {
  configured: boolean
  state: AuthSessionState
  getCurrentSession: AuthSessionController['getCurrentSession']
  getCurrentAccessToken: AuthSessionController['getCurrentAccessToken']
  signOut: AuthSessionController['signOut']
}

const AuthContext = createContext<AuthContextValue | null>(null)

export const AuthProvider = ({ children }: PropsWithChildren) => {
  const client = useMemo(() => getSupabaseBrowserClient(), [])
  const controller = useMemo(() => createAuthSessionController(client), [client])
  const [state, setState] = useState<AuthSessionState>(() => controller.getState())

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState)
    void controller.start()
    return () => {
      unsubscribe()
      controller.stop()
    }
  }, [controller])

  const value = useMemo<AuthContextValue>(() => ({
    configured: getSupabaseBrowserConfig() !== null,
    state,
    getCurrentSession: controller.getCurrentSession,
    getCurrentAccessToken: controller.getCurrentAccessToken,
    signOut: controller.signOut,
  }), [controller, state])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export const useAuth = (): AuthContextValue => {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used within AuthProvider.')
  return value
}
