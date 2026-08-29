/**
 * Payroll (spec §10).
 *
 * The shape of this module is driven by one rule from spec §3: no automated
 * decisions about people. A run is computed, previewed, and only becomes
 * payable when a named human approves it. Approval is recorded in `audit_log`,
 * which is append-only at the database role level.
 *
 * A run is immutable once approved. Correcting an approved run means issuing a
 * new off-cycle run, never editing the old one — otherwise the payslip an
 * employee downloaded stops matching the money that reached their account, and
 * there is no way to prove which was right.
 */

import type { FastifyInstance } from 'fastify'
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  ApiError,
  ERROR_CODES,
  BUILT_IN_SCHEDULES,
  computePayroll,
  explainPayslip,
  loanInstalment,
  naira,
  scheduleFor,
  solveNetToGross,
  totalsFor,
  type Allowance,
  type Deduction,
  type ISODate,
  type PayrollResult,
  type TaxSchedule,
} from '@quanti/shared'
import {
  compensation,
  employeeLoans,
  employees,
  organisations,
  payrollRuns,
  payslips,
  users,
} from '../db/schema.js'
import type { Database, Tx } from '../db/client.js'
import { audit } from '../lib/audit.js'
import { isHrAdmin, requireAuth, requireRole, tenant } from '../lib/context.js'
import { queueNotification } from '../lib/notify.js'
import { orgClock } from '../lib/time.js'
import { fullName, resolveSettings } from './shared.js'

// ---------------------------------------------------------------------------
// Org payroll configuration
// ---------------------------------------------------------------------------

const payrollSettings = z.object({
  scheduleId: z.string().default('ng-paye-fa2020'),
  periodsPerYear: z.number().int().min(1).max(52).default(12),
  nhfEnabled: z.boolean().default(false),
  /** Finance has confirmed the statutory rates against current law. */
  ratesConfirmedBy: z.string().nullable().default(null),
  ratesConfirmedAt: z.string().nullable().default(null),
})

type PayrollSettings = z.infer<typeof payrollSettings>

function resolvePayrollSettings(raw: unknown): PayrollSettings {
  const settings = (raw ?? {}) as { payroll?: unknown }
  return payrollSettings.parse(settings.payroll ?? {})
}

function scheduleById(id: string): TaxSchedule {
  const found = BUILT_IN_SCHEDULES.find((s) => s.id === id)
  if (!found) {
    throw new ApiError(
      ERROR_CODES.NOT_FOUND,
      `Unknown tax schedule "${id}". Configure payroll settings before running.`,
      422,
    )
  }
  return found
}

// ---------------------------------------------------------------------------

const money = z.number().int().min(0).max(1_000_000_000_000)

const allowanceSchema = z.object({
  name: z.string().min(1).max(80),
  amount: money,
  taxable: z.boolean().default(true),
  pensionable: z.boolean().default(false),
})

const upsertCompensation = z.object({
  employeeId: z.string().uuid(),
  effectiveFrom: z.string(),
  basic: money,
  housing: money.default(0),
  transport: money.default(0),
  allowances: z.array(allowanceSchema).default([]),
  voluntaryPension: money.default(0),
  nhis: money.default(0),
  bankName: z.string().max(120).nullable().optional(),
  bankAccountNumber: z.string().max(40).nullable().optional(),
  bankAccountName: z.string().max(160).nullable().optional(),
})

const upsertLoan = z.object({
  employeeId: z.string().uuid(),
  kind: z.enum(['loan_repayment', 'salary_advance', 'union_dues', 'cooperative', 'other']),
  name: z.string().min(1).max(80),
  principal: money,
  perPeriod: money,
  reason: z.string().max(500).optional(),
})

const runRequest = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
  payDate: z.string(),
  notes: z.string().max(1000).optional(),
  /** Limit the run to specific employees, for an off-cycle correction. */
  employeeIds: z.array(z.string().uuid()).optional(),
})

