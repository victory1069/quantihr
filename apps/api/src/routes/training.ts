/**
 * Learning & development.
 *
 * The employee owns the plan: what they intend to attend this month or
 * quarter and why. The manager owns the decision. Once approved the follow-up
 * is automatic — `jobs/training.ts` reminds at the start, asks for proof at
 * the end, and nudges until it arrives — so a manager never has to remember
 * to ask, and an employee never has to remember to tell.
 *
 * A plan is editable while it is a draft or has changes requested; once
 * submitted it is the manager's until they decide. Proof is a document on the
 * employee's record, so it lives with their certificates rather than in a
 * place only this feature can see.
 */

import { and, desc, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { ApiError, ERROR_CODES, schemas, type TrainingPlanView } from '@quanti/shared'
import { documents, employees, trainingItems, trainingPlans } from '../db/schema.js'
import type { Database, Tx } from '../db/client.js'
import { audit } from '../lib/audit.js'
import { isHrAdmin, requireAuth, tenant } from '../lib/context.js'
import { queueNotification } from '../lib/notify.js'
import { storage } from '../lib/storage.js'
import { fullName } from './shared.js'

type PlanRow = typeof trainingPlans.$inferSelect
type ItemRow = typeof trainingItems.$inferSelect

export function periodLabel(periodType: string, periodStart: string): string {
  const [y, m] = periodStart.split('-').map(Number)
  if (periodType === 'quarter') return `Q${Math.floor(((m ?? 1) - 1) / 3) + 1} ${y}`
  return new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, 1)).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
  })
}

/** Snaps a date to the first day of its month or quarter. */
export function periodStartFor(periodType: string, date: string): string {
  const [y, m] = date.split('-').map(Number)
  const month = periodType === 'quarter' ? Math.floor(((m ?? 1) - 1) / 3) * 3 + 1 : (m ?? 1)
  return `${y}-${String(month).padStart(2, '0')}-01`
}

function itemView(i: ItemRow) {
  return {
    id: i.id,
    title: i.title,
    provider: i.provider,
    mode: i.mode as 'physical' | 'virtual',
    startDate: i.startDate,
    endDate: i.endDate,
    need: i.need,
    costKobo: i.costKobo,
    status: i.status as 'planned' | 'completed' | 'missed',
    proofDocumentId: i.proofDocumentId,
    proofNote: i.proofNote,
    completedAt: i.completedAt?.toISOString() ?? null,
  }
}

async function loadPlans(
  tx: Tx,
  plans: (PlanRow & { firstName: string; lastName: string })[],
): Promise<TrainingPlanView[]> {
  if (plans.length === 0) return []
  const items = await tx
    .select()
    .from(trainingItems)
    .where(inArray(trainingItems.planId, plans.map((p) => p.id)))
    .orderBy(trainingItems.startDate)
  return plans.map((p) => ({
    id: p.id,
    employeeId: p.employeeId,
    employeeName: fullName(p),
    periodType: p.periodType as 'month' | 'quarter',
    periodStart: p.periodStart,
    periodLabel: periodLabel(p.periodType, p.periodStart),
    status: p.status as TrainingPlanView['status'],
    submittedAt: p.submittedAt?.toISOString() ?? null,
    decidedAt: p.decidedAt?.toISOString() ?? null,
    decisionNote: p.decisionNote,
    items: items.filter((i) => i.planId === p.id).map(itemView),
  }))
}

const planWithName = {
  id: trainingPlans.id,
  orgId: trainingPlans.orgId,
  employeeId: trainingPlans.employeeId,
  periodType: trainingPlans.periodType,
  periodStart: trainingPlans.periodStart,
  status: trainingPlans.status,
  submittedAt: trainingPlans.submittedAt,
  decidedAt: trainingPlans.decidedAt,
  decidedBy: trainingPlans.decidedBy,
  decisionNote: trainingPlans.decisionNote,
  createdAt: trainingPlans.createdAt,
  updatedAt: trainingPlans.updatedAt,
  firstName: employees.firstName,
  lastName: employees.lastName,
}

