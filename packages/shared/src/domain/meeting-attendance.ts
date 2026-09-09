/**
 * Meeting attendance resolution (meeting-assistant spec §7).
 *
 * This feeds the disciplinary system later, so the metric that matters is the
 * false-positive rate, not coverage. Every guard in `resolveAttendance` maps to
 * a real situation that would otherwise produce an unjust record, and each one
 * is named in the code below so it cannot be quietly optimised away.
 *
 * Nothing here reads a clock. The caller passes the conference facts in and
 * gets records out, which is what makes the guards testable against the exact
 * awkward cases they exist for.
 */

export type MeetingSource = 'google_meet' | 'in_person'

export type MeetingAttendanceStatus =
  | 'present'
  | 'late'
  | 'absent'
  | 'excused'
  /** The meeting was too short to hold anyone to. */
  | 'void'

export type InviteStatus = 'accepted' | 'declined' | 'tentative' | 'needs_action'

/** Why the whole meeting produced the records it did. */
export type MeetingResolution =
  /** No conference record: the meeting did not happen. No records at all. */
  | 'did_not_occur'
  /** It happened, but collapsed before the minimum duration. Everything voids. */
  | 'too_short'
  | 'recorded'

export interface Invitee {
  employeeId: string
  inviteStatus: InviteStatus
  isOptional: boolean
  /** Approved leave covering the meeting. Drives `excused`. */
  onApprovedLeave: boolean
}

/**
 * One join/leave pair. Someone who dropped and rejoined has several, which is
 * exactly why this is a list and not a single `joinedAt` on the participant.
 */
export interface ParticipantSession {
  employeeId: string
  joinedAt: Date
  /** `null` when the participant was still in the meeting when it ended. */
  leftAt: Date | null
  source: MeetingSource
}

export interface MeetingWindow {
  scheduledStart: Date
  scheduledEnd: Date
  /** `null` when no conference record exists — the meeting did not occur. */
  actualStart: Date | null
  actualEnd: Date | null
}

export interface MeetingAttendanceRules {
  /** Minutes past the start before someone counts as late. Default 5. */
  graceMinutes: number
  /** Below this, the meeting voids for everyone. Default 5. */
  minimumDurationMinutes: number
  /**
   * If the conference started more than this many minutes after the scheduled
   * time, lateness is measured from the actual start instead.
   */
  hostLateToleranceMinutes: number
}

export const DEFAULT_MEETING_ATTENDANCE_RULES: MeetingAttendanceRules = {
  graceMinutes: 5,
  minimumDurationMinutes: 5,
  hostLateToleranceMinutes: 2,
}

export interface MeetingAttendanceRecord {
  employeeId: string
  status: MeetingAttendanceStatus
  /** Raw minutes past the measurement baseline, before grace. 0 when on time. */
  minutesLate: number
  firstJoinAt: Date | null
  lastLeaveAt: Date | null
  totalDurationSeconds: number
  /** `null` for someone who never joined. */
  source: MeetingSource | null
  isOptional: boolean
  inviteStatus: InviteStatus
  /**
   * `false` for someone who turned up without being on the invite. They are
   * recorded because they were demonstrably there, but they were never expected
   * and must never be counted against an absence figure.
   */
  expected: boolean
}

export interface MeetingAttendanceInput {
  window: MeetingWindow
  invitees: Invitee[]
  sessions: ParticipantSession[]
  rules?: Partial<MeetingAttendanceRules>
}

export interface MeetingAttendanceResult {
  resolution: MeetingResolution
  records: MeetingAttendanceRecord[]
  /**
   * The instant lateness was measured against. Equal to `scheduledStart` unless
   * the host started late, in which case it is `actualStart`.
   */
  measuredFrom: Date | null
  /** `null` when the meeting did not occur. */
  durationMinutes: number | null
  /** True when lateness was measured from the actual start, not the schedule. */
  hostStartedLate: boolean
}

