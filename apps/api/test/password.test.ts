/**
 * Password sign-in as a second door beside the magic link.
 *
 * Two of these are the reason the file exists:
 *
 *   - the sign-in endpoint must answer identically for "no such account",
 *     "no password set" and "wrong password" — anything more specific is an
 *     enumeration oracle, and the link endpoint went to some trouble not to be
 *     one;
 *   - a temporary password must not open anything but the change screen, and
 *     the session it issues must say so.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import type { Database } from '../src/db/client.js'
import { users } from '../src/db/schema.js'
import { resetEnvCache } from '../src/lib/env.js'
import { setEmailDriver, type EmailMessage } from '../src/lib/email.js'
import {
  generateTemporaryPassword,
  hashPassword,
  passwordProblem,
  verifyPassword,
} from '../src/lib/password.js'
import { signAccessToken } from '../src/lib/tokens.js'
import { bearer, makeDatabase, makeOrg, type TestOrg } from './helpers.js'

const PLATFORM_KEY = 'test-platform-key-that-is-long-enough-to-pass-validation'

let db: Database
let app: FastifyInstance
let org: TestOrg
let hrToken: string
const sent: EmailMessage[] = []

beforeAll(async () => {
  process.env.PLATFORM_API_KEY = PLATFORM_KEY
  resetEnvCache()
  setEmailDriver({
    name: 'test',
    async send(m) {
      sent.push(m)
      return { messageId: 'x', driver: 'test' }
    },
  })
  db = await makeDatabase()
  org = await makeOrg(db, 'acme')
  app = await buildServer(db)
  await app.ready()
  hrToken = await signAccessToken({
    userId: org.managerUserId,
    orgId: org.orgId,
    employeeId: org.managerEmployeeId,
    roles: ['employee', 'hr_admin'],
    deviceId: 'hr-device',
  })
})

afterAll(async () => {
  setEmailDriver(null)
  delete process.env.PLATFORM_API_KEY
  resetEnvCache()
  await app.close()
  await db.close()
})

/** The temporary password only ever reaches the person — read it from their mail. */
const mailedPassword = async (email: string): Promise<string> => {
  // Mails go after the reply; give the loop a tick.
  await new Promise((r) => setTimeout(r, 30))
  const mail = [...sent].reverse().find((m) => m.to === email && /temporary password/i.test(m.text))
  const match = mail?.text.match(/([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/)
  if (!match) throw new Error(`no credentials mail for ${email}`)
  return match[1]!
}

const signIn = (email: string, password: string, deviceId = 'test-phone-1') =>
  app.inject({
    method: 'POST',
    url: '/v1/auth/password',
    payload: { email, password, deviceId, deviceName: 'Test' },
  })

describe('hashing', () => {
  it('round-trips and rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery')
    expect(hash.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('correct horse battery', hash)).toBe(true)
    expect(await verifyPassword('correct horse batter', hash)).toBe(false)
  })

  it('never produces the same hash twice for the same input', async () => {
    const a = await hashPassword('same')
    const b = await hashPassword('same')
    expect(a).not.toBe(b)
  })

  it('generates temporary passwords that can be read aloud', () => {
    for (let i = 0; i < 50; i += 1) {
      const pw = generateTemporaryPassword()
      expect(pw).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
      // No O/0 or I/1 — the whole point is that it survives a Post-it.
      expect(pw).not.toMatch(/[O0I1L]/)
    }
  })

  it('rejects short, self-referential and single-character passwords', () => {
    expect(passwordProblem('short', 'ada@acme.test')).toBeTruthy()
    expect(passwordProblem('ada-is-my-password', 'ada@acme.test')).toBeTruthy()
    expect(passwordProblem('aaaaaaaaaaaa', 'ada@acme.test')).toBeTruthy()
    expect(passwordProblem('a genuinely fine one', 'ada@acme.test')).toBeNull()
  })
})

