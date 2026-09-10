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
import { and, between, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import {
  ApiError,
  ERROR_CODES,
  disputeRateAcceptable,
  schemas,
  type AttendanceFacts,
  type LeaveFacts,
  type MeetingsFacts,
  type PerformanceFacts,
  type ReportAnalysis,
  type ReportKind,
} from '@quanti/shared'
import {
  attendanceDisputes,
  attendanceRecords,
  departments,
  employees,
  leaveBalances,
  leaveRequests,
  leaveTypes,
  meetingActions,
  meetingDisputes,
  meetingParticipants,
  meetingSummaries,
  meetings,
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
// Attendance
// ---------------------------------------------------------------------------

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export async function computeAttendanceFacts(
  tx: Tx,
  from: string,
  to: string,
): Promise<AttendanceFacts> {
  const staff = await tx
    .select({ id: employees.id, departmentId: employees.departmentId, status: employees.status })
    .from(employees)
  const active = staff.filter((e) => e.status === 'active')

  const records = await tx
    .select({
      employeeId: attendanceRecords.employeeId,
      date: attendanceRecords.date,
      status: attendanceRecords.status,
      minutesLate: attendanceRecords.minutesLate,
      recordedOffline: attendanceRecords.recordedOffline,
    })
    .from(attendanceRecords)
    .where(between(attendanceRecords.date, from, to))

  const present = records.filter((r) => r.status === 'present').length
  const late = records.filter((r) => r.status === 'late').length
  const absent = records.filter((r) => r.status === 'absent').length

  const lateMinutes = records
    .filter((r) => r.minutesLate > 0)
    .map((r) => r.minutesLate)
    .sort((a, b) => a - b)

  const depts = await tx
    .select({ id: departments.id, name: departments.name })
    .from(departments)

  const byDepartment = depts
    .map((dept) => {
      const ids = new Set(active.filter((e) => e.departmentId === dept.id).map((e) => e.id))
      const own = records.filter((r) => ids.has(r.employeeId))
      const lateHere = own.filter((r) => r.status === 'late').length
      return {
        departmentName: dept.name,
        headcount: ids.size,
        records: own.length,
        lateRate: own.length > 0 ? round1((lateHere / own.length) * 100) : 0,
      }
    })
    .filter((d) => d.headcount > 0)
    .sort((a, b) => b.lateRate - a.lateRate)

  // Weekday distribution. A Monday spike is a commute or rota problem; a flat
  // spread is an individual one, and separating those is most of the value.
  const byWeekday = WEEKDAYS.map((weekday, index) => {
    const own = records.filter((r) => new Date(`${r.date}T00:00:00Z`).getUTCDay() === index)
    return {
      weekday,
      records: own.length,
      late: own.filter((r) => r.status === 'late').length,
    }
  }).filter((d) => d.records > 0)

  const disputes = await tx
    .select({ id: attendanceDisputes.id })
    .from(attendanceDisputes)
    .where(eq(attendanceDisputes.status, 'open'))

  return {
    from,
    to,
    headcount: active.length,
    records: records.length,
    present,
    late,
    absent,
    punctualityRate:
      present + late > 0 ? round1((present / (present + late)) * 100) : 0,
    totalMinutesLate: records.reduce((sum, r) => sum + r.minutesLate, 0),
    medianMinutesLate: median(lateMinutes),
    recordedOffline: records.filter((r) => r.recordedOffline).length,
    openDisputes: disputes.length,
    byDepartment,
    byWeekday,
  }
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

/**
 * Below this many completed tasks an individual median is noise, and showing
 * it invites a comparison the data cannot support. Team figures are always
 * shown; per-person medians are withheld until there is enough to mean
 * something.
 */
const MIN_OWNER_SAMPLE = 3

export async function computePerformanceFacts(
  tx: Tx,
  from: string,
  to: string,
): Promise<PerformanceFacts> {
  const start = new Date(`${from}T00:00:00.000Z`)
  const end = new Date(`${to}T23:59:59.999Z`)

  // Only confirmed work counts. A draft the host never approved was never
  // assigned to anyone, and holding someone to it would be indefensible.
  const rows = await tx
    .select({
      id: meetingActions.id,
      ownerEmployeeId: meetingActions.ownerEmployeeId,
      status: meetingActions.status,
      dueDate: meetingActions.dueDate,
      confirmedAt: meetingActions.confirmedAt,
      completedAt: meetingActions.completedAt,
      firstName: employees.firstName,
      lastName: employees.lastName,
    })
    .from(meetingActions)
    .leftJoin(employees, eq(employees.id, meetingActions.ownerEmployeeId))
    .where(
      and(
        inArray(meetingActions.status, ['confirmed', 'done']),
        gte(meetingActions.confirmedAt, start),
        lte(meetingActions.confirmedAt, end),
      ),
    )

  const completed = rows.filter((r) => r.status === 'done' && r.completedAt)
  const outstanding = rows.filter((r) => r.status === 'confirmed')
  const today = new Date().toISOString().slice(0, 10)
  const overdue = outstanding.filter((r) => r.dueDate && r.dueDate < today)

  const responseDays = (r: (typeof completed)[number]): number =>
    (r.completedAt!.getTime() - r.confirmedAt!.getTime()) / 86_400_000

  const owners = new Map<string, { name: string; rows: typeof rows }>()
  for (const row of rows) {
    if (!row.ownerEmployeeId) continue
    const name = `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim() || 'Unknown'
    const entry = owners.get(row.ownerEmployeeId) ?? { name, rows: [] as typeof rows }
    entry.rows.push(row)
    owners.set(row.ownerEmployeeId, entry)
  }

  const byOwner = [...owners.values()]
    .map((o) => {
      const done = o.rows.filter((r) => r.status === 'done' && r.completedAt)
      return {
        employeeName: o.name,
        completed: done.length,
        overdue: o.rows.filter(
          (r) => r.status === 'confirmed' && r.dueDate && r.dueDate < today,
        ).length,
        medianResponseDays:
          done.length >= MIN_OWNER_SAMPLE
            ? round1(median(done.map(responseDays).sort((a, b) => a - b)))
            : null,
      }
    })
    .sort((a, b) => b.completed - a.completed)

  return {
    from,
    to,
    assigned: rows.length,
    completed: completed.length,
    outstanding: outstanding.length,
    overdue: overdue.length,
    completionRate: rows.length > 0 ? round1((completed.length / rows.length) * 100) : 0,
    medianResponseDays:
      completed.length >= MIN_OWNER_SAMPLE
        ? round1(median(completed.map(responseDays).sort((a, b) => a - b)))
        : null,
    unassigned: rows.filter((r) => !r.ownerEmployeeId).length,
    minSample: MIN_OWNER_SAMPLE,
    byOwner,
  }
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

export async function computeMeetingsFacts(
  tx: Tx,
  from: string,
  to: string,
): Promise<MeetingsFacts> {
  const start = new Date(`${from}T00:00:00.000Z`)
  const end = new Date(`${to}T23:59:59.999Z`)

  const rows = await tx
    .select({
      id: meetings.id,
      status: meetings.status,
      resolution: meetings.attendanceResolution,
      actualStart: meetings.actualStart,
      actualEnd: meetings.actualEnd,
    })
    .from(meetings)
    .where(and(gte(meetings.scheduledStart, start), lte(meetings.scheduledStart, end)))

  const ids = rows.map((r) => r.id)

  const totalMinutes = rows.reduce((sum, r) => {
    if (!r.actualStart || !r.actualEnd) return sum
    return sum + (r.actualEnd.getTime() - r.actualStart.getTime()) / 60_000
  }, 0)

  const actions =
    ids.length > 0
      ? await tx
          .select({ status: meetingActions.status })
          .from(meetingActions)
          .where(inArray(meetingActions.meetingId, ids))
      : []

  const participants =
    ids.length > 0
      ? await tx
          .select({ status: meetingParticipants.attendanceStatus })
          .from(meetingParticipants)
          .where(inArray(meetingParticipants.meetingId, ids))
      : []

  const disputes =
    ids.length > 0
      ? await tx
          .select({ id: meetingDisputes.id })
          .from(meetingDisputes)
          .where(inArray(meetingDisputes.meetingId, ids))
      : []

  const summaries =
    ids.length > 0
      ? await tx
          .select({ cost: meetingSummaries.costUsd })
          .from(meetingSummaries)
          .where(inArray(meetingSummaries.meetingId, ids))
      : []

  const confirmed = actions.filter((a) => a.status === 'confirmed' || a.status === 'done').length
  const dismissed = actions.filter((a) => a.status === 'dismissed').length
  const decided = confirmed + dismissed

  // Records the attendance engine actually stood behind. A voided meeting
  // produced rows that hold nobody to anything, so counting them would inflate
  // the denominator and flatter the dispute rate.
  const countedRecords = participants.filter((p) => p.status && p.status !== 'void').length

  return {
    from,
    to,
    held: rows.filter((r) => r.resolution === 'recorded').length,
    didNotOccur: rows.filter((r) => r.resolution === 'did_not_occur').length,
    tooShort: rows.filter((r) => r.resolution === 'too_short').length,
    totalMinutes: Math.round(totalMinutes),
    actionsExtracted: actions.length,
    actionsConfirmed: confirmed,
    actionsDismissed: dismissed,
    // The direct measure of over-extraction. A climbing figure means the
    // summariser is inventing work, which the spec calls the failure that
    // erodes trust fastest.
    dismissalRate: decided > 0 ? round1((dismissed / decided) * 100) : 0,
    awaitingReview: rows.filter((r) => r.status === 'awaiting_review').length,
    attendanceRecords: countedRecords,
    disputes: disputes.length,
    disputeRate: countedRecords > 0 ? round1((disputes.length / countedRecords) * 100) : 0,
    disputeRateAcceptable: disputeRateAcceptable(disputes.length, countedRecords),
    llmCostUsd: Math.round(summaries.reduce((sum, s) => sum + num(s.cost), 0) * 1_000_000) / 1_000_000,
  }
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2
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

export async function analyse(
  kind: ReportKind,
  facts: object,
): Promise<AnalysisResult | null> {
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
            `${kind} figures:

` +
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
