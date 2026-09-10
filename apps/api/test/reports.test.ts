/**
 * Leave report figures.
 *
 * Only the arithmetic is tested, and that is the point: the model's half of
 * this feature cannot produce a number, so the numbers are the whole of what
 * can be wrong. If these are right the report is right.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import type { Database } from '../src/db/client.js'
import { departments, employees, leaveBalances, leaveRequests } from '../src/db/schema.js'
import { computeLeaveFacts } from '../src/lib/reports.js'
import { bearer, makeDatabase, makeOrg, type TestOrg } from './helpers.js'

let db: Database
let app: FastifyInstance
let org: TestOrg
let other: TestOrg

const facts = (from = '2026-01-01', to = '2026-12-31') =>
  db.withTenant(org.orgId, async (tx) => computeLeaveFacts(tx, from, to))

beforeAll(async () => {
  db = await makeDatabase()
  org = await makeOrg(db, 'acme')
  other = await makeOrg(db, 'globex')
  app = await buildServer(db)
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await db.close()
})

beforeEach(async () => {
  await db.withTenant(org.orgId, async (tx) => {
    await tx.delete(leaveRequests)
    await tx.delete(leaveBalances)
  })
})

async function addRequest(over: {
  status: string
  days: string
  start?: string
  end?: string
  overrideReason?: string
  employeeId?: string
  decidedAt?: Date
  submittedAt?: Date
}) {
  await db.withTenant(org.orgId, async (tx) => {
    await tx.insert(leaveRequests).values({
      orgId: org.orgId,
      employeeId: over.employeeId ?? org.employeeId,
      leaveTypeId: org.leaveTypeId,
      startDate: over.start ?? '2026-06-01',
      endDate: over.end ?? '2026-06-05',
      daysCount: over.days,
      status: over.status,
      overrideReason: over.overrideReason ?? null,
      ...(over.decidedAt ? { decidedAt: over.decidedAt } : {}),
      ...(over.submittedAt ? { submittedAt: over.submittedAt } : {}),
    })
  })
}

describe('leave figures', () => {
  it('counts only approved requests towards days taken', async () => {
    await addRequest({ status: 'approved', days: '5' })
    await addRequest({ status: 'pending', days: '3' })
    await addRequest({ status: 'declined', days: '2' })

    const f = await facts()

    expect(f.daysTaken).toBe(5)
    expect(f.requests.approved).toBe(1)
    expect(f.requests.pending).toBe(1)
    expect(f.requests.declined).toBe(1)
    expect(f.requests.total).toBe(3)
  })

  it('includes a request that straddles the window edge', async () => {
    // A fortnight beginning on the 28th belongs to both months. Dropping it
    // from one would make two adjacent reports disagree.
    await addRequest({ status: 'approved', days: '10', start: '2026-06-28', end: '2026-07-10' })

    expect((await facts('2026-06-01', '2026-06-30')).daysTaken).toBe(10)
    expect((await facts('2026-07-01', '2026-07-31')).daysTaken).toBe(10)
  })

  it('excludes a request wholly outside the window', async () => {
    await addRequest({ status: 'approved', days: '4', start: '2026-02-01', end: '2026-02-04' })
    expect((await facts('2026-06-01', '2026-06-30')).daysTaken).toBe(0)
  })

  it('reports absence per head so unequal teams compare', async () => {
    const deptId = await db.withTenant(org.orgId, async (tx) => {
      const [d] = await tx
        .insert(departments)
        .values({ orgId: org.orgId, name: 'Kitchen' })
        .returning()
      await tx
        .update(employees)
        .set({ departmentId: d!.id })
        .where(eq(employees.id, org.employeeId))
      return d!.id
    })

    await addRequest({ status: 'approved', days: '6' })

    const f = await facts()
    const kitchen = f.byDepartment.find((d) => d.departmentName === 'Kitchen')
    expect(kitchen?.headcount).toBe(1)
    expect(kitchen?.daysPerHead).toBe(6)
    void deptId
  })

  it('counts overrides separately from ordinary approvals', async () => {
    await addRequest({ status: 'approved', days: '2' })
    await addRequest({ status: 'approved', days: '2', overrideReason: 'Short-handed but agreed' })

    const f = await facts()
    expect(f.requests.approved).toBe(2)
    expect(f.overrides).toBe(1)
  })

  it('treats untaken accrued days as a liability', async () => {
    await db.withTenant(org.orgId, async (tx) => {
      await tx.insert(leaveBalances).values({
        orgId: org.orgId,
        employeeId: org.employeeId,
        leaveTypeId: org.leaveTypeId,
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
        accrued: '20',
        taken: '5',
      })
    })

    expect((await facts()).untakenDays).toBe(15)
  })

  it('counts who took nothing at all', async () => {
    await addRequest({ status: 'approved', days: '3' })
    const f = await facts()

    // Two employees in the fixture org; one of them took leave.
    expect(f.headcount).toBe(2)
    expect(f.tookNothing).toBe(1)
  })

  it('measures approval latency from submission to decision', async () => {
    const submitted = new Date('2026-06-01T09:00:00.000Z')
    await addRequest({
      status: 'approved',
      days: '1',
      submittedAt: submitted,
      decidedAt: new Date(submitted.getTime() + 6 * 3_600_000),
    })

    const f = await facts()
    expect(f.approval.decided).toBe(1)
    expect(f.approval.medianHours).toBe(6)
  })
})

describe('access', () => {
  it('is refused to a manager who is not an HR admin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/reports/leave?from=2026-01-01&to=2026-12-31',
      headers: bearer(org.managerToken),
    })

    // Aggregating the whole org is not what direct-report scoping is for.
    expect(response.statusCode).toBe(403)
  })

  it('never counts another tenant rows', async () => {
    await addRequest({ status: 'approved', days: '5' })
    await db.withTenant(other.orgId, async (tx) => {
      await tx.insert(leaveRequests).values({
        orgId: other.orgId,
        employeeId: other.employeeId,
        leaveTypeId: other.leaveTypeId,
        startDate: '2026-06-01',
        endDate: '2026-06-20',
        daysCount: '99',
        status: 'approved',
      })
    })

    expect((await facts()).daysTaken).toBe(5)
  })
})
