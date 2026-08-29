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
  useSession.setState({ status: 'signed-out', me: null, unlocked: false })
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

export type SessionStatus = 'loading' | 'authenticated' | 'signed-out'

interface SessionState {
  status: SessionStatus
  me: MeResponse | null
  /** Biometric gate satisfied for this app session (spec §9). */
  unlocked: boolean
  /** Manager-mode tab visibility, toggled in the tab bar. */
  managerMode: boolean
  deviceReviewRequired: boolean
  setMe: (me: MeResponse | null) => void
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
  deviceReviewRequired: false,
  setMe: (me) => set({ me }),
  setUnlocked: (unlocked) => set({ unlocked }),
  setManagerMode: (managerMode) => set({ managerMode }),
  setDeviceReviewRequired: (deviceReviewRequired) => set({ deviceReviewRequired }),
  reset: () => set({ status: 'signed-out', me: null, unlocked: false, managerMode: false }),
}))

export function hasRole(me: MeResponse | null, ...roles: Role[]): boolean {
  if (!me) return false
  return me.roles.some((r) => roles.includes(r as Role))
}

export const isManager = (me: MeResponse | null): boolean =>
  hasRole(me, 'manager', 'hr_admin', 'owner')

/** Restores a session on launch. Returns false when the user must sign in. */
export async function restoreSession(): Promise<boolean> {
  const refresh = await getRefreshToken()
  if (!refresh) {
    useSession.setState({ status: 'signed-out' })
    return false
  }

  try {
    const { API_BASE_URL } = await import('../api/client')
    const response = await fetch(`${API_BASE_URL}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: refresh }),
    })

    if (!response.ok) {
      // Expired or revoked — fall back to magic link, never a password screen.
      await clearTokens()
      return false
    }

    const session = (await response.json()) as {
      accessToken: string
      refreshToken: string
      deviceReviewRequired: boolean
    }
    await setTokens(session.accessToken, session.refreshToken)
    useSession.setState({ deviceReviewRequired: session.deviceReviewRequired })
    return true
  } catch {
    // Offline at launch: keep the session and let cached data render. The app
    // must be useful with no network (spec §5).
    useSession.setState({ status: 'authenticated' })
    return true
  }
}
