/**
 * Lateness and check-in window computation.
 *
 * Works in wall-clock minutes-from-midnight in the org's timezone. The API layer
 * converts the authoritative server instant into that local wall clock before
 * calling in — never the device clock (spec §4).
 */

import { dayOfWeek, type ISODate } from './dates.js'

export type AttendanceStatus =
  | 'present'
  | 'late'
  | 'absent'
  | 'rejected'
  | 'pending_review'

export interface WorkSchedule {
  /** 0 = Sunday … 6 = Saturday. */
  workingDays: number[]
  /** `HH:MM` local. */
  startTime: string
  endTime: string
  gracePeriodMinutes: number
  checkinWindowStart: string
  checkinWindowEnd: string
}

/** `HH:MM` or `HH:MM:SS` → minutes from midnight. */
export function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) {
    throw new RangeError(`Not a valid time: ${time}`)
  }
  return h * 60 + m
}

export function toTimeString(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440
  const h = Math.floor(wrapped / 60)
  const m = wrapped % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function isWorkingDay(date: ISODate, schedule: WorkSchedule): boolean {
  return schedule.workingDays.includes(dayOfWeek(date))
}

export interface WindowState {
  open: boolean
  /** `HH:MM` the window opens on this date. */
  opensAt: string
  closesAt: string
  minutesUntilOpen: number
  minutesUntilClose: number
  reason: 'open' | 'too_early' | 'too_late' | 'not_a_working_day'
}

export function evaluateWindow(
  date: ISODate,
  nowMinutes: number,
  schedule: WorkSchedule,
): WindowState {
  const opensAt = schedule.checkinWindowStart
  const closesAt = schedule.checkinWindowEnd
  const open = toMinutes(opensAt)
  const close = toMinutes(closesAt)
  const base = {
    opensAt,
    closesAt,
    minutesUntilOpen: Math.max(0, open - nowMinutes),
    minutesUntilClose: Math.max(0, close - nowMinutes),
  }

  if (!isWorkingDay(date, schedule)) {
    return { ...base, open: false, reason: 'not_a_working_day' }
  }
  if (nowMinutes < open) return { ...base, open: false, reason: 'too_early' }
  if (nowMinutes > close) return { ...base, open: false, reason: 'too_late' }
  return { ...base, open: true, reason: 'open' }
}

export interface LatenessResult {
  /** Minutes past the scheduled start, before grace. 0 when on time or early. */
  minutesLate: number
  /** Minutes past the end of the grace period. Drives `status`. */
  minutesBeyondGrace: number
  status: Extract<AttendanceStatus, 'present' | 'late'>
  withinGrace: boolean
}

/**
 * `minutesLate` records the raw figure and `status` applies grace separately.
 *
 * Folding grace into the stored number would mean an employee 9 minutes late
 * under a 10-minute grace shows as 0, and HR loses the pattern that matters
 * when someone is 9 minutes late every single day.
 */
export function computeLateness(
  checkInMinutes: number,
  schedule: WorkSchedule,
): LatenessResult {
  const start = toMinutes(schedule.startTime)
  const minutesLate = Math.max(0, checkInMinutes - start)
  const minutesBeyondGrace = Math.max(
    0,
    checkInMinutes - (start + schedule.gracePeriodMinutes),
  )
  return {
    minutesLate,
    minutesBeyondGrace,
    withinGrace: minutesBeyondGrace === 0,
    status: minutesBeyondGrace > 0 ? 'late' : 'present',
  }
}
