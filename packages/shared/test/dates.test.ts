import { describe, expect, it } from 'vitest'
import {
  addDays,
  addMonths,
  dayOfWeek,
  daysInMonth,
  diffDays,
  eachDay,
  fromEpochDay,
  intersect,
  isISODate,
  isLeapYear,
  monthsBetween,
  rangesOverlap,
  toEpochDay,
} from '../src/domain/dates.js'

describe('calendar basics', () => {
  it('identifies leap years including the century rules', () => {
    expect(isLeapYear(2024)).toBe(true)
    expect(isLeapYear(2025)).toBe(false)
    expect(isLeapYear(1900)).toBe(false)
    expect(isLeapYear(2000)).toBe(true)
  })

  it('reports February length correctly', () => {
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2025, 2)).toBe(28)
  })

  it('rejects impossible dates', () => {
    expect(isISODate('2025-02-29')).toBe(false)
    expect(isISODate('2024-02-29')).toBe(true)
    expect(isISODate('2025-13-01')).toBe(false)
    expect(isISODate('2025-1-1')).toBe(false)
  })
})

describe('epoch day round-trip', () => {
  it('round-trips known dates', () => {
    expect(toEpochDay('1970-01-01')).toBe(0)
    expect(fromEpochDay(0)).toBe('1970-01-01')
    expect(fromEpochDay(toEpochDay('2025-08-28'))).toBe('2025-08-28')
    expect(fromEpochDay(toEpochDay('1999-12-31'))).toBe('1999-12-31')
  })

  it('round-trips every day across a leap year boundary', () => {
    for (let d = toEpochDay('2024-02-01'); d <= toEpochDay('2024-03-31'); d++) {
      expect(toEpochDay(fromEpochDay(d))).toBe(d)
    }
  })
})

describe('addDays / addMonths', () => {
  it('crosses a leap day', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(addDays('2025-02-28', 1)).toBe('2025-03-01')
  })

  it('clamps month arithmetic to the end of a short month', () => {
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28')
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29')
    expect(addMonths('2025-03-31', -1)).toBe('2025-02-28')
  })

  it('counts days across a year boundary', () => {
    expect(diffDays('2024-12-31', '2025-01-01')).toBe(1)
    expect(diffDays('2024-01-01', '2025-01-01')).toBe(366)
    expect(diffDays('2025-01-01', '2026-01-01')).toBe(365)
  })
})

describe('dayOfWeek', () => {
  it('maps to 0 = Sunday', () => {
    expect(dayOfWeek('2025-08-28')).toBe(4) // Thursday
    expect(dayOfWeek('2025-08-31')).toBe(0) // Sunday
    expect(dayOfWeek('2025-09-01')).toBe(1) // Monday
  })
})

describe('monthsBetween', () => {
  it('returns whole months for aligned dates', () => {
    expect(monthsBetween('2025-01-01', '2026-01-01')).toBe(12)
    expect(monthsBetween('2025-07-01', '2026-01-01')).toBe(6)
  })

  it('returns zero for an empty or inverted range', () => {
    expect(monthsBetween('2025-01-01', '2025-01-01')).toBe(0)
    expect(monthsBetween('2025-06-01', '2025-01-01')).toBe(0)
  })

  it('adds a fractional tail for a partial month', () => {
    // 16 Jan → 1 Feb is 16 of January's 31 days.
    expect(monthsBetween('2025-01-16', '2025-02-01')).toBeCloseTo(16 / 31, 10)
  })

  it('measures a leap February against 29 days', () => {
    expect(monthsBetween('2024-02-01', '2024-02-15')).toBeCloseTo(14 / 29, 10)
    expect(monthsBetween('2025-02-01', '2025-02-15')).toBeCloseTo(14 / 28, 10)
  })
})

describe('ranges', () => {
  it('detects overlap on a shared boundary day', () => {
    expect(
      rangesOverlap({ start: '2025-01-01', end: '2025-01-10' }, { start: '2025-01-10', end: '2025-01-20' }),
    ).toBe(true)
    expect(
      rangesOverlap({ start: '2025-01-01', end: '2025-01-09' }, { start: '2025-01-10', end: '2025-01-20' }),
    ).toBe(false)
  })

  it('intersects to the overlapping span or null', () => {
    expect(
      intersect({ start: '2025-01-01', end: '2025-06-30' }, { start: '2025-04-01', end: '2025-12-31' }),
    ).toEqual({ start: '2025-04-01', end: '2025-06-30' })
    expect(
      intersect({ start: '2025-01-01', end: '2025-03-31' }, { start: '2025-04-01', end: '2025-12-31' }),
    ).toBeNull()
  })

  it('enumerates an inclusive range', () => {
    expect(eachDay('2025-01-30', '2025-02-02')).toEqual([
      '2025-01-30',
      '2025-01-31',
      '2025-02-01',
      '2025-02-02',
    ])
  })
})
