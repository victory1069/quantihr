/**
 * Session lifecycle: magic link -> device registration -> refresh rotation.
 *
 * This is the entire trust chain behind a 90-day sliding session (spec §9).
 * `delivery.test.ts` already covers the magic-link send and a single
 * `/v1/auth/verify` call; this file picks up from there — refresh, replay,
 * and the sliding window's own expiry.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import type { Database } from '../src/db/client.js'
import { devices, refreshTokens } from '../src/db/schema.js'
import { setEmailDriver, type EmailMessage } from '../src/lib/email.js'
import { makeDatabase, makeOrg, bearer, type TestOrg } from './helpers.js'

let db: Database
let app: FastifyInstance
let org: TestOrg

const emails: EmailMessage[] = []

function captureEmail(): void {
  setEmailDriver({
    name: 'test',
    async send(message) {
      emails.push(message)
      return { messageId: 'test-message-id', driver: 'test' }
    },
  })
}

/** Runs a fresh magic-link -> verify round trip and returns the session. */
async function signIn(email: string, deviceId: string) {
  captureEmail()
  await app.inject({
    method: 'POST',
    url: '/v1/auth/magic-link',
    payload: { email },
  })
  const token = /token=([A-Za-z0-9_-]+)/.exec(emails.at(-1)!.text)?.[1]

  const verify = await app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: { token, deviceId, deviceName: 'Test device' },
  })
  return verify.json() as {
    accessToken: string
    refreshToken: string
    deviceRegistered: boolean
    deviceReviewRequired: boolean
  }
}

beforeAll(async () => {
  db = await makeDatabase()
  org = await makeOrg(db, 'acme')
  app = await buildServer(db)
  await app.ready()
})

afterAll(async () => {
  setEmailDriver(null)
  await app.close()
  await db.close()
})

beforeEach(async () => {
  // Each test signs in fresh and several assert on "the first device" or "a
  // brand new session" — state from an earlier test's devices/tokens would
  // make those assertions depend on run order instead of on the scenario.
  await db.withTenant(org.orgId, async (tx) => {
    await tx.delete(devices)
    await tx.delete(refreshTokens)
  })
})

afterEach(() => {
  emails.length = 0
})

describe('refresh', () => {
  it('rotates the token and invalidates the one it replaced', async () => {
    const session = await signIn('staff@acme.test', 'device-rotate')

    const refreshed = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    })

    expect(refreshed.statusCode).toBe(200)
    const next = refreshed.json()
    expect(next.refreshToken).toBeTruthy()
    // A rotation that just echoed the same token back would defeat the whole
    // point of "one rotation at most" for a stolen token.
    expect(next.refreshToken).not.toBe(session.refreshToken)

    // The new access token actually works.
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(next.accessToken),
    })
    expect(me.statusCode).toBe(200)
  })

  it('rejects a replayed (already-rotated) refresh token', async () => {
    const session = await signIn('staff@acme.test', 'device-replay')

    const first = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    })
    expect(first.statusCode).toBe(200)

    // The same token, used again — as if it had been stolen and the thief and
    // the real device both tried to use it.
    const replayed = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    })

    expect(replayed.statusCode).toBe(401)
    expect(replayed.json().code).toBe('auth/expired-token')
  })

  it('rejects a refresh token past the 90-day sliding window', async () => {
    const session = await signIn('staff@acme.test', 'device-expired')

    // The token is only ever known to the server as a hash, so backdating its
    // expiry in place is the only way to simulate 90 days passing without
    // faking the clock for the whole suite.
    await db.withTenant(org.orgId, async (tx) => {
      await tx
        .update(refreshTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(refreshTokens.userId, org.userId))
    })

    const refreshed = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    })

    expect(refreshed.statusCode).toBe(401)
    expect(refreshed.json().code).toBe('auth/expired-token')
  })

  it('rejects a refresh token that was never issued', async () => {
    const refreshed = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: 'not-a-real-token' },
    })

    expect(refreshed.statusCode).toBe(401)
    expect(refreshed.json().code).toBe('auth/expired-token')
  })
})

describe('device binding', () => {
  it('binds the first device automatically', async () => {
    const session = await signIn('staff@acme.test', 'device-first')
    expect(session.deviceRegistered).toBe(true)
    expect(session.deviceReviewRequired).toBe(false)
  })

  it('flags a second device for review rather than refusing it', async () => {
    await signIn('staff@acme.test', 'device-a')
    const second = await signIn('staff@acme.test', 'device-b')

    // Spec §7: an unapproved device is flagged, not blocked — the same
    // decision routes/attendance.ts makes for an unrecognised check-in
    // device. `deviceReviewRequired` is what a client uses to show a
    // "pending approval" notice; it deliberately does not withhold the
    // session, since the sign-in step already proved who this is.
    expect(second.deviceReviewRequired).toBe(true)
    expect(second.accessToken).toBeTruthy()

    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(second.accessToken),
    })
    expect(me.statusCode).toBe(200)
  })
})