export function registerTrainingRoutes(app: FastifyInstance, _db: Database): void {
  /** My plans, newest period first. */
  app.get('/v1/training/plans', async (request, reply) => {
    const auth = requireAuth(request)
    const plans = await tenant(request, async (tx) => {
      const rows = await tx
        .select(planWithName)
        .from(trainingPlans)
        .innerJoin(employees, eq(employees.id, trainingPlans.employeeId))
        .where(eq(trainingPlans.employeeId, auth.employeeId))
        .orderBy(desc(trainingPlans.periodStart))
      return loadPlans(tx, rows)
    })
    return reply.send({ plans })
  })

  /**
   * Create or replace the plan for a period. Replacing is the simplest
   * honest model for a draft: the whole list comes back each time, so
   * nothing can be half-edited.
   */
  app.post('/v1/training/plans', async (request, reply) => {
    const auth = requireAuth(request)
    const body = schemas.training.upsertTrainingPlan.parse(request.body)
    const periodStart = periodStartFor(body.periodType, body.periodStart)

    const { plan, created } = await tenant(request, async (tx) => {
      const [existing] = await tx
        .select()
        .from(trainingPlans)
        .where(
          and(
            eq(trainingPlans.employeeId, auth.employeeId),
            eq(trainingPlans.periodType, body.periodType),
            eq(trainingPlans.periodStart, periodStart),
          ),
        )
        .limit(1)

      if (existing && existing.status !== 'draft' && existing.status !== 'changes_requested') {
        throw new ApiError(
          ERROR_CODES.VALIDATION_FAILED,
          existing.status === 'submitted'
            ? 'This plan is with your manager. Wait for their decision before changing it.'
            : `This plan has been ${existing.status}. Plan the next period instead.`,
          409,
        )
      }

      let planId = existing?.id
      if (existing) {
        await tx.delete(trainingItems).where(eq(trainingItems.planId, existing.id))
        await tx
          .update(trainingPlans)
          .set({ status: 'draft', updatedAt: new Date() })
          .where(eq(trainingPlans.id, existing.id))
      } else {
        const [created] = await tx
          .insert(trainingPlans)
          .values({
            orgId: auth.orgId,
            employeeId: auth.employeeId,
            periodType: body.periodType,
            periodStart,
            status: 'draft',
          })
          .returning()
        planId = created!.id
      }

      await tx.insert(trainingItems).values(
        body.items.map((i) => ({
          orgId: auth.orgId,
          planId: planId!,
          employeeId: auth.employeeId,
          title: i.title.trim(),
          provider: i.provider?.trim() || null,
          mode: i.mode,
          startDate: i.startDate,
          endDate: i.endDate,
          need: i.need.trim(),
          costKobo: i.costKobo ?? null,
        })),
      )

      const [row] = await tx
        .select(planWithName)
        .from(trainingPlans)
        .innerJoin(employees, eq(employees.id, trainingPlans.employeeId))
        .where(eq(trainingPlans.id, planId!))
      return { plan: (await loadPlans(tx, [row!]))[0]!, created: !existing }
    })

    return reply.status(created ? 201 : 200).send(plan)
  })

  /** Hands the plan to the manager. */
  app.post('/v1/training/plans/:id/submit', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = request.params as { id: string }

    const plan = await tenant(request, async (tx) => {
      const [row] = await tx
        .select(planWithName)
        .from(trainingPlans)
        .innerJoin(employees, eq(employees.id, trainingPlans.employeeId))
        .where(and(eq(trainingPlans.id, id), eq(trainingPlans.employeeId, auth.employeeId)))
        .limit(1)
      if (!row) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Plan not found', 404)
      if (row.status !== 'draft' && row.status !== 'changes_requested') {
        throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'This plan has already been submitted', 409)
      }

      await tx
        .update(trainingPlans)
        .set({ status: 'submitted', submittedAt: new Date(), updatedAt: new Date() })
        .where(eq(trainingPlans.id, id))

      const [me] = await tx
        .select({ managerId: employees.managerId })
        .from(employees)
        .where(eq(employees.id, auth.employeeId))
        .limit(1)
      if (me?.managerId) {
        const [manager] = await tx
          .select({ userId: employees.userId })
          .from(employees)
          .where(eq(employees.id, me.managerId))
          .limit(1)
        if (manager?.userId) {
          await queueNotification(tx, {
            orgId: auth.orgId,
            userId: manager.userId,
            event: 'training.plan_submitted',
            title: `${fullName(row)} planned training for ${periodLabel(row.periodType, row.periodStart)}`,
            body: 'Approve it, decline it, or ask for changes.',
            deepLink: `/manage/training/${id}`,
            data: { planId: id },
          })
        }
      }

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'training.plan_submitted',
        entityType: 'training_plan',
        entityId: id,
        ip: request.ip,
      })

      const [after] = await tx
        .select(planWithName)
        .from(trainingPlans)
        .innerJoin(employees, eq(employees.id, trainingPlans.employeeId))
        .where(eq(trainingPlans.id, id))
      return (await loadPlans(tx, [after!]))[0]!
    })

    return reply.send(plan)
  })

  /** Plans from my reports (HR sees the whole org), those waiting first. */
  app.get('/v1/team/training', async (request, reply) => {
    const auth = requireAuth(request)
    const plans = await tenant(request, async (tx) => {
      const scope = isHrAdmin(auth) ? undefined : eq(employees.managerId, auth.employeeId)
      const rows = await tx
        .select(planWithName)
        .from(trainingPlans)
        .innerJoin(employees, eq(employees.id, trainingPlans.employeeId))
        .where(scope)
        .orderBy(desc(trainingPlans.periodStart))
      const order = { submitted: 0, changes_requested: 1, approved: 2, declined: 3, draft: 4 }
      rows.sort(
        (a, b) =>
          (order[a.status as keyof typeof order] ?? 9) - (order[b.status as keyof typeof order] ?? 9),
      )
      return loadPlans(tx, rows.filter((r) => r.status !== 'draft'))
    })
    return reply.send({ plans })
  })

  /** The manager's decision. Only the employee's manager, or HR. */
  app.post('/v1/team/training/:id', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = request.params as { id: string }
    const body = schemas.training.trainingPlanDecision.parse(request.body)

    const plan = await tenant(request, async (tx) => {
      const [row] = await tx
        .select({ ...planWithName, managerId: employees.managerId, userId: employees.userId })
        .from(trainingPlans)
        .innerJoin(employees, eq(employees.id, trainingPlans.employeeId))
        .where(eq(trainingPlans.id, id))
        .limit(1)
      if (!row) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Plan not found', 404)
      if (!isHrAdmin(auth) && row.managerId !== auth.employeeId) {
        throw new ApiError(ERROR_CODES.AUTH_FORBIDDEN, 'Only their manager can decide this plan', 403)
      }
      if (row.status !== 'submitted') {
        throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'This plan is not waiting for a decision', 409)
      }
      if (body.decision !== 'approve' && !body.note?.trim()) {
        throw new ApiError(
          ERROR_CODES.VALIDATION_FAILED,
          'Say why — the employee needs to know what to change',
          422,
        )
      }

      const status =
        body.decision === 'approve'
          ? 'approved'
          : body.decision === 'decline'
            ? 'declined'
            : 'changes_requested'
      await tx
        .update(trainingPlans)
        .set({
          status,
          decidedAt: new Date(),
          decidedBy: auth.userId,
          decisionNote: body.note?.trim() || null,
          updatedAt: new Date(),
        })
        .where(eq(trainingPlans.id, id))

      if (row.userId) {
        const label = periodLabel(row.periodType, row.periodStart)
        await queueNotification(tx, {
          orgId: auth.orgId,
          userId: row.userId,
          event: 'training.plan_decided',
          title:
            status === 'approved'
              ? `Your ${label} training plan is approved`
              : status === 'declined'
                ? `Your ${label} training plan was declined`
                : `Changes requested on your ${label} training plan`,
          body:
            status === 'approved'
              ? 'We will remind you as each course starts and ask for proof when it ends.'
              : (body.note?.trim() ?? ''),
          deepLink: '/learning',
          data: { planId: id, status },
        })
      }

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'training.plan_decided',
        entityType: 'training_plan',
        entityId: id,
        after: { status, note: body.note ?? null },
        ip: request.ip,
      })

      const [after] = await tx
        .select(planWithName)
        .from(trainingPlans)
        .innerJoin(employees, eq(employees.id, trainingPlans.employeeId))
        .where(eq(trainingPlans.id, id))
      return (await loadPlans(tx, [after!]))[0]!
    })

    return reply.send(plan)
  })

  /** Proof of completion, from the employee who planned it. */
  app.post('/v1/training/items/:id/complete', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = request.params as { id: string }
    const body = schemas.training.completeTrainingItem.parse(request.body)

    let proofKey: string | null = null
    let proofSize = 0
    if (body.proof) {
      const buffer = Buffer.from(body.proof.contentBase64, 'base64')
      if (buffer.length > 20_000_000) {
        throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'File is larger than 20MB', 413)
      }
      proofKey = storage().key(auth.orgId, body.proof.filename)
      await storage().put(proofKey, buffer, body.proof.contentType)
      proofSize = buffer.length
    }

    const item = await tenant(request, async (tx) => {
      const [row] = await tx
        .select({ item: trainingItems, planStatus: trainingPlans.status })
        .from(trainingItems)
        .innerJoin(trainingPlans, eq(trainingPlans.id, trainingItems.planId))
        .where(and(eq(trainingItems.id, id), eq(trainingItems.employeeId, auth.employeeId)))
        .limit(1)
      if (!row) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Training not found', 404)
      if (row.planStatus !== 'approved') {
        throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'This plan has not been approved', 409)
      }
      if (row.item.status === 'completed') {
        throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'Already marked complete', 409)
      }

      let proofDocumentId: string | null = null
      if (proofKey && body.proof) {
        const [doc] = await tx
          .insert(documents)
          .values({
            orgId: auth.orgId,
            employeeId: auth.employeeId,
            type: 'certificate',
            name: `${row.item.title} — ${body.proof.filename}`,
            s3Key: proofKey,
            contentType: body.proof.contentType,
            sizeBytes: proofSize,
            uploadedBy: auth.userId,
            requiresAcknowledgement: false,
          })
          .returning()
        proofDocumentId = doc!.id
      }

      const [updated] = await tx
        .update(trainingItems)
        .set({
          status: 'completed',
          completedAt: new Date(),
          proofDocumentId,
          proofNote: body.note?.trim() || null,
        })
        .where(eq(trainingItems.id, id))
        .returning()

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'training.item_completed',
        entityType: 'training_item',
        entityId: id,
        after: { proof: !!proofDocumentId, note: !!body.note },
        ip: request.ip,
      })

      return updated!
    })

    return reply.send(itemView(item))
  })
}
