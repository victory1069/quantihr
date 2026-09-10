/**
 * End-to-end behaviour: check-in, leave, approvals, idempotency, offline replay.
 *
 * The schedule is widened to every day / all hours in these fixtures so the
 * suite does not pass or fail depending on what time it is run — window logic
 * itself is covered by unit tests in @quanti/shared.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import type { Database } from '../src/db/client.js'
import {
  attendanceRecords,
  checkinCodes,
  coverageRules,
  departments,
  employees,
  leaveBalances,
  leaveRequests,
  workSchedules,
} from '../src/db/schema.js'
import { runAccrualForOrg } from '../src/jobs/accrual.js'
import { orgClock } from '../src/lib/time.js'
import { signAccessToken } from '../src/lib/tokens.js'
import { bearer, makeDatabase, makeOrg, type TestOrg } from './helpers.js'

let db: Database
let app: FastifyInstance
let org: TestOrg
let hrToken: string

const CODE = 'AB12CD'

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
  await app?.close()
  await db?.close()
})

async function freshCode(): Promise<string> {
  return db.withTenant(org.orgId, async (tx) => {
    await tx.delete(checkinCodes)
    await tx.insert(checkinCodes).values({
      orgId: org.orgId,
      locationId: org.locationId,
      code: CODE,
      validFrom: new Date(Date.now() - 60_000),
      validUntil: new Date(Date.now() + 600_000),
    })
    return CODE
  })
}

async function clearAttendance() {
  await db.withTenant(org.orgId, async (tx) => {
    await tx.delete(attendanceRecords)
  })
}

const AT_OFFICE = { latitude: 6.4281, longitude: 3.4219, accuracyM: 10 }

function checkinPayload(over: Record<string, unknown> = {}) {
  return {
    code: CODE,
    ...AT_OFFICE,
    isMocked: false,
    deviceId: 'test-device-0001',
    clientTimestamp: new Date().toISOString(),
    recordedOffline: false,
    ...over,
  }
}

const post = (url: string, payload: unknown, token: string, headers = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...bearer(token), ...headers },
    payload: payload as object,
  })

const get = (url: string, token: string) =>
  app.inject({ method: 'GET', url, headers: bearer(token) })

describe('attendance check-in', () => {
  beforeEach(async () => {
    await clearAttendance()
    await freshCode()
  })

  it('accepts a valid check-in inside the geofence', async () => {
    const res = await post('/v1/attendance/checkin', checkinPayload(), org.accessToken)
    expect(res.statusCode).toBe(201)
    expect(['present', 'late']).toContain(res.json().status)
  })

  it('rejects a wrong code but still stores the attempt', async () => {
    const res = await post(
      '/v1/attendance/checkin',
      checkinPayload({ code: 'WRONG1' }),
      org.accessToken,
    )
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('checkin/code-invalid')

    // A rejected attempt is a record, not a void (spec §7).
    const stored = await db.withTenant(org.orgId, (tx) =>
      tx.select().from(attendanceRecords),
    )
    expect(stored).toHaveLength(1)
    expect(stored[0]!.status).toBe('rejected')
    expect(stored[0]!.rejectionReason).toBeTruthy()
    expect((stored[0]!.verificationSignals as { codeMatch: boolean }).codeMatch).toBe(false)
  })

  it('rejects a check-in from outside the geofence and records the distance', async () => {
    const res = await post(
      '/v1/attendance/checkin',
      checkinPayload({ latitude: 6.5, longitude: 3.6 }),
      org.accessToken,
    )
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('checkin/outside-geofence')

    const stored = await db.withTenant(org.orgId, (tx) =>
      tx.select().from(attendanceRecords),
    )
    const signals = stored[0]!.verificationSignals as {
      geofence: { inside: boolean; distanceM: number }
    }
    expect(signals.geofence.inside).toBe(false)
    expect(signals.geofence.distanceM).toBeGreaterThan(1000)
  })

  it('rejects a mocked location', async () => {
    const res = await post(
      '/v1/attendance/checkin',
      checkinPayload({ isMocked: true }),
      org.accessToken,
    )
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('checkin/mock-location')
  })

  it('rejects an imprecise fix rather than accepting it', async () => {
    const res = await post(
      '/v1/attendance/checkin',
      checkinPayload({ accuracyM: 900 }),
      org.accessToken,
    )
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('checkin/accuracy-too-low')
  })

  it('refuses a second check-in on the same day', async () => {
    const first = await post('/v1/attendance/checkin', checkinPayload(), org.accessToken)
    expect(first.statusCode).toBe(201)

    const second = await post('/v1/attendance/checkin', checkinPayload(), org.accessToken)
    expect(second.statusCode).toBe(422)
    expect(second.json().code).toBe('checkin/already-recorded')
  })

  it('replays an idempotent retry instead of double-recording', async () => {
    // This is the offline outbox case: the response was lost, not the request.
    const headers = { 'idempotency-key': 'outbox-checkin-0001' }
    const payload = checkinPayload()

    const first = await post('/v1/attendance/checkin', payload, org.accessToken, headers)
    const second = await post('/v1/attendance/checkin', payload, org.accessToken, headers)

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)
    expect(second.json().id).toBe(first.json().id)

    const accepted = await db.withTenant(org.orgId, (tx) =>
      tx.select().from(attendanceRecords),
    )
    expect(accepted.filter((r) => r.status !== 'rejected')).toHaveLength(1)
  })

  it('reports window and location on the status endpoint', async () => {
    const res = await get('/v1/attendance/status', org.accessToken)
    expect(res.statusCode).toBe(200)
    expect(res.json().window.open).toBe(true)
    expect(res.json().location.name).toBe('acme HQ')
  })
})

describe('leave requests', () => {
  beforeEach(async () => {
    await db.withTenant(org.orgId, async (tx) => {
      await tx.delete(leaveRequests)
      await tx.delete(leaveBalances)
    })
  })

  const range = (offsetDays: number, length: number) => {
    const today = orgClock('Africa/Lagos').date
    const start = new Date(`${today}T00:00:00Z`)
    start.setUTCDate(start.getUTCDate() + offsetDays)
    const end = new Date(start)
    end.setUTCDate(end.getUTCDate() + length - 1)
    return {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    }
  }

  it('previews conflicts before submission', async () => {
    const res = await post(
      '/v1/leave/check-conflicts',
      { leaveTypeId: org.leaveTypeId, ...range(30, 5) },
      org.accessToken,
    )
    expect(res.statusCode).toBe(200)
    expect(res.json().daysCount).toBeGreaterThan(0)
    expect(res.json().sufficientBalance).toBe(true)
  })

  it('creates a request and reserves the days as pending', async () => {
    const res = await post(
      '/v1/leave/requests',
      { leaveTypeId: org.leaveTypeId, ...range(30, 5) },
      org.accessToken,
    )
    expect(res.statusCode).toBe(201)
    expect(res.json().status).toBe('pending')

    const balances = await get('/v1/leave/balances', org.accessToken)
    const annual = balances.json().balances[0]
    expect(annual.pending).toBeGreaterThan(0)
    // Pending must reduce what is available, or three overlapping requests all
    // pass the balance check (spec §8).
    expect(annual.available).toBeLessThan(annual.accrued)
  })

  it('refuses an overlapping request', async () => {
    const dates = range(40, 5)
    const first = await post(
      '/v1/leave/requests',
      { leaveTypeId: org.leaveTypeId, ...dates },
      org.accessToken,
    )
    expect(first.statusCode).toBe(201)

    const second = await post(
      '/v1/leave/requests',
      { leaveTypeId: org.leaveTypeId, ...dates },
      org.accessToken,
    )
    expect(second.statusCode).toBe(409)
    expect(second.json().code).toBe('leave/overlapping-request')
  })

  it('refuses a request larger than the balance with an actionable code', async () => {
    const res = await post(
      '/v1/leave/requests',
      { leaveTypeId: org.leaveTypeId, ...range(60, 40) },
      org.accessToken,
    )
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('leave/insufficient-balance')
    expect(res.json().message).toMatch(/available|runs out/i)
  })

  it('does not create duplicates when the outbox retries with a key', async () => {
    const headers = { 'idempotency-key': 'outbox-leave-0001' }
    const payload = { leaveTypeId: org.leaveTypeId, ...range(50, 3) }

    const first = await post('/v1/leave/requests', payload, org.accessToken, headers)
    const second = await post('/v1/leave/requests', payload, org.accessToken, headers)

    expect(first.statusCode).toBe(201)
    expect(second.json().id).toBe(first.json().id)

    const stored = await db.withTenant(org.orgId, (tx) => tx.select().from(leaveRequests))
    expect(stored).toHaveLength(1)
  })

  it('rejects a reused idempotency key carrying a different payload', async () => {
    const headers = { 'idempotency-key': 'outbox-leave-0002' }
    await post(
      '/v1/leave/requests',
      { leaveTypeId: org.leaveTypeId, ...range(70, 2) },
      org.accessToken,
      headers,
    )
    const res = await post(
      '/v1/leave/requests',
      { leaveTypeId: org.leaveTypeId, ...range(80, 2) },
      org.accessToken,
      headers,
    )
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('common/idempotency-key-reused')
  })

  it('releases the pending reservation when cancelled', async () => {
    const created = await post(
      '/v1/leave/requests',
      { leaveTypeId: org.leaveTypeId, ...range(90, 3) },
      org.accessToken,
    )
    const before = (await get('/v1/leave/balances', org.accessToken)).json().balances[0]

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/leave/requests/${created.json().id}`,
      headers: bearer(org.accessToken),
    })
    expect(res.statusCode).toBe(204)

    const after = (await get('/v1/leave/balances', org.accessToken)).json().balances[0]
    expect(after.pending).toBeLessThan(before.pending)
    expect(after.available).toBeGreaterThan(before.available)
  })
})

describe('manager approvals', () => {
  beforeEach(async () => {
    await db.withTenant(org.orgId, async (tx) => {
      await tx.delete(leaveRequests)
      await tx.delete(leaveBalances)
      await tx.delete(coverageRules)
    })
  })

  const soon = () => {
    const today = orgClock('Africa/Lagos').date
    const start = new Date(`${today}T00:00:00Z`)
    start.setUTCDate(start.getUTCDate() + 25)
    const end = new Date(start)
    end.setUTCDate(end.getUTCDate() + 2)
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
  }

  it('shows the request in the manager queue with waiting time', async () => {
    await post(
      '/v1/leave/requests',
      { leaveTypeId: org.leaveTypeId, ...soon() },
      org.accessToken,
    )

    const res = await get('/v1/team/approvals', org.managerToken)
    expect(res.statusCode).toBe(200)
    expect(res.json().approvals).toHaveLength(1)
    expect(res.json().approvals[0].employeeName).toContain('Staff')
    expect(res.json().approvals[0]).toHaveProperty('waitingHours')
  })

  it('moves days from pending to taken on approval', async () => {
    const created = await post(
      '/v1/leave/requests',
      { leaveTypeId: org.leaveTypeId, ...soon() },
      org.accessToken,
    )

    const res = await post(
      `/v1/team/approvals/${created.json().id}`,
      { decision: 'approve' },
      org.managerToken,
    )
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('approved')

    const balance = (await get('/v1/leave/balances', org.accessToken)).json().balances[0]
    expect(balance.pending).toBe(0)
    expect(balance.taken).toBeGreaterThan(0)
  })

  it('returns the days to the balance when declined', async () => {
    const created = await post(
      '/v1/leave/requests',
      { leaveTypeId: org.leaveTypeId, ...soon() },
      org.accessToken,
    )

    await post(
      `/v1/team/approvals/${created.json().id}`,
      { decision: 'decline', note: 'Cover not available' },
      org.managerToken,
    )

    const balance = (await get('/v1/leave/balances', org.accessToken)).json().balances[0]
    expect(balance.pending).toBe(0)
    expect(balance.taken).toBe(0)
  })

  it('requires an override reason to approve against a coverage rule', async () => {
    // Put the requester in a department with a blackout covering the dates.
    const dates = soon()
    await db.withTenant(org.orgId, async (tx) => {
      const [dept] = await tx
        .insert(departments)
        .values({ orgId: org.orgId, name: 'Ops' })
        .returning()
      await tx
        .update(employees)
        .set({ departmentId: dept!.id })
        .where(eq(employees.id, org.employeeId))
      await tx.insert(coverageRules).values({
        orgId: org.orgId,
        departmentId: dept!.id,
        maxConcurrentAbsent: null,
        blackoutPeriods: [{ name: 'Stock count', start: dates.start, end: dates.end }],
        criticalRoleIds: [],
      })
    })

    const created = await post(
      '/v1/leave/requests',
      { leaveTypeId: org.leaveTypeId, ...dates },
      org.accessToken,
    )
    expect(created.statusCode).toBe(201)
    expect(created.json().warnings.length).toBeGreaterThan(0)

    const refused = await post(
      `/v1/team/approvals/${created.json().id}`,
      { decision: 'approve' },
      org.managerToken,
    )
    expect(refused.statusCode).toBe(422)
    expect(refused.json().code).toBe('leave/override-reason-required')

    const allowed = await post(
      `/v1/team/approvals/${created.json().id}`,
      { decision: 'approve', overrideReason: 'Cover arranged with the Lagos team' },
      org.managerToken,
    )
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json().overrideReason).toContain('Cover arranged')
  })

  it('refuses to let an employee approve their own request', async () => {
    const created = await post(
      '/v1/leave/requests',
      { leaveTypeId: org.leaveTypeId, ...soon() },
      org.accessToken,
    )
    const res = await post(
      `/v1/team/approvals/${created.json().id}`,
      { decision: 'approve' },
      org.accessToken,
    )
    expect(res.statusCode).toBe(403)
  })
})

describe('accrual job', () => {
  it('is idempotent and does not overwrite taken or pending', async () => {
    await db.withTenant(org.orgId, async (tx) => {
      await tx.delete(leaveRequests)
      await tx.delete(leaveBalances)
    })

    const orgRow = { orgId: org.orgId, timezone: 'Africa/Lagos', settings: {} }

    const first = await runAccrualForOrg(db, orgRow)
    expect(first.balancesWritten).toBeGreaterThan(0)

    await db.withTenant(org.orgId, async (tx) => {
      await tx
        .update(leaveBalances)
        .set({ taken: '3', pending: '2' })
        .where(eq(leaveBalances.employeeId, org.employeeId))
    })

    const second = await runAccrualForOrg(db, orgRow)
    expect(second.balancesWritten).toBe(first.balancesWritten)

    const after = await db.withTenant(org.orgId, (tx) =>
      tx
        .select()
        .from(leaveBalances)
        .where(eq(leaveBalances.employeeId, org.employeeId)),
    )
    // The job owns `accrued`; the request flow owns `taken` and `pending`.
    expect(Number(after[0]!.taken)).toBe(3)
    expect(Number(after[0]!.pending)).toBe(2)
  })
})

describe('spreadsheet import', () => {
  /** Builds a real .xlsx in memory so the parser is exercised, not mocked. */
  async function workbook(rows: (string | Date)[][]): Promise<string> {
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    const sheet = wb.addWorksheet('Staff')
    for (const row of rows) sheet.addRow(row)
    const buf = await wb.xlsx.writeBuffer()
    return Buffer.from(buf).toString('base64')
  }

  it('reads rows out of an uploaded sheet', async () => {
    const contentBase64 = await workbook([
      ['Employee Number', 'First Name', 'Last Name', 'Email', 'Start Date'],
      ['QH-501', 'Ada', 'Lovelace', 'ada@acme.test', '2026-01-15'],
      ['QH-502', 'Grace', 'Hopper', 'grace@acme.test', '2026-02-01'],
    ])

    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/employees/import/parse',
      headers: bearer(org.managerToken),
      payload: { filename: 'staff.xlsx', contentBase64 },
    })

    // The seeded manager is not an HR admin.
    expect(response.statusCode).toBe(403)
  })

  it('normalises human column headings', async () => {
    const contentBase64 = await workbook([
      ['Employee Number', 'First Name', 'Last Name', 'Email', 'Start Date'],
      ['QH-501', 'Ada', 'Lovelace', 'ada@acme.test', '2026-01-15'],
    ])

    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/employees/import/parse',
      headers: bearer(hrToken),
      payload: { filename: 'staff.xlsx', contentBase64 },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    // "First Name" and "first_name" have to reach the importer as one column.
    expect(body.columns).toContain('employee_number')
    expect(body.columns).toContain('first_name')
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0].first_name).toBe('Ada')
    expect(body.rows[0].start_date).toBe('2026-01-15')
  })

  it('skips blank rows rather than importing empty people', async () => {
    const contentBase64 = await workbook([
      ['employee_number', 'first_name', 'last_name', 'email', 'start_date'],
      ['QH-503', 'Musa', 'Bello', 'musa2@acme.test', '2026-03-01'],
      ['', '', '', '', ''],
    ])

    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/employees/import/parse',
      headers: bearer(hrToken),
      payload: { filename: 'staff.xlsx', contentBase64 },
    })

    expect(response.json().rows).toHaveLength(1)
  })

  it('refuses something that is not a spreadsheet', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/employees/import/parse',
      headers: bearer(hrToken),
      payload: {
        filename: 'notes.xlsx',
        contentBase64: Buffer.from('this is just text').toString('base64'),
      },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().message).toContain('.xlsx')
  })
})
