import { z } from 'zod'
import { attendanceStatus, isoDate, isoInstant, timeOfDay, uuid } from './common.js'

/**
 * What the client actually checked, sent verbatim and stored verbatim.
 *
 * Persisting the signals rather than a pass/fail boolean means thresholds can be
 * revisited later without losing history, and gives HR something concrete to
 * show an employee disputing a record (spec §3).
 */
export const verificationSignals = z.object({
  code: z.string().min(4).max(12),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyM: z.number().nonnegative().max(100_000),
  isMocked: z.boolean(),
  wifiBssid: z.string().max(64).optional(),
  deviceId: z.string().min(8).max(128),
})

export const checkinRequest = verificationSignals.extend({
  /**
   * When the device believed the check-in happened. Recorded for the offline
   * case and never trusted for lateness — the server clock decides that (§4).
   */
  clientTimestamp: isoInstant,
  recordedOffline: z.boolean().default(false),
})

export const checkinResponse = z.object({
  id: uuid,
  date: isoDate,
  checkedInAt: isoInstant,
  status: attendanceStatus,
  minutesLate: z.number().int(),
  withinGrace: z.boolean(),
  /** Populated when the attempt was rejected, so the UI can say why. */
  rejectionReason: z.string().nullable(),
})

export const attendanceStatusResponse = z.object({
  date: isoDate,
  record: checkinResponse.nullable(),
  window: z.object({
    open: z.boolean(),
    opensAt: timeOfDay,
    closesAt: timeOfDay,
    minutesUntilOpen: z.number().int(),
    reason: z.enum(['open', 'too_early', 'too_late', 'not_a_working_day']),
  }),
  location: z
    .object({
      id: uuid,
      name: z.string(),
      latitude: z.number(),
      longitude: z.number(),
      geofenceRadiusM: z.number().int(),
    })
    .nullable(),
  schedule: z.object({
    startTime: timeOfDay,
    endTime: timeOfDay,
    gracePeriodMinutes: z.number().int(),
  }),
})

export const attendanceHistoryQuery = z.object({
  from: isoDate,
  to: isoDate,
})

export const attendanceDispute = z.object({
  recordId: uuid,
  reason: z.string().min(10).max(1000),
})

export type CheckinRequest = z.infer<typeof checkinRequest>
export type VerificationSignals = z.infer<typeof verificationSignals>
export type AttendanceStatusResponse = z.infer<typeof attendanceStatusResponse>
