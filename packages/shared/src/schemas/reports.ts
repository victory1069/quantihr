import { z } from 'zod'
import { isoDate, isoInstant, uuid } from './common.js'

/**
 * Leave analysis for the HR console.
 *
 * **The division of labour here is the whole design.** Every number is computed
 * in SQL and handed to the model already finished; the model's only job is to
 * say what the numbers mean. It is never given rows to count, never asked for a
 * total, and its output schema has no numeric field it could invent one in.
 *
 * That constraint is not fussiness. This report is read by an HR lead deciding
 * whether to challenge a manager about their team's absence, and a hallucinated
 * headcount would be indistinguishable from a real one at the moment it matters
 * most. It is the same reasoning as the mandatory verbatim quote on meeting
 * actions: the model may interpret evidence, never manufacture it.
 */

export const reportQuery = z.object({
  from: isoDate,
  to: isoDate,
})

// ---------------------------------------------------------------------------
// Computed facts — SQL only, no model involvement
// ---------------------------------------------------------------------------

export const leaveTypeUsage = z.object({
  leaveTypeName: z.string(),
  requests: z.number().int(),
  daysTaken: z.number(),
})

export const departmentAbsence = z.object({
  departmentName: z.string(),
  headcount: z.number().int(),
  daysTaken: z.number(),
  /** Days taken per head. The comparable figure across unequal teams. */
  daysPerHead: z.number(),
})

export const approvalLatency = z.object({
  decided: z.number().int(),
  medianHours: z.number(),
  slowestHours: z.number(),
  /** Still pending past the 48h nudge threshold. */
  overdue: z.number().int(),
})

export const leaveFacts = z.object({
  from: isoDate,
  to: isoDate,
  headcount: z.number().int(),
  requests: z.object({
    total: z.number().int(),
    approved: z.number().int(),
    declined: z.number().int(),
    pending: z.number().int(),
    cancelled: z.number().int(),
  }),
  daysTaken: z.number(),
  byType: z.array(leaveTypeUsage),
  byDepartment: z.array(departmentAbsence),
  approval: approvalLatency,
  /**
   * Approvals that went through against a coverage rule. Each one was a
   * deliberate override with a recorded reason, so a rising count is a
   * signal about the rules rather than about the managers.
   */
  overrides: z.number().int(),
  /**
   * Accrued but untaken days across the org. This is a real liability — it is
   * money owed if everyone left tomorrow — and it is the figure a proprietor
   * has never seen before buying this product.
   */
  untakenDays: z.number(),
  /** Employees who took no leave at all in the window. */
  tookNothing: z.number().int(),
})

export type LeaveFacts = z.infer<typeof leaveFacts>

// ---------------------------------------------------------------------------
// The model's output — interpretation only
// ---------------------------------------------------------------------------

export const findingSeverity = z.enum(['info', 'watch', 'act'])

export const reportFinding = z.object({
  finding: z.string().describe('One sentence. What is true and why it matters.'),
  /**
   * Must restate a figure from the supplied facts. This is what makes a claim
   * checkable at a glance, and what makes an invented one obvious.
   */
  evidence: z
    .string()
    .describe('The specific figure from the data that supports this, quoted as given.'),
  severity: findingSeverity,
})

export const reportAnalysis = z.object({
  headline: z.string().describe('One sentence summing up the period.'),
  findings: z.array(reportFinding),
  recommendations: z
    .array(z.string())
    .describe('Concrete actions for the HR lead. Empty if nothing needs doing.'),
})

export type ReportAnalysis = z.infer<typeof reportAnalysis>

/** Mirror of `reportAnalysis` for the structured-output call. See meetings.ts. */
export const reportAnalysisJsonSchema = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          finding: { type: 'string' },
          evidence: {
            type: 'string',
            description: 'A figure taken verbatim from the supplied data.',
          },
          severity: { type: 'string', enum: ['info', 'watch', 'act'] },
        },
        required: ['finding', 'evidence', 'severity'],
        additionalProperties: false,
      },
    },
    recommendations: { type: 'array', items: { type: 'string' } },
  },
  required: ['headline', 'findings', 'recommendations'],
  additionalProperties: false,
} as const

export const leaveReport = z.object({
  facts: leaveFacts,
  /** `null` when summarisation is unavailable — the figures still stand alone. */
  analysis: reportAnalysis.nullable(),
  generatedAt: isoInstant,
  model: z.string().nullable(),
  costUsd: z.number(),
})

