/**
 * Attendance disputes: raise, and a manager's review queue.
 *
 * Raising a dispute (routes/attendance.ts) previously had nowhere to go
 * except a count in a manager's report — there was no way to see the reason
 * or act on one. This file covers the queue and resolve step added
 * alongside it (routes/team.ts), mirroring the meeting-dispute pattern
 * already proven in meetings.test.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import type { Database } from '../src/db/client.js'
import {
  attendanceDisputes,
  attendanceRecords,
  checkinCodes,
  workSchedules,
} from '../src/db/schema.js'
import { bearer, makeDatabase, makeOrg, type TestOrg } from './helpers.js'

let db: Database
let app: FastifyInstance
let org: TestOrg
let other: TestOrg

const AT_OFFICE = { latitude: 6.4281, longitude: 3.4219, accuracyM: 10 }

beforeAll(async () => {
  db = await makeDatabase()
  org = await makeOrg(db, 'acme')
  other = await makeOrg(db, 'globex')
  app = await buildServer(db)
  await app.ready()

  // Same reasoning as api.test.ts: don't let the suite's result depend on
  // what time of day it happens to run.
  for (const target of [org, other]) {
    await db.withTenant(target.orgId, async (tx) => {
      await tx
        .update(workSchedules)
        .set({
          workingDays: [0, 1, 2, 3, 4, 5, 6],
          checkinWindowStart: '00:00',
          checkinWindowEnd: '23:59',
        })
        .where(eq(workSchedules.id, target.scheduleId))
    })
  }
})

afterAll(async () => {
  await app.close()
  await db.close()
})

beforeEach(async () => {
  await db.withTenant(org.orgId, async (tx) => {
    await tx.delete(attendanceDisputes)
    await tx.delete(attendanceRecords)
    await tx.delete(checkinCodes)
    await tx.insert(checkinCodes).values({
      orgId: org.orgId,
      locationId: org.locationId,
      code: 'ATTDIS',
      validFrom: new Date(Date.now() - 60_000),
      validUntil: new Date(Date.now() + 600_000),
    })
  })
})

const post = (url: string, payload: unknown, token: string) =>
  app.inject({ method: 'POST', url, headers: bearer(token), payload: payload as object })

const get = (url: string, token: string) =>
  app.inject({ method: 'GET', url, headers: bearer(token) })

/** A rejected check-in (wrong code) — a real, disputable record. */
async function rejectedCheckin(): Promise<string> {
  const res = await post(
    '/v1/attendance/checkin',
    {
      code: 'WRONG1',
      ...AT_OFFICE,
      isMocked: false,
      deviceId: 'test-device-0001',
      clientTimestamp: new Date().toISOString(),
      recordedOffline: false,
    },
    org.accessToken,
  )
  expect(res.statusCode).toBe(422)
  const [record] = await db.withTenant(org.orgId, (tx) =>
    tx.select().from(attendanceRecords).where(eq(attendanceRecords.employeeId, org.employeeId)),
  )
  expect(record?.status).toBe('rejected')
  return record!.id
}

describe('raising a dispute', () => {
  it('flags the record pending_review and puts it on the manager queue', async () => {
    const recordId = await rejectedCheckin()

    const raised = await post(
      '/v1/attendance/dispute',
      { recordId, reason: 'My GPS was inaccurate — I was actually at the office.' },
      org.accessToken,
    )
    expect(raised.statusCode).toBe(201)

    const [record] = await db.withTenant(org.orgId, (tx) =>
      tx.select().from(attendanceRecords).where(eq(attendanceRecords.id, recordId)),
    )
    expect(record?.status).toBe('pending_review')

    const queue = await get('/v1/team/attendance-disputes', org.managerToken)
    expect(queue.statusCode).toBe(200)
    expect(queue.json().disputes).toHaveLength(1)
    expect(queue.json().disputes[0]).toMatchObject({
      employeeName: 'Staff acme',
      recordStatus: 'pending_review',
    })
  })

  it('refuses a dispute on a record that is not the caller\'s own', async () => {
    const recordId = await rejectedCheckin()

    const raised = await post(
      '/v1/attendance/dispute',
      { recordId, reason: 'This is not even my check-in, but I am trying anyway.' },
      org.managerToken,
    )

    // Not found, not forbidden — the same information-hiding shape as every
    // other "not yours" lookup in this API (documents, devices).
    expect(raised.statusCode).toBe(404)
  })
})

