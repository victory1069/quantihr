/**
 * Leave types, balances, conflict checking, requests (spec §4, §5, §8).
 *
 * Two invariants hold across this file:
 *
 *  - `pending` is incremented when a request is submitted and decremented when
 *    it is decided. Without that, an employee submits three overlapping requests
 *    and the third is approved against days already spoken for (spec §8).
 *  - Balance sufficiency is checked with a day-by-day draw-down, not a single
 *    subtraction, so carryover expiring partway through a request is handled
 *    correctly in both directions.
 */

import type { FastifyInstance } from 'fastify'
import { and, eq, gte, inArray, lte, ne, or, sql } from 'drizzle-orm'
import {
  ApiError,
  ERROR_CODES,
  availableOn,
  computeAccrual,
  computeLeaveDays,
  diffDays,
  drawDown,
  evaluateCoverage,
  resolvePeriod,
  schemas,
  type AccrualMethod,
  type CoverageWarning,
  type ISODate,
  type LeaveBalance,
  type LeaveTypeConfig,
} from '@quanti/shared'
import {
  coverageRules,
  employees,
  leaveBalances,
  leaveRequests,
  leaveTypes,
  users,
} from '../db/schema.js'
import type { Database, Tx } from '../db/client.js'
import { audit } from '../lib/audit.js'
import { requireAuth, tenant } from '../lib/context.js'
import {
  checkIdempotency,
  idempotencyKeyFrom,
  recordIdempotency,
} from '../lib/idempotency.js'
import { queueNotification } from '../lib/notify.js'
import { orgClock } from '../lib/time.js'
import { fullName, loadEmployeeContext, num, resolveSettings } from './shared.js'