/**
 * Expected attendance per §7.1: invited, not declined, not optional, not on
 * approved leave.
 *
 * Declining is correct behaviour and is never penalised. If it were, people
 * would stop declining and the calendar data would degrade for everyone —
 * which costs more than the handful of records it would have produced.
 */
export function isExpected(invitee: Invitee): boolean {
  return (
    invitee.inviteStatus !== 'declined' &&
    !invitee.isOptional &&
    !invitee.onApprovedLeave
  )
}

const MINUTE_MS = 60_000

export function resolveAttendance(
  input: MeetingAttendanceInput,
): MeetingAttendanceResult {
  const rules = { ...DEFAULT_MEETING_ATTENDANCE_RULES, ...input.rules }
  const { window, invitees } = input

  // Guard 1 — the meeting was cancelled and the calendar was never updated.
  // With no conference record we produce nothing. Marking a room of people
  // absent from a meeting that did not happen is the worst output this
  // function could give, so it is the first thing ruled out.
  if (window.actualStart === null) {
    return {
      resolution: 'did_not_occur',
      records: [],
      measuredFrom: null,
      durationMinutes: null,
      hostStartedLate: false,
    }
  }

  const end = window.actualEnd ?? window.scheduledEnd
  const durationMinutes = Math.max(
    0,
    (end.getTime() - window.actualStart.getTime()) / MINUTE_MS,
  )

  // Guard 2 — the host started materially late. Measuring against the schedule
  // would mark the entire room late whenever the organiser was, which is both
  // unjust and the fastest way to teach people the figure means nothing.
  const hostDelayMinutes =
    (window.actualStart.getTime() - window.scheduledStart.getTime()) / MINUTE_MS
  const hostStartedLate = hostDelayMinutes > rules.hostLateToleranceMinutes
  const measuredFrom = hostStartedLate ? window.actualStart : window.scheduledStart

  // Guard 3 — dual attendance. Someone in the room who also joined the Meet
  // link appears in both session sets; they are one person and get one record.
  const byEmployee = new Map<string, ParticipantSession[]>()
  for (const session of input.sessions) {
    const list = byEmployee.get(session.employeeId)
    if (list) list.push(session)
    else byEmployee.set(session.employeeId, [session])
  }

  const inviteeById = new Map(invitees.map((i) => [i.employeeId, i]))
  const employeeIds = new Set<string>([
    ...invitees.map((i) => i.employeeId),
    ...byEmployee.keys(),
  ])

  const records: MeetingAttendanceRecord[] = []

  for (const employeeId of employeeIds) {
    const invitee = inviteeById.get(employeeId)
    const sessions = byEmployee.get(employeeId) ?? []
    const presence = summariseSessions(sessions, end)

    // Guard 4 — optional invitees and proper decliners are excluded from
    // expected attendance entirely (§7.1), and a no-show by either produces no
    // record at all. They still get one if they actually showed up, because
    // that happened and is worth knowing.
    //
    // Approved leave is the exception that has to be spelled out: it also
    // clears `expected`, but an excused record is a real outcome (§7.2) rather
    // than an absence to suppress, so it is written even with no sessions.
    const expected = invitee ? isExpected(invitee) : false
    const silent =
      !invitee || invitee.isOptional || invitee.inviteStatus === 'declined'
    if (sessions.length === 0 && silent) continue

    records.push({
      employeeId,
      firstJoinAt: presence.firstJoinAt,
      lastLeaveAt: presence.lastLeaveAt,
      totalDurationSeconds: presence.totalDurationSeconds,
      source: presence.source,
      isOptional: invitee?.isOptional ?? false,
      inviteStatus: invitee?.inviteStatus ?? 'needs_action',
      expected,
      ...classify({
        invitee,
        firstJoinAt: presence.firstJoinAt,
        measuredFrom,
        graceMinutes: rules.graceMinutes,
      }),
    })
  }

  records.sort((a, b) => a.employeeId.localeCompare(b.employeeId))

  // Guard 5 — the meeting collapsed after two minutes. Below the minimum
  // duration the whole set voids: nobody was meaningfully absent from a
  // meeting that barely happened, and nobody was meaningfully present either.
  if (durationMinutes < rules.minimumDurationMinutes) {
    return {
      resolution: 'too_short',
      records: records.map((r) => ({ ...r, status: 'void' as const, minutesLate: 0 })),
      measuredFrom,
      durationMinutes,
      hostStartedLate,
    }
  }

  return {
    resolution: 'recorded',
    records,
    measuredFrom,
    durationMinutes,
    hostStartedLate,
  }
}

