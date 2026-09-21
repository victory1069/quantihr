/**
 * Google sign-in: identity only. A verified email either matches an account
 * HR created, or it does not — and then the person is pointed at HR.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import type { Database } from '../src/db/client.js'
import { resetEnvCache } from '../src/lib/env.js'
import { setGoogleVerifier } from '../src/lib/sso.js'
import { makeDatabase, makeOrg, type TestOrg } from './helpers.js'

let db: Database
let app: FastifyInstance
let org: TestOrg

const sso = (idToken: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/auth/sso/google',
    payload: { idToken, deviceId: 'sso-test-device-1', platform: 'android' },
  })

beforeAll(async () => {
  process.env.GOOGLE_SSO_CLIENT_IDS = 'web-client.apps.googleusercontent.com, android-client.apps.googleusercontent.com'
  resetEnvCache()
  // A fake Google: the "token" is JSON describing the identity it stands for.
  setGoogleVerifier(async (idToken) => JSON.parse(Buffer.from(idToken, 'base64').toString()))
  db = await makeDatabase()
  org = await makeOrg(db, 'acme')
  app = await buildServer(db)
  await app.ready()
})

afterAll(async () => {
  setGoogleVerifier(null)
  delete process.env.GOOGLE_SSO_CLIENT_IDS
  resetEnvCache()
  await app.close()
  await db.close()
})

const token = (identity: Record<string, unknown>) =>
  Buffer.from(
    JSON.stringify({
      email: 'staff@acme.test',
      emailVerified: true,
      audience: 'android-client.apps.googleusercontent.com',
      name: 'Staff Member',
      ...identity,
    }),
  ).toString('base64')

describe('Google sign-in', () => {
  it('signs an invited person in, and says it is their first time', async () => {
    const res = await sso(token({}))
    expect(res.statusCode).toBe(200)
    expect(res.json().accessToken).toBeTruthy()
    expect(res.json().firstSignIn).toBe(true)

    const again = await sso(token({}))
    expect(again.json().firstSignIn).toBe(false)
  })

  it('turns away someone HR has not added, naming who can', async () => {
    const res = await sso(token({ email: 'stranger@acme.test' }))
    expect(res.statusCode).toBe(403)
    expect(res.json().message).toContain('Ask your HR')
    expect(res.json().details.reason).toBe('not_invited')
  })

  it('refuses a token issued to a client that is not ours', async () => {
    const res = await sso(token({ audience: 'someone-else.apps.googleusercontent.com' }))
    expect(res.statusCode).toBe(401)
  })

  it('refuses an unverified email', async () => {
    const res = await sso(token({ emailVerified: false }))
    expect(res.statusCode).toBe(401)
  })

  it('is off entirely when no client ids are configured', async () => {
    process.env.GOOGLE_SSO_CLIENT_IDS = ''
    resetEnvCache()
    const res = await sso(token({}))
    expect(res.statusCode).toBe(503)
    process.env.GOOGLE_SSO_CLIENT_IDS = 'android-client.apps.googleusercontent.com'
    resetEnvCache()
  })
})