export function registerLeaveRoutes(app: FastifyInstance, db: Database): void {
  app.get('/v1/leave/types', async (request, reply) => {
    const rows = await tenant(request, async (tx) =>
      tx.select().from(leaveTypes).where(eq(leaveTypes.active, true)),
    )
    return reply.send({ types: rows.map(toLeaveTypeView) })
  })

  app.get('/v1/leave/balances', async (request, reply) => {
    const auth = requireAuth(request)

    const balances = await tenant(request, async (tx) => {
      const ctx = await loadEmployeeContext(tx, auth.employeeId)
      const settings = resolveSettings(ctx.org.settings)
      const asOf = orgClock(ctx.org.timezone).date
      const types = await tx.select().from(leaveTypes).where(eq(leaveTypes.active, true))

      const out = []
      for (const type of types) {
        const balance = await ensureBalance(tx, {
          employee: ctx.employee,
          leaveType: type,
          settings,
          asOf,
        })
        out.push(toBalanceView(balance, type, asOf))
      }
      return out
    })

    return reply.send({ balances })
  })

  /**
   * Conflict preview. Shown inline before submit rather than as a rejection
   * afterwards (spec §5) — the employee should never fill in a form that was
   * always going to be refused.
   */
  app.post('/v1/leave/check-conflicts', async (request, reply) => {
    const auth = requireAuth(request)
    const body = schemas.leave.checkConflictsRequest.parse(request.body)

    const result = await tenant(request, async (tx) =>
      evaluateRequest(tx, auth.employeeId, body),
    )
    return reply.send(result)
  })

  app.post('/v1/leave/requests', async (request, reply) => {
    const auth = requireAuth(request)
    const body = schemas.leave.createLeaveRequest.parse(request.body)
    const key = idempotencyKeyFrom(request.headers as Record<string, unknown>)
    const endpoint = 'POST /v1/leave/requests'

    const result = await db.withTenant(auth.orgId, async (tx) => {
      const replay = await checkIdempotency(tx, auth.orgId, key, endpoint, body)
      if (replay) return { kind: 'replay' as const, replay }

      const evaluation = await evaluateRequest(tx, auth.employeeId, body)

      if (evaluation.daysCount === 0) {
        throw new ApiError(
          ERROR_CODES.LEAVE_NO_WORKING_DAYS,
          'That range contains no working days',
          422,
        )
      }
      if (evaluation.overlapsExistingRequest) {
        throw new ApiError(
          ERROR_CODES.LEAVE_OVERLAPPING_REQUEST,
          'You already have a request covering some of those dates',
          409,
        )
      }
      if (!evaluation.sufficientBalance) {
        // A specific, actionable code — the offline outbox must not retry this
        // forever, and the UI needs to say which day ran out (spec §6).
        throw new ApiError(
          ERROR_CODES.LEAVE_INSUFFICIENT_BALANCE,
          evaluation.shortfallOn
            ? `Your balance runs out on ${evaluation.shortfallOn}. You have ${evaluation.balanceBefore} days available.`
            : `You have ${evaluation.balanceBefore} days available and this request needs ${evaluation.daysCount}.`,
          422,
          { shortfallOn: evaluation.shortfallOn, available: evaluation.balanceBefore },
        )
      }

      const [type] = await tx
        .select()
        .from(leaveTypes)
        .where(eq(leaveTypes.id, body.leaveTypeId))
        .limit(1)

      if (!type) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Leave type not found', 404)
      if (type.requiresDocument && !body.documentUrl) {
        throw new ApiError(
          ERROR_CODES.LEAVE_DOCUMENT_REQUIRED,
          `${type.name} requires a supporting document`,
          422,
        )
      }

      const ctx = await loadEmployeeContext(tx, auth.employeeId)
      const settings = resolveSettings(ctx.org.settings)
      const asOf = orgClock(ctx.org.timezone).date
      const period = resolvePeriod(type.accrualMethod as AccrualMethod, asOf, {
        leaveYearStart: settings.leaveYearStart,
        employmentStart: ctx.employee.startDate as ISODate,
      })

      const [created] = await tx
        .insert(leaveRequests)
        .values({
          orgId: auth.orgId,
          employeeId: auth.employeeId,
          leaveTypeId: type.id,
          startDate: body.start,
          endDate: body.end,
          daysCount: String(evaluation.daysCount),
          halfDayStart: body.halfDayStart,
          halfDayEnd: body.halfDayEnd,
          reason: body.reason ?? null,
          status: 'pending',
          warnings: evaluation.warnings,
          documentUrl: body.documentUrl ?? null,
        })
        .returning()

      // Reserve the days immediately.
      await tx
        .update(leaveBalances)
        .set({ pending: sql`${leaveBalances.pending} + ${evaluation.daysCount}` })
        .where(
          and(
            eq(leaveBalances.employeeId, auth.employeeId),
            eq(leaveBalances.leaveTypeId, type.id),
            eq(leaveBalances.periodStart, period.start),
          ),
        )

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'leave_request.submitted',
        entityType: 'leave_request',
        entityId: created!.id,
        after: {
          leaveTypeId: type.id,
          start: body.start,
          end: body.end,
          daysCount: evaluation.daysCount,
          warnings: evaluation.warnings.map((w) => w.code),
        },
        ip: request.ip,
      })

      if (ctx.employee.managerId) {
        const [manager] = await tx
          .select({ userId: employees.userId })
          .from(employees)
          .where(eq(employees.id, ctx.employee.managerId))
          .limit(1)

        if (manager?.userId) {
          await queueNotification(tx, {
            orgId: auth.orgId,
            userId: manager.userId,
            event: 'leave.submitted',
            title: 'Leave request to review',
            // No leave reason in the body — it may be medical and this lands on
            // a lock screen (spec §10).
            body: `${fullName(ctx.employee)} requested ${evaluation.daysCount} day(s) from ${body.start}.`,
            deepLink: '/manage/approvals',
            data: { requestId: created!.id },
          })
        }
      }

      const view = await hydrateRequest(tx, created!)
      await recordIdempotency(tx, auth.orgId, key, endpoint, body, 201, view)
      return { kind: 'created' as const, view }
    })

    if (result.kind === 'replay') {
      return reply.status(result.replay.status).send(result.replay.body)
    }
    return reply.status(201).send(result.view)
  })

  app.get('/v1/leave/requests', async (request, reply) => {
    const auth = requireAuth(request)
    const query = schemas.leave.listLeaveRequestsQuery.parse(request.query)

    const rows = await tenant(request, async (tx) => {
      const conditions = [eq(leaveRequests.employeeId, auth.employeeId)]
      if (query.status) conditions.push(eq(leaveRequests.status, query.status))
      if (query.from) conditions.push(gte(leaveRequests.endDate, query.from))
      if (query.to) conditions.push(lte(leaveRequests.startDate, query.to))

      const requests = await tx
        .select()
        .from(leaveRequests)
        .where(and(...conditions))
        .orderBy(sql`${leaveRequests.startDate} desc`)

      return Promise.all(requests.map((r) => hydrateRequest(tx, r)))
    })

    return reply.send({ requests: rows })
  })

  app.delete('/v1/leave/requests/:id', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = request.params as { id: string }

    await tenant(request, async (tx) => {
      const [existing] = await tx
        .select()
        .from(leaveRequests)
        .where(
          and(eq(leaveRequests.id, id), eq(leaveRequests.employeeId, auth.employeeId)),
        )
        .limit(1)

      if (!existing) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Request not found', 404)
      if (existing.status !== 'pending') {
        throw new ApiError(
          ERROR_CODES.LEAVE_NOT_PENDING,
          `That request is already ${existing.status} and can no longer be cancelled`,
          409,
        )
      }

      await tx
        .update(leaveRequests)
        .set({ status: 'cancelled', decidedAt: new Date() })
        .where(eq(leaveRequests.id, id))

      await releasePending(tx, existing)

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'leave_request.cancelled',
        entityType: 'leave_request',
        entityId: id,
        before: { status: 'pending' },
        after: { status: 'cancelled' },
        ip: request.ip,
      })
    })

    return reply.status(204).send()
  })
}

