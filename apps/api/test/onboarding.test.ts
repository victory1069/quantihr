/**
 * Provisioning and the setup wizard.
 *
 * The provisioning test that matters is the last one: an org created through
 * this path has to be as isolated from every other org as one created by the
 * seed. Provisioning inserts before a tenant JWT exists, and that is exactly
 * where an RLS mistake would live.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import type { Database } from '../src/db/client.js'
import { employees, organisations } from '../src/db/schema.js'
import { resetEnvCache } from '../src/lib/env.js'
import { setEmailDriver, type EmailMessage } from '../src/lib/email.js'
import { hashToken } from '../src/lib/tokens.js'
import { bearer, makeDatabase, makeOrg, type TestOrg } from './helpers.js'

const PLATFORM_KEY = 'test-platform-key-that-is-long-enough-to-pass-validation'

let db: Database
let app: FastifyInstance
let existing: TestOrg
const sent: EmailMessage[] = []

beforeAll(async () => {
  process.env.PLATFORM_API_KEY = PLATFORM_KEY
  resetEnvCache()
  setEmailDriver({
    name: 'test',
    async send(message) {
      sent.push(message)
      return { messageId: 'welcome-1', driver: 'test' }
    },
  })

  db = await makeDatabase()
  existing = await makeOrg(db, 'acme')
  app = await buildServer(db)
  await app.ready()
})

afterAll(async () => {
  setEmailDriver(null)
  delete process.env.PLATFORM_API_KEY
  resetEnvCache()
  await app.close()
  await db.close()
})

const provision = (body: object, key: string | null = PLATFORM_KEY) =>
  app.inject({
    method: 'POST',
    url: '/v1/platform/organisations',
    headers: key ? { 'x-platform-key': key } : {},
    payload: body,
  })

const NEW_ORG = {
  name: 'Bello Logistics',
  admin: { firstName: 'Fatima', lastName: 'Bello', email: 'fatima@bello.test' },
}

describe('provisioning', () => {
  it('refuses without the platform key', async () => {
    expect((await provision(NEW_ORG, null)).statusCode).toBe(401)
    expect((await provision(NEW_ORG, 'wrong-key-of-the-same-general-length-xxxxxxx')).statusCode).toBe(401)
  })

  it('creates the org, its first HR admin, and sends the welcome link', async () => {
    sent.length = 0
    const response = await provision(NEW_ORG)

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.organisation.name).toBe('Bello Logistics')
    expect(body.admin.email).toBe('fatima@bello.test')
    expect(body.signInLink).toMatch(/token=/)

    // The welcome email carries the same link the response does.
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('fatima@bello.test')
    expect(sent[0]!.text).toContain(body.signInLink)

    // And the link actually signs them in as an HR admin.
    const token = /token=([A-Za-z0-9_-]+)/.exec(body.signInLink)![1]
    const verify = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify',
      payload: { token, deviceId: 'fatima-phone', deviceName: 'Test' },
    })
    expect(verify.statusCode).toBe(200)

    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(verify.json().accessToken),
    })
    expect(me.json().roles).toEqual(
      expect.arrayContaining(['employee', 'hr_admin', 'owner']),
    )
  })

  it('refuses an email that already has an account anywhere', async () => {
    const response = await provision({
      name: 'Another Co',
      admin: { firstName: 'X', lastName: 'Y', email: 'staff@acme.test' },
    })
    expect(response.statusCode).toBe(409)
  })

  it('leaves a provisioned org fully isolated from every other org', async () => {
    const response = await provision({
      name: 'Isolated Ltd',
      admin: { firstName: 'Ike', lastName: 'Obi', email: 'ike@isolated.test' },
    })
    const orgId = response.json().organisation.id as string

    // From inside the new org: exactly one employee, the admin.
    const inside = await db.withTenant(orgId, async (tx) => tx.select().from(employees))
    expect(inside).toHaveLength(1)
    expect(inside[0]!.email).toBe('ike@isolated.test')

    // From inside the pre-existing org: none of the new org's rows are visible,
    // and its organisation row is not either.
    const fromAcme = await db.withTenant(existing.orgId, async (tx) => ({
      employees: await tx.select().from(employees),
      orgs: await tx.select().from(organisations).where(eq(organisations.id, orgId)),
    }))
    expect(fromAcme.employees.every((e) => e.orgId === existing.orgId)).toBe(true)
    expect(fromAcme.orgs).toHaveLength(0)
  })

  it('stores the magic link hashed, never in the clear', async () => {
    const response = await provision({
      name: 'Hash Check',
      admin: { firstName: 'H', lastName: 'C', email: 'hash@check.test' },
    })
    const token = /token=([A-Za-z0-9_-]+)/.exec(response.json().signInLink)![1]!
    const found = await db.lookup.magicLink(hashToken(token))
    expect(found).toBeTruthy()
    expect(await db.lookup.magicLink(token)).toBeNull()
  })
})

describe('setup wizard state', () => {
  let hr: string

  beforeAll(async () => {
    const response = await provision({
      name: 'Wizard Co',
      admin: { firstName: 'W', lastName: 'Z', email: 'wz@wizard.test' },
    })
    const token = /token=([A-Za-z0-9_-]+)/.exec(response.json().signInLink)![1]
    const verify = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify',
      payload: { token, deviceId: 'wz-phone', deviceName: 'Test' },
    })
    hr = verify.json().accessToken
  })

  it('starts with nothing done and the admin not counted as staff', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/onboarding',
      headers: bearer(hr),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.completedAt).toBeNull()
    expect(body.steps.every((s: { done: boolean }) => !s.done)).toBe(true)
    expect(body.facts.staff).toBe(0)
    expect(body.facts.locations).toBe(0)
  })

  it('records steps as the HR lead moves past them', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/admin/onboarding/steps/basics',
      headers: bearer(hr),
    })
    // Marking it twice is harmless — the wizard may resubmit on a refresh.
    await app.inject({
      method: 'POST',
      url: '/v1/admin/onboarding/steps/basics',
      headers: bearer(hr),
    })

    const state = await app.inject({
      method: 'GET',
      url: '/v1/admin/onboarding',
      headers: bearer(hr),
    })
    const steps = state.json().steps as { step: string; done: boolean }[]
    expect(steps.find((s) => s.step === 'basics')?.done).toBe(true)
    expect(steps.find((s) => s.step === 'leave')?.done).toBe(false)
  })

  it('rejects a step that is not part of the wizard', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/onboarding/steps/payroll',
      headers: bearer(hr),
    })
    expect(response.statusCode).toBe(422)
  })

  it('completes once, and can be explicitly reopened', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/admin/onboarding/complete',
      headers: bearer(hr),
    })
    const second = await app.inject({
      method: 'POST',
      url: '/v1/admin/onboarding/complete',
      headers: bearer(hr),
    })
    // Idempotent: the timestamp from the first completion is what sticks.
    expect(first.json().completedAt).toBe(second.json().completedAt)

    await app.inject({ method: 'POST', url: '/v1/admin/onboarding/reopen', headers: bearer(hr) })
    const state = await app.inject({
      method: 'GET',
      url: '/v1/admin/onboarding',
      headers: bearer(hr),
    })
    expect(state.json().completedAt).toBeNull()
  })

  it('is HR-only', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/onboarding',
      headers: bearer(existing.managerToken),
    })
    expect(response.statusCode).toBe(403)
  })
})
