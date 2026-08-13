import { useEffect, useState, type FormEvent } from 'react'
import { Icon } from '../components/Icon'
import { useAuth } from './AuthProvider'
import { BrowserAuthError } from './session'

type AuthPanelMode = 'sign-in' | 'sign-up' | 'reset' | 'recovery'
type FeedbackTone = 'success' | 'error' | 'info'

interface Feedback {
  tone: FeedbackTone
  text: string
}

const modeCopy: Record<AuthPanelMode, { title: string; action: string }> = {
  'sign-in': { title: 'Sign in to Tracework', action: 'sign in' },
  'sign-up': { title: 'Create your account', action: 'create account' },
  reset: { title: 'Reset your password', action: 'send reset link' },
  recovery: { title: 'Choose a new password', action: 'update password' },
}

const genericAuthError = 'The account action could not be completed. Check the details and try again.'

const readableError = (error: unknown): string => {
  if (error instanceof BrowserAuthError) {
    if (error.code === 'auth_configuration') return 'Account sign-in is not configured in this environment.'
  }
  return genericAuthError
}

const readableStateError = (error: { code: string } | null): string => (
  error?.code === 'auth_configuration'
    ? 'Account sign-in is not configured in this environment.'
    : genericAuthError
)

const validateEmail = (email: string): string | null => {
  const value = email.trim()
  if (!value) return 'Enter your email address.'
  if (!/^\S+@\S+\.\S+$/.test(value)) return 'Enter a complete email address.'
  return null
}

const validatePassword = (password: string): string | null => {
  if (!password) return 'Enter a password.'
  if (password.length < 8) return 'Use at least 8 characters.'
  return null
}

const displayEmail = (email: string | undefined): string => email?.trim() || 'authenticated account'

