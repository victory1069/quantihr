import { z } from 'zod'
import {
  employeeStatus,
  employmentType,
  isoDate,
  role,
  roundingRule,
  timeOfDay,
  uuid,
} from './common.js'

export const orgSettings = z.object({
  /** `MM-DD`. Anchors the leave year for every non-anniversary accrual method. */
  leaveYearStart: z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/),
  proRataRounding: roundingRule,
  /** Reject location fixes less precise than this, in metres. */
  maxAccuracyM: z.number().int().min(10).max(1000),
  /** How long a rotating check-in code stays valid. */
  codeRotationMinutes: z.number().int().min(1).max(60),
  /** Consecutive late arrivals before the manager view flags an employee. */
  latenessThreshold: z.number().int().min(1).max(30),
  /** Notify when carryover expires within this many days. */
  balanceExpiryWarningDays: z.number().int().min(1).max(180),
  publicHolidays: z.array(isoDate).default([]),
})

export const DEFAULT_ORG_SETTINGS: z.infer<typeof orgSettings> = {
  leaveYearStart: '01-01',
  proRataRounding: 'nearest_half',
  maxAccuracyM: 100,
  codeRotationMinutes: 5,
  latenessThreshold: 3,
  balanceExpiryWarningDays: 30,
  publicHolidays: [],
}

export const workSchedule = z.object({
  id: uuid,
  name: z.string(),
  workingDays: z.array(z.number().int().min(0).max(6)),
  startTime: timeOfDay,
  endTime: timeOfDay,
  gracePeriodMinutes: z.number().int().min(0).max(240),
  checkinWindowStart: timeOfDay,
  checkinWindowEnd: timeOfDay,
})

export const configResponse = z.object({
  org: z.object({
    id: uuid,
    name: z.string(),
    country: z.string(),
    timezone: z.string(),
  }),
  settings: orgSettings,
  schedule: workSchedule,
})

export const meResponse = z.object({
  user: z.object({
    id: uuid,
    email: z.string(),
    biometricEnabled: z.boolean(),
    hasPassword: z.boolean(),
    /** Signed in with a temporary password; the app goes to change-password and nowhere else. */
    mustChangePassword: z.boolean(),
  }),
  employee: z.object({
    id: uuid,
    employeeNumber: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
    phone: z.string().nullable(),
    jobTitle: z.string().nullable(),
    band: z.string().nullable(),
    departmentName: z.string().nullable(),
    locationName: z.string().nullable(),
    managerName: z.string().nullable(),
    employmentType,
    startDate: isoDate,
    endDate: isoDate.nullable(),
    status: employeeStatus,
  }),
  roles: z.array(role),
  config: configResponse,
})

/** Fields an employee may edit themselves. Everything else is HR's to change. */
export const updateMe = z.object({
  phone: z.string().max(32).nullable().optional(),
  biometricEnabled: z.boolean().optional(),
  notificationPreferences: z
    .object({
      leaveDecisions: z.boolean(),
      checkinReminders: z.boolean(),
      balanceExpiry: z.boolean(),
      documents: z.boolean(),
    })
    .partial()
    .optional(),
})

export type OrgSettings = z.infer<typeof orgSettings>
export type ConfigResponse = z.infer<typeof configResponse>
export type MeResponse = z.infer<typeof meResponse>
export type WorkScheduleView = z.infer<typeof workSchedule>
