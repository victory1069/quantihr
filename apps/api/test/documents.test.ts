/**
 * Documents and admin-surface positive paths.
 *
 * Every existing test for these routes proves a cross-tenant request is
 * refused (tenant-isolation.test.ts). Nothing exercises the same-tenant,
 * correctly-authorised case actually working and returning the right shape —
 * that's what this file adds.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import type { Database } from '../src/db/client.js'
import {
  attendanceRecords,
  checkinCodes,
  devices,
  documents,
  locations,
  workSchedules,
} from '../src/db/schema.js'
import { signAccessToken } from '../src/lib/tokens.js'
import { bearer, makeDatabase, makeOrg, type TestOrg } from './helpers.js'

let db: Database
let app: FastifyInstance
let org: TestOrg
let hrToken: string

beforeAll(async () => {
  db = await makeDatabase()
  org = await makeOrg(db, 'acme')
  app = await buildServer(db)
  await app.ready()

  hrToken = await signAccessToken({
    userId: org.managerUserId,
    orgId: org.orgId,
    employeeId: org.managerEmployeeId,
    roles: ['employee', 'hr_admin'],
    deviceId: 'test-device-hr',
  })

  // The DOC-03 geofence check-in must not depend on what time of day the
  // suite happens to run (api.test.ts widens the same way, for the same
  // reason).
  await db.withTenant(org.orgId, async (tx) => {
    await tx
      .update(workSchedules)
      .set({
        workingDays: [0, 1, 2, 3, 4, 5, 6],
        checkinWindowStart: '00:00',
        checkinWindowEnd: '23:59',
      })
      .where(eq(workSchedules.id, org.scheduleId))
  })
})

afterAll(async () => {
  await app.close()
  await db.close()
})

beforeEach(async () => {
  await db.withTenant(org.orgId, async (tx) => {
    await tx.delete(documents)
    await tx.delete(devices)
  })
})

const post = (url: string, payload: unknown, token: string) =>
  app.inject({ method: 'POST', url, headers: bearer(token), payload: payload as object })

const get = (url: string, token: string) =>
  app.inject({ method: 'GET', url, headers: bearer(token) })

describe('documents — owned-document round trip', () => {
  it('lists, downloads and acknowledges a document HR uploaded for this employee', async () => {
    const content = Buffer.from('This is your offer letter.').toString('base64')

    const uploaded = await post(
      '/v1/admin/documents',
      {
        employeeId: org.employeeId,
        type: 'letter',
        name: 'Offer letter.pdf',
        contentType: 'application/pdf',
        content,
        requiresAcknowledgement: true,
      },
      hrToken,
    )
    expect(uploaded.statusCode).toBe(201)
    const documentId = uploaded.json().id as string

    // 1. Shows up in the employee's own list, unacknowledged.
    const list = await get('/v1/documents', org.accessToken)
    expect(list.statusCode).toBe(200)
    const entry = list.json().documents.find((d: { id: string }) => d.id === documentId)
    expect(entry).toBeTruthy()
    expect(entry.name).toBe('Offer letter.pdf')
    expect(entry.requiresAcknowledgement).toBe(true)
    expect(entry.acknowledgedAt).toBeNull()
    expect(entry.uploadedByName).toBe('Manager acme')

    // 2. The download URL round-trips the exact bytes that were uploaded —
    // not just "returns some URL", but the URL actually serves this document.
    const urlResponse = await get(`/v1/documents/${documentId}/url`, org.accessToken)
    expect(urlResponse.statusCode).toBe(200)
    const { url, expiresAt } = urlResponse.json()
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now())

    const download = await app.inject({ method: 'GET', url })
    expect(download.statusCode).toBe(200)
    expect(download.body).toBe('This is your offer letter.')

    // 3. Acknowledging flips the flag the employee-facing list reads.
    const ack = await post(`/v1/documents/${documentId}/acknowledge`, {}, org.accessToken)
    expect(ack.statusCode).toBe(204)

    const listAfter = await get('/v1/documents', org.accessToken)
    const entryAfter = listAfter
      .json()
      .documents.find((d: { id: string }) => d.id === documentId)
    expect(entryAfter.acknowledgedAt).not.toBeNull()
  })

  it('lists an org-wide document (no employeeId) alongside personal ones', async () => {
    const uploaded = await post(
      '/v1/admin/documents',
      {
        employeeId: null,
        type: 'policy',
        name: 'Remote work policy.pdf',
        contentType: 'application/pdf',
        content: Buffer.from('Policy text').toString('base64'),
        requiresAcknowledgement: false,
      },
      hrToken,
    )
    expect(uploaded.statusCode).toBe(201)

    const list = await get('/v1/documents', org.accessToken)
    const names = list.json().documents.map((d: { name: string }) => d.name)
    expect(names).toContain('Remote work policy.pdf')
  })
})

describe('admin location CRUD — an employee sees the effect', () => {
  it('widening a geofence lets a previously out-of-range check-in succeed', async () => {
    // 333m from the office fixture (helpers.ts: 6.4281, 3.4219) — outside the
    // default 150m radius, comfortably inside a widened one.
    const nearby = { latitude: 6.4311, longitude: 3.4219, accuracyM: 10 }
    await db.withTenant(org.orgId, async (tx) => {
      await tx.delete(attendanceRecords)
      await tx.delete(checkinCodes)
      await tx.insert(checkinCodes).values({
        orgId: org.orgId,
        locationId: org.locationId,
        code: 'DOC03CD',
        validFrom: new Date(Date.now() - 60_000),
        validUntil: new Date(Date.now() + 600_000),
      })
    })

    const before = await post(
      '/v1/attendance/checkin',
      {
        code: 'DOC03CD',
        ...nearby,
        isMocked: false,
        deviceId: 'test-device-0001',
        clientTimestamp: new Date().toISOString(),
        recordedOffline: false,
      },
      org.accessToken,
    )
    expect(before.statusCode).toBe(422)
    expect(before.json().code).toBe('checkin/outside-geofence')

    const [current] = await db.withTenant(org.orgId, (tx) =>
      tx.select().from(locations).where(eq(locations.id, org.locationId)),
    )
    const updated = await post(
      '/v1/admin/locations',
      {
        id: org.locationId,
        name: current!.name,
        latitude: Number(current!.latitude),
        longitude: Number(current!.longitude),
        geofenceRadiusM: 1000,
      },
      hrToken,
    )
    expect(updated.statusCode).toBe(200)
    expect(updated.json().geofenceRadiusM).toBe(1000)

    const after = await post(
      '/v1/attendance/checkin',
      {
        code: 'DOC03CD',
        ...nearby,
        isMocked: false,
        deviceId: 'test-device-0001',
        clientTimestamp: new Date().toISOString(),
        recordedOffline: false,
      },
      org.accessToken,
    )
    expect(after.statusCode).toBe(201)
  })
})

describe('device approval — actually unblocks the pending device', () => {
  async function seedDevices() {
    await db.withTenant(org.orgId, async (tx) => {
      await tx.insert(devices).values([
        {
          orgId: org.orgId,
          employeeId: org.employeeId,
          deviceId: 'device-first',
          platform: 'ios',
          approved: true,
          lastSeenAt: new Date(),
        },
        {
          orgId: org.orgId,
          employeeId: org.employeeId,
          deviceId: 'device-second',
          platform: 'android',
          approved: false,
          approvalRequestedAt: new Date(),
          lastSeenAt: new Date(),
        },
      ])
    })
  }

  it('moves the device out of the pending queue and marks it approved', async () => {
    await seedDevices()

    const pendingBefore = await get('/v1/admin/devices/pending', hrToken)
    expect(pendingBefore.json().devices.map((d: { deviceId: string }) => d.deviceId)).toEqual([
      'device-second',
    ])

    const approve = await post(
      '/v1/admin/devices/approve',
      { employeeId: org.employeeId, deviceId: 'device-second' },
      hrToken,
    )
    expect(approve.statusCode).toBe(204)

    const pendingAfter = await get('/v1/admin/devices/pending', hrToken)
    expect(pendingAfter.json().devices).toHaveLength(0)

    const rows = await db.withTenant(org.orgId, (tx) =>
      tx.select().from(devices).where(eq(devices.employeeId, org.employeeId)),
    )
    const second = rows.find((d) => d.deviceId === 'device-second')
    const first = rows.find((d) => d.deviceId === 'device-first')
    expect(second?.approved).toBe(true)
    expect(second?.approvalRequestedAt).toBeNull()
    // "One bound device at a time" (routes/admin.ts comment) — approving the
    // new one retires the old one.
    expect(first?.approved).toBe(false)
  })

  it('404s approving a device that never requested review', async () => {
    await seedDevices()

    const approve = await post(
      '/v1/admin/devices/approve',
      { employeeId: org.employeeId, deviceId: 'device-never-seen' },
      hrToken,
    )
    expect(approve.statusCode).toBe(404)
  })
})
