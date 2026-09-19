/**
 * Training follow-up.
 *
 * Runs on the same cadence as the other sweeps. For every course on an
 * approved plan it sends, at most once each:
 *
 *   starts     — on the start date: "X starts today"
 *   proof_due  — on the end date: "X ended today — send proof"
 *   nudge_1/2/3 — 3, 7 and 14 days after the end, while nothing has come in
 *
 * and after the third nudge it stops. A course that was never evidenced
 * stays `planned` on the record; the manager can see it, and nobody is
 * nagged forever. Separately, five days before a period ends, anyone with
 * no plan for the next period is asked to write one — once.
 *
 * `last_reminder` on the item is the idempotency key: the sweep can run as
 * often as it likes and each message still goes out once.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import { addDays, type ISODate } from '@quanti/shared'
import { employees, notifications, trainingItems, trainingPlans } from '../db/schema.js'
import type { Database, Tx } from '../db/client.js'
import { queueNotification } from '../lib/notify.js'
import { orgClock } from '../lib/time.js'
import { periodLabel, periodStartFor } from '../routes/training.js'

const NUDGES: { key: string; afterDays: number }[] = [
  { key: 'nudge_1', afterDays: 3 },
  { key: 'nudge_2', afterDays: 7 },
  { key: 'nudge_3', afterDays: 14 },
]

const PLAN_DUE_DAYS_BEFORE = 5

export async function sweepTrainingReminders(db: Database): Promise<number> {
  const orgs = await db.lookup.orgs()
  let sent = 0

  for (const org of orgs) {
    await db.withTenant(org.orgId, async (tx) => {
      const today = orgClock(org.timezone).date as ISODate

      const open = await tx
        .select({ item: trainingItems, userId: employees.userId })
        .from(trainingItems)
        .innerJoin(trainingPlans, eq(trainingPlans.id, trainingItems.planId))
        .innerJoin(employees, eq(employees.id, trainingItems.employeeId))
        .where(and(eq(trainingPlans.status, 'approved'), eq(trainingItems.status, 'planned')))

      for (const { item, userId } of open) {
        if (!userId) continue
        const due = nextReminder(item, today)
        if (!due) continue

        await queueNotification(tx, {
          orgId: org.orgId,
          userId,
          event: due.event,
          title: due.title,
          body: due.body,
          deepLink: '/learning',
          data: { itemId: item.id, reminder: due.key },
        })
        await tx
          .update(trainingItems)
          .set({ lastReminder: due.key, lastReminderAt: new Date() })
          .where(eq(trainingItems.id, item.id))
        sent += 1
      }

      sent += await remindPlanDue(tx, org.orgId, today)
    })
  }

  return sent
}

interface Due {
  key: string
  event: 'training.starts' | 'training.proof_due'
  title: string
  body: string
}

function nextReminder(
  item: typeof trainingItems.$inferSelect,
  today: ISODate,
): Due | null {
  const sent = item.lastReminder
  const where = item.mode === 'physical' ? 'in person' : 'online'

  if (!sent && today >= item.startDate && today < item.endDate) {
    return {
      key: 'starts',
      event: 'training.starts',
      title: `${item.title} starts today`,
      body: `${where}${item.provider ? ` · ${item.provider}` : ''} · ends ${item.endDate}. Keep your certificate or a screenshot — we'll ask for it.`,
    }
  }

  if ((!sent || sent === 'starts') && today >= item.endDate) {
    return {
      key: 'proof_due',
      event: 'training.proof_due',
      title: `${item.title} has ended — send your proof`,
      body: 'A certificate, a screenshot, or a sentence on what you completed. It goes on your record.',
    }
  }

  if (sent === 'proof_due' || sent?.startsWith('nudge_')) {
    const index = sent === 'proof_due' ? 0 : NUDGES.findIndex((n) => n.key === sent) + 1
    const next = NUDGES[index]
    if (!next) return null
    if (today < addDays(item.endDate as ISODate, next.afterDays)) return null
    return {
      key: next.key,
      event: 'training.proof_due',
      title: `Still waiting on proof for ${item.title}`,
      body:
        index === NUDGES.length - 1
          ? 'This is the last reminder. Without proof the course stays unverified on your record.'
          : 'A certificate, a screenshot, or a sentence on what you completed.',
    }
  }

  return null
}

/**
 * Five days before the month ends, everyone active with no plan for next
 * month is asked for one. Once: the notification itself is the marker, so a
 * second sweep the same week finds it and moves on.
 */
async function remindPlanDue(
  tx: Tx,
  orgId: string,
  today: ISODate,
): Promise<number> {
  const nextMonth = periodStartFor('month', addDays(today, PLAN_DUE_DAYS_BEFORE + 1))
  const thisMonth = periodStartFor('month', today)
  // Only in the window: from five days before month end until the month ends.
  if (nextMonth === thisMonth) return 0

  const staff = await tx
    .select({ id: employees.id, userId: employees.userId })
    .from(employees)
    .where(eq(employees.status, 'active'))
  if (staff.length === 0) return 0

  const planned = await tx
    .select({ employeeId: trainingPlans.employeeId })
    .from(trainingPlans)
    .where(
      and(
        inArray(trainingPlans.employeeId, staff.map((s) => s.id)),
        eq(trainingPlans.periodStart, nextMonth),
      ),
    )
  const hasPlan = new Set(planned.map((p) => p.employeeId))

  const already = await tx
    .select({ userId: notifications.userId })
    .from(notifications)
    .where(
      and(
        eq(notifications.event, 'training.plan_due'),
        sql`${notifications.data} ->> 'periodStart' = ${nextMonth}`,
      ),
    )
  const nudged = new Set(already.map((a) => a.userId))

  let sent = 0
  for (const member of staff) {
    if (!member.userId || hasPlan.has(member.id) || nudged.has(member.userId)) continue
    await queueNotification(tx, {
      orgId,
      userId: member.userId,
      event: 'training.plan_due',
      title: `Plan your training for ${periodLabel('month', nextMonth)}`,
      body: 'What will you attend next month, and why? Your manager approves it before it starts.',
      deepLink: '/learning',
      data: { periodStart: nextMonth },
    })
    sent += 1
  }
  return sent
}

export const _internal = { nextReminder }
