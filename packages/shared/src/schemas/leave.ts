import { z } from 'zod'
import { accrualMethod, isoDate, isoInstant, leaveRequestStatus, uuid } from './common.js'

export const leaveType = z.object({
  id: uuid,
  name: z.string(),
  accrualMethod,
  accrualRate: z.number(),
  maxBalance: z.number().nullable(),
  carryoverCap: z.number().nullable(),
  carryoverExpiryMonths: z.number().int().nullable(),
  requiresDocument: z.boolean(),
  minNoticeDays: z.number().int().nullable(),
  isPaid: z.boolean(),
  colour: z.string(),
})

export const leaveBalance = z.object({
  leaveTypeId: uuid,
  leaveTypeName: z.string(),
  colour: z.string(),
  periodStart: isoDate,
  periodEnd: isoDate,
  accrued: z.number(),
  taken: z.number(),
  pending: z.number(),
  carriedOver: z.number(),
  adjustment: z.number(),
  /** `accrued + carriedOver + adjustment − taken − pending`, expiry applied. */
  available: z.number(),
  carryoverExpiresOn: isoDate.nullable(),
})

export const createLeaveRequest = z
  .object({
    leaveTypeId: uuid,
    start: isoDate,
    end: isoDate,
    halfDayStart: z.boolean().default(false),
    halfDayEnd: z.boolean().default(false),
    reason: z.string().max(1000).optional(),
    documentUrl: z.string().url().optional(),
    /** Echoed back from check-conflicts so the server knows what was shown. */
    acknowledgedWarnings: z.array(z.string()).default([]),
  })
  .refine((v) => v.start <= v.end, {
    message: 'end must be on or after start',
    path: ['end'],
  })

export const coverageWarning = z.object({
  code: z.enum([
    'blackout_period',
    'max_concurrent_absent',
    'max_concurrent_percent',
    'critical_role_uncovered',
    'insufficient_notice',
  ]),
  message: z.string(),
  date: isoDate.nullable(),
  requiresOverride: z.boolean(),
})

export const checkConflictsRequest = z.object({
  leaveTypeId: uuid,
  start: isoDate,
  end: isoDate,
  halfDayStart: z.boolean().default(false),
  halfDayEnd: z.boolean().default(false),
})

/** Shown inline before submit, never as a blocking modal after the fact (§5). */
export const checkConflictsResponse = z.object({
  daysCount: z.number(),
  workingDays: z.array(isoDate),
  skipped: z.array(z.object({ date: isoDate, reason: z.enum(['non_working_day', 'holiday']) })),
  balanceBefore: z.number(),
  balanceAfter: z.number(),
  sufficientBalance: z.boolean(),
  shortfallOn: isoDate.nullable(),
  expiredMidRequest: z.number(),
  overlapsExistingRequest: z.boolean(),
  warnings: z.array(coverageWarning),
})

export const leaveRequest = z.object({
  id: uuid,
  leaveTypeId: uuid,
  leaveTypeName: z.string(),
  colour: z.string(),
  employeeId: uuid,
  employeeName: z.string(),
  start: isoDate,
  end: isoDate,
  daysCount: z.number(),
  halfDayStart: z.boolean(),
  halfDayEnd: z.boolean(),
  reason: z.string().nullable(),
  status: leaveRequestStatus,
  submittedAt: isoInstant,
  decidedAt: isoInstant.nullable(),
  decidedByName: z.string().nullable(),
  decisionNote: z.string().nullable(),
  overrideReason: z.string().nullable(),
  documentUrl: z.string().nullable(),
  warnings: z.array(coverageWarning).default([]),
})

export const listLeaveRequestsQuery = z.object({
  status: leaveRequestStatus.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
})

export const approvalDecision = z
  .object({
    decision: z.enum(['approve', 'decline']),
    note: z.string().max(1000).optional(),
    /** Required when approving against a coverage warning (spec §5). */
    overrideReason: z.string().min(10).max(1000).optional(),
  })

export type LeaveType = z.infer<typeof leaveType>
export type LeaveBalanceView = z.infer<typeof leaveBalance>
export type LeaveRequestView = z.infer<typeof leaveRequest>
export type CheckConflictsResponse = z.infer<typeof checkConflictsResponse>
export type CreateLeaveRequest = z.infer<typeof createLeaveRequest>
export type ApprovalDecision = z.infer<typeof approvalDecision>