export const AuthPanel = () => {
  const {
    configured,
    state,
    signIn,
    signUp,
    requestPasswordReset,
    resendConfirmation,
    updatePassword,
    signOut,
  } = useAuth()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<AuthPanelMode>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  useEffect(() => {
    if (state.status === 'password-recovery') {
      setMode('recovery')
      setOpen(true)
      setFeedback({ tone: 'info', text: 'Your reset link is ready. Choose a new password to continue.' })
    }
    if (state.status === 'email-verification-pending') {
      setMode('sign-in')
      setOpen(true)
      setFeedback({ tone: 'success', text: 'Check your inbox for the verification link, then return here to sign in.' })
    }
  }, [state.status])

  const setPanelMode = (nextMode: AuthPanelMode) => {
    setMode(nextMode)
    setFeedback(null)
    setPassword('')
    setConfirmation('')
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFeedback(null)

    if (!configured) {
      setFeedback({ tone: 'info', text: 'Account sign-in is not configured in this environment. The local demo remains available.' })
      return
    }

    const emailError = mode === 'recovery' ? null : validateEmail(email)
    const passwordError = mode === 'reset' ? null : validatePassword(password)
    if (emailError) {
      setFeedback({ tone: 'error', text: emailError })
      return
    }
    if (passwordError) {
      setFeedback({ tone: 'error', text: passwordError })
      return
    }
    if (mode === 'sign-up' && password !== confirmation) {
      setFeedback({ tone: 'error', text: 'Passwords do not match.' })
      return
    }

    setBusy(true)
    try {
      if (mode === 'sign-in') {
        await signIn(email, password)
        setPassword('')
        setFeedback({ tone: 'success', text: 'Signed in. Your browser session is ready.' })
        setOpen(false)
      } else if (mode === 'sign-up') {
        await signUp(email, password)
        setPassword('')
        setConfirmation('')
        setFeedback({ tone: 'success', text: 'Account created. Check your inbox before signing in.' })
      } else if (mode === 'reset') {
        await requestPasswordReset(email)
        setFeedback({ tone: 'success', text: 'If an account uses that address, reset instructions will arrive by email.' })
      } else {
        await updatePassword(password)
        setPassword('')
        setConfirmation('')
        setFeedback({ tone: 'success', text: 'Password updated. You can continue in Tracework.' })
        setOpen(false)
      }
    } catch (error) {
      setFeedback({ tone: 'error', text: readableError(error) })
    } finally {
      setBusy(false)
    }
  }

  const handleResendConfirmation = async () => {
    const emailError = validateEmail(email || state.user?.email || '')
    if (emailError) {
      setFeedback({ tone: 'error', text: emailError })
      return
    }
    setBusy(true)
    try {
      await resendConfirmation(email || state.user?.email || '')
      setFeedback({ tone: 'success', text: 'A fresh verification link has been requested.' })
    } catch (error) {
      setFeedback({ tone: 'error', text: readableError(error) })
    } finally {
      setBusy(false)
    }
  }

  const handleSignOut = async () => {
    setBusy(true)
    setFeedback(null)
    try {
      await signOut()
      setOpen(false)
    } catch (error) {
      setFeedback({ tone: 'error', text: readableError(error) })
    } finally {
      setBusy(false)
    }
  }

  const triggerLabel = state.status === 'initializing'
    ? 'checking session'
    : state.status === 'signed-in'
      ? displayEmail(state.user?.email)
      : state.status === 'email-verification-pending'
        ? 'check your email'
        : state.status === 'password-recovery'
          ? 'finish password reset'
          : configured
            ? 'sign in'
            : 'account setup'

  return (
    <div className="auth-surface">
      <button
        className={`auth-trigger is-${state.status}`}
        type="button"
        aria-expanded={open}
        aria-controls="tracework-auth-panel"
        onClick={() => setOpen((visible) => !visible)}
        disabled={state.status === 'initializing'}
      >
        <span className="auth-trigger-mark" aria-hidden="true"><Icon name={state.status === 'signed-in' ? 'check' : 'target'} size={15} /></span>
        <span className="auth-trigger-copy">
          <span className="auth-trigger-label">account</span>
          <strong>{triggerLabel}</strong>
        </span>
        <Icon name="chevron" size={15} />
      </button>

      {open && <div className="auth-panel" id="tracework-auth-panel" role="dialog" aria-label="Tracework account">
        <div className="auth-panel-heading">
          <div>
            <span className="auth-panel-kicker">account / identity</span>
            <h2>{state.status === 'signed-in' ? 'Your session' : modeCopy[mode].title}</h2>
          </div>
          <button className="auth-close" type="button" aria-label="Close account panel" onClick={() => setOpen(false)}><Icon name="close" size={16} /></button>
        </div>

        {state.status === 'signed-in' ? (
          <div className="auth-account-state">
            <span className="auth-state-mark"><Icon name="check" size={18} /></span>
            <p className="auth-account-email">{displayEmail(state.user?.email)}</p>
            <p className="auth-account-note">Your browser session is active. Resource authorization and workspace access remain separate server-side decisions.</p>
            <button className="auth-submit auth-submit-secondary" type="button" onClick={() => void handleSignOut()} disabled={busy}>
              {busy ? 'signing out...' : 'sign out'}
              <Icon name="arrow" size={15} />
            </button>
          </div>
        ) : state.status === 'email-verification-pending' ? (
          <div className="auth-account-state">
            <span className="auth-state-mark is-pending"><Icon name="target" size={18} /></span>
            <p className="auth-account-email">Verification is pending</p>
            <p className="auth-account-note">{displayEmail(state.user?.email)} needs to confirm its email address before a normal session can begin.</p>
            <button className="auth-submit auth-submit-secondary" type="button" onClick={() => void handleResendConfirmation()} disabled={busy}>
              {busy ? 'requesting link...' : 'resend verification'}
              <Icon name="arrow" size={15} />
            </button>
            <button className="auth-text-button" type="button" onClick={() => setPanelMode('sign-in')}>return to sign in</button>
          </div>
        ) : !configured ? (
          <div className="auth-config-state">
            <span className="auth-state-mark is-pending"><Icon name="target" size={18} /></span>
            <p className="auth-account-email">Auth is not configured here yet.</p>
            <p className="auth-account-note">The local Tracework demo remains available. A later environment-readiness step must provide the browser project URL and publishable key before account actions can contact Supabase.</p>
            <div className="auth-config-list" aria-label="Required browser configuration">
              <span>VITE_SUPABASE_URL</span>
              <span>VITE_SUPABASE_PUBLISHABLE_KEY</span>
            </div>
          </div>
        ) : (
          <>
            {state.status === 'session-expired' && <p className="auth-inline-notice is-error" role="status">Your previous session is no longer usable. Sign in again to continue.</p>}
            {state.status === 'error' && state.error && <p className="auth-inline-notice is-error" role="status">{readableStateError(state.error)}</p>}
            {mode !== 'recovery' && <div className="auth-mode-tabs" role="group" aria-label="Account action">
              <button type="button" className={mode === 'sign-in' ? 'is-active' : ''} aria-pressed={mode === 'sign-in'} onClick={() => setPanelMode('sign-in')}>sign in</button>
              <button type="button" className={mode === 'sign-up' ? 'is-active' : ''} aria-pressed={mode === 'sign-up'} onClick={() => setPanelMode('sign-up')}>create account</button>
            </div>}

            <form className="auth-form" onSubmit={(event) => void handleSubmit(event)}>
              {mode !== 'recovery' && <label className="auth-field">
                <span>email</span>
                <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" placeholder="you@example.com" disabled={busy} />
              </label>}
              {mode !== 'reset' && <label className="auth-field">
                <span>{mode === 'recovery' ? 'new password' : 'password'}</span>
                <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'} placeholder="8 characters or more" disabled={busy} />
              </label>}
              {mode === 'sign-up' && <label className="auth-field">
                <span>confirm password</span>
                <input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" placeholder="repeat password" disabled={busy} />
              </label>}

              {feedback && <p className={`auth-inline-notice is-${feedback.tone}`} role="status" aria-live="polite">{feedback.text}</p>}

              <button className="auth-submit" type="submit" disabled={busy}>
                {busy ? 'working...' : modeCopy[mode].action}
                <Icon name="arrow" size={15} />
              </button>
            </form>

            {mode === 'sign-in' && <button className="auth-text-button" type="button" onClick={() => setPanelMode('reset')}>forgot password?</button>}
            {(mode === 'reset' || mode === 'recovery') && <button className="auth-text-button" type="button" onClick={() => setPanelMode('sign-in')}>return to sign in</button>}
          </>
        )}
      </div>}
    </div>
  )
}
