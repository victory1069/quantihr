import { z } from 'zod'
import {
  accrualMethod,
  employeeStatus,
  employmentType,
  isoDate,
  role,
  timeOfDay,
  uuid,
} from './common.js'

export const upsertLocation = z.object({
  id: uuid.optional(),
  name: z.string().min(1).max(120),
  address: z.string().max(400).optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  geofenceRadiusM: z.number().int().min(20).max(5000),
})

export const upsertDepartment = z.object({
  id: uuid.optional(),
  name: z.string().min(1).max(120),
  parentDepartmentId: uuid.nullable().optional(),
})

export const upsertLeaveType = z.object({
  id: uuid.optional(),
  name: z.string().min(1).max(120),
  accrualMethod,
  accrualRate: z.number().min(0).max(365),
  maxBalance: z.number().min(0).max(365).nullable(),
  carryoverCap: z.number().min(0).max(365).nullable(),
  carryoverExpiryMonths: z.number().int().min(1).max(24).nullable(),
  requiresDocument: z.boolean().default(false),
  minNoticeDays: z.number().int().min(0).max(365).nullable(),
  isPaid: z.boolean().default(true),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
})

export const upsertEmployee = z.object({
  id: uuid.optional(),
  employeeNumber: z.string().min(1).max(40),
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  email: z.string().email().transform((v) => v.toLowerCase().trim()),
  phone: z.string().max(32).nullable().optional(),
  departmentId: uuid.nullable().optional(),
  locationId: uuid.nullable().optional(),
  managerId: uuid.nullable().optional(),
  jobTitle: z.string().max(120).nullable().optional(),
  band: z.string().max(40).nullable().optional(),
  roleId: z.string().max(60).nullable().optional(),
  employmentType,
  startDate: isoDate,
  endDate: isoDate.nullable().optional(),
  status: employeeStatus.default('active'),
  workScheduleId: uuid.nullable().optional(),
  roles: z.array(role).default(['employee']),
})

export const upsertCoverageRule = z.object({
  id: uuid.optional(),
  departmentId: uuid,
  maxConcurrentAbsent: z.number().int().min(0).nullable(),
  maxConcurrentPercent: z.number().min(0).max(100).nullable(),
  blackoutPeriods: z
    .array(z.object({ name: z.string().min(1), start: isoDate, end: isoDate }))
    .default([]),
  criticalRoleIds: z.array(z.string()).default([]),
})

export const upsertWorkSchedule = z.object({
  id: uuid.optional(),
  name: z.string().min(1).max(120),
  workingDays: z.array(z.number().int().min(0).max(6)).min(1),
  startTime: timeOfDay,
  endTime: timeOfDay,
  gracePeriodMinutes: z.number().int().min(0).max(240),
  checkinWindowStart: timeOfDay,
  checkinWindowEnd: timeOfDay,
})

/**
 * Bulk import runs in two passes: `validate` returns a preview with per-row
 * errors and nothing is written; `commit` applies a previously validated batch.
 * HR gets to see what a 300-row spreadsheet will do before it does it (spec §11).
 */
export const bulkImportRequest = z.object({
  mode: z.enum(['validate', 'commit']),
  rows: z.array(z.record(z.string(), z.string())).min(1).max(2000),
})

export const bulkImportRowResult = z.object({
  rowNumber: z.number().int(),
  action: z.enum(['create', 'update', 'skip', 'error']),
  employeeNumber: z.string().nullable(),
  name: z.string().nullable(),
  errors: z.array(z.object({ field: z.string(), message: z.string() })),
})

export const bulkImportResponse = z.object({
  mode: z.enum(['validate', 'commit']),
  totalRows: z.number().int(),
  willCreate: z.number().int(),
  willUpdate: z.number().int(),
  errorCount: z.number().int(),
  rows: z.array(bulkImportRowResult),
  committed: z.boolean(),
  /** One temporary password per account the commit created. Shown once. */
  credentials: z
    .array(z.object({ employeeNumber: z.string(), email: z.string(), temporaryPassword: z.string() }))
    .default([]),
})

export const adjustBalance = z.object({
  employeeId: uuid,
  leaveTypeId: uuid,
  /** Signed. Negative corrections are allowed and may take a balance below zero. */
  delta: z.number().min(-365).max(365),
  reason: z.string().min(5).max(500),
})

export const approveDeviceChange = z.object({
  employeeId: uuid,
  deviceId: z.string().min(8).max(128),
})

export const uploadDocumentRequest = z.object({
  employeeId: uuid.nullable(),
  type: z.enum(['contract', 'policy', 'payslip_placeholder', 'certificate', 'letter', 'other']),
  name: z.string().min(1).max(200),
  contentType: z.string().min(3).max(120),
  sizeBytes: z.number().int().min(1).max(50_000_000),
  requiresAcknowledgement: z.boolean().default(false),
})

export type UpsertEmployee = z.infer<typeof upsertEmployee>
export type UpsertLeaveType = z.infer<typeof upsertLeaveType>
export type UpsertLocation = z.infer<typeof upsertLocation>
export type BulkImportResponse = z.infer<typeof bulkImportResponse>
