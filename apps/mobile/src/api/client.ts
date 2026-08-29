/**
 * HTTP client.
 *
 * The access token lives in memory only; the refresh token lives in
 * `expo-secure-store` (spec §9). A 401 triggers exactly one refresh attempt,
 * with concurrent callers sharing that single attempt rather than each firing
 * their own — otherwise a screen with four queries produces four refreshes and
 * three of them rotate a token that has already been revoked.
 */

import { ApiError, ERROR_CODES, type ErrorCode } from '@quanti/shared'
import { getRefreshToken, setTokens, clearTokens, getAccessToken } from '../store/session'

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  idempotencyKey?: string
  signal?: AbortSignal
  /** Skip the refresh-and-retry dance (used by the refresh call itself). */
  raw?: boolean
}

export class NetworkError extends Error {
  readonly offline = true
  constructor(message = 'No connection') {
    super(message)
    this.name = 'NetworkError'
  }
}

function baseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  // Web preview default; a device build must set EXPO_PUBLIC_API_URL to the
  // machine's LAN address, since localhost on a phone is the phone.
  return 'http://localhost:4000'
}

export const API_BASE_URL = baseUrl()

let refreshInFlight: Promise<boolean> | null = null

async function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    const refreshToken = await getRefreshToken()
    if (!refreshToken) return false

    try {
      const response = await fetch(`${API_BASE_URL}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })
      if (!response.ok) {
        await clearTokens()
        return false
      }
      const session = (await response.json()) as {
        accessToken: string
        refreshToken: string
      }
      await setTokens(session.accessToken, session.refreshToken)
      return true
    } catch {
      // A network failure is not an expired session — keep the refresh token.
      return false
    } finally {
      refreshInFlight = null
    }
  })()

  return refreshInFlight
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET'

  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = { accept: 'application/json' }
    const token = getAccessToken()
    if (token) headers.authorization = `Bearer ${token}`
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey

    try {
      return await fetch(`${API_BASE_URL}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
      })
    } catch (cause) {
      // fetch rejects only on transport failure, which is what "offline" means
      // to the outbox. Everything else arrives as a response with a status.
      throw new NetworkError(cause instanceof Error ? cause.message : undefined)
    }
  }

  let response = await send()

  if (response.status === 401 && !options.raw) {
    const refreshed = await refreshSession()
    if (refreshed) response = await send()
  }

  if (response.status === 204) return undefined as T

  const text = await response.text()
  const payload = text ? safeJson(text) : null

  if (!response.ok) {
    const body = payload as { code?: string; message?: string; details?: Record<string, unknown> }
    throw new ApiError(
      (body?.code as ErrorCode) ?? ERROR_CODES.INTERNAL,
      body?.message ?? `Request failed (${response.status})`,
      response.status,
      body?.details,
    )
  }

  return payload as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export const api = {
  get: <T,>(path: string, signal?: AbortSignal) => request<T>(path, { method: 'GET', signal }),
  post: <T,>(path: string, body?: unknown, idempotencyKey?: string) =>
    request<T>(path, { method: 'POST', body, idempotencyKey }),
  patch: <T,>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T,>(path: string) => request<T>(path, { method: 'DELETE' }),
}