// ---------------------------------------------------------------------------
// Shared leave logic, also used by the approvals route and the accrual job
// ---------------------------------------------------------------------------

export interface EvaluateInput {
  leaveTypeId: string
  start: ISODate
  end: ISODate
  halfDayStart: boolean
  halfDayEnd: boolean
}

export async function evaluateRequest(
  tx: Tx,
  employeeId: string,
  input: EvaluateInput,
  excludeRequestId?: string,
) {
  const ctx = await loadEmployeeContext(tx, employeeId)
  const settings = resolveSettings(ctx.org.settings)
  const asOf = orgClock(ctx.org.timezone).date

  const [type] = await tx
    .select()
    .from(leaveTypes)
    .where(eq(leaveTypes.id, input.leaveTypeId))
    .limit(1)

  if (!type) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Leave type not found', 404)

  const days = computeLeaveDays({
    start: input.start,
    end: input.end,
    halfDayStart: input.halfDayStart,
    halfDayEnd: input.halfDayEnd,
    schedule: ctx.schedule,
    holidays: settings.publicHolidays as ISODate[],
  })

  const balanceRow = await ensureBalance(tx, {
    employee: ctx.employee,
    leaveType: type,
    settings,
    asOf,
  })
  const balance = toDomainBalance(balanceRow)
  const balanceBefore = availableOn(balance, asOf)
  const draw = drawDown(balance, days.draws)

  // Overlap against the employee's own live requests.
  const overlapConditions = [
    eq(leaveRequests.employeeId, employeeId),
    inArray(leaveRequests.status, ['pending', 'approved']),
    lte(leaveRequests.startDate, input.end),
    gte(leaveRequests.endDate, input.start),
  ]
  if (excludeRequestId) overlapConditions.push(ne(leaveRequests.id, excludeRequestId))

  const overlapping = await tx
    .select({ id: leaveRequests.id })
    .from(leaveRequests)
    .where(and(...overlapConditions))
    .limit(1)

  const warnings = await evaluateCoverageFor(tx, ctx, input, excludeRequestId, type)

  return {
    daysCount: days.daysCount,
    workingDays: days.workingDays,
    skipped: days.skipped,
    balanceBefore,
    balanceAfter: Math.round((balanceBefore - days.daysCount) * 100) / 100,
    sufficientBalance: draw.ok,
    shortfallOn: draw.shortfallOn,
    expiredMidRequest: draw.expiredMidRequest,
    overlapsExistingRequest: overlapping.length > 0,
    warnings,
  }
}