describe('manager review', () => {
  it('upholding corrects the record and closes the dispute', async () => {
    const recordId = await rejectedCheckin()
    const raised = await post(
      '/v1/attendance/dispute',
      { recordId, reason: 'I was at the office the whole time.' },
      org.accessToken,
    )
    const disputeId = raised.json().id as string

    const resolved = await post(
      `/v1/team/attendance-disputes/${disputeId}`,
      { outcome: 'upheld', attendanceStatus: 'present' },
      org.managerToken,
    )
    expect(resolved.statusCode).toBe(200)
    expect(resolved.json()).toMatchObject({ status: 'resolved', outcome: 'upheld' })

    const [record] = await db.withTenant(org.orgId, (tx) =>
      tx.select().from(attendanceRecords).where(eq(attendanceRecords.id, recordId)),
    )
    expect(record?.status).toBe('present')

    const [dispute] = await db.withTenant(org.orgId, (tx) =>
      tx.select().from(attendanceDisputes).where(eq(attendanceDisputes.id, disputeId)),
    )
    expect(dispute?.status).toBe('resolved')
    expect(dispute?.resolvedBy).toBe(org.managerUserId)
  })

  it('dismissing restores the record to what it was before the dispute', async () => {
    const recordId = await rejectedCheckin()
    const raised = await post(
      '/v1/attendance/dispute',
      { recordId, reason: 'I still think this should count.' },
      org.accessToken,
    )
    const disputeId = raised.json().id as string

    const resolved = await post(
      `/v1/team/attendance-disputes/${disputeId}`,
      { outcome: 'dismissed', note: 'Confirmed with the office door log — no entry that day.' },
      org.managerToken,
    )
    expect(resolved.statusCode).toBe(200)

    const [record] = await db.withTenant(org.orgId, (tx) =>
      tx.select().from(attendanceRecords).where(eq(attendanceRecords.id, recordId)),
    )
    // Back to 'rejected' — what it was before the dispute — not stuck in
    // pending_review, and not guessed at as 'present'.
    expect(record?.status).toBe('rejected')

    const queueAfter = await get('/v1/team/attendance-disputes', org.managerToken)
    expect(queueAfter.json().disputes).toHaveLength(0)
  })

  it('a different org\'s manager cannot see or resolve it — RLS, not just the team check', async () => {
    const recordId = await rejectedCheckin()
    const raised = await post(
      '/v1/attendance/dispute',
      { recordId, reason: 'Reason enough to pass validation.' },
      org.accessToken,
    )
    const disputeId = raised.json().id as string

    // Cross-tenant, so RLS hides the row before the team-membership check
    // ever runs — the same "not found, not forbidden" shape as every other
    // cross-tenant lookup in this API (documents, devices).
    const resolved = await post(
      `/v1/team/attendance-disputes/${disputeId}`,
      { outcome: 'dismissed' },
      other.managerToken,
    )
    expect(resolved.statusCode).toBe(404)

    const queue = await get('/v1/team/attendance-disputes', other.managerToken)
    expect(queue.json().disputes).toHaveLength(0)
  })

  it('refuses to resolve an already-resolved dispute', async () => {
    const recordId = await rejectedCheckin()
    const raised = await post(
      '/v1/attendance/dispute',
      { recordId, reason: 'One more time, for good measure.' },
      org.accessToken,
    )
    const disputeId = raised.json().id as string

    await post(
      `/v1/team/attendance-disputes/${disputeId}`,
      { outcome: 'dismissed' },
      org.managerToken,
    )
    const second = await post(
      `/v1/team/attendance-disputes/${disputeId}`,
      { outcome: 'upheld', attendanceStatus: 'present' },
      org.managerToken,
    )

    expect(second.statusCode).toBe(409)
    expect(second.json().code).toBe('attendance/dispute-not-open')
  })

  it('requires attendanceStatus to uphold a dispute', async () => {
    const recordId = await rejectedCheckin()
    const raised = await post(
      '/v1/attendance/dispute',
      { recordId, reason: 'Missing the correction on purpose, for this test.' },
      org.accessToken,
    )
    const disputeId = raised.json().id as string

    const resolved = await post(
      `/v1/team/attendance-disputes/${disputeId}`,
      { outcome: 'upheld' },
      org.managerToken,
    )
    // This API's convention: a failed Zod parse is 422, not 400
    // (lib/errors.ts).
    expect(resolved.statusCode).toBe(422)
    expect(resolved.json().code).toBe('common/validation-failed')
  })
})
