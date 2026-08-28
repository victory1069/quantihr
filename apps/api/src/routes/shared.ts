/**
 * Loaders shared across route modules.
 *
 * Every one of these is already inside a tenant transaction, so none of them
 * filter on `org_id` themselves — RLS does that. If you find yourself adding an
 * `eq(table.orgId, ...)` here, something has gone wrong upstream: it means the
 * query is running without a tenant context, and the fix is at the call site.
 */

import { eq } from 'drizzle-orm'
import {
  DEFAULT_ORG_SETTINGS,
  ApiError,
  ERROR_CODES,
  type OrgSettings,
  type WorkSchedule,
} from '@quanti/shared'
import {
  departments,
  employees,
  locations,
  organisations,
  workSchedules,
} from '../db/schema.js'
import type { Tx } from '../db/client.js'

export interface EmployeeContext {
  employee: typeof employees.$inferSelect
  org: { id: string; name: string; country: string; timezone: string; settings: unknown }
  schedule: WorkSchedule
  location: {
    id: string
    name: string
    latitude: number
    longitude: number
    geofenceRadiusM: number
  } | null
  departmentName: string | null
}

/** Falls back to a sane weekday schedule so a misconfigured org still works. */
const FALLBACK_SCHEDULE: WorkSchedule = {
  workingDays: [1, 2, 3, 4, 5],
  startTime: '09:00',
  endTime: '17:00',
  gracePeriodMinutes: 10,
  checkinWindowStart: '06:00',
  checkinWindowEnd: '11:00',
}

export async function loadEmployeeContext(
  tx: Tx,
  employeeId: string,
): Promise<EmployeeContext> {
  const [employee] = await tx
    .select()
    .from(employees)
    .where(eq(employees.id, employeeId))
    .limit(1)

  if (!employee) {
    throw new ApiError(ERROR_CODES.NOT_FOUND, 'Employee record not found', 404)
  }

  const [org] = await tx
    .select()
    .from(organisations)
    .where(eq(organisations.id, employee.orgId))
    .limit(1)

  if (!org) {
    throw new ApiError(ERROR_CODES.NOT_FOUND, 'Organisation not found', 404)
  }

  let schedule: WorkSchedule = FALLBACK_SCHEDULE
  if (employee.workScheduleId) {
    const [row] = await tx
      .select()
      .from(workSchedules)
      .where(eq(workSchedules.id, employee.workScheduleId))
      .limit(1)
    if (row) {
      schedule = {
        workingDays: row.workingDays,
        startTime: row.startTime,
        endTime: row.endTime,
        gracePeriodMinutes: row.gracePeriodMinutes,
        checkinWindowStart: row.checkinWindowStart,
        checkinWindowEnd: row.checkinWindowEnd,
      }
    }
  }

  let location: EmployeeContext['location'] = null
  if (employee.locationId) {
    const [row] = await tx
      .select()
      .from(locations)
      .where(eq(locations.id, employee.locationId))
      .limit(1)
    if (row) {
      location = {
        id: row.id,
        name: row.name,
        latitude: row.latitude,
        longitude: row.longitude,
        geofenceRadiusM: row.geofenceRadiusM,
      }
    }
  }

  let departmentName: string | null = null
  if (employee.departmentId) {
    const [row] = await tx
      .select({ name: departments.name })
      .from(departments)
      .where(eq(departments.id, employee.departmentId))
      .limit(1)
    departmentName = row?.name ?? null
  }

  return {
    employee,
    org: {
      id: org.id,
      name: org.name,
      country: org.country,
      timezone: org.timezone,
      settings: org.settings,
    },
    schedule,
    location,
    departmentName,
  }
}

/** Org settings merged over defaults, so a partial `settings` blob is safe. */
export function resolveSettings(raw: unknown): OrgSettings {
  const partial = (raw ?? {}) as Partial<OrgSettings>
  return { ...DEFAULT_ORG_SETTINGS, ...partial }
}

export function fullName(e: { firstName: string; lastName: string }): string {
  return `${e.firstName} ${e.lastName}`.trim()
}

/** Numeric columns come back as strings from the driver. */
export function num(value: string | number | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}
