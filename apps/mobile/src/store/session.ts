/**
 * Session and app-level state (spec §9).
 *
 * The access token is held in a module variable, not in the Zustand store and
 * not in storage: it is short-lived and re-derivable, and keeping it out of
 * persisted state means a cache dump never contains a usable credential. The
 * refresh token goes to `expo-secure-store` (Keychain / Keystore).
 */

import { create } from 'zustand'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import type { MeResponse, Role } from '@quanti/shared'

const REFRESH_KEY = 'quanti.refreshToken'
const DEVICE_KEY = 'quanti.deviceId'

let accessToken: string | null = null

export function getAccessToken(): string | null {
  return accessToken
}

/**
 * SecureStore has no web implementation. On web we fall back to localStorage
 * and accept that a browser profile is only as private as the machine — the
 * web surface is a preview and an HR console, not the attendance client.
 */
const secure = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      try {
        return window.localStorage.getItem(key)
      } catch {
        return null
      }
    }
    return SecureStore.getItemAsync(key)
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        /* ignore */
      }
      return
    }
    await SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    })
  },
  async remove(key: string): Promise<void> {
    if (Platform.OS === 'web') {
      try {
        window.localStorage.removeItem(key)
      } catch {
        /* ignore */
      }
      return
    }
    await SecureStore.deleteItemAsync(key)
  },
}

export async function getRefreshToken(): Promise<string | null> {
  return secure.get(REFRESH_KEY)
}

export async function setTokens(access: string, refresh: string): Promise<void> {
  accessToken = access
  await secure.set(REFRESH_KEY, refresh)
  useSession.setState({ status: 'authenticated' })
}

export async function clearTokens(): Promise<void> {
  accessToken = null
  await secure.remove(REFRESH_KEY)
  useSession.setState({ status: 'signed-out', me: null, unlocked: false, mustChangePassword: false })
}

/**
 * A stable per-install identifier, bound to the employee at first sign-in and
 * checked at every check-in. Regenerating it would silently defeat device
 * binding, so it is created once and never rotated by the client.
 */
export async function getDeviceId(): Promise<string> {
  const existing = await secure.get(DEVICE_KEY)
  if (existing) return existing

  const c = globalThis.crypto
  const id =
    c && typeof c.randomUUID === 'function'
      ? c.randomUUID()
      : `dev-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`

  await secure.set(DEVICE_KEY, id)
  return id
}

const ONBOARDED_KEY = 'quanti.onboarded'

/**
 * Whether this device has been through first-run.
 *
 * Stored per device rather than per user, because the thing onboarding explains
 * — that this handset is now the employee's registered device — is a property
 * of the device. Signing out does not clear it; re-installing does, which is
 * correct, since a fresh install re-registers.
 */
export async function hasOnboarded(): Promise<boolean> {
  return (await secure.get(ONBOARDED_KEY)) === 'true'
}

export async function setOnboarded(): Promise<void> {
  await secure.set(ONBOARDED_KEY, 'true')
}

export type SessionStatus = 'loading' | 'authenticated' | 'signed-out'

interface SessionState {
  status: SessionStatus
  me: MeResponse | null
  /** Biometric gate satisfied for this app session (spec §9). */
  unlocked: boolean
  /** Which tab set is showing. Defaults from role, then user-controlled. */
  managerMode: boolean
  /** True once the user has switched mode themselves. */
  modeChosen: boolean
  deviceReviewRequired: boolean
  /**
   * The account is still on the temporary password it was issued with. Set
   * from whichever arrives first — the sign-in response or /v1/me — and the
   * layout routes to the change screen while it is true. Nothing else in the
   * app is reachable until it is cleared.
   */
  mustChangePassword: boolean
  setMe: (me: MeResponse | null) => void
  setMustChangePassword: (on: boolean) => void
  setUnlocked: (unlocked: boolean) => void
  setManagerMode: (on: boolean) => void
  setDeviceReviewRequired: (on: boolean) => void
  reset: () => void
}

export const useSession = create<SessionState>((set) => ({
  status: 'loading',
  me: null,
  unlocked: false,
  managerMode: false,
  modeChosen: false,
  deviceReviewRequired: false,
  mustChangePassword: false,
  /**
   * Setting the profile also picks the default mode.
   *
   * A manager signing in lands in their own view rather than the employee one
   * with a toggle to find — their queue is why they opened the app. It stays a
   * mode rather than a second app, because a manager is also an employee with
   * their own leave and pay, which is what the Personal tab is for.
   *
   * Only applied once per session, so an explicit switch is never overridden.
   */
  setMe: (me) =>
    set((state) => ({
      me,
      mustChangePassword: me?.user.mustChangePassword ?? state.mustChangePassword,
      managerMode: state.modeChosen
        ? state.managerMode
        : !!me?.roles.some((r) => r === 'manager' || r === 'hr_admin' || r === 'owner'),
    })),
  setUnlocked: (unlocked) => set({ unlocked }),
  setManagerMode: (managerMode) => set({ managerMode, modeChosen: true }),
  setDeviceReviewRequired: (deviceReviewRequired) => set({ deviceReviewRequired }),
  setMustChangePassword: (mustChangePassword) => set({ mustChangePassword }),
  reset: () =>
    set({
      status: 'signed-out',
      me: null,
      unlocked: false,
      managerMode: false,
      modeChosen: false,
      mustChangePassword: false,
    }),
}))

export function hasRole(me: MeResponse | null, ...roles: Role[]): boolean {
  if (!me) return false
  return me.roles.some((r) => roles.includes(r as Role))
}

export const isManager = (me: MeResponse | null): boolean =>
  hasRole(me, 'manager', 'hr_admin', 'owner')

export type RefreshOutcome = 'ok' | 'rejected' | 'offline'

let refreshInFlight: Promise<RefreshOutcome> | null = null

/**
 * The one place a refresh token is spent.
 *
 * Tokens rotate on use, and the server treats a second use of the same token
 * as theft and revokes the family. So every caller — launch restore, the API
 * client's 401 retry — shares a single in-flight refresh rather than racing
 * to spend the same token twice.
 */
export function refreshSession(): Promise<RefreshOutcome> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async (): Promise<RefreshOutcome> => {
    const refresh = await getRefreshToken()
    if (!refresh) return 'rejected'
    try {
      const { API_BASE_URL } = await import('../api/client')
      const response = await fetch(`${API_BASE_URL}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
      })
      if (!response.ok) {
        // Expired or revoked — back to sign-in.
        await clearTokens()
        return 'rejected'
      }
      const session = (await response.json()) as {
        accessToken: string
        refreshToken: string
        deviceReviewRequired: boolean
        mustChangePassword?: boolean
      }
      await setTokens(session.accessToken, session.refreshToken)
      useSession.setState({
        deviceReviewRequired: session.deviceReviewRequired,
        mustChangePassword: session.mustChangePassword ?? false,
      })
      return 'ok'
    } catch {
      // A network failure is not an expired session — keep the refresh token.
      return 'offline'
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

/** Restores a session on launch. Returns false when the user must sign in. */
export async function restoreSession(): Promise<boolean> {
  const outcome = await refreshSession()
  if (outcome === 'rejected') {
    useSession.setState({ status: 'signed-out' })
    return false
  }
  // Offline at launch: keep the session and let cached data render. The app
  // must be useful with no network (spec §5).
  if (outcome === 'offline') useSession.setState({ status: 'authenticated' })
  return true
}