async function evaluateCoverageFor(
  tx: Tx,
  ctx: Awaited<ReturnType<typeof loadEmployeeContext>>,
  input: EvaluateInput,
  excludeRequestId: string | undefined,
  type: typeof leaveTypes.$inferSelect,
): Promise<CoverageWarning[]> {
  if (!ctx.employee.departmentId) return []

  const [rule] = await tx
    .select()
    .from(coverageRules)
    .where(eq(coverageRules.departmentId, ctx.employee.departmentId))
    .limit(1)

  const noticeDays = diffDays(orgClock(ctx.org.timezone).date, input.start)

  if (!rule) {
    // Notice is a leave-type property, so it still applies with no coverage rule.
    return evaluateCoverage({
      request: {
        employeeId: ctx.employee.id,
        roleId: ctx.employee.roleId,
        start: input.start,
        end: input.end,
      },
      rule: {
        maxConcurrentAbsent: null,
        maxConcurrentPercent: null,
        blackoutPeriods: [],
        criticalRoleIds: [],
      },
      existingAbsences: [],
      departmentHeadcount: 0,
      noticeDays,
      minNoticeDays: type.minNoticeDays,
    })
  }

  const teamConditions = [
    eq(employees.departmentId, ctx.employee.departmentId),
    eq(employees.status, 'active'),
  ]
  const team = await tx
    .select({ id: employees.id, roleId: employees.roleId })
    .from(employees)
    .where(and(...teamConditions))

  const absenceConditions = [
    inArray(leaveRequests.status, ['pending', 'approved']),
    inArray(
      leaveRequests.employeeId,
      team.map((t) => t.id),
    ),
    lte(leaveRequests.startDate, input.end),
    gte(leaveRequests.endDate, input.start),
  ]
  if (excludeRequestId) absenceConditions.push(ne(leaveRequests.id, excludeRequestId))

  const absences = await tx
    .select({
      employeeId: leaveRequests.employeeId,
      start: leaveRequests.startDate,
      end: leaveRequests.endDate,
    })
    .from(leaveRequests)
    .where(and(...absenceConditions))

  const roleById = new Map(team.map((t) => [t.id, t.roleId]))

  return evaluateCoverage({
    request: {
      employeeId: ctx.employee.id,
      roleId: ctx.employee.roleId,
      start: input.start,
      end: input.end,
    },
    rule: {
      maxConcurrentAbsent: rule.maxConcurrentAbsent,
      maxConcurrentPercent: rule.maxConcurrentPercent ? num(rule.maxConcurrentPercent) : null,
      blackoutPeriods: (rule.blackoutPeriods ?? []) as never,
      criticalRoleIds: rule.criticalRoleIds,
    },
    existingAbsences: absences.map((a) => ({
      employeeId: a.employeeId,
      roleId: roleById.get(a.employeeId) ?? null,
      start: a.start as ISODate,
      end: a.end as ISODate,
    })),
    departmentHeadcount: team.length,
    noticeDays,
    minNoticeDays: type.minNoticeDays,
  })
}

export interface EnsureBalanceInput {
  employee: typeof employees.$inferSelect
  leaveType: typeof leaveTypes.$inferSelect
  settings: ReturnType<typeof resolveSettings>
  asOf: ISODate
}

/**
 * Reads the materialised balance, creating it on demand if the nightly job has
 * not run for this employee and period yet.
 *
 * `leave_balances` is materialised rather than computed on read (spec §3), but
 * a new hire must not see an empty screen until midnight.
 */
export async function ensureBalance(
  tx: Tx,
  input: EnsureBalanceInput,
): Promise<typeof leaveBalances.$inferSelect> {
  const method = input.leaveType.accrualMethod as AccrualMethod
  const period = resolvePeriod(method, input.asOf, {
    leaveYearStart: input.settings.leaveYearStart,
    employmentStart: input.employee.startDate as ISODate,
  })

  const [existing] = await tx
    .select()
    .from(leaveBalances)
    .where(
      and(
        eq(leaveBalances.employeeId, input.employee.id),
        eq(leaveBalances.leaveTypeId, input.leaveType.id),
        eq(leaveBalances.periodStart, period.start),
      ),
    )
    .limit(1)

  if (existing) return existing

  const accrual =
    method === 'per_hours_worked'
      ? { accrued: 0 }
      : computeAccrual({
          leaveType: toLeaveTypeConfig(input.leaveType),
          employment: {
            startDate: input.employee.startDate as ISODate,
            endDate: (input.employee.endDate as ISODate | null) ?? null,
          },
          period,
          asOf: input.asOf,
          rounding: input.settings.proRataRounding,
        })

  const [created] = await tx
    .insert(leaveBalances)
    .values({
      orgId: input.employee.orgId,
      employeeId: input.employee.id,
      leaveTypeId: input.leaveType.id,
      periodStart: period.start,
      periodEnd: period.end,
      accrued: String(accrual.accrued),
    })
    .onConflictDoNothing()
    .returning()

  if (created) return created

  // Lost a race with a concurrent insert — read the winner.
  const [row] = await tx
    .select()
    .from(leaveBalances)
    .where(
      and(
        eq(leaveBalances.employeeId, input.employee.id),
        eq(leaveBalances.leaveTypeId, input.leaveType.id),
        eq(leaveBalances.periodStart, period.start),
      ),
    )
    .limit(1)

  if (!row) throw new ApiError(ERROR_CODES.INTERNAL, 'Could not materialise balance', 500)
  return row
}

/** Releases the reservation a pending request held. */
export async function releasePending(
  tx: Tx,
  request: typeof leaveRequests.$inferSelect,
): Promise<void> {
  await tx
    .update(leaveBalances)
    .set({
      pending: sql`greatest(0, ${leaveBalances.pending} - ${num(request.daysCount)})`,
    })
    .where(
      and(
        eq(leaveBalances.employeeId, request.employeeId),
        eq(leaveBalances.leaveTypeId, request.leaveTypeId),
        lte(leaveBalances.periodStart, request.startDate),
        gte(leaveBalances.periodEnd, request.startDate),
      ),
    )
}

