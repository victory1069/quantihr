/**
 * Leave analysis (HR console → Reports).
 *
 * Two halves, deliberately kept apart:
 *
 *   1. `computeLeaveFacts` does arithmetic in SQL and TypeScript. It is pure
 *      counting and it is tested.
 *   2. `analyseLeave` hands those finished figures to a model and asks only for
 *      interpretation.
 *
 * The model never sees a row it could count, and its output schema contains no
 * numeric field it could invent one in. An HR lead reads this report before
 * challenging a manager about their team's absence — a fabricated headcount
 * would be indistinguishable from a real one at exactly the moment it matters.
 *
 * If the model is unavailable the report still returns, with `analysis: null`.
 * The figures are the product; the prose is the convenience.
 */

import Anthropic from '@anthropic-ai/sdk'
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema'
import { and, sql } from 'drizzle-orm'
import {
  ApiError,
  ERROR_CODES,
  schemas,
  type LeaveFacts,
  type ReportAnalysis,
} from '@quanti/shared'
import {
  departments,
  employees,
  leaveBalances,
  leaveRequests,
  leaveTypes,
} from '../db/schema.js'
import type { Tx } from '../db/client.js'
import { anthropic, costOf, extractionAvailable } from './anthropic.js'
import { env } from './env.js'

const num = (v: string | number | null | undefined): number => Number(v ?? 0)
const round1 = (n: number): number => Math.round(n * 10) / 10

// ---------------------------------------------------------------------------
// 1. The figures
// ---------------------------------------------------------------------------

export async function computeLeaveFacts(
  tx: Tx,
  from: string,
  to: string,
): Promise<LeaveFacts> {
  const staff = await tx
    .select({
      id: employees.id,
      departmentId: employees.departmentId,
      status: employees.status,
    })
    .from(employees)

  const active = staff.filter((e) => e.status === 'active')

  // Requests that overlap the window at all, not only those that start inside
  // it — a fortnight beginning on the 28th belongs to both months, and dropping
  // it from one would make the two reports disagree.
  const requests = await tx
    .select({
      id: leaveRequests.id,
      employeeId: leaveRequests.employeeId,
      leaveTypeId: leaveRequests.leaveTypeId,
      status: leaveRequests.status,
      daysCount: leaveRequests.daysCount,
      submittedAt: leaveRequests.submittedAt,
      decidedAt: leaveRequests.decidedAt,
      overrideReason: leaveRequests.overrideReason,
    })
    .from(leaveRequests)
    .where(
      and(
        sql`${leaveRequests.startDate} <= ${to}`,
        sql`${leaveRequests.endDate} >= ${from}`,
      ),
    )

  const approved = requests.filter((r) => r.status === 'approved')
  const daysTaken = approved.reduce((sum, r) => sum + num(r.daysCount), 0)

  const types = await tx
    .select({ id: leaveTypes.id, name: leaveTypes.name })
    .from(leaveTypes)

  const byType = types
    .map((type) => {
      const own = approved.filter((r) => r.leaveTypeId === type.id)
      return {
        leaveTypeName: type.name,
        requests: own.length,
        daysTaken: round1(own.reduce((sum, r) => sum + num(r.daysCount), 0)),
      }
    })
    .filter((t) => t.requests > 0)
    .sort((a, b) => b.daysTaken - a.daysTaken)

  const depts = await tx
    .select({ id: departments.id, name: departments.name })
    .from(departments)

  const byDepartment = depts
    .map((dept) => {
      const members = active.filter((e) => e.departmentId === dept.id)
      const ids = new Set(members.map((m) => m.id))
      const days = approved
        .filter((r) => ids.has(r.employeeId))
        .reduce((sum, r) => sum + num(r.daysCount), 0)
      return {
        departmentName: dept.name,
        headcount: members.length,
        daysTaken: round1(days),
        // Per head, because comparing a team of three against a team of thirty
        // on raw days says nothing.
        daysPerHead: members.length > 0 ? round1(days / members.length) : 0,
      }
    })
    .filter((d) => d.headcount > 0)
    .sort((a, b) => b.daysPerHead - a.daysPerHead)

  const decided = requests.filter((r) => r.decidedAt !== null)
  const latencies = decided
    .map((r) => (r.decidedAt!.getTime() - r.submittedAt.getTime()) / 3_600_000)
    .sort((a, b) => a - b)

  const median =
    latencies.length === 0
      ? 0
      : latencies.length % 2 === 1
        ? latencies[(latencies.length - 1) / 2]!
        : (latencies[latencies.length / 2 - 1]! + latencies[latencies.length / 2]!) / 2

  const now = Date.now()
  const overdue = requests.filter(
    (r) => r.status === 'pending' && now - r.submittedAt.getTime() > 48 * 3_600_000,
  ).length

  const balances = await tx
    .select({ accrued: leaveBalances.accrued, taken: leaveBalances.taken })
    .from(leaveBalances)

  const untakenDays = round1(
    balances.reduce((sum, b) => sum + Math.max(0, num(b.accrued) - num(b.taken)), 0),
  )

  const tookLeave = new Set(approved.map((r) => r.employeeId))

  return {
    from,
    to,
    headcount: active.length,
    requests: {
      total: requests.length,
      approved: approved.length,
      declined: requests.filter((r) => r.status === 'declined').length,
      pending: requests.filter((r) => r.status === 'pending').length,
      cancelled: requests.filter((r) => r.status === 'cancelled').length,
    },
    daysTaken: round1(daysTaken),
    byType,
    byDepartment,
    approval: {
      decided: decided.length,
      medianHours: round1(median),
      slowestHours: round1(latencies.length > 0 ? latencies[latencies.length - 1]! : 0),
      overdue,
    },
    overrides: approved.filter((r) => r.overrideReason).length,
    untakenDays,
    tookNothing: active.filter((e) => !tookLeave.has(e.id)).length,
  }
}

