/**
 * Notification dispatch.
 *
 * Every notification is persisted before it is sent, so a push that fails is
 * still visible in the app rather than lost. Content rules from spec §10 are
 * enforced here rather than at each call site: nothing that shouldn't sit on a
 * lock screen goes into a title or body — no leave reasons, no disciplinary
 * detail, no figures.
 */

import { eq, isNull } from 'drizzle-orm'
import { notifications, users } from '../db/schema.js'
import type { Database, Tx } from '../db/client.js'
import { env } from './env.js'

export type NotificationEvent =
  | 'leave.decided'
  | 'leave.submitted'
  | 'leave.pending_48h'
  | 'checkin.window_opening'
  | 'balance.expiring'
  | 'document.uploaded'
  | 'payslip.ready'

export interface NotificationInput {
  orgId: string
  userId: string
  event: NotificationEvent
  title: string
  body: string
  deepLink: string
  data?: Record<string, unknown>
}

/** Which preference key gates each event. */
const PREFERENCE_KEY: Record<NotificationEvent, string> = {
  'leave.decided': 'leaveDecisions',
  'leave.submitted': 'leaveDecisions',
  'leave.pending_48h': 'leaveDecisions',
  'checkin.window_opening': 'checkinReminders',
  'balance.expiring': 'balanceExpiry',
  'document.uploaded': 'documents',
  // Payslip alerts are not opt-out: an employee must be told their pay is
  // ready. The figure itself never appears in the preview (spec §5.5).
  'payslip.ready': 'payslips',
}

/**
 * Actions offered on the notification itself.
 *
 * Approving from the notification is the single biggest lever on approval
 * latency, which is the metric employees judge the product on (spec §10).
 */
export const NOTIFICATION_ACTIONS: Partial<Record<NotificationEvent, string[]>> = {
  'leave.submitted': ['approve', 'decline'],
  'leave.pending_48h': ['approve', 'decline'],
}

export async function queueNotification(tx: Tx, input: NotificationInput): Promise<void> {
  const [user] = await tx
    .select({ prefs: users.notificationPreferences, pushToken: users.pushToken })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1)

  if (!user) return

  const prefs = (user.prefs ?? {}) as Record<string, boolean>
  const key = PREFERENCE_KEY[input.event]
  if (prefs[key] === false) return

  await tx.insert(notifications).values({
    orgId: input.orgId,
    userId: input.userId,
    event: input.event,
    title: input.title,
    body: input.body,
    deepLink: input.deepLink,
    data: {
      ...(input.data ?? {}),
      ...(NOTIFICATION_ACTIONS[input.event]
        ? { actions: NOTIFICATION_ACTIONS[input.event] }
        : {}),
    },
  })
}

export interface PushMessage {
  to: string
  title: string
  body: string
  data: Record<string, unknown>
  categoryId?: string
}

/**
 * Drains unsent notifications and pushes them.
 *
 * Split from `queueNotification` so the sending side can fail, retry, or be
 * swapped for Expo Push without touching any handler.
 */
export async function flushNotifications(db: Database, orgId: string): Promise<number> {
  const pending = await db.withTenant(orgId, async (tx) =>
    tx
      .select({
        id: notifications.id,
        userId: notifications.userId,
        event: notifications.event,
        title: notifications.title,
        body: notifications.body,
        deepLink: notifications.deepLink,
        data: notifications.data,
        pushToken: users.pushToken,
      })
      .from(notifications)
      .innerJoin(users, eq(users.id, notifications.userId))
      // `= NULL` matches nothing in SQL — this must be IS NULL or the queue
      // never drains.
      .where(isNull(notifications.sentAt))
      .limit(200),
  )

  const sendable = pending.filter((n) => n.pushToken)
  if (sendable.length > 0) {
    const messages: PushMessage[] = sendable.map((n) => ({
      to: n.pushToken!,
      title: n.title,
      body: n.body,
      data: { ...(n.data as object), deepLink: n.deepLink },
      categoryId: NOTIFICATION_ACTIONS[n.event as NotificationEvent] ? 'leave_approval' : undefined,
    }))
    await deliver(messages)
  }

  if (pending.length > 0) {
    await db.withTenant(orgId, async (tx) => {
      for (const n of pending) {
        await tx
          .update(notifications)
          .set({ sentAt: new Date() })
          .where(eq(notifications.id, n.id))
      }
    })
  }

  return pending.length
}

async function deliver(messages: PushMessage[]): Promise<void> {
  if (env().PUSH_DRIVER === 'console') {
    for (const m of messages) {
      // eslint-disable-next-line no-console
      console.log(`[push] → ${m.to}: ${m.title} — ${m.body}`)
    }
    return
  }

  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(messages),
  })
  if (!response.ok) {
    throw new Error(`Expo push failed: ${response.status} ${await response.text()}`)
  }
}