export type LeaveReport = z.infer<typeof leaveReport>

export const reportEmployeeRow = z.object({
  employeeId: uuid,
  employeeName: z.string(),
  daysTaken: z.number(),
})

// ---------------------------------------------------------------------------
// The other report kinds
// ---------------------------------------------------------------------------

export const reportKind = z.enum(['leave', 'attendance', 'performance', 'meetings'])
export type ReportKind = z.infer<typeof reportKind>

/** Shown in the console picker, so the copy lives with the contract. */
export const REPORT_KINDS: { kind: ReportKind; label: string; blurb: string }[] = [
  { kind: 'leave', label: 'Leave', blurb: 'Days taken, approval speed and the untaken liability.' },
  { kind: 'attendance', label: 'Attendance', blurb: 'Punctuality and absence across clock-ins.' },
  { kind: 'performance', label: 'Performance', blurb: 'Task completion and response time.' },
  { kind: 'meetings', label: 'Meetings', blurb: 'Volume, action quality and dispute rate.' },
]

export const attendanceFacts = z.object({
  from: isoDate,
  to: isoDate,
  headcount: z.number().int(),
  records: z.number().int(),
  present: z.number().int(),
  late: z.number().int(),
  absent: z.number().int(),
  /** Present as a share of days actually recorded. */
  punctualityRate: z.number(),
  totalMinutesLate: z.number().int(),
  medianMinutesLate: z.number(),
  recordedOffline: z.number().int(),
  openDisputes: z.number().int(),
  byDepartment: z.array(
    z.object({
      departmentName: z.string(),
      headcount: z.number().int(),
      lateRate: z.number(),
      records: z.number().int(),
    }),
  ),
  /**
   * Lateness by weekday. A Monday pattern is a commute or a rota problem; a
   * flat distribution is an individual one, and telling those apart is most of
   * what an HR lead wants from this.
   */
  byWeekday: z.array(z.object({ weekday: z.string(), records: z.number().int(), late: z.number().int() })),
})

export const performanceFacts = z.object({
  from: isoDate,
  to: isoDate,
  assigned: z.number().int(),
  completed: z.number().int(),
  outstanding: z.number().int(),
  overdue: z.number().int(),
  completionRate: z.number(),
  /** Confirmed to completed. Null when too few finished to have a middle. */
  medianResponseDays: z.number().nullable(),
  unassigned: z.number().int(),
  /**
   * Per person, and only above `minSample`. A median over one or two tasks is
   * noise, and publishing it invites a comparison the data cannot support.
   */
  minSample: z.number().int(),
  byOwner: z.array(
    z.object({
      employeeName: z.string(),
      completed: z.number().int(),
      overdue: z.number().int(),
      medianResponseDays: z.number().nullable(),
    }),
  ),
})

export const meetingsFacts = z.object({
  from: isoDate,
  to: isoDate,
  held: z.number().int(),
  didNotOccur: z.number().int(),
  tooShort: z.number().int(),
  totalMinutes: z.number().int(),
  actionsExtracted: z.number().int(),
  actionsConfirmed: z.number().int(),
  actionsDismissed: z.number().int(),
  /**
   * Share of extracted actions the host threw away. This is the direct measure
   * of over-extraction, which the spec calls the failure that erodes trust
   * fastest — a climbing number means the summariser is inventing work.
   */
  dismissalRate: z.number(),
  awaitingReview: z.number().int(),
  attendanceRecords: z.number().int(),
  disputes: z.number().int(),
  /** Against the 2% product-health threshold in the meeting spec §7.4. */
  disputeRate: z.number(),
  disputeRateAcceptable: z.boolean(),
  llmCostUsd: z.number(),
})

export type AttendanceFacts = z.infer<typeof attendanceFacts>
export type PerformanceFacts = z.infer<typeof performanceFacts>
export type MeetingsFacts = z.infer<typeof meetingsFacts>

/** Any report: the shape is identical, only the facts differ. */
export const reportResponse = z.object({
  kind: reportKind,
  facts: z.union([leaveFacts, attendanceFacts, performanceFacts, meetingsFacts]),
  analysis: reportAnalysis.nullable(),
  generatedAt: isoInstant,
  model: z.string().nullable(),
  costUsd: z.number(),
})
