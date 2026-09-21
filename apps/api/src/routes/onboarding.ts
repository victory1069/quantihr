/**
 * Setup wizard state.
 *
 * The wizard's four steps each write to endpoints that already exist — org
 * settings, locations, schedules, leave types, the policy corpus, staff
 * import. What did not exist was a record of which of them the HR lead has
 * been through, so the console could not resume a half-finished setup and
 * could not tell when to stop showing the wizard and show the product.
 *
 * Steps are recorded as done by the console when the HR lead moves past them,
 * not inferred from data. A leave policy step "counts" when they say it does,
 * even with one type, because inferring "done" from row counts would send
 * someone who deliberately runs a single leave type back through the wizard
 * every time they sign in.
 *
 * Completion is one-way from the HR lead's side. Reopening the wizard is an
 * explicit action rather than something that happens because a step's data
 * later changed.
 */

import type { FastifyInstance } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ApiError, ERROR_CODES } from '@quanti/shared'
import {
  employees,
  leaveTypes,
  locations,
  organisations,
  policyDocuments,
} from '../db/schema.js'
import type { Database, Tx } from '../db/client.js'
import { audit } from '../lib/audit.js'
import { requireRole, tenant } from '../lib/context.js'

/**
 * In order. The last three are the people steps: managers first, then who
 * reports to whom, then everyone else — because the organogram is what makes
 * approvals route anywhere, and a team imported before its managers exist
 * has nobody to report to.
 */
export const ONBOARDING_STEPS = ['basics', 'leave', 'handbook', 'managers', 'organogram', 'team'] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

const stepParam = z.enum(ONBOARDING_STEPS)

export function registerOnboardingRoutes(app: FastifyInstance, _db: Database): void {
  /**
   * Where the org is in setup, plus the facts the wizard uses to pre-fill and
   * to nudge — "you have no locations yet" is more useful than a bare step
   * list, and it is cheap to compute here in one round trip.
   */
  app.get('/v1/admin/onboarding', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')

    const state = await tenant(request, async (tx) => {
      const [org] = await tx
        .select({
          name: organisations.name,
          country: organisations.country,
          timezone: organisations.timezone,
          steps: organisations.onboardingSteps,
          completedAt: organisations.onboardingCompletedAt,
        })
        .from(organisations)
        .where(eq(organisations.id, auth.orgId))
        .limit(1)

      const count = async (table: typeof locations | typeof leaveTypes | typeof policyDocuments) => {
        const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(table)
        return row?.n ?? 0
      }

      const [staff] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(employees)
        .where(eq(employees.status, 'active'))

      const requirements = await checkRequirements(tx, auth.employeeId)
      // 'staff' was the old name of the last step; an org that ticked it
      // before the rename keeps the credit.
      const ticked = (org!.steps ?? []).map((st) => (st === 'staff' ? 'team' : st))

      return {
        organisation: {
          name: org!.name,
          country: org!.country,
          timezone: org!.timezone,
        },
        steps: ONBOARDING_STEPS.map((step) => ({
          step,
          done: ticked.includes(step),
        })),
        completedAt: org!.completedAt?.toISOString() ?? null,
        facts: {
          locations: await count(locations),
          leaveTypes: await count(leaveTypes),
          policyDocuments: await count(policyDocuments),
          // Minus one: the HR admin created at provisioning is not "staff
          // imported", and a wizard that says "1 employee" on a fresh org
          // reads as a mistake.
          staff: Math.max(0, (staff?.n ?? 0) - 1),
          managers: requirements.managers,
          unassigned: requirements.unassigned,
        },
        /** What still stands between this org and its dashboard. */
        missing: requirements.missing,
      }
    })

    return reply.send(state)
  })

  app.post('/v1/admin/onboarding/steps/:step', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const step = stepParam.parse((request.params as { step: string }).step)

    const steps = await tenant(request, async (tx) => {
      const [org] = await tx
        .select({ steps: organisations.onboardingSteps })
        .from(organisations)
        .where(eq(organisations.id, auth.orgId))
        .limit(1)

      const current = org!.steps ?? []
      if (current.includes(step)) return current

      const next = [...current, step]
      await tx
        .update(organisations)
        .set({ onboardingSteps: next })
        .where(eq(organisations.id, auth.orgId))
      return next
    })

    return reply.send({ steps })
  })

  app.post('/v1/admin/onboarding/complete', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')

    const completedAt = await tenant(request, async (tx) => {
      const [org] = await tx
        .select({
          completedAt: organisations.onboardingCompletedAt,
          steps: organisations.onboardingSteps,
        })
        .from(organisations)
        .where(eq(organisations.id, auth.orgId))
        .limit(1)

      if (org!.completedAt) return org!.completedAt

      // The wizard is a gate, not a checklist: the dashboard is not reachable
      // until the org can actually run. Each line here is something that
      // would otherwise fail the first employee who tried to use the app.
      const requirements = await checkRequirements(tx, auth.employeeId)
      if (requirements.missing.length > 0) {
        throw new ApiError(
          ERROR_CODES.VALIDATION_FAILED,
          `Not finished yet: ${requirements.missing.map((m) => m.message).join(' ')}`,
          422,
          { missing: requirements.missing },
        )
      }

      const now = new Date()
      await tx
        .update(organisations)
        .set({ onboardingCompletedAt: now })
        .where(eq(organisations.id, auth.orgId))

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'org.onboarding_completed',
        entityType: 'organisation',
        entityId: auth.orgId,
        after: { steps: org!.steps },
        ip: request.ip,
      })

      return now
    })

    return reply.send({ completedAt: completedAt.toISOString() })
  })

  /** Explicit, so a later change to a step's data never drops HR back in. */
  app.post('/v1/admin/onboarding/reopen', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')

    await tenant(request, async (tx) => {
      await tx
        .update(organisations)
        .set({ onboardingCompletedAt: null })
        .where(eq(organisations.id, auth.orgId))
    })

    return reply.send({ completedAt: null })
  })
}

