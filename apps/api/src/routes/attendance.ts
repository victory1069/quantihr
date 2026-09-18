/**
 * Attendance check-in (spec §7).
 *
 * The important structural decision here: a rejected attempt is a record, not a
 * void. Every attempt — accepted or not — is committed with its full signal set
 * before any error is raised. That means the rejection cannot be raised from
 * inside the transaction, because throwing would roll back the very record we
 * are required to keep. The handler commits first and throws after.
 */

import type { FastifyInstance } from 'fastify'
import { and, asc, between, desc, eq, gte } from 'drizzle-orm'
import {
  ApiError,
  ERROR_CODES,
  computeLateness,
  evaluateGeofence,
  evaluateWindow,
  schemas,
  type ErrorCode,
} from '@quanti/shared'
import {
  attendanceDisputes,
  attendanceRecords,
  checkinCodes,
  devices,
  employees,
  locations,
  organisations,
  workSchedules,
} from '../db/schema.js'
import type { Database, Tx } from '../db/client.js'
import { audit } from '../lib/audit.js'
import { requireAuth, tenant } from '../lib/context.js'
import {
  checkIdempotency,
  idempotencyKeyFrom,
  recordIdempotency,
} from '../lib/idempotency.js'
import { orgClock } from '../lib/time.js'
import { loadEmployeeContext, resolveSettings } from './shared.js'

