/**
 * Manager mode: approvals, team calendar, team attendance (spec §5).
 *
 * Manager mode is a role, not a separate app. Scope is the manager's direct
 * reports; HR admins see the whole org. That scoping is on top of RLS, not
 * instead of it — RLS keeps other tenants out, this keeps one manager out of
 * another manager's team.
 */

import type { FastifyInstance } from 'fastify'
import { and, between, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import {
  ApiError,
  ERROR_CODES,
  eachDay,
  requiresOverride,
  schemas,
  type CoverageWarning,
  type ISODate,
} from '@quanti/shared'
import {
  attendanceRecords,
  coverageRules,
  employees,
  leaveRequests,
  leaveTypes,
} from '../db/schema.js'
import type { Database, Tx } from '../db/client.js'
import { audit } from '../lib/audit.js'
import { isHrAdmin, requireAuth, requireRole, tenant } from '../lib/context.js'
import { queueNotification } from '../lib/notify.js'
import { hoursBetween, orgClock } from '../lib/time.js'
import {
  commitTaken,
  evaluateRequest,
  hydrateRequest,
  releasePending,
} from './leave.js'
import { fullName, loadEmployeeContext, num, resolveSettings } from './shared.js'

export function registerTeamRoutes(app: FastifyInstance, db: Database): void {
  app.get('/v1/team/calendar', async (request, reply) => {
    const auth = requireAuth(request)
    const { from, to } = schemas.team.teamCalendarQuery.parse(request.query)

    const result = await tenant(request, async (tx) => {
      // Team members see their own team's calendar too, not just managers —
      // knowing who is off is what stops three people booking the same week.
      const teamIds = await visibleTeamIds(tx, auth.employeeId, isHrAdmin(auth), true)
      if (teamIds.length === 0) return { entries: [], gaps: [], headcount: 0 }

      const rows = await tx
        .select({
          id: leaveRequests.id,
          employeeId: leaveRequests.employeeId,
          firstName: employees.firstName,
          lastName: employees.lastName,
          typeName: leaveTypes.name,
          colour: leaveTypes.colour,
          start: leaveRequests.startDate,
          end: leaveRequests.endDate,
          status: leaveRequests.status,
          halfDayStart: leaveRequests.halfDayStart,
          halfDayEnd: leaveRequests.halfDayEnd,
        })
        .from(leaveRequests)
        .innerJoin(employees, eq(employees.id, leaveRequests.employeeId))
        .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
        .where(
          and(
            inArray(leaveRequests.employeeId, teamIds),
            inArray(leaveRequests.status, ['pending', 'approved']),
            lte(leaveRequests.startDate, to),
            gte(leaveRequests.endDate, from),
          ),
        )

      const entries = rows.map((r) => ({
        employeeId: r.employeeId,
        employeeName: fullName(r),
        leaveTypeName: r.typeName,
        colour: r.colour,
        start: r.start,
        end: r.end,
        status: r.status,
        halfDayStart: r.halfDayStart,
        halfDayEnd: r.halfDayEnd,
      }))

      const ctx = await loadEmployeeContext(tx, auth.employeeId)
      let limit: number | null = null
      if (ctx.employee.departmentId) {
        const [rule] = await tx
          .select()
          .from(coverageRules)
          .where(eq(coverageRules.departmentId, ctx.employee.departmentId))
          .limit(1)
        limit = rule?.maxConcurrentAbsent ?? null
      }

      const gaps = eachDay(from as ISODate, to as ISODate).map((date) => {
        const absentCount = entries.filter((e) => e.start <= date && date <= e.end).length
        return {
          date,
          absentCount,
          headcount: teamIds.length,
          limit,
          breached: limit !== null && absentCount > limit,
        }
      })

      return { entries, gaps: gaps.filter((g) => g.absentCount > 0), headcount: teamIds.length }
    })

    return reply.send(result)
  })

  app.get('/v1/team/approvals', async (request, reply) => {
    const auth = requireRole(request, 'manager', 'hr_admin', 'owner')

    const items = await tenant(request, async (tx) => {
      const teamIds = await visibleTeamIds(tx, auth.employeeId, isHrAdmin(auth), false)
      if (teamIds.length === 0) return []

      const rows = await tx
        .select()
        .from(leaveRequests)
        .where(
          and(
            inArray(leaveRequests.employeeId, teamIds),
            eq(leaveRequests.status, 'pending'),
          ),
        )
        .orderBy(leaveRequests.submittedAt)

      const out = []
      for (const r of rows) {
        const view = await hydrateRequest(tx, r)
        // Re-evaluate rather than trusting the warnings stored at submit time:
        // the team's calendar has moved on since, and the manager is deciding
        // against today's coverage, not last week's.
        const evaluation = await evaluateRequest(
          tx,
          r.employeeId,
          {
            leaveTypeId: r.leaveTypeId,
            start: r.startDate as ISODate,
            end: r.endDate as ISODate,
            halfDayStart: r.halfDayStart,
            halfDayEnd: r.halfDayEnd,
          },
          r.id,
        )

        out.push({
          id: r.id,
          employeeId: r.employeeId,
          employeeName: view.employeeName,
          leaveTypeName: view.leaveTypeName,
          colour: view.colour,
          start: r.startDate,
          end: r.endDate,
          daysCount: num(r.daysCount),
          reason: r.reason,
          submittedAt: r.submittedAt.toISOString(),
          waitingHours: Math.round(hoursBetween(r.submittedAt, new Date()) * 10) / 10,
          balanceAfter: evaluation.balanceAfter,
          warnings: evaluation.warnings,
          requiresOverride: requiresOverride(evaluation.warnings),
        })
      }
      return out
    })

    return reply.send({ approvals: items })
  })

  app.post('/v1/team/approvals/:id', async (request, reply) => {
    const auth = requireRole(request, 'manager', 'hr_admin', 'owner')
    const { id } = request.params as { id: string }
    const body = schemas.leave.approvalDecision.parse(request.body)

    const result = await tenant(request, async (tx) => {
      const [existing] = await tx
        .select()
        .from(leaveRequests)
        .where(eq(leaveRequests.id, id))
        .limit(1)

      if (!existing) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Request not found', 404)

      const teamIds = await visibleTeamIds(tx, auth.employeeId, isHrAdmin(auth), false)
      if (!teamIds.includes(existing.employeeId)) {
        throw new ApiError(
          ERROR_CODES.AUTH_FORBIDDEN,
          'That request belongs to someone outside your team',
          403,
        )
      }
      if (existing.status !== 'pending') {
        throw new ApiError(
          ERROR_CODES.LEAVE_NOT_PENDING,
          `That request is already ${existing.status}`,
          409,
        )
      }

      const evaluation = await evaluateRequest(
        tx,
        existing.employeeId,
        {
          leaveTypeId: existing.leaveTypeId,
          start: existing.startDate as ISODate,
          end: existing.endDate as ISODate,
          halfDayStart: existing.halfDayStart,
          halfDayEnd: existing.halfDayEnd,
        },
        existing.id,
      )

      // Approving against a coverage rule is allowed, but it is recorded
      // (spec §5). Silence here would make the rule decorative.
      if (
        body.decision === 'approve' &&
        requiresOverride(evaluation.warnings) &&
        !body.overrideReason
      ) {
        throw new ApiError(
          ERROR_CODES.LEAVE_OVERRIDE_REASON_REQUIRED,
          'This request breaches a coverage rule. Give a reason to approve it anyway.',
          422,
          { warnings: evaluation.warnings },
        )
      }

      const status = body.decision === 'approve' ? 'approved' : 'declined'
      const [updated] = await tx
        .update(leaveRequests)
        .set({
          status,
          decidedAt: new Date(),
          decidedBy: auth.userId,
          decisionNote: body.note ?? null,
          overrideReason: body.overrideReason ?? null,
          warnings: evaluation.warnings,
        })
        .where(eq(leaveRequests.id, id))
        .returning()

      if (status === 'approved') {
        await commitTaken(tx, existing)
      } else {
        await releasePending(tx, existing)
      }

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: status === 'approved' ? 'leave_request.approved' : 'leave_request.declined',
        entityType: 'leave_request',
        entityId: id,
        before: { status: 'pending' },
        after: {
          status,
          overrideReason: body.overrideReason ?? null,
          warnings: evaluation.warnings.map((w: CoverageWarning) => w.code),
        },
        ip: request.ip,
      })

      const [requester] = await tx
        .select({ userId: employees.userId })
        .from(employees)
        .where(eq(employees.id, existing.employeeId))
        .limit(1)

      if (requester?.userId) {
        await queueNotification(tx, {
          orgId: auth.orgId,
          userId: requester.userId,
          event: 'leave.decided',
          title: status === 'approved' ? 'Leave approved' : 'Leave declined',
          body: `Your leave from ${existing.startDate} to ${existing.endDate} was ${status}.`,
          deepLink: `/leave/${id}`,
          data: { requestId: id, status },
        })
      }

      return hydrateRequest(tx, updated!)
    })

    return reply.send(result)
  })

  app.get('/v1/team/attendance', async (request, reply) => {
    const auth = requireRole(request, 'manager', 'hr_admin', 'owner')
    const { from, to } = schemas.team.teamAttendanceQuery.parse(request.query)

    const result = await tenant(request, async (tx) => {
      const ctx = await loadEmployeeContext(tx, auth.employeeId)
      const settings = resolveSettings(ctx.org.settings)
      const teamIds = await visibleTeamIds(tx, auth.employeeId, isHrAdmin(auth), false)
      if (teamIds.length === 0) {
        return { rows: [], from, to, latenessThreshold: settings.latenessThreshold }
      }

      const team = await tx
        .select({
          id: employees.id,
          firstName: employees.firstName,
          lastName: employees.lastName,
        })
        .from(employees)
        .where(inArray(employees.id, teamIds))

      const records = await tx
        .select({
          employeeId: attendanceRecords.employeeId,
          status: attendanceRecords.status,
          minutesLate: attendanceRecords.minutesLate,
        })
        .from(attendanceRecords)
        .where(
          and(
            inArray(attendanceRecords.employeeId, teamIds),
            between(attendanceRecords.date, from, to),
          ),
        )

      const rows = team.map((member) => {
        const own = records.filter((r) => r.employeeId === member.id)
        const daysLate = own.filter((r) => r.status === 'late').length
        return {
          employeeId: member.id,
          employeeName: fullName(member),
          daysPresent: own.filter((r) => r.status === 'present').length,
          daysLate,
          daysAbsent: own.filter((r) => r.status === 'absent').length,
          totalMinutesLate: own.reduce((sum, r) => sum + r.minutesLate, 0),
          // Informational only in the MVP — the query engine that would act on
          // this is deliberately out of scope (spec §1).
          approachingThreshold: daysLate >= settings.latenessThreshold,
        }
      })

      return { rows, from, to, latenessThreshold: settings.latenessThreshold }
    })

    return reply.send(result)
  })

  app.get('/v1/team/attendance/:employeeId', async (request, reply) => {
    const auth = requireRole(request, 'manager', 'hr_admin', 'owner')
    const { employeeId } = request.params as { employeeId: string }
    const { from, to } = schemas.team.teamAttendanceQuery.parse(request.query)

    const rows = await tenant(request, async (tx) => {
      const teamIds = await visibleTeamIds(tx, auth.employeeId, isHrAdmin(auth), false)
      if (!teamIds.includes(employeeId)) {
        throw new ApiError(ERROR_CODES.AUTH_FORBIDDEN, 'Outside your team', 403)
      }

      const records = await tx
        .select()
        .from(attendanceRecords)
        .where(
          and(
            eq(attendanceRecords.employeeId, employeeId),
            between(attendanceRecords.date, from, to),
          ),
        )
        .orderBy(sql`${attendanceRecords.date} desc`)

      return records.map((r) => ({
        date: r.date,
        status: r.status,
        checkedInAt: r.checkedInAt?.toISOString() ?? null,
        minutesLate: r.minutesLate,
        recordedOffline: r.recordedOffline,
        rejectionReason: r.rejectionReason,
      }))
    })

    return reply.send({ records: rows })
  })
}

/**
 * Employee ids the caller may see.
 *
 * HR admins see the org. Managers see their direct reports. `includeSelf` is on
 * for the calendar (you are part of your own team's coverage picture) and off
 * for approvals (you cannot approve your own leave).
 */
async function visibleTeamIds(
  tx: Tx,
  employeeId: string,
  hrAdmin: boolean,
  includeSelf: boolean,
): Promise<string[]> {
  if (hrAdmin) {
    const all = await tx.select({ id: employees.id }).from(employees)
    return all.map((e) => e.id).filter((id) => includeSelf || id !== employeeId)
  }

  const reports = await tx
    .select({ id: employees.id })
    .from(employees)
    .where(eq(employees.managerId, employeeId))

  const ids = reports.map((r) => r.id)

  if (includeSelf) {
    // Peers, so a team member sees who else on their team is away.
    const [self] = await tx
      .select({ departmentId: employees.departmentId })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1)

    if (self?.departmentId) {
      const peers = await tx
        .select({ id: employees.id })
        .from(employees)
        .where(eq(employees.departmentId, self.departmentId))
      for (const p of peers) if (!ids.includes(p.id)) ids.push(p.id)
    }
    if (!ids.includes(employeeId)) ids.push(employeeId)
  }

  return ids
}
