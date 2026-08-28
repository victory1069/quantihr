/**
 * Nightly accrual run (spec §8).
 *
 * Runs per org, in the org's timezone, and writes materialised rows to
 * `leave_balances`. The arithmetic itself lives in `@quanti/shared` and is
 * tested there against mid-year joiners, leavers, leap years and carryover
 * expiry; this file is only responsible for iterating the right employees and
 * persisting the result.
 *
 * The job is idempotent. Running it twice on the same day produces the same
 * balances, because `accrued` is recomputed from the employment window rather
 * than incremented.
 */

import { and, eq, ne } from 'drizzle-orm'
import {
  AccrualNotImplementedError,
  addYears,
  availableOn,
  computeAccrual,
  computeCarryover,
  diffDays,
  resolvePeriod,
  type AccrualMethod,
  type ISODate,
} from '@quanti/shared'
import { employees, leaveBalances, leaveTypes } from '../db/schema.js'
import type { Database, Tx } from '../db/client.js'
import { queueNotification } from '../lib/notify.js'
import { orgClock } from '../lib/time.js'
import { toDomainBalance, toLeaveTypeConfig } from '../routes/leave.js'
import { num, resolveSettings } from '../routes/shared.js'

export interface AccrualRunSummary {
  orgId: string
  asOf: ISODate
  employeesProcessed: number
  balancesWritten: number
  carryoversApplied: number
  expiryWarningsSent: number
  skipped: { employeeId: string; leaveTypeId: string; reason: string }[]
}

export async function runAccrualForOrg(
  db: Database,
  org: { orgId: string; timezone: string; settings: Record<string, unknown> },
): Promise<AccrualRunSummary> {
  const settings = resolveSettings(org.settings)
  const asOf = orgClock(org.timezone).date

  const summary: AccrualRunSummary = {
    orgId: org.orgId,
    asOf,
    employeesProcessed: 0,
    balancesWritten: 0,
    carryoversApplied: 0,
    expiryWarningsSent: 0,
    skipped: [],
  }

  await db.withTenant(org.orgId, async (tx) => {
    const staff = await tx
      .select()
      .from(employees)
      .where(ne(employees.status, 'terminated'))

    const types = await tx.select().from(leaveTypes).where(eq(leaveTypes.active, true))

    for (const employee of staff) {
      summary.employeesProcessed += 1

      for (const type of types) {
        const method = type.accrualMethod as AccrualMethod
        const period = resolvePeriod(method, asOf, {
          leaveYearStart: settings.leaveYearStart,
          employmentStart: employee.startDate as ISODate,
        })

        let accrued: number
        try {
          accrued = computeAccrual({
            leaveType: toLeaveTypeConfig(type),
            employment: {
              startDate: employee.startDate as ISODate,
              endDate: (employee.endDate as ISODate | null) ?? null,
            },
            period,
            asOf,
            rounding: settings.proRataRounding,
          }).accrued
        } catch (error) {
          if (error instanceof AccrualNotImplementedError) {
            // `per_hours_worked` is a stubbed interface (spec §8). Skip loudly
            // rather than silently writing a zero balance an employee will
            // read as "I have no leave".
            summary.skipped.push({
              employeeId: employee.id,
              leaveTypeId: type.id,
              reason: error.message,
            })
            continue
          }
          throw error
        }

        const carryover = await applyCarryoverIfNeeded(tx, {
          orgId: org.orgId,
          employeeId: employee.id,
          type,
          period,
          asOf,
        })
        if (carryover.applied) summary.carryoversApplied += 1

        await tx
          .insert(leaveBalances)
          .values({
            orgId: org.orgId,
            employeeId: employee.id,
            leaveTypeId: type.id,
            periodStart: period.start,
            periodEnd: period.end,
            accrued: String(accrued),
            carriedOver: String(carryover.carriedOver),
            carryoverExpiresOn: carryover.expiresOn,
            computedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              leaveBalances.orgId,
              leaveBalances.employeeId,
              leaveBalances.leaveTypeId,
              leaveBalances.periodStart,
            ],
            // `taken` and `pending` are owned by the request flow, and
            // `adjustment` by HR. The job must never overwrite them.
            set: {
              accrued: String(accrued),
              periodEnd: period.end,
              computedAt: new Date(),
              ...(carryover.applied
                ? {
                    carriedOver: String(carryover.carriedOver),
                    carryoverExpiresOn: carryover.expiresOn,
                  }
                : {}),
            },
          })

        summary.balancesWritten += 1
      }
    }

    summary.expiryWarningsSent = await sendExpiryWarnings(tx, {
      orgId: org.orgId,
      asOf,
      warningDays: settings.balanceExpiryWarningDays,
    })
  })

  return summary
}

