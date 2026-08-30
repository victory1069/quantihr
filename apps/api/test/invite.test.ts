/**
 * Invite lookup and phone verification.
 *
 * The interesting assertions are the refusals: a brute-forced code has to lock
 * out, a superseded code has to stop working, and a terminated employee must
 * not be handed a sign-up path.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import type { Database } from '../src/db/client.js'
import { employees, otpCodes } from '../src/db/schema.js'
import { resetRateLimits } from '../src/routes/invite.js'
import { makeDatabase, makeOrg, type TestOrg } from './helpers.js'

let db: Database
let app: FastifyInstance
let org: TestOrg

const STAFF_EMAIL = 'staff@invco.test'

beforeAll(async () => {
  db = await makeDatabase()
  org = await makeOrg(db, 'invco')
  app = await buildServer(db)
  await app.ready()

  await db.withTenant(org.orgId, async (tx) => {
    await tx
      .update(employees)
      .set({ phone: '+2348031234541' })
      .where(eq(employees.id, org.employeeId))
  })
})

afterAll(async () => {
  await app?.close()
  await db?.close()
})

beforeEach(async () => {
  resetRateLimits()
  await db.withTenant(org.orgId, async (tx) => {
    await tx.delete(otpCodes)
  })
})

const get = (url: string) => app.inject({ method: 'GET', url })
const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, payload: payload as object })

describe('invite lookup', () => {
  it('returns the employer and a masked phone for a known address', async () => {
    const res = await get(`/v1/auth/invite?email=${encodeURIComponent(STAFF_EMAIL)}`)
    expect(res.statusCode).toBe(200)
    expect(res.json().found).toBe(true)
    expect(res.json().orgName).toBe('invco')
    expect(res.json().email).toBe(STAFF_EMAIL)
    // Enough to recognise, not enough to dial.
    expect(res.json().phoneHint).toContain('••••')
    expect(res.json().phoneHint).not.toContain('1234')
  })

  it('reports no invite for an unknown address', async () => {
    const res = await get('/v1/auth/invite?email=nobody@nowhere.test')
    expect(res.statusCode).toBe(200)
    expect(res.json().found).toBe(false)
    expect(res.json().orgName).toBeNull()
  })

  it('does not offer sign-up to a terminated employee', async () => {
    await db.withTenant(org.orgId, async (tx) => {
      await tx
        .update(employees)
        .set({ status: 'terminated' })
        .where(eq(employees.id, org.employeeId))
    })

    const res = await get(`/v1/auth/invite?email=${encodeURIComponent(STAFF_EMAIL)}`)
    expect(res.json().found).toBe(false)
    expect(res.json().ended).toBe(true)

    await db.withTenant(org.orgId, async (tx) => {
      await tx
        .update(employees)
        .set({ status: 'active' })
        .where(eq(employees.id, org.employeeId))
    })
  })

  it('never leaks a name or a full number', async () => {
    const body = (await get(`/v1/auth/invite?email=${encodeURIComponent(STAFF_EMAIL)}`)).body
    expect(body).not.toContain('Staff')
    expect(body).not.toContain('+2348031234541')
  })
})

describe('otp request', () => {
  it('issues a code and reports where it went', async () => {
    const res = await post('/v1/auth/otp/request', { email: STAFF_EMAIL })
    expect(res.statusCode).toBe(200)
    expect(res.json().sent).toBe(true)
    expect(res.json().devCode).toMatch(/^\d{6}$/)

    const stored = await db.withTenant(org.orgId, (tx) => tx.select().from(otpCodes))
    expect(stored).toHaveLength(1)
    // Stored as a hash, never in the clear.
    expect(stored[0]!.codeHash).not.toBe(res.json().devCode)
  })

  it('stays non-committal for an unknown address', async () => {
    const res = await post('/v1/auth/otp/request', { email: 'nobody@nowhere.test' })
    expect(res.statusCode).toBe(200)
    expect(res.json().sent).toBe(true)
    expect(res.json().devCode).toBeUndefined()
  })

  it('supersedes an earlier code', async () => {
    const first = await post('/v1/auth/otp/request', { email: STAFF_EMAIL })
    await post('/v1/auth/otp/request', { email: STAFF_EMAIL })

    // Screen L6 promises older codes stop working, so it must be true.
    const res = await post('/v1/auth/otp/verify', {
      email: STAFF_EMAIL,
      code: first.json().devCode,
    })
    expect(res.statusCode).toBe(401)
  })

  it('refuses when the HR record has no phone number', async () => {
    await db.withTenant(org.orgId, async (tx) => {
      await tx.update(employees).set({ phone: null }).where(eq(employees.id, org.employeeId))
    })

    const res = await post('/v1/auth/otp/request', { email: STAFF_EMAIL })
    expect(res.statusCode).toBe(422)
    expect(res.json().message).toMatch(/no phone number/i)

    await db.withTenant(org.orgId, async (tx) => {
      await tx
        .update(employees)
        .set({ phone: '+2348031234541' })
        .where(eq(employees.id, org.employeeId))
    })
  })
})

describe('otp verify', () => {
  it('accepts the issued code once', async () => {
    const issued = await post('/v1/auth/otp/request', { email: STAFF_EMAIL })
    const code = issued.json().devCode

    const first = await post('/v1/auth/otp/verify', { email: STAFF_EMAIL, code })
    expect(first.statusCode).toBe(200)
    expect(first.json().verified).toBe(true)

    // Consumed — replaying it must not work.
    const second = await post('/v1/auth/otp/verify', { email: STAFF_EMAIL, code })
    expect(second.statusCode).toBe(401)
  })

  it('counts down attempts and says how many are left', async () => {
    await post('/v1/auth/otp/request', { email: STAFF_EMAIL })

    const res = await post('/v1/auth/otp/verify', { email: STAFF_EMAIL, code: '000000' })
    expect(res.statusCode).toBe(401)
    expect(res.json().details.attemptsLeft).toBe(4)
  })

  it('locks out after five wrong codes and names the alternative', async () => {
    await post('/v1/auth/otp/request', { email: STAFF_EMAIL })

    let last = await post('/v1/auth/otp/verify', { email: STAFF_EMAIL, code: '000000' })
    for (let i = 0; i < 4; i++) {
      last = await post('/v1/auth/otp/verify', { email: STAFF_EMAIL, code: '000000' })
    }
    expect(last.json().details.locked).toBe(true)

    // Screen X3: a lockout with an escape hatch is not a lockout.
    const after = await post('/v1/auth/otp/verify', { email: STAFF_EMAIL, code: '000000' })
    expect(after.statusCode).toBe(429)
    expect(after.json().message).toMatch(/email sign-in link/i)
    expect(after.json().details.alternative).toBe('magic_link')
  })

  it('rejects a correct code once it has expired', async () => {
    const issued = await post('/v1/auth/otp/request', { email: STAFF_EMAIL })

    await db.withTenant(org.orgId, async (tx) => {
      await tx.update(otpCodes).set({ expiresAt: new Date(Date.now() - 1000) })
    })

    const res = await post('/v1/auth/otp/verify', {
      email: STAFF_EMAIL,
      code: issued.json().devCode,
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('auth/expired-token')
  })

  it('refuses when no code is outstanding', async () => {
    const res = await post('/v1/auth/otp/verify', { email: STAFF_EMAIL, code: '123456' })
    expect(res.statusCode).toBe(401)
    expect(res.json().message).toMatch(/request one first/i)
  })
})

describe('rate limiting', () => {
  it('cuts off code requests past the per-minute budget', async () => {
    // Five are allowed; the sixth must be refused rather than sending another SMS.
    for (let i = 0; i < 5; i++) {
      const ok = await post('/v1/auth/otp/request', { email: STAFF_EMAIL })
      expect(ok.statusCode).toBe(200)
    }
    const blocked = await post('/v1/auth/otp/request', { email: STAFF_EMAIL })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json().code).toBe('common/rate-limited')
  })

  it('bounds the invite oracle', async () => {
    for (let i = 0; i < 10; i++) {
      await get(`/v1/auth/invite?email=probe${i}@nowhere.test`)
    }
    const blocked = await get('/v1/auth/invite?email=probe99@nowhere.test')
    expect(blocked.statusCode).toBe(429)
  })
})
