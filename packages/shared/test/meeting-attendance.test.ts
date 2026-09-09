import { describe, expect, it } from 'vitest'
import {
  disputeRate,
  disputeRateAcceptable,
  isExpected,
  resolveAttendance,
  type Invitee,
  type ParticipantSession,
} from '../src/domain/meeting-attendance.js'

const at = (hhmm: string): Date => new Date(`2026-09-07T${hhmm}:00.000Z`)

const window = {
  scheduledStart: at('10:00'),
  scheduledEnd: at('11:00'),
  actualStart: at('10:00'),
  actualEnd: at('11:00'),
}

const invitee = (id: string, over: Partial<Invitee> = {}): Invitee => ({
  employeeId: id,
  inviteStatus: 'accepted',
  isOptional: false,
  onApprovedLeave: false,
  ...over,
})

const session = (
  id: string,
  join: string,
  leave: string | null = '11:00',
  source: 'google_meet' | 'in_person' = 'google_meet',
): ParticipantSession => ({
  employeeId: id,
  joinedAt: at(join),
  leftAt: leave === null ? null : at(leave),
  source,
})

const find = <T extends { employeeId: string }>(records: T[], id: string): T =>
  records.find((r) => r.employeeId === id)!

describe('expected attendance', () => {
  it('excludes optional invitees', () => {
    expect(isExpected(invitee('a', { isOptional: true }))).toBe(false)
  })

  it('excludes people who declined', () => {
    expect(isExpected(invitee('a', { inviteStatus: 'declined' }))).toBe(false)
  })

  it('includes people who have not responded', () => {
    expect(isExpected(invitee('a', { inviteStatus: 'needs_action' }))).toBe(true)
  })

  it('excludes people on approved leave', () => {
    expect(isExpected(invitee('a', { onApprovedLeave: true }))).toBe(false)
  })
})

describe('status resolution', () => {
  it('marks someone who joined on time as present', () => {
    const { records, resolution } = resolveAttendance({
      window,
      invitees: [invitee('a')],
      sessions: [session('a', '10:00')],
    })

    expect(resolution).toBe('recorded')
    expect(find(records, 'a').status).toBe('present')
    expect(find(records, 'a').minutesLate).toBe(0)
  })

  it('allows the grace period before calling someone late', () => {
    const { records } = resolveAttendance({
      window,
      invitees: [invitee('a')],
      sessions: [session('a', '10:05')],
    })

    // Five minutes late under a five-minute grace is still present, but the
    // raw figure is kept so the pattern survives.
    expect(find(records, 'a').status).toBe('present')
    expect(find(records, 'a').minutesLate).toBe(5)
  })

  it('marks someone past grace as late with the raw minutes', () => {
    const { records } = resolveAttendance({
      window,
      invitees: [invitee('a')],
      sessions: [session('a', '10:12')],
    })

    expect(find(records, 'a').status).toBe('late')
    expect(find(records, 'a').minutesLate).toBe(12)
  })

  it('marks an expected invitee with no sessions absent', () => {
    const { records } = resolveAttendance({
      window,
      invitees: [invitee('a')],
      sessions: [],
    })

    expect(find(records, 'a').status).toBe('absent')
  })

  it('marks someone on approved leave excused rather than absent', () => {
    const { records } = resolveAttendance({
      window,
      invitees: [invitee('a', { onApprovedLeave: true })],
      sessions: [],
    })

    expect(find(records, 'a').status).toBe('excused')
  })

  it('sums duration across sessions', () => {
    const { records } = resolveAttendance({
      window,
      invitees: [invitee('a')],
      sessions: [session('a', '10:00', '10:20'), session('a', '10:30', '11:00')],
    })

    expect(find(records, 'a').totalDurationSeconds).toBe(50 * 60)
  })

  it('treats a participant still in the meeting at the end as leaving at the end', () => {
    const { records } = resolveAttendance({
      window,
      invitees: [invitee('a')],
      sessions: [session('a', '10:00', null)],
    })

    expect(find(records, 'a').lastLeaveAt).toEqual(at('11:00'))
    expect(find(records, 'a').totalDurationSeconds).toBe(60 * 60)
  })
})

