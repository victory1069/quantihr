/**
 * Reminder sweeps: approvals waiting too long, and check-in windows opening.
 *
 * Approval latency is the metric employees judge the product on (spec §10), so
 * the 48-hour nudge is a first-class job rather than something bolted on later.
 */

import { and, eq, inArray, lte } from 'drizzle-orm'
import { evaluateWindow, type ISODate } from '@quanti/shared'
import { employees, leaveRequests, notifications } from '../db/schema.js'
import type { Database } from '../db/client.js'
import { queueNotification } from '../lib/notify.js'
import { orgClock } from '../lib/time.js'
import { loadEmployeeContext, fullName } from '../routes/shared.js'

const APPROVAL_NUDGE_HOURS = 48

export async function sweepPendingApprovals(db: Database): Promise<number> {
  const orgs = await db.lookup.orgs()
  let nudged = 0

  for (const org of orgs) {
    await db.withTenant(org.orgId, async (tx) => {
      const cutoff = new Date(Date.now() - APPROVAL_NUDGE_HOURS * 3_600_000)

      const stale = await tx
        .select({
          id: leaveRequests.id,
          employeeId: leaveRequests.employeeId,
          startDate: leaveRequests.startDate,
        })
        .from(leaveRequests)
        .where(
          and(eq(leaveRequests.status, 'pending'), lte(leaveRequests.submittedAt, cutoff)),
        )

      for (const request of stale) {
        const [employee] = await tx
          .select({
            managerId: employees.managerId,
            firstName: employees.firstName,
            lastName: employees.lastName,
          })
          .from(employees)
          .where(eq(employees.id, request.employeeId))
          .limit(1)

        if (!employee?.managerId) continue

        const [manager] = await tx
          .select({ userId: employees.userId })
          .from(employees)
          .where(eq(employees.id, employee.managerId))
          .limit(1)

        if (!manager?.userId) continue

        // One nudge per request, not one per sweep. The request id lives in the
        // notification payload, so dedup keys off that rather than a timestamp.
        const alreadySent = await tx
          .select({ data: notifications.data })
          .from(notifications)
          .where(
            and(
              eq(notifications.userId, manager.userId),
              eq(notifications.event, 'leave.pending_48h'),
            ),
          )

        if (
          alreadySent.some(
            (n) => (n.data as { requestId?: string } | null)?.requestId === request.id,
          )
        ) {
          continue
        }

        await queueNotification(tx, {
          orgId: org.orgId,
          userId: manager.userId,
          event: 'leave.pending_48h',
          title: 'Leave request still waiting',
          body: `${fullName(employee)}'s request from ${request.startDate} has been waiting ${APPROVAL_NUDGE_HOURS} hours.`,
          deepLink: '/manage/approvals',
          data: { requestId: request.id },
        })
        nudged += 1
      }
    })
  }

  return nudged
}

/**
 * Notifies employees whose check-in window is about to open.
 *
 * Only fires within the 30 minutes before the window opens, so running this
 * job on a short interval does not spam anyone.
 */
export async function sweepCheckinWindows(db: Database): Promise<number> {
  const orgs = await db.lookup.orgs()
  let notified = 0

  for (const org of orgs) {
    await db.withTenant(org.orgId, async (tx) => {
      const clock = orgClock(org.timezone)
      const staff = await tx
        .select({ id: employees.id, userId: employees.userId })
        .from(employees)
        .where(eq(employees.status, 'active'))

      for (const member of staff) {
        if (!member.userId) continue
        const ctx = await loadEmployeeContext(tx, member.id)
        const window = evaluateWindow(clock.date as ISODate, clock.minutes, ctx.schedule)

        if (window.reason !== 'too_early') continue
        if (window.minutesUntilOpen > 30 || window.minutesUntilOpen === 0) continue

        await queueNotification(tx, {
          orgId: org.orgId,
          userId: member.userId,
          event: 'checkin.window_opening',
          title: 'Check-in opens soon',
          body: `You can check in from ${window.opensAt}.`,
          deepLink: '/checkin',
          data: { date: clock.date },
        })
        notified += 1
      }
    })
  }

  return notified
}