/** Moves a reservation from `pending` to `taken` on approval. */
export async function commitTaken(
  tx: Tx,
  request: typeof leaveRequests.$inferSelect,
): Promise<void> {
  const days = num(request.daysCount)
  await tx
    .update(leaveBalances)
    .set({
      pending: sql`greatest(0, ${leaveBalances.pending} - ${days})`,
      taken: sql`${leaveBalances.taken} + ${days}`,
    })
    .where(
      and(
        eq(leaveBalances.employeeId, request.employeeId),
        eq(leaveBalances.leaveTypeId, request.leaveTypeId),
        lte(leaveBalances.periodStart, request.startDate),
        gte(leaveBalances.periodEnd, request.startDate),
      ),
    )
}

export function toDomainBalance(row: typeof leaveBalances.$inferSelect): LeaveBalance {
  return {
    accrued: num(row.accrued),
    carriedOver: num(row.carriedOver),
    adjustment: num(row.adjustment),
    taken: num(row.taken),
    pending: num(row.pending),
    carryoverExpiresOn: (row.carryoverExpiresOn as ISODate | null) ?? null,
  }
}

export function toLeaveTypeConfig(t: typeof leaveTypes.$inferSelect): LeaveTypeConfig {
  return {
    id: t.id,
    name: t.name,
    accrualMethod: t.accrualMethod as AccrualMethod,
    accrualRate: num(t.accrualRate),
    maxBalance: t.maxBalance === null ? null : num(t.maxBalance),
    carryoverCap: t.carryoverCap === null ? null : num(t.carryoverCap),
    carryoverExpiryMonths: t.carryoverExpiryMonths,
  }
}

export function toLeaveTypeView(t: typeof leaveTypes.$inferSelect) {
  return {
    id: t.id,
    name: t.name,
    accrualMethod: t.accrualMethod,
    accrualRate: num(t.accrualRate),
    maxBalance: t.maxBalance === null ? null : num(t.maxBalance),
    carryoverCap: t.carryoverCap === null ? null : num(t.carryoverCap),
    carryoverExpiryMonths: t.carryoverExpiryMonths,
    requiresDocument: t.requiresDocument,
    minNoticeDays: t.minNoticeDays,
    isPaid: t.isPaid,
    colour: t.colour,
  }
}

export function toBalanceView(
  row: typeof leaveBalances.$inferSelect,
  type: typeof leaveTypes.$inferSelect,
  asOf: ISODate,
) {
  const domain = toDomainBalance(row)
  return {
    leaveTypeId: type.id,
    leaveTypeName: type.name,
    colour: type.colour,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    accrued: domain.accrued,
    taken: domain.taken,
    pending: domain.pending,
    carriedOver: domain.carriedOver,
    adjustment: domain.adjustment,
    available: availableOn(domain, asOf),
    carryoverExpiresOn: row.carryoverExpiresOn,
  }
}

export async function hydrateRequest(
  tx: Tx,
  r: typeof leaveRequests.$inferSelect,
) {
  const [type] = await tx
    .select({ name: leaveTypes.name, colour: leaveTypes.colour })
    .from(leaveTypes)
    .where(eq(leaveTypes.id, r.leaveTypeId))
    .limit(1)

  const [employee] = await tx
    .select({ firstName: employees.firstName, lastName: employees.lastName })
    .from(employees)
    .where(eq(employees.id, r.employeeId))
    .limit(1)

  let decidedByName: string | null = null
  if (r.decidedBy) {
    const [decider] = await tx
      .select({ firstName: employees.firstName, lastName: employees.lastName })
      .from(employees)
      .where(eq(employees.userId, r.decidedBy))
      .limit(1)
    decidedByName = decider ? fullName(decider) : null
  }

  return {
    id: r.id,
    leaveTypeId: r.leaveTypeId,
    leaveTypeName: type?.name ?? 'Leave',
    colour: type?.colour ?? '#4F46E5',
    employeeId: r.employeeId,
    employeeName: employee ? fullName(employee) : '',
    start: r.startDate,
    end: r.endDate,
    daysCount: num(r.daysCount),
    halfDayStart: r.halfDayStart,
    halfDayEnd: r.halfDayEnd,
    reason: r.reason,
    status: r.status,
    submittedAt: r.submittedAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decidedByName,
    decisionNote: r.decisionNote,
    overrideReason: r.overrideReason,
    documentUrl: r.documentUrl,
    warnings: (r.warnings ?? []) as CoverageWarning[],
  }
}
