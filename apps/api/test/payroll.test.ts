/**
 * Payroll run lifecycle (spec §10).
 *
 * The controls being tested here are the ones that stop money moving wrongly:
 * preview writes nothing, approval cannot be self-service, an approved run is
 * frozen, and the totals the approver confirmed must still be the totals on the
 * run when they press approve.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { naira } from '@quanti/shared'
import { buildServer } from '../src/server.js'
import type { Database } from '../src/db/client.js'
import {
  compensation,
  employeeLoans,
  organisations,
  payrollRuns,
  payslips,
} from '../src/db/schema.js'
import { signAccessToken } from '../src/lib/tokens.js'
import { bearer, makeDatabase, makeOrg, type TestOrg } from './helpers.js'

let db: Database
let app: FastifyInstance
let org: TestOrg
/** A second HR admin, so approval can be segregated from creation. */
let approverToken: string
let creatorToken: string

const PERIOD = { periodStart: '2026-09-01', periodEnd: '2026-09-30', payDate: '2026-09-28' }

beforeAll(async () => {
  db = await makeDatabase()
  org = await makeOrg(db, 'payco')
  app = await buildServer(db)
  await app.ready()

  // The fixture manager doubles as the payroll creator; the fixture staff member
  // is promoted to a second HR admin purely to approve.
  creatorToken = await signAccessToken({
    userId: org.managerUserId,
    orgId: org.orgId,
    employeeId: org.managerEmployeeId,
    roles: ['employee', 'hr_admin'],
    deviceId: 'creator-device',
  })
  approverToken = await signAccessToken({
    userId: org.userId,
    orgId: org.orgId,
    employeeId: org.employeeId,
    roles: ['employee', 'hr_admin'],
    deviceId: 'approver-device',
  })

  await db.withTenant(org.orgId, async (tx) => {
    await tx
      .update(organisations)
      .set({
        settings: {
          payroll: {
            scheduleId: 'ng-paye-fa2020',
            periodsPerYear: 12,
            nhfEnabled: true,
            ratesConfirmedBy: 'Finance',
            ratesConfirmedAt: '2026-08-01T00:00:00.000Z',
          },
        },
      })
      .where(eq(organisations.id, org.orgId))
  })
})

afterAll(async () => {
  await app?.close()
  await db?.close()
})

const post = (url: string, payload: unknown, token: string) =>
  app.inject({ method: 'POST', url, headers: bearer(token), payload: payload as object })

const get = (url: string, token: string) =>
  app.inject({ method: 'GET', url, headers: bearer(token) })

async function giveCompensation(employeeId: string, basic: number) {
  return post(
    '/v1/admin/payroll/compensation',
    {
      employeeId,
      effectiveFrom: '2026-01-01',
      basic: naira(basic),
      housing: naira(basic / 2),
      transport: naira(basic / 4),
      bankName: 'Test Bank',
      bankAccountNumber: '0123456789',
      bankAccountName: 'Test Account',
    },
    creatorToken,
  )
}

beforeEach(async () => {
  await db.withTenant(org.orgId, async (tx) => {
    await tx.delete(payslips)
    await tx.delete(payrollRuns)
    await tx.delete(compensation)
    await tx.delete(employeeLoans)
  })
})

describe('compensation', () => {
  it('records a versioned compensation row', async () => {
    const res = await giveCompensation(org.employeeId, 200_000)
    expect(res.statusCode).toBe(201)
    expect(res.json().basic).toBe(naira(200_000))
  })

  it('is refused to a non-admin', async () => {
    const res = await post(
      '/v1/admin/payroll/compensation',
      { employeeId: org.employeeId, effectiveFrom: '2026-01-01', basic: naira(1) },
      org.accessToken,
    )
    expect(res.statusCode).toBe(403)
  })
})

