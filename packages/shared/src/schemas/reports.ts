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
