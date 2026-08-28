import { describe, expect, it } from 'vitest'
import { computeLeaveDays } from '../src/domain/leave-days.js'
import type { WorkSchedule } from '../src/domain/lateness.js'

const SCHEDULE: WorkSchedule = {
  workingDays: [1, 2, 3, 4, 5],
  startTime: '09:00',
  endTime: '17:00',
  gracePeriodMinutes: 10,
  checkinWindowStart: '06:00',
  checkinWindowEnd: '11:00',
}

const req = (start: string, end: string, over = {}) =>
  computeLeaveDays({
    start,
    end,
    halfDayStart: false,
    halfDayEnd: false,
    schedule: SCHEDULE,
    ...over,
  })

describe('computeLeaveDays', () => {
  it('counts a plain working week', () => {
    // Mon 1 Sep 2025 → Fri 5 Sep 2025
    expect(req('2025-09-01', '2025-09-05').daysCount).toBe(5)
  })

  it('skips the weekend in a Friday-to-Monday request', () => {
    const r = req('2025-09-05', '2025-09-08')
    expect(r.daysCount).toBe(2)
    expect(r.workingDays).toEqual(['2025-09-05', '2025-09-08'])
    expect(r.skipped.map((s) => s.reason)).toEqual(['non_working_day', 'non_working_day'])
  })

  it('skips public holidays', () => {
    const r = req('2025-09-01', '2025-09-05', { holidays: ['2025-09-03'] })
    expect(r.daysCount).toBe(4)
    expect(r.skipped).toEqual([{ date: '2025-09-03', reason: 'holiday' }])
  })

  it('applies half days at each end', () => {
    expect(req('2025-09-01', '2025-09-05', { halfDayStart: true }).daysCount).toBe(4.5)
    expect(req('2025-09-01', '2025-09-05', { halfDayEnd: true }).daysCount).toBe(4.5)
    expect(
      req('2025-09-01', '2025-09-05', { halfDayStart: true, halfDayEnd: true }).daysCount,
    ).toBe(4)
  })

  it('charges a single-day half-day request half a day, not two halves', () => {
    const r = req('2025-09-01', '2025-09-01', { halfDayStart: true, halfDayEnd: true })
    expect(r.daysCount).toBe(0.5)
    expect(r.draws).toEqual([{ date: '2025-09-01', amount: 0.5 }])
  })

  it('anchors half days to the first and last working day, not the raw range', () => {
    // Request starts on a Saturday; the half day belongs to the Monday.
    const r = req('2025-09-06', '2025-09-10', { halfDayStart: true })
    expect(r.draws[0]).toEqual({ date: '2025-09-08', amount: 0.5 })
    expect(r.daysCount).toBe(2.5)
  })

  it('returns nothing chargeable for a weekend-only request', () => {
    const r = req('2025-09-06', '2025-09-07')
    expect(r.daysCount).toBe(0)
    expect(r.draws).toEqual([])
  })

  it('spans a leap day without dropping it', () => {
    const r = req('2024-02-28', '2024-03-01')
    expect(r.workingDays).toContain('2024-02-29')
    expect(r.daysCount).toBe(3)
  })

  it('does not accumulate float error over a long request', () => {
    const r = req('2025-09-01', '2025-12-31', { halfDayStart: true, halfDayEnd: true })
    expect(Number.isInteger(r.daysCount * 2)).toBe(true)
  })
})
