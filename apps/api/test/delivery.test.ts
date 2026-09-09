/**
 * Email and SMS delivery.
 *
 * Two of these assertions are security properties rather than plumbing checks,
 * and they are the reason this file exists:
 *
 *   - a magic-link request must answer identically for a known and an unknown
 *     address, *including* when the mail provider is down, or the endpoint
 *     becomes a way to enumerate who works at the company;
 *   - the code must never be sent to a destination the caller supplied.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import type { Database } from '../src/db/client.js'
import { employees } from '../src/db/schema.js'
import { setEmailDriver, type EmailMessage } from '../src/lib/email.js'
import { normalisePhone, setSmsDriver, type SmsMessage } from '../src/lib/sms.js'
import { makeDatabase, makeOrg, type TestOrg } from './helpers.js'

let db: Database
let app: FastifyInstance
let org: TestOrg

const emails: EmailMessage[] = []
const texts: SmsMessage[] = []

function captureEmail(fail = false): void {
  setEmailDriver({
    name: 'test',
    async send(message) {
      if (fail) throw new Error('provider unavailable')
      emails.push(message)
      return { messageId: 'test-message-id', driver: 'test' }
    },
  })
}

function captureSms(fail = false): void {
  setSmsDriver({
    name: 'test',
    async send(message) {
      if (fail) throw new Error('provider unavailable')
      texts.push(message)
      return { messageId: 'test-sms-id', driver: 'test' }
    },
  })
}

beforeAll(async () => {
  db = await makeDatabase()
  org = await makeOrg(db, 'acme')
  app = await buildServer(db)
  await app.ready()

  await db.withTenant(org.orgId, async (tx) => {
    await tx
      .update(employees)
      .set({ phone: '08031234567' })
      .where(eq(employees.id, org.employeeId))
  })
})

afterAll(async () => {
  setEmailDriver(null)
  setSmsDriver(null)
  await app.close()
  await db.close()
})

afterEach(() => {
  emails.length = 0
  texts.length = 0
})

describe('magic link email', () => {
  it('sends a link to a known address', async () => {
    captureEmail()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link',
      payload: { email: 'staff@acme.test' },
    })

    expect(response.statusCode).toBe(200)
    expect(emails).toHaveLength(1)
    expect(emails[0]!.to).toBe('staff@acme.test')
    expect(emails[0]!.subject).toContain('sign-in link')
  })

  it('carries a working token in both the html and the text part', async () => {
    captureEmail()

    await app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link',
      payload: { email: 'staff@acme.test' },
    })

    const token = /token=([A-Za-z0-9_-]+)/.exec(emails[0]!.text)?.[1]
    expect(token).toBeTruthy()
    // A text/html-only message with one link is a spam-filter signature, so
    // both parts must actually carry the link.
    expect(emails[0]!.html).toContain(token!)

    const verify = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify',
      payload: { token, deviceId: 'test-device-mail', deviceName: 'Test' },
    })

    expect(verify.statusCode).toBe(200)
  })

  it('sends nothing for an address that is not an employee', async () => {
    captureEmail()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link',
      payload: { email: 'nobody@example.com' },
    })

    expect(response.statusCode).toBe(200)
    expect(emails).toHaveLength(0)
  })

  it('answers identically when the provider is down', async () => {
    captureEmail()
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link',
      payload: { email: 'nobody@example.com' },
    })

    captureEmail(true)
    const knownButBroken = await app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link',
      payload: { email: 'staff@acme.test' },
    })

    // If a failed send surfaced as a 5xx, the pair of responses would tell an
    // attacker which addresses belong to employees.
    expect(knownButBroken.statusCode).toBe(unknown.statusCode)
    expect(knownButBroken.json().message).toBe(unknown.json().message)
  })
})

describe('verification sms', () => {
  it('sends the code to the number on the HR record', async () => {
    captureSms()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { email: 'staff@acme.test' },
    })

    expect(response.statusCode).toBe(200)
    expect(texts).toHaveLength(1)
    expect(texts[0]!.to).toBe('08031234567')
    expect(texts[0]!.body).toMatch(/\d{6}/)
  })

  it('never sends to a destination the caller supplied', async () => {
    captureSms()

    await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      // The route takes only an email; this is here to prove that adding a
      // phone to the payload cannot redirect the message.
      payload: { email: 'staff@acme.test', phone: '08099999999' },
    })

    expect(texts[0]!.to).toBe('08031234567')
  })

  it('carries no link', async () => {
    captureSms()
    await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { email: 'staff@acme.test' },
    })

    // An SMS with a link in it is the shape of every phishing message people
    // are told to ignore.
    expect(texts[0]!.body).not.toMatch(/https?:\/\//)
  })

  it('tells the user to fall back to email when the provider fails', async () => {
    captureSms(true)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { email: 'staff@acme.test' },
    })

    // Unlike the magic-link endpoint this one has already confirmed membership,
    // so there is no enumeration left to protect and a real error is the more
    // useful answer.
    expect(response.statusCode).toBe(502)
    expect(response.json().message).toContain('email link')
  })

  it('sends nothing for an unknown address', async () => {
    captureSms()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { email: 'nobody@example.com' },
    })

    expect(response.statusCode).toBe(200)
    expect(texts).toHaveLength(0)
  })
})

describe('phone normalisation', () => {
  it('turns a Nigerian local number into international format', () => {
    expect(normalisePhone('08031234567')).toBe('2348031234567')
  })

  it('accepts numbers people actually type', () => {
    expect(normalisePhone('+234 803 123 4567')).toBe('2348031234567')
    expect(normalisePhone('234-803-123-4567')).toBe('2348031234567')
    expect(normalisePhone('0803 123 4567')).toBe('2348031234567')
    expect(normalisePhone('00234 8031234567')).toBe('2348031234567')
  })

  it('leaves an already-international number alone', () => {
    expect(normalisePhone('2348031234567')).toBe('2348031234567')
  })

  it('honours a different default country', () => {
    expect(normalisePhone('07700900123', '44')).toBe('447700900123')
  })
})