describe('run preview', () => {
  it('computes without writing anything', async () => {
    await giveCompensation(org.employeeId, 200_000)

    const res = await post('/v1/admin/payroll/runs/preview', PERIOD, creatorToken)
    expect(res.statusCode).toBe(200)
    expect(res.json().lines).toHaveLength(1)
    expect(res.json().totals.netPay).toBeGreaterThan(0)

    const stored = await db.withTenant(org.orgId, (tx) => tx.select().from(payrollRuns))
    expect(stored).toHaveLength(0)
  })

  it('warns about an employee with no compensation rather than failing silently', async () => {
    await giveCompensation(org.employeeId, 200_000)
    const res = await post('/v1/admin/payroll/runs/preview', PERIOD, creatorToken)
    const warnings: string[] = res.json().warnings
    expect(warnings.some((w) => w.includes('no compensation record'))).toBe(true)
  })

  it('warns when statutory rates have not been confirmed', async () => {
    await db.withTenant(org.orgId, async (tx) => {
      await tx
        .update(organisations)
        .set({ settings: { payroll: { scheduleId: 'ng-paye-fa2020', ratesConfirmedAt: null } } })
        .where(eq(organisations.id, org.orgId))
    })
    await giveCompensation(org.employeeId, 200_000)

    const res = await post('/v1/admin/payroll/runs/preview', PERIOD, creatorToken)
    expect(res.json().ratesConfirmed).toBe(false)
    expect((res.json().warnings as string[]).some((w) => /not been confirmed/i.test(w))).toBe(true)

    await db.withTenant(org.orgId, async (tx) => {
      await tx
        .update(organisations)
        .set({
          settings: {
            payroll: {
              scheduleId: 'ng-paye-fa2020',
              periodsPerYear: 12,
              nhfEnabled: true,
              ratesConfirmedBy: 'Finance',
              ratesConfirmedAt: '2026-08-01T00:00:00.000Z',
            },
          },
        })
        .where(eq(organisations.id, org.orgId))
    })
  })
})

describe('run lifecycle', () => {
  it('creates a run pending approval, with a payslip per employee', async () => {
    await giveCompensation(org.employeeId, 200_000)

    const res = await post('/v1/admin/payroll/runs', PERIOD, creatorToken)
    expect(res.statusCode).toBe(201)
    expect(res.json().status).toBe('pending_approval')

    const slips = await db.withTenant(org.orgId, (tx) => tx.select().from(payslips))
    expect(slips).toHaveLength(1)
    expect(slips[0]!.netPay).toBeGreaterThan(0)
  })

  it('hides an unapproved payslip from the employee', async () => {
    await giveCompensation(org.employeeId, 200_000)
    await post('/v1/admin/payroll/runs', PERIOD, creatorToken)

    const res = await get('/v1/payroll/payslips', org.accessToken)
    expect(res.statusCode).toBe(200)
    // A draft figure that later changes is worse than showing nothing.
    expect(res.json().payslips).toHaveLength(0)
  })

  it('refuses approval by the person who created the run', async () => {
    await giveCompensation(org.employeeId, 200_000)
    const created = await post('/v1/admin/payroll/runs', PERIOD, creatorToken)
    const runId = created.json().id

    const res = await post(
      `/v1/admin/payroll/runs/${runId}/approve`,
      { confirmTotals: created.json().totals.netPay },
      creatorToken,
    )
    expect(res.statusCode).toBe(403)
    expect(res.json().message).toMatch(/other than the person who created/i)
  })

  it('refuses approval when the confirmed total does not match', async () => {
    await giveCompensation(org.employeeId, 200_000)
    const created = await post('/v1/admin/payroll/runs', PERIOD, creatorToken)

    const res = await post(
      `/v1/admin/payroll/runs/${created.json().id}/approve`,
      { confirmTotals: 1 },
      approverToken,
    )
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toMatch(/changed since it was displayed/i)
  })

  it('approves, releases the payslip, and records the approver', async () => {
    await giveCompensation(org.employeeId, 200_000)
    const created = await post('/v1/admin/payroll/runs', PERIOD, creatorToken)

    const approved = await post(
      `/v1/admin/payroll/runs/${created.json().id}/approve`,
      { confirmTotals: created.json().totals.netPay },
      approverToken,
    )
    expect(approved.statusCode).toBe(200)

    const stored = await db.withTenant(org.orgId, (tx) => tx.select().from(payrollRuns))
    expect(stored[0]!.status).toBe('approved')
    expect(stored[0]!.approvedBy).toBe(org.userId)
    expect(stored[0]!.approvedAt).not.toBeNull()

    const visible = await get('/v1/payroll/payslips', org.accessToken)
    expect(visible.json().payslips).toHaveLength(1)
  })

  it('refuses to approve the same run twice', async () => {
    await giveCompensation(org.employeeId, 200_000)
    const created = await post('/v1/admin/payroll/runs', PERIOD, creatorToken)
    const total = created.json().totals.netPay

    await post(`/v1/admin/payroll/runs/${created.json().id}/approve`, { confirmTotals: total }, approverToken)
    const again = await post(
      `/v1/admin/payroll/runs/${created.json().id}/approve`,
      { confirmTotals: total },
      approverToken,
    )
    expect(again.statusCode).toBe(409)
  })

  it('records the approval in the append-only audit log', async () => {
    await giveCompensation(org.employeeId, 200_000)
    const created = await post('/v1/admin/payroll/runs', PERIOD, creatorToken)
    await post(
      `/v1/admin/payroll/runs/${created.json().id}/approve`,
      { confirmTotals: created.json().totals.netPay },
      approverToken,
    )

    const entries = await db.withTenant(org.orgId, async (tx) => {
      const { auditLog } = await import('../src/db/schema.js')
      return tx.select().from(auditLog)
    })
    expect(entries.some((e) => e.action === 'payroll.run_approved')).toBe(true)
  })
})