export function registerAttendanceRoutes(app: FastifyInstance, db: Database): void {
  app.get('/v1/attendance/status', async (request, reply) => {
    const auth = requireAuth(request)

    const result = await tenant(request, async (tx) => {
      const ctx = await loadEmployeeContext(tx, auth.employeeId)
      const clock = orgClock(ctx.org.timezone)
      const window = evaluateWindow(clock.date, clock.minutes, ctx.schedule)

      const [record] = await tx
        .select()
        .from(attendanceRecords)
        .where(
          and(
            eq(attendanceRecords.employeeId, auth.employeeId),
            eq(attendanceRecords.date, clock.date),
          ),
        )
        .orderBy(desc(attendanceRecords.createdAt))
        .limit(1)

      return {
        date: clock.date,
        record: record ? toRecordView(record) : null,
        window: {
          open: window.open,
          opensAt: window.opensAt,
          closesAt: window.closesAt,
          minutesUntilOpen: window.minutesUntilOpen,
          reason: window.reason,
        },
        location: ctx.location
          ? {
              id: ctx.location.id,
              name: ctx.location.name,
              latitude: ctx.location.latitude,
              longitude: ctx.location.longitude,
              geofenceRadiusM: ctx.location.geofenceRadiusM,
            }
          : null,
        schedule: {
          startTime: ctx.schedule.startTime,
          endTime: ctx.schedule.endTime,
          gracePeriodMinutes: ctx.schedule.gracePeriodMinutes,
        },
      }
    })

    return reply.send(result)
  })

  app.post('/v1/attendance/checkin', async (request, reply) => {
    const auth = requireAuth(request)
    const body = schemas.attendance.checkinRequest.parse(request.body)
    const key = idempotencyKeyFrom(request.headers as Record<string, unknown>)
    const endpoint = 'POST /v1/attendance/checkin'

    const outcome = await db.withTenant(auth.orgId, async (tx) => {
      const replay = await checkIdempotency(tx, auth.orgId, key, endpoint, body)
      if (replay) return { kind: 'replay' as const, replay }

      const ctx = await loadEmployeeContext(tx, auth.employeeId)
      const settings = resolveSettings(ctx.org.settings)
      const clock = orgClock(ctx.org.timezone)

      const failures: { code: ErrorCode; message: string }[] = []
      const signals: Record<string, unknown> = {
        code: body.code,
        latitude: body.latitude,
        longitude: body.longitude,
        accuracyM: body.accuracyM,
        isMocked: body.isMocked,
        wifiBssid: body.wifiBssid ?? null,
        deviceId: body.deviceId,
        clientTimestamp: body.clientTimestamp,
        serverDate: clock.date,
        serverMinutes: clock.minutes,
      }

      // 6. Within the check-in window.
      const window = evaluateWindow(clock.date, clock.minutes, ctx.schedule)
      if (!window.open) {
        failures.push(
          window.reason === 'not_a_working_day'
            ? {
                code: ERROR_CODES.CHECKIN_NOT_WORKING_DAY,
                message: 'Today is not a working day on your schedule',
              }
            : {
                code: ERROR_CODES.CHECKIN_WINDOW_CLOSED,
                message:
                  window.reason === 'too_early'
                    ? `Check-in opens at ${window.opensAt}`
                    : `Check-in closed at ${window.closesAt}`,
              },
        )
      }
      signals.window = { open: window.open, reason: window.reason }

      if (!ctx.location) {
        failures.push({
          code: ERROR_CODES.CHECKIN_NO_LOCATION,
          message: 'No office location is assigned to you. Ask HR to set one.',
        })
      }

      // 1. Code is current for that location, allowing one stale rotation so a
      //    slow walk from the door to the app does not fail (spec §7).
      if (ctx.location) {
        const staleFrom = new Date(Date.now() - settings.codeRotationMinutes * 60_000)
        const candidates = await tx
          .select()
          .from(checkinCodes)
          .where(
            and(
              eq(checkinCodes.locationId, ctx.location.id),
              gte(checkinCodes.validUntil, staleFrom),
            ),
          )
          .orderBy(desc(checkinCodes.validUntil))
          .limit(4)

        const submitted = body.code.trim().toUpperCase()
        const exact = candidates.find((c) => c.code === submitted)
        const now = Date.now()

        if (!exact) {
          failures.push({
            code: ERROR_CODES.CHECKIN_CODE_INVALID,
            message: 'That code is not valid for this location',
          })
          signals.codeMatch = false
        } else {
          const stale = exact.validUntil.getTime() < now
          signals.codeMatch = true
          signals.codeStale = stale
          signals.codeValidUntil = exact.validUntil.toISOString()
          if (stale && exact.validUntil.getTime() < now - settings.codeRotationMinutes * 60_000) {
            failures.push({
              code: ERROR_CODES.CHECKIN_CODE_STALE,
              message: 'That code has expired. Check the display for the current one.',
            })
          }
        }
      }

      // 2 & 3. Inside the geofence, with a fix precise enough to prove it.
      if (ctx.location) {
        const fence = evaluateGeofence(
          {
            latitude: body.latitude,
            longitude: body.longitude,
            accuracyM: body.accuracyM,
          },
          {
            latitude: ctx.location.latitude,
            longitude: ctx.location.longitude,
            geofenceRadiusM: ctx.location.geofenceRadiusM,
          },
          { maxAccuracyM: settings.maxAccuracyM },
        )
        signals.geofence = {
          inside: fence.inside,
          distanceM: Math.round(fence.distanceM),
          worstCaseDistanceM: Math.round(fence.worstCaseDistanceM),
          failure: fence.failure,
          radiusM: ctx.location.geofenceRadiusM,
        }

        if (!fence.inside) {
          failures.push(
            fence.failure === 'outside_geofence'
              ? {
                  code: ERROR_CODES.CHECKIN_OUTSIDE_GEOFENCE,
                  message: `You are about ${Math.round(fence.distanceM)}m from ${ctx.location.name}. Move closer and try again.`,
                }
              : {
                  code: ERROR_CODES.CHECKIN_ACCURACY_TOO_LOW,
                  message:
                    'Your location is not precise enough to confirm you are at the office. Step outside or wait a moment for a better signal.',
                },
          )
        }
      }

      // 4. Mock location.
      if (body.isMocked) {
        failures.push({
          code: ERROR_CODES.CHECKIN_MOCK_LOCATION,
          message: 'Your device is reporting a simulated location',
        })
      }

      // 5. Device binding — flag for review rather than reject, per spec §7.
      const bound = await tx
        .select()
        .from(devices)
        .where(and(eq(devices.employeeId, auth.employeeId), eq(devices.approved, true)))

      const deviceMatches = bound.some((d) => d.deviceId === body.deviceId)
      signals.deviceMatch = deviceMatches
      signals.deviceKnown = bound.length > 0

      const alreadyToday = await tx
        .select({ id: attendanceRecords.id, status: attendanceRecords.status })
        .from(attendanceRecords)
        .where(
          and(
            eq(attendanceRecords.employeeId, auth.employeeId),
            eq(attendanceRecords.date, clock.date),
          ),
        )

      if (alreadyToday.some((r) => r.status === 'present' || r.status === 'late')) {
        failures.push({
          code: ERROR_CODES.CHECKIN_ALREADY_RECORDED,
          message: 'You have already checked in today',
        })
      }

      const lateness = computeLateness(clock.minutes, ctx.schedule)
      const rejected = failures.length > 0
      const status = rejected
        ? 'rejected'
        : deviceMatches || bound.length === 0
          ? lateness.status
          : 'pending_review'

      const [inserted] = await tx
        .insert(attendanceRecords)
        .values({
          orgId: auth.orgId,
          employeeId: auth.employeeId,
          date: clock.date,
          checkedInAt: rejected ? null : clock.instant,
          clientTimestamp: new Date(body.clientTimestamp),
          checkinMethod: 'geofence_code',
          verificationSignals: signals,
          latitude: body.latitude,
          longitude: body.longitude,
          accuracyM: body.accuracyM,
          status,
          minutesLate: rejected ? 0 : lateness.minutesLate,
          rejectionReason: rejected ? failures.map((f) => f.message).join(' ') : null,
          recordedOffline: body.recordedOffline,
        })
        .returning()

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: rejected ? 'attendance.rejected' : 'attendance.checked_in',
        entityType: 'attendance_record',
        entityId: inserted!.id,
        after: { status, date: clock.date, signals },
        ip: request.ip,
      })

      const responseBody = {
        ...toRecordView(inserted!),
        withinGrace: rejected ? false : lateness.withinGrace,
      }

      if (!rejected) {
        await recordIdempotency(tx, auth.orgId, key, endpoint, body, 201, responseBody)
      }

      return rejected
        ? { kind: 'rejected' as const, failures }
        : { kind: 'accepted' as const, body: responseBody }
    })

    // The record is committed by this point. Only now is it safe to fail the
    // request — the signals survive either way.
    if (outcome.kind === 'replay') {
      return reply.status(outcome.replay.status).send(outcome.replay.body)
    }
    if (outcome.kind === 'rejected') {
      const first = outcome.failures[0]!
      throw new ApiError(first.code, outcome.failures.map((f) => f.message).join(' '), 422, {
        failures: outcome.failures,
      })
    }
    return reply.status(201).send(outcome.body)
  })

  app.get('/v1/attendance/history', async (request, reply) => {
    const auth = requireAuth(request)
    const { from, to } = schemas.attendance.attendanceHistoryQuery.parse(request.query)

    const rows = await tenant(request, async (tx) =>
      tx
        .select()
        .from(attendanceRecords)
        .where(
          and(
            eq(attendanceRecords.employeeId, auth.employeeId),
            between(attendanceRecords.date, from, to),
          ),
        )
        .orderBy(desc(attendanceRecords.date), desc(attendanceRecords.createdAt)),
    )

    return reply.send({ records: rows.map(toRecordView) })
  })

  app.post('/v1/attendance/dispute', async (request, reply) => {
    const auth = requireAuth(request)
    const body = schemas.attendance.attendanceDispute.parse(request.body)

    const created = await tenant(request, async (tx) => {
      const [record] = await tx
        .select()
        .from(attendanceRecords)
        .where(
          and(
            eq(attendanceRecords.id, body.recordId),
            eq(attendanceRecords.employeeId, auth.employeeId),
          ),
        )
        .limit(1)

      if (!record) {
        throw new ApiError(ERROR_CODES.NOT_FOUND, 'Attendance record not found', 404)
      }

      const [dispute] = await tx
        .insert(attendanceDisputes)
        .values({
          orgId: auth.orgId,
          recordId: record.id,
          employeeId: auth.employeeId,
          reason: body.reason,
          // So a dismissal can restore this exactly rather than guess.
          previousStatus: record.status,
        })
        .returning()

      // Otherwise a disputed record looks identical to an undisputed one
      // everywhere a manager might see it except a separate report count.
      await tx
        .update(attendanceRecords)
        .set({ status: 'pending_review' })
        .where(eq(attendanceRecords.id, record.id))

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'attendance.disputed',
        entityType: 'attendance_record',
        entityId: record.id,
        ip: request.ip,
      })

      return dispute!
    })

    return reply.status(201).send({ id: created.id, status: created.status })
  })
}

type AttendanceRow = typeof attendanceRecords.$inferSelect

function toRecordView(r: AttendanceRow) {
  return {
    id: r.id,
    date: r.date,
    checkedInAt: r.checkedInAt?.toISOString() ?? null,
    status: r.status,
    minutesLate: r.minutesLate,
    recordedOffline: r.recordedOffline,
    rejectionReason: r.rejectionReason,
  }
}