describe('creating an account issues a temporary password', () => {
  it('provisioning returns it and puts it in the welcome email', async () => {
    sent.length = 0
    const res = await app.inject({
      method: 'POST',
      url: '/v1/platform/organisations',
      headers: { 'x-platform-key': PLATFORM_KEY },
      payload: {
        name: 'Temp Co',
        admin: { firstName: 'Tobi', lastName: 'Ade', email: 'tobi@tempco.test' },
      },
    })
    expect(res.statusCode).toBe(201)
    const temp = res.json().temporaryPassword as string
    expect(temp).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(sent[0]!.text).toContain(temp)

    // It signs in, and the session says a change is required.
    const session = await signIn('tobi@tempco.test', temp)
    expect(session.statusCode).toBe(200)
    expect(session.json().mustChangePassword).toBe(true)
  })

  it('a new employee from HR gets one; an update does not rotate it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/employees',
      headers: bearer(hrToken),
      payload: {
        employeeNumber: 'QH-900',
        firstName: 'Bisi',
        lastName: 'Lawal',
        email: 'bisi@acme.test',
        startDate: '2026-09-01',
        employmentType: 'full_time',
        status: 'active',
        roles: ['employee'],
      },
    })
    expect(created.statusCode).toBe(201)
    // HR is told the mail went, and never sees the password itself.
    expect(created.json().credentialsEmailed).toBe(true)
    expect(created.json().temporaryPassword).toBeUndefined()
    const temp = await mailedPassword('bisi@acme.test')
    expect(sent.filter((m) => m.to === 'bisi@acme.test')).toHaveLength(2)

    const again = await app.inject({
      method: 'POST',
      url: '/v1/admin/employees',
      headers: bearer(hrToken),
      payload: {
        employeeNumber: 'QH-900',
        firstName: 'Bisi',
        lastName: 'Lawal-Ojo',
        email: 'bisi@acme.test',
        startDate: '2026-09-01',
        employmentType: 'full_time',
        status: 'active',
        roles: ['employee'],
      },
    })
    expect(again.json().credentialsEmailed).toBe(false)
    // The original still works: the update did not touch the credential.
    expect((await signIn('bisi@acme.test', temp)).statusCode).toBe(200)
  })

  it('bulk import returns one credential per created account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/employees/import',
      headers: bearer(hrToken),
      payload: {
        mode: 'commit',
        rows: [
          { employee_number: 'QH-901', first_name: 'Kemi', last_name: 'Ojo', email: 'kemi@acme.test', start_date: '2026-09-01' },
          { employee_number: 'QH-902', first_name: 'Dayo', last_name: 'Bak', email: 'dayo@acme.test', start_date: '2026-09-01' },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    const creds = res.json().credentials as { email: string; temporaryPassword?: string }[]
    expect(creds.map((c) => c.email).sort()).toEqual(['dayo@acme.test', 'kemi@acme.test'])
    expect(creds.every((c) => c.temporaryPassword === undefined)).toBe(true)
    expect((await signIn('kemi@acme.test', await mailedPassword('kemi@acme.test'))).statusCode).toBe(200)
  })
})

describe('signing in', () => {
  it('answers identically for unknown account, no password, and wrong password', async () => {
    // Seeded staff have no password yet.
    const noPassword = await signIn('staff@acme.test', 'anything-at-all')
    const unknown = await signIn('nobody@acme.test', 'anything-at-all')
    const wrong = await signIn('bisi@acme.test', 'definitely-wrong')

    for (const r of [noPassword, unknown, wrong]) {
      expect(r.statusCode).toBe(401)
    }
    expect(noPassword.json().message).toBe(unknown.json().message)
    expect(unknown.json().message).toBe(wrong.json().message)
  })

  it('binds the device exactly as the link path does', async () => {
    const reset = await app.inject({
      method: 'POST',
      url: `/v1/admin/employees/${org.employeeId}/reset-password`,
      headers: bearer(hrToken),
    })
    expect(reset.json().temporaryPassword).toBeUndefined()
    const temp = await mailedPassword('staff@acme.test')

    const first = await signIn('staff@acme.test', temp, 'staff-phone-a')
    expect(first.json().deviceReviewRequired).toBe(false)

    // A second device through the password door still needs HR review.
    const second = await signIn('staff@acme.test', temp, 'staff-phone-b')
    expect(second.json().deviceReviewRequired).toBe(true)
  })

  it('rate-limits guessing', async () => {
    let last = 200
    for (let i = 0; i < 12; i += 1) {
      last = (await signIn('bisi@acme.test', `guess-${i}`)).statusCode
    }
    expect(last).toBe(429)
  })
})

