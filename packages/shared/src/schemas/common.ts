import { z } from 'zod'
import { isISODate } from '../domain/dates.js'

export const isoDate = z
  .string()
  .refine(isISODate, { message: 'Expected a calendar date as YYYY-MM-DD' })

export const isoInstant = z.string().datetime({ offset: true })

export const uuid = z.string().uuid()

export const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM')

export const roundingRule = z.enum(['up', 'down', 'nearest_half'])

export const accrualMethod = z.enum([
  'annual_fixed',
  'annual_anniversary',
  'monthly',
  'per_hours_worked',
])

export const employmentType = z.enum(['full_time', 'part_time', 'contract', 'intern'])

export const employeeStatus = z.enum(['active', 'on_leave', 'suspended', 'terminated'])

export const leaveRequestStatus = z.enum([
  'pending',
  'approved',
  'declined',
  'cancelled',
])

export const attendanceStatus = z.enum([
  'present',
  'late',
  'absent',
  'rejected',
  'pending_review',
])

export const role = z.enum(['employee', 'manager', 'hr_admin', 'owner'])

/**
 * A date range that is guaranteed non-inverted at the schema boundary, so no
 * handler has to re-check it.
 */
export const dateRange = z
  .object({ start: isoDate, end: isoDate })
  .refine((v) => v.start <= v.end, {
    message: 'end must be on or after start',
    path: ['end'],
  })

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
})

export type Role = z.infer<typeof role>
export type LeaveRequestStatus = z.infer<typeof leaveRequestStatus>
export type AttendanceStatusValue = z.infer<typeof attendanceStatus>
