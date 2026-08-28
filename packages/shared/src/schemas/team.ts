import { z } from 'zod'
import { attendanceStatus, isoDate, leaveRequestStatus, uuid } from './common.js'
import { coverageWarning } from './leave.js'

export const teamCalendarQuery = z.object({ from: isoDate, to: isoDate })

export const teamCalendarEntry = z.object({
  employeeId: uuid,
  employeeName: z.string(),
  leaveTypeName: z.string(),
  colour: z.string(),
  start: isoDate,
  end: isoDate,
  status: leaveRequestStatus,
  halfDayStart: z.boolean(),
  halfDayEnd: z.boolean(),
})

export const coverageGap = z.object({
  date: isoDate,
  absentCount: z.number().int(),
  headcount: z.number().int(),
  limit: z.number().int().nullable(),
  breached: z.boolean(),
})

export const teamCalendarResponse = z.object({
  entries: z.array(teamCalendarEntry),
  gaps: z.array(coverageGap),
  headcount: z.number().int(),
})

export const approvalItem = z.object({
  id: uuid,
  employeeId: uuid,
  employeeName: z.string(),
  leaveTypeName: z.string(),
  colour: z.string(),
  start: isoDate,
  end: isoDate,
  daysCount: z.number(),
  reason: z.string().nullable(),
  submittedAt: z.string(),
  /** Hours the request has been waiting — drives the 48h nudge. */
  waitingHours: z.number(),
  balanceAfter: z.number(),
  warnings: z.array(coverageWarning),
  requiresOverride: z.boolean(),
})

export const teamAttendanceQuery = z.object({ from: isoDate, to: isoDate })

export const teamAttendanceRow = z.object({
  employeeId: uuid,
  employeeName: z.string(),
  daysPresent: z.number().int(),
  daysLate: z.number().int(),
  daysAbsent: z.number().int(),
  totalMinutesLate: z.number().int(),
  /**
   * Informational in the MVP — the query engine that would act on it is out of
   * scope until attendance data has run clean for a month (spec §1, §5).
   */
  approachingThreshold: z.boolean(),
})

export const teamAttendanceResponse = z.object({
  rows: z.array(teamAttendanceRow),
  from: isoDate,
  to: isoDate,
  latenessThreshold: z.number().int(),
})

export const employeeAttendanceDetail = z.object({
  date: isoDate,
  status: attendanceStatus,
  checkedInAt: z.string().nullable(),
  minutesLate: z.number().int(),
  recordedOffline: z.boolean(),
  rejectionReason: z.string().nullable(),
})

export type ApprovalItem = z.infer<typeof approvalItem>
export type TeamCalendarResponse = z.infer<typeof teamCalendarResponse>
export type TeamAttendanceResponse = z.infer<typeof teamAttendanceResponse>
