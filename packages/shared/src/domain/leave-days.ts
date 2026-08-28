/**
 * Turning a requested date range into chargeable leave days.
 *
 * Non-working days and public holidays are skipped, so a Friday-to-Monday
 * request costs two days rather than four.
 */

import { eachDay, type ISODate } from './dates.js'
import { isWorkingDay, type WorkSchedule } from './lateness.js'
import type { Draw } from './accrual.js'

export interface LeaveDaysInput {
  start: ISODate
  /** Inclusive. */
  end: ISODate
  halfDayStart: boolean
  halfDayEnd: boolean
  schedule: WorkSchedule
  /** Org public holidays as ISO dates. */
  holidays?: ISODate[]
}

export interface LeaveDaysResult {
  draws: Draw[]
  daysCount: number
  workingDays: ISODate[]
  skipped: { date: ISODate; reason: 'non_working_day' | 'holiday' }[]
}

export function computeLeaveDays(input: LeaveDaysInput): LeaveDaysResult {
  const holidays = new Set(input.holidays ?? [])
  const workingDays: ISODate[] = []
  const skipped: LeaveDaysResult['skipped'] = []

  for (const date of eachDay(input.start, input.end)) {
    if (!isWorkingDay(date, input.schedule)) {
      skipped.push({ date, reason: 'non_working_day' })
      continue
    }
    if (holidays.has(date)) {
      skipped.push({ date, reason: 'holiday' })
      continue
    }
    workingDays.push(date)
  }

  const draws: Draw[] = workingDays.map((date, i) => {
    const isFirst = i === 0
    const isLast = i === workingDays.length - 1
    // A single-day request flagged as a half day at either end is still half a
    // day, not two halves.
    const half =
      (isFirst && input.halfDayStart) || (isLast && input.halfDayEnd)
    return { date, amount: half ? 0.5 : 1 }
  })

  const daysCount = round2(draws.reduce((sum, d) => sum + d.amount, 0))
  return { draws, daysCount, workingDays, skipped }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