describe('bank file', () => {
  it('is refused before approval', async () => {
    await giveCompensation(org.employeeId, 200_000)
    const created = await post('/v1/admin/payroll/runs', PERIOD, creatorToken)
    const res = await get(`/v1/admin/payroll/runs/${created.json().id}/bank-file`, creatorToken)
    expect(res.statusCode).toBe(409)
  })

  it('emits CSV with major units after approval', async () => {
    await giveCompensation(org.employeeId, 200_000)
    const created = await post('/v1/admin/payroll/runs', PERIOD, creatorToken)
    await post(
      `/v1/admin/payroll/runs/${created.json().id}/approve`,
      { confirmTotals: created.json().totals.netPay },
      approverToken,
    )

    const res = await get(`/v1/admin/payroll/runs/${created.json().id}/bank-file`, creatorToken)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')

    const [header, row] = res.body.trim().split('\r\n')
    expect(header).toBe(
      'employee_number,account_name,bank_name,account_number,amount_ngn,narration',
    )
    // Amount must be major units with two decimals, not kobo.
    expect(row).toMatch(/,\d+\.\d{2},/)
    expect(row).toContain('0123456789')
  })
})

describe('loans', () => {
  it('deducts an instalment and advances the balance on approval', async () => {
    await giveCompensation(org.employeeId, 200_000)
    await post(
      '/v1/admin/payroll/loans',
      {
        employeeId: org.employeeId,
        kind: 'loan_repayment',
        name: 'Staff loan',
        principal: naira(100_000),
        perPeriod: naira(25_000),
      },
      creatorToken,
    )

    const created = await post('/v1/admin/payroll/runs', PERIOD, creatorToken)
    await post(
      `/v1/admin/payroll/runs/${created.json().id}/approve`,
      { confirmTotals: created.json().totals.netPay },
      approverToken,
    )

    const loans = await db.withTenant(org.orgId, (tx) => tx.select().from(employeeLoans))
    expect(loans[0]!.paid).toBe(naira(25_000))
  })
})

describe('payslip explainer', () => {
  it('explains the difference against the previous period', async () => {
    await giveCompensation(org.employeeId, 200_000)

    // Period one.
    const first = await post('/v1/admin/payroll/runs', PERIOD, creatorToken)
    await post(
      `/v1/admin/payroll/runs/${first.json().id}/approve`,
      { confirmTotals: first.json().totals.netPay },
      approverToken,
    )

    // Period two, with a loan that did not exist before.
    await post(
      '/v1/admin/payroll/loans',
      {
        employeeId: org.employeeId,
        kind: 'loan_repayment',
        name: 'Staff loan',
        principal: naira(100_000),
        perPeriod: naira(25_000),
      },
      creatorToken,
    )
    const second = await post(
      '/v1/admin/payroll/runs',
      { periodStart: '2026-10-01', periodEnd: '2026-10-31', payDate: '2026-10-28' },
      creatorToken,
    )
    await post(
      `/v1/admin/payroll/runs/${second.json().id}/approve`,
      { confirmTotals: second.json().totals.netPay },
      approverToken,
    )

    const list = await get('/v1/payroll/payslips', org.accessToken)
    const latest = list.json().payslips[0]

    const detail = await get(`/v1/payroll/payslips/${latest.id}`, org.accessToken)
    expect(detail.statusCode).toBe(200)
    expect(detail.json().explanation).not.toBeNull()
    expect(detail.json().explanation.summary).toContain('Staff loan')
    expect(detail.json().explanation.netDelta).toBe(-naira(25_000))
  })
})

describe('net-to-gross', () => {
  it('solves for the gross that yields a target net', async () => {
    const res = await post(
      '/v1/admin/payroll/net-to-gross',
      {
        targetNet: naira(500_000),
        basic: naira(200_000),
        housing: naira(100_000),
        transport: naira(50_000),
      },
      creatorToken,
    )
    expect(res.statusCode).toBe(200)
    expect(res.json().converged).toBe(true)
    expect(res.json().gross).toBeGreaterThan(naira(500_000))
  })
})