// ---------------------------------------------------------------------------
// 2. The interpretation
// ---------------------------------------------------------------------------

/**
 * The prompt spends most of its length on prohibitions, as the meeting
 * extractor does, and for the same reason: the failure that destroys trust is
 * not a dull report, it is a confident wrong one.
 */
const SYSTEM_PROMPT = `You are an HR analyst writing a short leave report for the HR lead of a
mid-sized Nigerian company.

You are given a JSON object of figures that have ALREADY been computed. Your job
is to say what they mean.

Rules, in order of importance:

1. Never state a number that is not in the supplied data. Do not add, average,
   project, or otherwise derive a new figure. If you want to say something the
   data does not support, do not say it.

2. Every finding carries an "evidence" field restating the specific figure it
   rests on, exactly as supplied. If you cannot point at a figure, the finding
   does not belong in the report.

3. Severity means what it says. "act" is for something that needs a decision
   this week — an approval queue past the nudge threshold, a department at an
   outlier absence rate. "watch" is a trend worth a second look next month.
   "info" is context. Most findings are info. Do not inflate severity to seem
   useful.

4. Say when nothing is wrong. A period where leave was taken evenly, approvals
   were quick and nothing breached coverage is a good outcome and should be
   reported as one. An empty recommendations list is a valid answer.

5. Untaken accrued days are a liability, not an achievement. A high figure with
   many employees taking nothing is a burnout and balance-sheet signal, not
   evidence of a committed workforce.

6. Be concrete and plain. No management jargon, no "leverage", no "going
   forward". Write the way a competent colleague would in an email.`

export interface AnalysisResult {
  analysis: ReportAnalysis
  model: string
  costUsd: number
}

export async function analyseLeave(facts: LeaveFacts): Promise<AnalysisResult | null> {
  if (!extractionAvailable()) return null

  const model = env().MEETING_MODEL

  const response = await anthropic()
    .messages.parse({
      model,
      max_tokens: 8000,
      output_config: {
        effort: 'medium',
        format: jsonSchemaOutputFormat(schemas.reports.reportAnalysisJsonSchema),
      },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content:
            `Leave figures for ${facts.from} to ${facts.to}:\n\n` +
            `${JSON.stringify(facts, null, 2)}`,
        },
      ],
    })
    .catch((error: unknown) => {
      if (error instanceof Anthropic.APIError) {
        throw new ApiError(
          ERROR_CODES.MEETING_EXTRACTION_UNAVAILABLE,
          'The analyst is unavailable. The figures below are still accurate.',
          502,
        )
      }
      throw error
    })

  if (response.stop_reason === 'refusal' || !response.parsed_output) {
    return null
  }

  const parsed = schemas.reports.reportAnalysis.safeParse(response.parsed_output)
  if (!parsed.success) return null

  const usage = response.usage
  return {
    analysis: parsed.data,
    model,
    costUsd: costOf(model, {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    }),
  }
}