export function registerPayrollRoutes(app: FastifyInstance, _db: Database): void {
  // -------------------------------------------------------------------------
  // Employee-facing
  // -------------------------------------------------------------------------

  /**
   * The employee's own payslips.
   *
   * Only from runs that reached `approved` or `paid`: a draft run is a working
   * document, and showing an employee a figure that later changes is worse than
   * showing them nothing.
   */
  app.get('/v1/payroll/payslips', async (request, reply) => {
    const auth = requireAuth(request)

    const rows = await tenant(request, async (tx) =>
      tx
        .select({
          id: payslips.id,
          runId: payslips.runId,
          gross: payslips.gross,
          netPay: payslips.netPay,
          paye: payslips.paye,
          periodStart: payrollRuns.periodStart,
          periodEnd: payrollRuns.periodEnd,
          payDate: payrollRuns.payDate,
          status: payrollRuns.status,
        })
        .from(payslips)
        .innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
        .where(
          and(
            eq(payslips.employeeId, auth.employeeId),
            inArray(payrollRuns.status, ['approved', 'paid']),
          ),
        )
        .orderBy(desc(payrollRuns.payDate)),
    )

    return reply.send({ payslips: rows })
  })

  /**
   * A single payslip, with the explainer against the previous period (spec §5.5).
   *
   * The explanation is computed arithmetically from the two stored results, not
   * generated — see `explainPayslip`.
   */
  app.get('/v1/payroll/payslips/:id', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = request.params as { id: string }

    const payload = await tenant(request, async (tx) => {
      const [slip] = await tx
        .select({
          slip: payslips,
          periodStart: payrollRuns.periodStart,
          periodEnd: payrollRuns.periodEnd,
          payDate: payrollRuns.payDate,
          status: payrollRuns.status,
        })
        .from(payslips)
        .innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
        .where(and(eq(payslips.id, id), eq(payslips.employeeId, auth.employeeId)))
        .limit(1)

      if (!slip || !['approved', 'paid'].includes(slip.status)) {
        throw new ApiError(ERROR_CODES.NOT_FOUND, 'Payslip not found', 404)
      }

      const [previous] = await tx
        .select({ detail: payslips.detail, payDate: payrollRuns.payDate })
        .from(payslips)
        .innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
        .where(
          and(
            eq(payslips.employeeId, auth.employeeId),
            inArray(payrollRuns.status, ['approved', 'paid']),
            lte(payrollRuns.payDate, slip.payDate),
            sql`${payslips.id} <> ${id}`,
          ),
        )
        .orderBy(desc(payrollRuns.payDate))
        .limit(1)

      const current = slip.slip.detail as PayrollResult
      return {
        id: slip.slip.id,
        periodStart: slip.periodStart,
        periodEnd: slip.periodEnd,
        payDate: slip.payDate,
        detail: current,
        explanation: previous
          ? explainPayslip(previous.detail as PayrollResult, current)
          : null,
      }
    })

    return reply.send(payload)
  })

  // -------------------------------------------------------------------------
  // Configuration (HR / Finance)
  // -------------------------------------------------------------------------

  app.get('/v1/admin/payroll/settings', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')

    const payload = await tenant(request, async (tx) => {
      const [org] = await tx
        .select()
        .from(organisations)
        .where(eq(organisations.id, auth.orgId))
        .limit(1)
      const settings = resolvePayrollSettings(org?.settings)
      const schedule = BUILT_IN_SCHEDULES.find((s) => s.id === settings.scheduleId)
      return {
        settings,
        schedule: schedule ?? null,
        available: BUILT_IN_SCHEDULES.map((s) => ({
          id: s.id,
          label: s.label,
          jurisdiction: s.jurisdiction,
          effectiveFrom: s.effectiveFrom,
          sourceNote: s.sourceNote,
        })),
      }
    })

    return reply.send(payload)
  })

  app.patch('/v1/admin/payroll/settings', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const body = payrollSettings.partial().parse(request.body)

    const payload = await tenant(request, async (tx) => {
      const [org] = await tx
        .select()
        .from(organisations)
        .where(eq(organisations.id, auth.orgId))
        .limit(1)
      if (!org) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Organisation not found', 404)

      if (body.scheduleId) scheduleById(body.scheduleId)

      const existing = resolvePayrollSettings(org.settings)
      const next = { ...existing, ...body }
      const settings = { ...(org.settings as object), payroll: next }

      await tx
        .update(organisations)
        .set({ settings })
        .where(eq(organisations.id, auth.orgId))

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'config.updated',
        entityType: 'payroll_settings',
        entityId: auth.orgId,
        before: existing,
        after: next,
        ip: request.ip,
      })

      return next
    })

    return reply.send(payload)
  })

  app.get('/v1/admin/payroll/compensation', async (request, reply) => {
    requireRole(request, 'hr_admin', 'owner')

    const rows = await tenant(request, async (tx) =>
      tx
        .select({
          id: compensation.id,
          employeeId: compensation.employeeId,
          firstName: employees.firstName,
          lastName: employees.lastName,
          employeeNumber: employees.employeeNumber,
          effectiveFrom: compensation.effectiveFrom,
          basic: compensation.basic,
          housing: compensation.housing,
          transport: compensation.transport,
          allowances: compensation.allowances,
          voluntaryPension: compensation.voluntaryPension,
          nhis: compensation.nhis,
          bankName: compensation.bankName,
          bankAccountNumber: compensation.bankAccountNumber,
        })
        .from(compensation)
        .innerJoin(employees, eq(employees.id, compensation.employeeId))
        .orderBy(employees.employeeNumber, desc(compensation.effectiveFrom)),
    )

    return reply.send({
      compensation: rows.map((r) => ({ ...r, employeeName: fullName(r) })),
    })
  })

  app.post('/v1/admin/payroll/compensation', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const body = upsertCompensation.parse(request.body)

    const row = await tenant(request, async (tx) => {
      const [created] = await tx
        .insert(compensation)
        .values({
          orgId: auth.orgId,
          employeeId: body.employeeId,
          effectiveFrom: body.effectiveFrom,
          basic: body.basic,
          housing: body.housing,
          transport: body.transport,
          allowances: body.allowances,
          voluntaryPension: body.voluntaryPension,
          nhis: body.nhis,
          bankName: body.bankName ?? null,
          bankAccountNumber: body.bankAccountNumber ?? null,
          bankAccountName: body.bankAccountName ?? null,
          createdBy: auth.userId,
        })
        .onConflictDoUpdate({
          target: [compensation.orgId, compensation.employeeId, compensation.effectiveFrom],
          set: {
            basic: body.basic,
            housing: body.housing,
            transport: body.transport,
            allowances: body.allowances,
            voluntaryPension: body.voluntaryPension,
            nhis: body.nhis,
            bankName: body.bankName ?? null,
            bankAccountNumber: body.bankAccountNumber ?? null,
            bankAccountName: body.bankAccountName ?? null,
          },
        })
        .returning()

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'config.updated',
        entityType: 'compensation',
        entityId: created!.id,
        after: { employeeId: body.employeeId, effectiveFrom: body.effectiveFrom },
        ip: request.ip,
      })

      return created!
    })

    return reply.status(201).send(row)
  })

  app.get('/v1/admin/payroll/loans', async (request, reply) => {
    requireRole(request, 'hr_admin', 'owner')
    const rows = await tenant(request, async (tx) =>
      tx
        .select({
          id: employeeLoans.id,
          employeeId: employeeLoans.employeeId,
          firstName: employees.firstName,
          lastName: employees.lastName,
          kind: employeeLoans.kind,
          name: employeeLoans.name,
          principal: employeeLoans.principal,
          paid: employeeLoans.paid,
          perPeriod: employeeLoans.perPeriod,
          status: employeeLoans.status,
        })
        .from(employeeLoans)
        .innerJoin(employees, eq(employees.id, employeeLoans.employeeId)),
    )
    return reply.send({ loans: rows.map((r) => ({ ...r, employeeName: fullName(r) })) })
  })

  app.post('/v1/admin/payroll/loans', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const body = upsertLoan.parse(request.body)

    const row = await tenant(request, async (tx) => {
      const [created] = await tx
        .insert(employeeLoans)
        .values({
          orgId: auth.orgId,
          employeeId: body.employeeId,
          kind: body.kind,
          name: body.name,
          principal: body.principal,
          perPeriod: body.perPeriod,
          reason: body.reason ?? null,
          createdBy: auth.userId,
        })
        .returning()
      return created!
    })

    return reply.status(201).send(row)
  })

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  /**
   * Computes a run without writing anything.
   *
   * Finance previews before committing (spec §16: "preview before commit"), so
   * this is the screen where a wrong compensation record gets caught rather than
   * discovered in a bank file.
   */
  app.post('/v1/admin/payroll/runs/preview', async (request, reply) => {
    requireRole(request, 'hr_admin', 'owner')
    const body = runRequest.parse(request.body)

    const preview = await tenant(request, async (tx) => {
      const built = await buildRun(tx, request, body)
      return {
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
        payDate: body.payDate,
        scheduleId: built.schedule.id,
        scheduleLabel: built.schedule.label,
        ratesConfirmed: built.settings.ratesConfirmedAt !== null,
        totals: built.totals,
        warnings: built.warnings,
        lines: built.entries.map((e) => ({
          employeeId: e.employeeId,
          employeeName: e.employeeName,
          employeeNumber: e.employeeNumber,
          gross: e.result.gross,
          paye: e.result.paye,
          pension: e.result.pensionEmployee,
          nhf: e.result.nhf,
          deductions: e.result.totalDeductions,
          netPay: e.result.netPay,
          hasBankDetails: e.hasBankDetails,
        })),
      }
    })

    return reply.send(preview)
  })

  app.post('/v1/admin/payroll/runs', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const body = runRequest.parse(request.body)

    const created = await tenant(request, async (tx) => {
      const built = await buildRun(tx, request, body)

      if (built.entries.length === 0) {
        throw new ApiError(
          ERROR_CODES.VALIDATION_FAILED,
          'No employees have compensation effective for this period.',
          422,
        )
      }

      const [run] = await tx
        .insert(payrollRuns)
        .values({
          orgId: auth.orgId,
          periodStart: body.periodStart,
          periodEnd: body.periodEnd,
          payDate: body.payDate,
          status: 'pending_approval',
          scheduleId: built.schedule.id,
          totals: built.totals,
          notes: body.notes ?? null,
          createdBy: auth.userId,
        })
        .returning()

      for (const entry of built.entries) {
        await tx.insert(payslips).values({
          orgId: auth.orgId,
          runId: run!.id,
          employeeId: entry.employeeId,
          gross: entry.result.gross,
          netPay: entry.result.netPay,
          paye: entry.result.paye,
          pensionEmployee: entry.result.pensionEmployee,
          pensionEmployer: entry.result.pensionEmployer,
          nhf: entry.result.nhf,
          nhis: entry.result.nhis,
          nsitf: entry.result.employerNsitf,
          totalDeductions: entry.result.totalDeductions,
          detail: entry.result as unknown as object,
        })
      }

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'payroll.run_created',
        entityType: 'payroll_run',
        entityId: run!.id,
        after: {
          period: `${body.periodStart}..${body.periodEnd}`,
          scheduleId: built.schedule.id,
          totals: built.totals,
        },
        ip: request.ip,
      })

      return { id: run!.id, status: run!.status, totals: built.totals, warnings: built.warnings }
    })

    return reply.status(201).send(created)
  })

  app.get('/v1/admin/payroll/runs', async (request, reply) => {
    requireRole(request, 'hr_admin', 'owner')
    const rows = await tenant(request, async (tx) =>
      tx.select().from(payrollRuns).orderBy(desc(payrollRuns.payDate)),
    )
    return reply.send({ runs: rows })
  })

  app.get('/v1/admin/payroll/runs/:id', async (request, reply) => {
    requireRole(request, 'hr_admin', 'owner')
    const { id } = request.params as { id: string }

    const payload = await tenant(request, async (tx) => {
      const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, id)).limit(1)
      if (!run) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Run not found', 404)

      const slips = await tx
        .select({
          id: payslips.id,
          employeeId: payslips.employeeId,
          firstName: employees.firstName,
          lastName: employees.lastName,
          employeeNumber: employees.employeeNumber,
          gross: payslips.gross,
          paye: payslips.paye,
          pensionEmployee: payslips.pensionEmployee,
          nhf: payslips.nhf,
          totalDeductions: payslips.totalDeductions,
          netPay: payslips.netPay,
        })
        .from(payslips)
        .innerJoin(employees, eq(employees.id, payslips.employeeId))
        .where(eq(payslips.runId, id))
        .orderBy(employees.employeeNumber)

      return {
        run,
        payslips: slips.map((s) => ({ ...s, employeeName: fullName(s) })),
      }
    })

    return reply.send(payload)
  })

  /**
   * Approval. The point at which a run becomes payable.
   *
   * Self-approval is refused: whoever created the run cannot be the one who
   * signs it off. That is the ordinary segregation-of-duties control for
   * anything that moves money, and it is cheap to enforce here.
   */
  app.post('/v1/admin/payroll/runs/:id/approve', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const { id } = request.params as { id: string }
    const body = z
      .object({ confirmTotals: z.number().int(), note: z.string().max(500).optional() })
      .parse(request.body)

    const result = await tenant(request, async (tx) => {
      const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, id)).limit(1)
      if (!run) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Run not found', 404)

      if (run.status !== 'pending_approval') {
        throw new ApiError(
          ERROR_CODES.VALIDATION_FAILED,
          `This run is ${run.status} and cannot be approved.`,
          409,
        )
      }

      if (run.createdBy === auth.userId) {
        throw new ApiError(
          ERROR_CODES.AUTH_FORBIDDEN,
          'A payroll run must be approved by someone other than the person who created it.',
          403,
        )
      }

      // The approver confirms the net total they were shown. If it does not
      // match, the run changed underneath them and approval must not proceed.
      const totals = run.totals as { netPay?: number }
      if (totals.netPay !== body.confirmTotals) {
        throw new ApiError(
          ERROR_CODES.VALIDATION_FAILED,
          'The run total has changed since it was displayed. Review it again before approving.',
          409,
          { expected: totals.netPay, submitted: body.confirmTotals },
        )
      }

      await tx
        .update(payrollRuns)
        .set({ status: 'approved', approvedBy: auth.userId, approvedAt: new Date() })
        .where(eq(payrollRuns.id, id))

      // Advance loan balances only once the run is actually approved.
      const slips = await tx
        .select({ employeeId: payslips.employeeId, detail: payslips.detail })
        .from(payslips)
        .where(eq(payslips.runId, id))

      for (const slip of slips) {
        const detail = slip.detail as PayrollResult
        for (const line of detail.lines) {
          if (!line.code.startsWith('deduction:')) continue
          const [, kind, name] = line.code.split(':')
          if (kind !== 'loan_repayment' && kind !== 'salary_advance') continue

          await tx
            .update(employeeLoans)
            .set({ paid: sql`${employeeLoans.paid} + ${line.amount}` })
            .where(
              and(
                eq(employeeLoans.employeeId, slip.employeeId),
                eq(employeeLoans.name, name ?? ''),
                eq(employeeLoans.status, 'active'),
              ),
            )
        }
      }

      await tx
        .update(employeeLoans)
        .set({ status: 'settled' })
        .where(
          and(
            eq(employeeLoans.status, 'active'),
            gte(employeeLoans.paid, employeeLoans.principal),
          ),
        )

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'payroll.run_approved',
        entityType: 'payroll_run',
        entityId: id,
        before: { status: 'pending_approval' },
        after: { status: 'approved', note: body.note ?? null, totals: run.totals },
        ip: request.ip,
      })

      // Payslip figures never appear in a notification preview (spec §5.5).
      for (const slip of slips) {
        const [employee] = await tx
          .select({ userId: employees.userId })
          .from(employees)
          .where(eq(employees.id, slip.employeeId))
          .limit(1)
        if (employee?.userId) {
          await queueNotification(tx, {
            orgId: auth.orgId,
            userId: employee.userId,
            event: 'payslip.ready',
            title: 'Payslip available',
            body: `Your payslip for ${run.periodStart} to ${run.periodEnd} is ready.`,
            deepLink: '/payslips',
            data: { runId: id },
          })
        }
      }

      return { id, status: 'approved' as const }
    })

    return reply.send(result)
  })

  app.post('/v1/admin/payroll/runs/:id/mark-paid', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const { id } = request.params as { id: string }

    await tenant(request, async (tx) => {
      const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, id)).limit(1)
      if (!run) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Run not found', 404)
      if (run.status !== 'approved') {
        throw new ApiError(
          ERROR_CODES.VALIDATION_FAILED,
          `Only an approved run can be marked paid; this one is ${run.status}.`,
          409,
        )
      }

      await tx
        .update(payrollRuns)
        .set({ status: 'paid', paidAt: new Date() })
        .where(eq(payrollRuns.id, id))

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'payroll.run_paid',
        entityType: 'payroll_run',
        entityId: id,
        after: { status: 'paid' },
        ip: request.ip,
      })
    })

    return reply.status(204).send()
  })

  /** Bank payment file. CSV, because every Nigerian bank accepts a CSV upload. */
  app.get('/v1/admin/payroll/runs/:id/bank-file', async (request, reply) => {
    requireRole(request, 'hr_admin', 'owner')
    const { id } = request.params as { id: string }

    const csv = await tenant(request, async (tx) => {
      const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, id)).limit(1)
      if (!run) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Run not found', 404)
      if (!['approved', 'paid'].includes(run.status)) {
        throw new ApiError(
          ERROR_CODES.VALIDATION_FAILED,
          'A bank file can only be generated for an approved run.',
          409,
        )
      }

      const rows = await tx
        .select({
          employeeNumber: employees.employeeNumber,
          firstName: employees.firstName,
          lastName: employees.lastName,
          netPay: payslips.netPay,
          bankName: compensation.bankName,
          accountNumber: compensation.bankAccountNumber,
          accountName: compensation.bankAccountName,
        })
        .from(payslips)
        .innerJoin(employees, eq(employees.id, payslips.employeeId))
        .leftJoin(
          compensation,
          and(
            eq(compensation.employeeId, payslips.employeeId),
            lte(compensation.effectiveFrom, run.payDate),
          ),
        )
        .where(eq(payslips.runId, id))
        .orderBy(employees.employeeNumber)

      const header = 'employee_number,account_name,bank_name,account_number,amount_ngn,narration'
      const lines = rows.map((r) =>
        [
          r.employeeNumber,
          csvCell(r.accountName ?? fullName(r)),
          csvCell(r.bankName ?? ''),
          csvCell(r.accountNumber ?? ''),
          // Banks want major units with two decimals, not kobo.
          (r.netPay / 100).toFixed(2),
          csvCell(`Salary ${run.periodStart} to ${run.periodEnd}`),
        ].join(','),
      )

      return [header, ...lines].join('\r\n')
    })

    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="payroll-${id}.csv"`)
      .send(csv)
  })

  /** Statutory filing summary: PAYE, pension, NHF, NSITF for the period. */
  app.get('/v1/admin/payroll/runs/:id/filings', async (request, reply) => {
    requireRole(request, 'hr_admin', 'owner')
    const { id } = request.params as { id: string }

    const payload = await tenant(request, async (tx) => {
      const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, id)).limit(1)
      if (!run) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Run not found', 404)

      const rows = await tx
        .select({
          employeeNumber: employees.employeeNumber,
          firstName: employees.firstName,
          lastName: employees.lastName,
          gross: payslips.gross,
          paye: payslips.paye,
          pensionEmployee: payslips.pensionEmployee,
          pensionEmployer: payslips.pensionEmployer,
          nhf: payslips.nhf,
        })
        .from(payslips)
        .innerJoin(employees, eq(employees.id, payslips.employeeId))
        .where(eq(payslips.runId, id))
        .orderBy(employees.employeeNumber)

      const sum = (pick: (r: (typeof rows)[number]) => number) =>
        rows.reduce((t, r) => t + pick(r), 0)

      return {
        run: { id: run.id, periodStart: run.periodStart, periodEnd: run.periodEnd, payDate: run.payDate },
        scheduleId: run.scheduleId,
        paye: { total: sum((r) => r.paye), rows: rows.map((r) => ({ employeeNumber: r.employeeNumber, name: fullName(r), gross: r.gross, paye: r.paye })) },
        pension: {
          employee: sum((r) => r.pensionEmployee),
          employer: sum((r) => r.pensionEmployer),
          total: sum((r) => r.pensionEmployee + r.pensionEmployer),
        },
        nhf: { total: sum((r) => r.nhf) },
        nsitf: { total: (run.totals as { nsitf?: number }).nsitf ?? 0 },
      }
    })

    return reply.send(payload)
  })

  /** Net-to-gross helper, for offer letters quoted as take-home. */
  app.post('/v1/admin/payroll/net-to-gross', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const body = z
      .object({
        targetNet: money,
        basic: money,
        housing: money.default(0),
        transport: money.default(0),
      })
      .parse(request.body)

    const payload = await tenant(request, async (tx) => {
      const [org] = await tx
        .select()
        .from(organisations)
        .where(eq(organisations.id, auth.orgId))
        .limit(1)
      const settings = resolvePayrollSettings(org?.settings)
      const headcount = await activeHeadcount(tx)

      return solveNetToGross(body.targetNet, {
        compensation: {
          basic: body.basic,
          housing: body.housing,
          transport: body.transport,
          allowances: [],
        },
        deductions: [],
        schedule: scheduleById(settings.scheduleId),
        periodsPerYear: settings.periodsPerYear,
        headcount,
        nhfEnabled: settings.nhfEnabled,
      })
    })

    return reply.send(payload)
  })
}

// ---------------------------------------------------------------------------
// Run construction
// ---------------------------------------------------------------------------

interface RunEntry {
  employeeId: string
  employeeName: string
  employeeNumber: string
  result: PayrollResult
  hasBankDetails: boolean
}

interface BuiltRun {
  schedule: TaxSchedule
  settings: PayrollSettings
  entries: RunEntry[]
  totals: ReturnType<typeof totalsFor> & { nsitf: number }
  warnings: string[]
}

async function activeHeadcount(tx: Tx): Promise<number> {
  const rows = await tx
    .select({ id: employees.id })
    .from(employees)
    .where(eq(employees.status, 'active'))
  return rows.length
}

/**
 * Computes every payslip for a period without writing.
 *
 * Compensation is resolved as of the pay date, so a raise effective mid-period
 * applies from the run it was dated into rather than retroactively rewriting an
 * earlier payslip.
 */
async function buildRun(
  tx: Tx,
  request: Parameters<typeof requireRole>[0],
  body: z.infer<typeof runRequest>,
): Promise<BuiltRun> {
  const auth = requireRole(request, 'hr_admin', 'owner')

  const [org] = await tx
    .select()
    .from(organisations)
    .where(eq(organisations.id, auth.orgId))
    .limit(1)
  if (!org) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Organisation not found', 404)

  const settings = resolvePayrollSettings(org.settings)
  const schedule = scheduleById(settings.scheduleId)
  const warnings: string[] = []

  if (settings.ratesConfirmedAt === null) {
    warnings.push(
      'Statutory rates have not been confirmed by Finance. Review the schedule in Payroll settings before approving a live run.',
    )
  }

  const staff = await tx
    .select()
    .from(employees)
    .where(
      body.employeeIds?.length
        ? and(eq(employees.status, 'active'), inArray(employees.id, body.employeeIds))
        : eq(employees.status, 'active'),
    )
    .orderBy(employees.employeeNumber)

  const headcount = staff.length
  const entries: RunEntry[] = []

  for (const employee of staff) {
    const [comp] = await tx
      .select()
      .from(compensation)
      .where(
        and(
          eq(compensation.employeeId, employee.id),
          lte(compensation.effectiveFrom, body.payDate),
          or(isNull(compensation.effectiveTo), gte(compensation.effectiveTo, body.payDate)),
        ),
      )
      .orderBy(desc(compensation.effectiveFrom))
      .limit(1)

    if (!comp) {
      warnings.push(`${fullName(employee)} (${employee.employeeNumber}) has no compensation record and was skipped.`)
      continue
    }

    const loans = await tx
      .select()
      .from(employeeLoans)
      .where(
        and(eq(employeeLoans.employeeId, employee.id), eq(employeeLoans.status, 'active')),
      )

    const deductions: Deduction[] = loans
      .map((loan) => ({
        name: loan.name,
        kind: loan.kind as Deduction['kind'],
        amount: loanInstalment({
          principal: loan.principal,
          paid: loan.paid,
          perPeriod: loan.perPeriod,
        }),
        preTax: false,
      }))
      .filter((d) => d.amount > 0)

    const result = computePayroll({
      compensation: {
        basic: comp.basic,
        housing: comp.housing,
        transport: comp.transport,
        allowances: (comp.allowances ?? []) as Allowance[],
      },
      deductions,
      schedule,
      periodsPerYear: settings.periodsPerYear,
      headcount,
      nhfEnabled: settings.nhfEnabled,
      voluntaryPension: comp.voluntaryPension,
      nhis: comp.nhis,
    })

    if (result.netPay < 0) {
      warnings.push(
        `${fullName(employee)} has deductions exceeding gross pay; net would be negative. Review before approving.`,
      )
    }

    const hasBankDetails = !!comp.bankAccountNumber && !!comp.bankName
    if (!hasBankDetails) {
      warnings.push(`${fullName(employee)} has no bank details and will be missing from the bank file.`)
    }

    entries.push({
      employeeId: employee.id,
      employeeName: fullName(employee),
      employeeNumber: employee.employeeNumber,
      result,
      hasBankDetails,
    })
  }

  const totals = totalsFor(entries.map((e) => e.result))

  return { schedule, settings, entries, totals: { ...totals, nsitf: totals.nsitf }, warnings }
}

/** RFC 4180 quoting, so a name containing a comma cannot shift every column. */
function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}