describe('the forced change', () => {
  it('clears the flag and the temporary password stops working', async () => {
    const reset = await app.inject({
      method: 'POST',
      url: `/v1/admin/employees/${org.managerEmployeeId}/reset-password`,
      headers: bearer(hrToken),
    })
    const temp = await mailedPassword('manager@acme.test')
    const session = (await signIn('manager@acme.test', temp, 'manager-phone')).json()
    expect(session.mustChangePassword).toBe(true)

    // No current password needed while it is temporary.
    const changed = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/change',
      headers: bearer(session.accessToken),
      payload: { newPassword: 'a long enough new one' },
    })
    expect(changed.statusCode).toBe(204)

    expect((await signIn('manager@acme.test', temp, 'manager-phone')).statusCode).toBe(401)
    const fresh = await signIn('manager@acme.test', 'a long enough new one', 'manager-phone')
    expect(fresh.statusCode).toBe(200)
    expect(fresh.json().mustChangePassword).toBe(false)

    const [row] = await db.withTenant(org.orgId, async (tx) =>
      tx.select({ flag: users.mustChangePassword }).from(users).where(eq(users.id, org.managerUserId)),
    )
    expect(row!.flag).toBe(false)
  })

  it('requires the current password once it is no longer temporary', async () => {
    const session = (await signIn('manager@acme.test', 'a long enough new one', 'manager-phone')).json()

    const without = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/change',
      headers: bearer(session.accessToken),
      payload: { newPassword: 'another long enough one' },
    })
    expect(without.statusCode).toBe(401)

    const withWrong = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/change',
      headers: bearer(session.accessToken),
      payload: { currentPassword: 'nope nope nope', newPassword: 'another long enough one' },
    })
    expect(withWrong.statusCode).toBe(401)

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/change',
      headers: bearer(session.accessToken),
      payload: { currentPassword: 'a long enough new one', newPassword: 'another long enough one' },
    })
    expect(ok.statusCode).toBe(204)
  })

  it('refuses a weak replacement', async () => {
    const session = (await signIn('manager@acme.test', 'another long enough one', 'manager-phone')).json()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/change',
      headers: bearer(session.accessToken),
      payload: { currentPassword: 'another long enough one', newPassword: 'short' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('is reported on /v1/me', async () => {
    const session = (await signIn('manager@acme.test', 'another long enough one', 'manager-phone')).json()
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(session.accessToken) })
    expect(me.json().user.hasPassword).toBe(true)
    expect(me.json().user.mustChangePassword).toBe(false)
  })
})

describe('changing an employee email', () => {
  it('moves the existing login rather than creating a second account', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/employees',
      headers: bearer(hrToken),
      payload: {
        employeeNumber: 'QH-950',
        firstName: 'Tunde',
        lastName: 'Bello',
        email: 'tunde@acme.test',
        startDate: '2026-09-01',
        employmentType: 'full_time',
        status: 'active',
        roles: ['employee'],
      },
    })
    const temp = await mailedPassword('tunde@acme.test')
    const before = await db.lookup.userByEmail('tunde@acme.test')

    const moved = await app.inject({
      method: 'POST',
      url: '/v1/admin/employees',
      headers: bearer(hrToken),
      payload: {
        employeeNumber: 'QH-950',
        firstName: 'Tunde',
        lastName: 'Bello',
        email: 'tunde.bello@gmail.test',
        startDate: '2026-09-01',
        employmentType: 'full_time',
        status: 'active',
        roles: ['employee'],
      },
    })
    expect(moved.statusCode).toBe(201)
    // No new credential: the account moved with the address.
    expect(moved.json().credentialsEmailed).toBe(false)
    const after = await db.lookup.userByEmail('tunde.bello@gmail.test')
    expect(after?.userId).toBe(before?.userId)
    expect(await db.lookup.userByEmail('tunde@acme.test')).toBeNull()
    // And the original temporary password still opens the moved account.
    const back = await signIn('tunde.bello@gmail.test', temp, 'tunde-phone-1')
    expect(back.statusCode, back.body).toBe(200)
  })

  it('refuses an address that belongs to someone else', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/employees',
      headers: bearer(hrToken),
      payload: {
        employeeNumber: 'QH-950',
        firstName: 'Tunde',
        lastName: 'Bello',
        email: 'staff@acme.test',
        startDate: '2026-09-01',
        employmentType: 'full_time',
        status: 'active',
        roles: ['employee'],
      },
    })
    expect(res.statusCode).toBe(409)
  })
})

describe('hiring before the start date', () => {
  it('files the offer letter on the record and asks for it in the welcome', async () => {
    sent.length = 0
    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/employees',
      headers: bearer(hrToken),
      payload: {
        employeeNumber: 'QH-960',
        firstName: 'Sade',
        lastName: 'Bakare',
        email: 'sade@acme.test',
        startDate: '2026-11-01',
        employmentType: 'full_time',
        status: 'active',
        roles: ['employee'],
        offerLetter: {
          filename: 'offer.pdf',
          contentType: 'application/pdf',
          contentBase64: Buffer.from('%PDF-1.4 offer').toString('base64'),
        },
      },
    })
    expect(created.statusCode).toBe(201)
    const temp = await mailedPassword('sade@acme.test')
    const creds = sent.find((m) => m.to === 'sade@acme.test' && m.text.includes(temp))
    expect(creds?.text).toContain('offer letter')

    const session = await signIn('sade@acme.test', temp, 'sade-phone-1')
    const docs = await app.inject({ method: 'GET', url: '/v1/documents', headers: bearer(session.json().accessToken) })
    const letter = docs.json().documents.find((d: { type: string }) => d.type === 'letter')
    expect(letter?.name).toContain('Offer letter')
    expect(letter?.requiresAcknowledgement).toBe(true)
    expect(letter?.acknowledgedAt).toBeNull()
  })
})
