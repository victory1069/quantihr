import { describe, expect, it } from 'vitest'
import {
  computeLateness,
  evaluateWindow,
  isWorkingDay,
  toMinutes,
  toTimeString,
  type WorkSchedule,
} from '../src/domain/lateness.js'

const SCHEDULE: WorkSchedule = {
  workingDays: [1, 2, 3, 4, 5],
  startTime: '09:00',
  endTime: '17:00',
  gracePeriodMinutes: 10,
  checkinWindowStart: '06:00',
  checkinWindowEnd: '11:00',
}

describe('time helpers', () => {
  it('converts between HH:MM and minutes', () => {
    expect(toMinutes('09:00')).toBe(540)
    expect(toMinutes('09:15:30')).toBe(555)
    expect(toTimeString(555)).toBe('09:15')
    expect(toTimeString(0)).toBe('00:00')
  })

  it('rejects malformed times', () => {
    expect(() => toMinutes('nine')).toThrow()
  })
})

describe('isWorkingDay', () => {
  it('follows the schedule, not the calendar', () => {
    expect(isWorkingDay('2025-08-28', SCHEDULE)).toBe(true) // Thursday
    expect(isWorkingDay('2025-08-30', SCHEDULE)).toBe(false) // Saturday
    expect(isWorkingDay('2025-08-31', SCHEDULE)).toBe(false) // Sunday
  })

  it('supports a Sunday-inclusive schedule', () => {
    const shift: WorkSchedule = { ...SCHEDULE, workingDays: [0, 3, 5] }
    expect(isWorkingDay('2025-08-31', shift)).toBe(true)
    expect(isWorkingDay('2025-08-28', shift)).toBe(false)
  })
})

describe('evaluateWindow', () => {
  it('is open inside the window on a working day', () => {
    const w = evaluateWindow('2025-08-28', toMinutes('08:30'), SCHEDULE)
    expect(w.open).toBe(true)
    expect(w.reason).toBe('open')
  })

  it('says how long until the window opens', () => {
    const w = evaluateWindow('2025-08-28', toMinutes('05:30'), SCHEDULE)
    expect(w.open).toBe(false)
    expect(w.reason).toBe('too_early')
    expect(w.minutesUntilOpen).toBe(30)
  })

  it('closes after the window end', () => {
    const w = evaluateWindow('2025-08-28', toMinutes('11:01'), SCHEDULE)
    expect(w.open).toBe(false)
    expect(w.reason).toBe('too_late')
  })

  it('is closed on a non-working day even inside the clock window', () => {
    const w = evaluateWindow('2025-08-30', toMinutes('08:30'), SCHEDULE)
    expect(w.open).toBe(false)
    expect(w.reason).toBe('not_a_working_day')
  })
})

describe('computeLateness', () => {
  it('treats an early arrival as present with zero lateness', () => {
    const r = computeLateness(toMinutes('08:45'), SCHEDULE)
    expect(r.minutesLate).toBe(0)
    expect(r.status).toBe('present')
  })

  it('records raw lateness even when it falls inside grace', () => {
    // The stored figure must not hide a habitual 9-minutes-late pattern behind
    // a 10-minute grace period.
    const r = computeLateness(toMinutes('09:09'), SCHEDULE)
    expect(r.minutesLate).toBe(9)
    expect(r.minutesBeyondGrace).toBe(0)
    expect(r.withinGrace).toBe(true)
    expect(r.status).toBe('present')
  })

  it('marks late once grace is exhausted', () => {
    const r = computeLateness(toMinutes('09:11'), SCHEDULE)
    expect(r.minutesLate).toBe(11)
    expect(r.minutesBeyondGrace).toBe(1)
    expect(r.status).toBe('late')
  })

  it('treats the last minute of grace as on time', () => {
    const r = computeLateness(toMinutes('09:10'), SCHEDULE)
    expect(r.status).toBe('present')
    expect(r.minutesBeyondGrace).toBe(0)
  })

  it('handles a zero grace period', () => {
    const r = computeLateness(toMinutes('09:01'), { ...SCHEDULE, gracePeriodMinutes: 0 })
    expect(r.status).toBe('late')
    expect(r.minutesLate).toBe(1)
  })
})