function classify(args: {
  invitee: Invitee | undefined
  firstJoinAt: Date | null
  measuredFrom: Date
  graceMinutes: number
}): { status: MeetingAttendanceStatus; minutesLate: number } {
  const { invitee, firstJoinAt, measuredFrom, graceMinutes } = args

  // Approved leave outranks everything, including a no-show that would
  // otherwise read as absent.
  if (invitee?.onApprovedLeave) return { status: 'excused', minutesLate: 0 }

  if (firstJoinAt === null) return { status: 'absent', minutesLate: 0 }

  const minutesLate = Math.max(
    0,
    Math.round((firstJoinAt.getTime() - measuredFrom.getTime()) / MINUTE_MS),
  )

  // The stored figure is raw and grace is applied only to the status, for the
  // same reason as daily attendance: someone 4 minutes late to every meeting
  // under a 5-minute grace is a pattern, and folding grace into the number
  // erases it.
  return {
    status: minutesLate > graceMinutes ? 'late' : 'present',
    minutesLate,
  }
}

interface Presence {
  firstJoinAt: Date | null
  lastLeaveAt: Date | null
  totalDurationSeconds: number
  source: MeetingSource | null
}

/**
 * Collapses every session into one presence summary.
 *
 * Guard 6 — earliest join across all sessions, never the last. Someone whose
 * connection dropped at minute 20 and who rejoined at minute 22 was on time,
 * and taking the latest join would record them as twenty minutes late.
 */
function summariseSessions(
  sessions: ParticipantSession[],
  meetingEnd: Date,
): Presence {
  if (sessions.length === 0) {
    return {
      firstJoinAt: null,
      lastLeaveAt: null,
      totalDurationSeconds: 0,
      source: null,
    }
  }

  let firstJoinAt = sessions[0]!.joinedAt
  let lastLeaveAt = sessions[0]!.leftAt ?? meetingEnd
  let totalMs = 0

  for (const session of sessions) {
    if (session.joinedAt < firstJoinAt) firstJoinAt = session.joinedAt
    const left = session.leftAt ?? meetingEnd
    if (left > lastLeaveAt) lastLeaveAt = left
    totalMs += Math.max(0, left.getTime() - session.joinedAt.getTime())
  }

  // In-person wins the label when someone attended both ways: they were in the
  // room, and the room is the stronger claim.
  const source: MeetingSource = sessions.some((s) => s.source === 'in_person')
    ? 'in_person'
    : 'google_meet'

  return {
    firstJoinAt,
    lastLeaveAt,
    totalDurationSeconds: Math.round(totalMs / 1000),
    source,
  }
}

/**
 * Dispute rate over the records produced (§7.4).
 *
 * The product spec's threshold is 2%. Above it the feature is not trustworthy
 * enough to feed the query engine, and the answer is to disconnect the two
 * rather than to tune the number.
 */
export const MEETING_DISPUTE_RATE_THRESHOLD = 0.02

export function disputeRate(disputes: number, records: number): number {
  if (records === 0) return 0
  return disputes / records
}

export function disputeRateAcceptable(disputes: number, records: number): boolean {
  return disputeRate(disputes, records) <= MEETING_DISPUTE_RATE_THRESHOLD
}