interface CarryoverInput {
  orgId: string
  employeeId: string
  type: typeof leaveTypes.$inferSelect
  period: { start: ISODate; end: ISODate }
  asOf: ISODate
}

/**
 * Carries the previous period's remaining balance forward, once.
 *
 * Guarded on the current row having no carryover yet, so a second run on the
 * same day does not stack a second carryover on top of the first.
 */
async function applyCarryoverIfNeeded(
  tx: Tx,
  input: CarryoverInput,
): Promise<{ applied: boolean; carriedOver: number; expiresOn: ISODate | null }> {
  const [current] = await tx
    .select()
    .from(leaveBalances)
    .where(
      and(
        eq(leaveBalances.employeeId, input.employeeId),
        eq(leaveBalances.leaveTypeId, input.type.id),
        eq(leaveBalances.periodStart, input.period.start),
      ),
    )
    .limit(1)

  if (current && num(current.carriedOver) > 0) {
    return {
      applied: false,
      carriedOver: num(current.carriedOver),
      expiresOn: (current.carryoverExpiresOn as ISODate | null) ?? null,
    }
  }

  const previousStart = previousPeriodStart(input.period.start)
  const [previous] = await tx
    .select()
    .from(leaveBalances)
    .where(
      and(
        eq(leaveBalances.employeeId, input.employeeId),
        eq(leaveBalances.leaveTypeId, input.type.id),
        eq(leaveBalances.periodStart, previousStart),
      ),
    )
    .limit(1)

  if (!previous) return { applied: false, carriedOver: 0, expiresOn: null }

  const remaining = availableOn(toDomainBalance(previous), previous.periodEnd as ISODate)
  const result = computeCarryover(
    remaining,
    toLeaveTypeConfig(input.type),
    input.period.start,
  )

  return {
    applied: result.carriedOver > 0,
    carriedOver: result.carriedOver,
    expiresOn: result.expiresOn,
  }
}

function previousPeriodStart(start: ISODate): ISODate {
  return addYears(start, -1)
}

interface ExpiryInput {
  orgId: string
  asOf: ISODate
  warningDays: number
}

async function sendExpiryWarnings(tx: Tx, input: ExpiryInput): Promise<number> {
  const rows = await tx
    .select({
      employeeId: leaveBalances.employeeId,
      leaveTypeId: leaveBalances.leaveTypeId,
      carriedOver: leaveBalances.carriedOver,
      expiresOn: leaveBalances.carryoverExpiresOn,
      typeName: leaveTypes.name,
      userId: employees.userId,
    })
    .from(leaveBalances)
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveBalances.leaveTypeId))
    .innerJoin(employees, eq(employees.id, leaveBalances.employeeId))

  let sent = 0
  for (const row of rows) {
    if (!row.expiresOn || !row.userId) continue
    const days = num(row.carriedOver)
    if (days <= 0) continue

    const until = diffDays(input.asOf, row.expiresOn as ISODate)
    if (until < 0 || until > input.warningDays) continue

    await queueNotification(tx, {
      orgId: input.orgId,
      userId: row.userId,
      event: 'balance.expiring',
      title: 'Leave expiring soon',
      body: `${days} carried-over ${row.typeName} day(s) expire on ${row.expiresOn}.`,
      deepLink: '/leave',
      data: { leaveTypeId: row.leaveTypeId, expiresOn: row.expiresOn },
    })
    sent += 1
  }

  return sent
}

export async function runAccrual(db: Database): Promise<AccrualRunSummary[]> {
  const orgs = await db.lookup.orgs()
  const summaries: AccrualRunSummary[] = []
  for (const org of orgs) {
    summaries.push(await runAccrualForOrg(db, org))
  }
  return summaries
}
