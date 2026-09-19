/**
 * Learning & development: the plan goes to the manager, the decision comes
 * back, and the follow-up runs itself.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import type { Database } from '../src/db/client.js'
import { trainingItems, trainingPlans } from '../src/db/schema.js'
import { sweepTrainingReminders, _internal } from '../src/jobs/training.js'
import { bearer, makeDatabase, makeOrg, type TestOrg } from './helpers.js'

let db: Database
let app: FastifyInstance
let org: TestOrg

const today = new Date().toISOString().slice(0, 10)
const plus = (days: number) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const inbox = async (token: string) =>
  (await app.inject({ method: 'GET', url: '/v1/notifications', headers: bearer(token) })).json()
    .notifications as { event: string; title: string; data: Record<string, unknown> }[]

beforeAll(async () => {
  db = await makeDatabase()
  org = await makeOrg(db, 'acme')
  app = await buildServer(db)
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await db.close()
})

const plan = (overrides: Record<string, unknown> = {}) => ({
  periodType: 'month',
  periodStart: plus(35),
  items: [
    {
      title: 'Advanced Excel for finance',
      provider: 'Udemy',
      mode: 'virtual',
      startDate: plus(40),
      endDate: plus(42),
      need: 'Month-end close still takes me three days; pivot and Power Query would halve it.',
      costKobo: 1_500_000,
    },
  ],
  ...overrides,
})

describe('planning', () => {
  it('creates a draft, replaces it on resubmission, and snaps to the period start', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/training/plans',
      headers: bearer(org.accessToken),
      payload: plan(),
    })
    expect(first.statusCode).toBe(201)
    expect(first.json().status).toBe('draft')
    expect(first.json().periodStart.endsWith('-01')).toBe(true)
    expect(first.json().items).toHaveLength(1)

    const second = await app.inject({
      method: 'POST',
      url: '/v1/training/plans',
      headers: bearer(org.accessToken),
      payload: plan({
        items: [
          ...plan().items,
          {
            title: 'First aid at work',
            mode: 'physical',
            startDate: plus(45),
            endDate: plus(45),
            need: 'We have no trained first-aider on the floor since Ade left.',
          },
        ],
      }),
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().id).toBe(first.json().id)
    expect(second.json().items).toHaveLength(2)
  })

  it('rejects an item with no stated need', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/training/plans',
      headers: bearer(org.accessToken),
      payload: plan({ items: [{ ...plan().items[0], need: 'because' }] }),
    })
    expect(res.statusCode).toBe(422)
  })
})

describe('approval', () => {
  let planId: string

  it('submitting tells the manager and freezes the plan', async () => {
    const mine = await app.inject({ method: 'GET', url: '/v1/training/plans', headers: bearer(org.accessToken) })
    planId = mine.json().plans[0].id

    const res = await app.inject({
      method: 'POST',
      url: `/v1/training/plans/${planId}/submit`,
      headers: bearer(org.accessToken),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('submitted')

    const managerInbox = await inbox(org.managerToken)
    const note = managerInbox.find((n) => n.event === 'training.plan_submitted')
    expect(note?.title).toContain('planned training for')

    const edit = await app.inject({
      method: 'POST',
      url: '/v1/training/plans',
      headers: bearer(org.accessToken),
      payload: plan(),
    })
    expect(edit.statusCode).toBe(409)
  })

  it('shows the manager their reports, waiting first', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/team/training', headers: bearer(org.managerToken) })
    expect(res.statusCode).toBe(200)
    expect(res.json().plans[0].id).toBe(planId)
    expect(res.json().plans[0].employeeName).toBeTruthy()
  })

  it('requires a reason to decline or ask for changes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/team/training/${planId}`,
      headers: bearer(org.managerToken),
      payload: { decision: 'request_changes' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('changes requested reopens the plan; approval tells the employee', async () => {
    const changes = await app.inject({
      method: 'POST',
      url: `/v1/team/training/${planId}`,
      headers: bearer(org.managerToken),
      payload: { decision: 'request_changes', note: 'Drop the Excel course — finance is moving to Sheets.' },
    })
    expect(changes.json().status).toBe('changes_requested')

    const employeeInbox = await inbox(org.accessToken)
    expect(employeeInbox.find((n) => n.event === 'training.plan_decided')?.title).toContain('Changes requested')

    // Editable again, then resubmitted and approved.
    const edit = await app.inject({
      method: 'POST',
      url: '/v1/training/plans',
      headers: bearer(org.accessToken),
      payload: plan({
        items: [
          {
            title: 'Google Sheets for finance',
            mode: 'virtual',
            startDate: plus(40),
            endDate: plus(42),
            need: 'Finance is moving to Sheets and I have only ever used Excel.',
          },
        ],
      }),
    })
    expect(edit.statusCode).toBe(200)
    await app.inject({ method: 'POST', url: `/v1/training/plans/${planId}/submit`, headers: bearer(org.accessToken) })

    const approve = await app.inject({
      method: 'POST',
      url: `/v1/team/training/${planId}`,
      headers: bearer(org.managerToken),
      payload: { decision: 'approve' },
    })
    expect(approve.json().status).toBe('approved')
    expect((await inbox(org.accessToken)).some((n) => n.title.includes('is approved'))).toBe(true)
  })

  it('does not let someone who is not the manager decide', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/team/training/${planId}`,
      headers: bearer(org.accessToken),
      payload: { decision: 'approve' },
    })
    expect([403, 409]).toContain(res.statusCode)
  })
})

describe('follow-up', () => {
  it('reminds at the start, asks for proof at the end, and nudges three times', () => {
    const item = {
      id: 'x',
      title: 'Sheets',
      provider: null,
      mode: 'virtual',
      startDate: '2026-10-05',
      endDate: '2026-10-07',
      lastReminder: null as string | null,
    } as unknown as typeof trainingItems.$inferSelect

    expect(_internal.nextReminder(item, '2026-10-04' as never)).toBeNull()
    expect(_internal.nextReminder(item, '2026-10-05' as never)?.key).toBe('starts')
    item.lastReminder = 'starts'
    expect(_internal.nextReminder(item, '2026-10-06' as never)).toBeNull()
    expect(_internal.nextReminder(item, '2026-10-07' as never)?.key).toBe('proof_due')
    item.lastReminder = 'proof_due'
    expect(_internal.nextReminder(item, '2026-10-09' as never)).toBeNull()
    expect(_internal.nextReminder(item, '2026-10-10' as never)?.key).toBe('nudge_1')
    item.lastReminder = 'nudge_1'
    expect(_internal.nextReminder(item, '2026-10-14' as never)?.key).toBe('nudge_2')
    item.lastReminder = 'nudge_2'
    expect(_internal.nextReminder(item, '2026-10-21' as never)?.key).toBe('nudge_3')
    item.lastReminder = 'nudge_3'
    expect(_internal.nextReminder(item, '2026-12-01' as never)).toBeNull()
  })

  it('the sweep sends each reminder once and records it on the item', async () => {
    // Move the approved course to end yesterday so proof is due today.
    await db.withTenant(org.orgId, async (tx) =>
      tx
        .update(trainingItems)
        .set({ startDate: plus(-3), endDate: plus(-1) })
        .where(eq(trainingItems.employeeId, org.employeeId)),
    )
    const before = (await inbox(org.accessToken)).filter((n) => n.event === 'training.proof_due').length
    const first = await sweepTrainingReminders(db)
    expect(first).toBeGreaterThanOrEqual(1)
    const second = await sweepTrainingReminders(db)
    const after = (await inbox(org.accessToken)).filter((n) => n.event === 'training.proof_due').length
    expect(after - before).toBe(1)
    expect(second).toBe(0)
  })

  it('proof marks the course complete and files the certificate on the record', async () => {
    const mine = await app.inject({ method: 'GET', url: '/v1/training/plans', headers: bearer(org.accessToken) })
    const item = mine.json().plans[0].items[0]

    const noProof = await app.inject({
      method: 'POST',
      url: `/v1/training/items/${item.id}/complete`,
      headers: bearer(org.accessToken),
      payload: { note: 'done' },
    })
    expect(noProof.statusCode).toBe(422)

    const res = await app.inject({
      method: 'POST',
      url: `/v1/training/items/${item.id}/complete`,
      headers: bearer(org.accessToken),
      payload: {
        note: 'Completed all six modules and the final assessment.',
        proof: { filename: 'certificate.png', contentType: 'image/png', contentBase64: Buffer.from('png').toString('base64') },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('completed')
    expect(res.json().proofDocumentId).toBeTruthy()

    const docs = await app.inject({ method: 'GET', url: '/v1/documents', headers: bearer(org.accessToken) })
    expect(JSON.stringify(docs.json())).toContain('certificate.png')

    // No more reminders for a completed course.
    expect(await sweepTrainingReminders(db)).toBe(0)
    const [row] = await db.withTenant(org.orgId, async (tx) =>
      tx.select({ status: trainingPlans.status }).from(trainingPlans).where(eq(trainingPlans.employeeId, org.employeeId)),
    )
    expect(row?.status).toBe('approved')
  })
})