interface Requirement {
  step: OnboardingStep
  code: string
  message: string
}

/**
 * The rules the dashboard is held behind. Kept together so the status
 * endpoint and the completion endpoint can never disagree about them.
 */
async function checkRequirements(
  tx: Tx,
  adminEmployeeId: string,
): Promise<{ missing: Requirement[]; managers: number; unassigned: number }> {
  const missing: Requirement[] = []

  const [loc] = await tx.select({ n: sql<number>`count(*)::int` }).from(locations)
  if ((loc?.n ?? 0) === 0) {
    missing.push({ step: 'basics', code: 'no_location', message: 'Add at least one office location.' })
  }
  const [lt] = await tx.select({ n: sql<number>`count(*)::int` }).from(leaveTypes)
  if ((lt?.n ?? 0) === 0) {
    missing.push({ step: 'leave', code: 'no_leave_type', message: 'Add at least one leave type.' })
  }

  const people = await tx
    .select({ id: employees.id, managerId: employees.managerId, roles: employees.roles })
    .from(employees)
    .where(eq(employees.status, 'active'))
  const others = people.filter((p) => p.id !== adminEmployeeId)
  const managers = people.filter((p) => (p.roles ?? []).includes('manager')).length
  const unassigned = others.filter((p) => !p.managerId).length

  if (others.length === 0) {
    missing.push({ step: 'team', code: 'no_staff', message: 'Onboard at least one person besides yourself.' })
  }
  if (managers === 0) {
    missing.push({ step: 'managers', code: 'no_manager', message: 'Add at least one manager.' })
  }
  if (others.length > 0 && unassigned > 0) {
    missing.push({
      step: 'organogram',
      code: 'unassigned',
      message: `${unassigned} ${unassigned === 1 ? 'person has' : 'people have'} no manager — finish the organogram.`,
    })
  }

  return { missing, managers, unassigned }
}