describe('guards against false positives', () => {
  it('produces no records at all when the meeting did not happen', () => {
    const result = resolveAttendance({
      window: { ...window, actualStart: null, actualEnd: null },
      invitees: [invitee('a'), invitee('b')],
      sessions: [],
    })

    // The cancelled-but-not-updated calendar. Marking a room of people absent
    // from a meeting that never occurred is the worst available output.
    expect(result.resolution).toBe('did_not_occur')
    expect(result.records).toEqual([])
  })

  it('voids every record when the meeting collapsed before the minimum', () => {
    const result = resolveAttendance({
      window: { ...window, actualEnd: at('10:03') },
      invitees: [invitee('a'), invitee('b')],
      sessions: [session('a', '10:00', '10:03')],
    })

    expect(result.resolution).toBe('too_short')
    expect(result.records.map((r) => r.status)).toEqual(['void', 'void'])
    expect(result.records.every((r) => r.minutesLate === 0)).toBe(true)
  })

  it('never marks an optional invitee absent', () => {
    const { records } = resolveAttendance({
      window,
      invitees: [invitee('a', { isOptional: true })],
      sessions: [],
    })

    expect(records).toEqual([])
  })

  it('never marks someone who declined absent', () => {
    const { records } = resolveAttendance({
      window,
      invitees: [invitee('a', { inviteStatus: 'declined' })],
      sessions: [],
    })

    expect(records).toEqual([])
  })

  it('still records an optional invitee who actually attended', () => {
    const { records } = resolveAttendance({
      window,
      invitees: [invitee('a', { isOptional: true })],
      sessions: [session('a', '10:00')],
    })

    expect(find(records, 'a').status).toBe('present')
    expect(find(records, 'a').expected).toBe(false)
  })

  it('uses the earliest join when someone dropped and rejoined', () => {
    const { records } = resolveAttendance({
      window,
      invitees: [invitee('a')],
      // Joined on time, dropped at 10:20, rejoined at 10:22.
      sessions: [session('a', '10:22', '11:00'), session('a', '10:00', '10:20')],
    })

    expect(find(records, 'a').status).toBe('present')
    expect(find(records, 'a').minutesLate).toBe(0)
  })

  it('measures lateness from the actual start when the host started late', () => {
    const result = resolveAttendance({
      window: { ...window, actualStart: at('10:15'), actualEnd: at('11:15') },
      invitees: [invitee('a'), invitee('b')],
      sessions: [session('a', '10:15', '11:15'), session('b', '10:16', '11:15')],
    })

    // Against the schedule both would be 15+ minutes late, which is the
    // organiser's fault, not theirs.
    expect(result.hostStartedLate).toBe(true)
    expect(result.measuredFrom).toEqual(at('10:15'))
    expect(find(result.records, 'a').status).toBe('present')
    expect(find(result.records, 'a').minutesLate).toBe(0)
    expect(find(result.records, 'b').minutesLate).toBe(1)
  })

  it('does not shift the baseline for a trivially late start', () => {
    const result = resolveAttendance({
      window: { ...window, actualStart: at('10:01') },
      invitees: [invitee('a')],
      sessions: [session('a', '10:08')],
    })

    expect(result.hostStartedLate).toBe(false)
    expect(find(result.records, 'a').minutesLate).toBe(8)
  })

  it('deduplicates someone present in the room and on the call', () => {
    const { records } = resolveAttendance({
      window,
      invitees: [invitee('a')],
      sessions: [
        session('a', '10:00', '11:00', 'in_person'),
        session('a', '10:02', '11:00', 'google_meet'),
      ],
    })

    expect(records).toHaveLength(1)
    expect(find(records, 'a').source).toBe('in_person')
    expect(find(records, 'a').status).toBe('present')
  })

  it('records an uninvited attendee without marking them expected', () => {
    const { records } = resolveAttendance({
      window,
      invitees: [invitee('a')],
      sessions: [session('a', '10:00'), session('z', '10:00')],
    })

    expect(find(records, 'z').status).toBe('present')
    expect(find(records, 'z').expected).toBe(false)
    expect(find(records, 'a').expected).toBe(true)
  })
})

describe('dispute rate', () => {
  it('is zero when nothing was recorded', () => {
    expect(disputeRate(0, 0)).toBe(0)
  })

  it('holds at the 2% threshold', () => {
    expect(disputeRateAcceptable(2, 100)).toBe(true)
    expect(disputeRateAcceptable(3, 100)).toBe(false)
  })
})
