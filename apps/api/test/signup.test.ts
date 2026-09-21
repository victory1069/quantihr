/**
 * Self-serve signup, and the wizard as a gate.
 *
 * The company proves it owns its hr@ address with a code, gets an
 * organisation, and then cannot reach the dashboard until the org can run:
 * a location, a leave type, a manager, at least one other person, and
 * everyone reporting to someone.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import type { Database } from '../src/db/client.js'
import { setEmailDriver, type EmailMessage } from '../src/lib/email.js'
import { bearer, makeDatabase } from './helpers.js'

let db: Database
let app: FastifyInstance
const sent: EmailMessage[] = []

beforeAll(async () => {
  setEmailDriver({
    name: 'test',
    async send(m) {
      sent.push(m)
      return { messageId: 'x', driver: 'test' }
    },
  })
  db = await makeDatabase()
  app = await buildServer(db)
  await app.ready()
})

afterAll(async () => {
  setEmailDriver(null)
  await app.close()
  await db.close()
})

const start = (overrides: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/signup/start',
    payload: {
      orgName: 'Northbridge Logistics',
      firstName: 'Ify',
      lastName: 'Okon',
      email: 'hr@northbridge.test',
      password: 'a properly long password',
      ...overrides,
    },
  })

let signupId: string
let code: string
let token: string
let employeeIds: Record<string, string> = {}

describe('starting a signup', () => {
  it('refuses an address that is not the HR mailbox', async () => {
    const res = await start({ email: 'ify@northbridge.test' })
    expect(res.statusCode).toBe(422)
    expect(res.json().message).toContain('hr')
  })

  it('accepts any address whose local part starts with hr', async () => {
    for (const email of ['hr@a.test', 'hr.team@a.test', 'hrdesk@a.test']) {
      const res = await start({ email, orgName: `Org ${email}` })
      expect(res.statusCode, email).toBe(201)
    }
  })

  it('refuses a weak password before sending anything', async () => {
    sent.length = 0
    const res = await start({ password: 'short' })
    expect(res.statusCode).toBe(422)
    expect(sent).toHaveLength(0)
  })

  it('sends a six-digit code to the HR address', async () => {
    sent.length = 0
    const res = await start()
    expect(res.statusCode).toBe(201)
    signupId = res.json().signupId
    code = res.json().devCode
    expect(code).toMatch(/^\d{6}$/)
    expect(sent[0]!.to).toBe('hr@northbridge.test')
    expect(sent[0]!.subject).toContain(code)
    expect(sent[0]!.text).toContain('Northbridge Logistics')
  })
})

describe('verifying', () => {
  it('counts wrong codes and says how many tries are left', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/signup/verify',
      payload: { signupId, code: code === '000000' ? '000001' : '000000' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().message).toContain('4 tries left')
  })

  it('creates the organisation and its HR admin on the right code', async () => {
    sent.length = 0
    const res = await app.inject({ method: 'POST', url: '/v1/signup/verify', payload: { signupId, code } })
    expect(res.statusCode).toBe(201)
    expect(res.json().organisation.name).toBe('Northbridge Logistics')

    // The welcome mail follows the reply; give it a tick.
    await new Promise((r) => setTimeout(r, 20))
    expect(sent.some((m) => m.subject.includes('is set up'))).toBe(true)

    // The password they chose works, and nothing forces a change.
    const session = await app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      payload: {
        email: 'hr@northbridge.test',
        password: 'a properly long password',
        deviceId: 'signup-test-device',
        platform: 'web',
      },
    })
    expect(session.statusCode).toBe(200)
    expect(session.json().mustChangePassword).toBe(false)
    token = session.json().accessToken
  })

  it('cannot be verified twice', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/signup/verify', payload: { signupId, code } })
    expect(res.statusCode).toBe(409)
  })
})

describe('the wizard as a gate', () => {
  const employee = (
    number: string,
    first: string,
    roles: string[],
    managerId: string | null = null,
  ) => ({
    employeeNumber: number,
    firstName: first,
    lastName: 'Test',
    email: `${first.toLowerCase()}@northbridge.test`,
    startDate: '2026-09-01',
    employmentType: 'full_time',
    status: 'active',
    roles,
    managerId,
  })

  it('names everything still missing, and refuses to complete', async () => {
    const status = await app.inject({ method: 'GET', url: '/v1/admin/onboarding', headers: bearer(token) })
    expect(status.statusCode).toBe(200)
    expect(status.json().steps.map((s: { step: string }) => s.step)).toEqual([
      'basics', 'leave', 'handbook', 'managers', 'departments', 'organogram', 'team',
    ])
    const codes = status.json().missing.map((m: { code: string }) => m.code)
    expect(codes).toEqual(expect.arrayContaining(['no_location', 'no_leave_type', 'no_staff', 'no_manager']))

    const complete = await app.inject({ method: 'POST', url: '/v1/admin/onboarding/complete', headers: bearer(token) })
    expect(complete.statusCode).toBe(422)
    expect(complete.json().details.missing.length).toBeGreaterThanOrEqual(4)
  })

  it('clears the basics and leave requirements as they are met', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/admin/locations',
      headers: bearer(token),
      payload: { name: 'Apapa depot', latitude: 6.45, longitude: 3.36, geofenceRadiusM: 150 },
    })
    await app.inject({
      method: 'POST',
      url: '/v1/admin/leave-types',
      headers: bearer(token),
      payload: {
        name: 'Annual leave',
        accrualMethod: 'annual_fixed',
        accrualRate: 20,
        maxBalance: null,
        carryoverCap: null,
        carryoverExpiryMonths: null,
        minNoticeDays: null,
        colour: '#00D3FF',
      },
    })
    const status = await app.inject({ method: 'GET', url: '/v1/admin/onboarding', headers: bearer(token) })
    const codes = status.json().missing.map((m: { code: string }) => m.code)
    expect(codes).not.toContain('no_location')
    expect(codes).not.toContain('no_leave_type')
  })

  it('needs a manager, then an organogram with nobody unassigned', async () => {
    const manager = await app.inject({
      method: 'POST',
      url: '/v1/admin/employees',
      headers: bearer(token),
      payload: employee('NB-002', 'Chidi', ['employee', 'manager']),
    })
    expect(manager.statusCode).toBe(201)
    employeeIds.chidi = manager.json().id

    // A manager with no manager of their own still needs one — the org head.
    let status = await app.inject({ method: 'GET', url: '/v1/admin/onboarding', headers: bearer(token) })
    let codes = status.json().missing.map((m: { code: string }) => m.code)
    expect(codes).not.toContain('no_manager')
    expect(codes).not.toContain('no_staff')
    expect(codes).toContain('unassigned')

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) })
    const adminId = me.json().employee.id

    await app.inject({
      method: 'POST',
      url: '/v1/admin/employees',
      headers: bearer(token),
      payload: employee('NB-002', 'Chidi', ['employee', 'manager'], adminId),
    })
    const amara = await app.inject({
      method: 'POST',
      url: '/v1/admin/employees',
      headers: bearer(token),
      payload: employee('NB-003', 'Amara', ['employee'], employeeIds.chidi!),
    })
    expect(amara.statusCode).toBe(201)

    status = await app.inject({ method: 'GET', url: '/v1/admin/onboarding', headers: bearer(token) })
    codes = status.json().missing.map((m: { code: string }) => m.code)
    expect(codes).toEqual([])
    expect(status.json().facts.managers).toBe(1)
    expect(status.json().facts.unassigned).toBe(0)
  })

  it('completes once everything is in place', async () => {
    const complete = await app.inject({ method: 'POST', url: '/v1/admin/onboarding/complete', headers: bearer(token) })
    expect(complete.statusCode).toBe(200)
    expect(complete.json().completedAt).toBeTruthy()
  })
})
