import { describe, expect, it } from 'vitest'
import {
  AccrualNotImplementedError,
  availableOn,
  computeAccrual,
  computeCarryover,
  drawDown,
  resolvePeriod,
  roundDays,
  type LeaveBalance,
  type LeaveTypeConfig,
} from '../src/domain/accrual.js'

const annual = (over: Partial<LeaveTypeConfig> = {}): LeaveTypeConfig => ({
  id: 'lt-annual',
  name: 'Annual Leave',
  accrualMethod: 'annual_fixed',
  accrualRate: 20,
  maxBalance: null,
  carryoverCap: null,
  carryoverExpiryMonths: null,
  ...over,
})

const PERIOD_2025 = { start: '2025-01-01', end: '2025-12-31' }

describe('roundDays', () => {
  it('rounds to whole days up and down', () => {
    expect(roundDays(16.67, 'up')).toBe(17)
    expect(roundDays(16.67, 'down')).toBe(16)
  })

  it('rounds to the nearest half day', () => {
    expect(roundDays(16.67, 'nearest_half')).toBe(16.5)
    expect(roundDays(16.3, 'nearest_half')).toBe(16.5)
    expect(roundDays(16.2, 'nearest_half')).toBe(16)
    expect(roundDays(16.25, 'nearest_half')).toBe(16.5)
  })

  it('does not let binary float error swallow a day under `down`', () => {
    // 10/12*20 and friends land just under an integer; a naive floor loses a day.
    expect(roundDays(2.9999999999999996, 'down')).toBe(3)
    expect(roundDays(2.9, 'down')).toBe(2)
  })
})

describe('computeAccrual — annual grant', () => {
  it('grants the full entitlement to someone employed all period', () => {
    const r = computeAccrual({
      leaveType: annual(),
      employment: { startDate: '2020-01-01', endDate: null },
      period: PERIOD_2025,
      asOf: '2025-06-15',
      rounding: 'nearest_half',
    })
    expect(r.accrued).toBe(20)
    expect(r.proRataFactor).toBe(1)
  })

  it('pro-rates a mid-year joiner', () => {
    const r = computeAccrual({
      leaveType: annual(),
      employment: { startDate: '2025-07-01', endDate: null },
      period: PERIOD_2025,
      asOf: '2025-12-31',
      rounding: 'nearest_half',
    })
    expect(r.proRataFactor).toBeCloseTo(0.5, 10)
    expect(r.accrued).toBe(10)
  })

  it('pro-rates a mid-year leaver', () => {
    const r = computeAccrual({
      leaveType: annual(),
      employment: { startDate: '2020-01-01', endDate: '2025-06-30' },
      period: PERIOD_2025,
      asOf: '2025-12-31',
      rounding: 'nearest_half',
    })
    expect(r.proRataFactor).toBeCloseTo(0.5, 10)
    expect(r.accrued).toBe(10)
  })

  it('pro-rates someone who both joined and left inside the period', () => {
    const r = computeAccrual({
      leaveType: annual(),
      employment: { startDate: '2025-04-01', endDate: '2025-09-30' },
      period: PERIOD_2025,
      asOf: '2025-12-31',
      rounding: 'nearest_half',
    })
    expect(r.proRataFactor).toBeCloseTo(0.5, 10)
    expect(r.accrued).toBe(10)
  })

  it('gives a joiner partway through a month a fractional month, not a whole one', () => {
    const r = computeAccrual({
      leaveType: annual(),
      employment: { startDate: '2025-07-16', endDate: null },
      period: PERIOD_2025,
      asOf: '2025-12-31',
      rounding: 'nearest_half',
    })
    // 16 Jul → 31 Dec is 5 months + 16/31, i.e. 5.52 of 12 → 9.19 days raw.
    // A whole-month reading would have given 6/12 → 10; the fractional tail is
    // the difference between the two, and it rounds down to 9.
    expect(r.raw).toBeCloseTo(9.19, 2)
    expect(r.accrued).toBe(9)
  })

  it('accrues nothing when employment does not overlap the period', () => {
    const r = computeAccrual({
      leaveType: annual(),
      employment: { startDate: '2026-02-01', endDate: null },
      period: PERIOD_2025,
      asOf: '2025-12-31',
      rounding: 'nearest_half',
    })
    expect(r.accrued).toBe(0)
    expect(r.proRataFactor).toBe(0)
  })

  it('caps at maxBalance and reports that it did', () => {
    const r = computeAccrual({
      leaveType: annual({ accrualRate: 30, maxBalance: 25 }),
      employment: { startDate: '2020-01-01', endDate: null },
      period: PERIOD_2025,
      asOf: '2025-12-31',
      rounding: 'nearest_half',
    })
    expect(r.accrued).toBe(25)
    expect(r.cappedByMaxBalance).toBe(true)
  })

  it('applies the org rounding rule to the same underlying figure', () => {
    const base = {
      employment: { startDate: '2024-03-01', endDate: null },
      period: { start: '2024-01-01', end: '2024-12-31' },
      asOf: '2024-12-31',
    } as const
    // 10 of 12 months × 20 days = 16.67
    expect(computeAccrual({ ...base, leaveType: annual(), rounding: 'up' }).accrued).toBe(17)
    expect(computeAccrual({ ...base, leaveType: annual(), rounding: 'down' }).accrued).toBe(16)
    expect(
      computeAccrual({ ...base, leaveType: annual(), rounding: 'nearest_half' }).accrued,
    ).toBe(16.5)
  })
})

describe('computeAccrual — leap years', () => {
  it('treats a full leap year as a full year, not 366/365 of one', () => {
    const r = computeAccrual({
      leaveType: annual(),
      employment: { startDate: '2020-01-01', endDate: null },
      period: { start: '2024-01-01', end: '2024-12-31' },
      asOf: '2024-12-31',
      rounding: 'nearest_half',
    })
    expect(r.accrued).toBe(20)
    expect(r.proRataFactor).toBe(1)
  })

  it('handles employment starting on 29 February', () => {
    const r = computeAccrual({
      leaveType: annual(),
      employment: { startDate: '2024-02-29', endDate: null },
      period: { start: '2024-01-01', end: '2024-12-31' },
      asOf: '2024-12-31',
      rounding: 'nearest_half',
    })
    // 29 Feb → 31 Dec: 10 whole months from 29 Feb, plus 1/29 of February.
    expect(r.raw).toBeGreaterThan(16.6)
    expect(r.raw).toBeLessThan(17.3)
  })

  it('lands a 29 February anniversary on 28 February in a common year', () => {
    const period = resolvePeriod('annual_anniversary', '2025-06-01', {
      leaveYearStart: '01-01',
      employmentStart: '2024-02-29',
    })
    expect(period.start).toBe('2025-02-28')
    expect(period.end).toBe('2026-02-27')
  })
})

describe('computeAccrual — monthly', () => {
  const monthly = annual({ accrualMethod: 'monthly', accrualRate: 1.75 })

  it('credits only completed months as of the run date', () => {
    const r = computeAccrual({
      leaveType: monthly,
      employment: { startDate: '2025-01-01', endDate: null },
      period: PERIOD_2025,
      asOf: '2025-04-15',
      rounding: 'nearest_half',
    })
    // Three completed months by 15 April → 5.25 → 5.5 at half-day rounding.
    expect(r.raw).toBeCloseTo(5.25, 10)
    expect(r.accrued).toBe(5.5)
  })

  it('credits nothing before the first month completes', () => {
    const r = computeAccrual({
      leaveType: monthly,
      employment: { startDate: '2025-01-01', endDate: null },
      period: PERIOD_2025,
      asOf: '2025-01-20',
      rounding: 'nearest_half',
    })
    expect(r.accrued).toBe(0)
  })

  it('stops accruing at the employment end date', () => {
    const r = computeAccrual({
      leaveType: monthly,
      employment: { startDate: '2025-01-01', endDate: '2025-03-31' },
      period: PERIOD_2025,
      asOf: '2025-12-31',
      rounding: 'down',
    })
    expect(r.raw).toBeCloseTo(5.25, 10)
  })
})

describe('computeAccrual — unimplemented methods', () => {
  it('throws a typed error for per_hours_worked rather than silently accruing zero', () => {
    expect(() =>
      computeAccrual({
        leaveType: annual({ accrualMethod: 'per_hours_worked' }),
        employment: { startDate: '2025-01-01', endDate: null },
        period: PERIOD_2025,
        asOf: '2025-06-01',
        rounding: 'down',
      }),
    ).toThrow(AccrualNotImplementedError)
  })
})

describe('resolvePeriod', () => {
  it('finds the leave year containing the date for a fixed start', () => {
    const p = resolvePeriod('annual_fixed', '2025-08-01', {
      leaveYearStart: '04-01',
      employmentStart: '2020-01-01',
    })
    expect(p).toEqual({ start: '2025-04-01', end: '2026-03-31' })
  })

  it('rolls back to the previous year when the date precedes the anchor', () => {
    const p = resolvePeriod('annual_fixed', '2025-02-01', {
      leaveYearStart: '04-01',
      employmentStart: '2020-01-01',
    })
    expect(p).toEqual({ start: '2024-04-01', end: '2025-03-31' })
  })

  it('keys off the employment date for anniversary accrual', () => {
    const p = resolvePeriod('annual_anniversary', '2025-08-01', {
      leaveYearStart: '01-01',
      employmentStart: '2021-09-15',
    })
    expect(p).toEqual({ start: '2024-09-15', end: '2025-09-14' })
  })
})

describe('computeCarryover', () => {
  it('caps carryover and reports what was forfeited', () => {
    const r = computeCarryover(12, annual({ carryoverCap: 5 }), '2026-01-01')
    expect(r.carriedOver).toBe(5)
    expect(r.forfeited).toBe(7)
  })

  it('carries everything when there is no cap', () => {
    const r = computeCarryover(12, annual(), '2026-01-01')
    expect(r.carriedOver).toBe(12)
    expect(r.forfeited).toBe(0)
    expect(r.expiresOn).toBeNull()
  })

  it('never carries a negative balance forward', () => {
    const r = computeCarryover(-3, annual({ carryoverCap: 5 }), '2026-01-01')
    expect(r.carriedOver).toBe(0)
    expect(r.forfeited).toBe(0)
  })

  it('sets an inclusive expiry date from the expiry window', () => {
    const r = computeCarryover(5, annual({ carryoverExpiryMonths: 3 }), '2026-01-01')
    expect(r.expiresOn).toBe('2026-03-31')
  })
})

const balance = (over: Partial<LeaveBalance> = {}): LeaveBalance => ({
  accrued: 20,
  carriedOver: 0,
  adjustment: 0,
  taken: 0,
  pending: 0,
  carryoverExpiresOn: null,
  ...over,
})

describe('availableOn', () => {
  it('deducts pending as well as taken', () => {
    expect(availableOn(balance({ taken: 4, pending: 3 }), '2025-06-01')).toBe(13)
  })

  it('drops carryover once it has expired', () => {
    const b = balance({ carriedOver: 5, carryoverExpiresOn: '2025-03-31' })
    expect(availableOn(b, '2025-03-31')).toBe(25)
    expect(availableOn(b, '2025-04-01')).toBe(20)
  })

  it('reports a negative balance rather than clamping it to zero', () => {
    // A negative adjustment (an HR correction, or leave taken in advance) must
    // stay visible — clamping hides the fact that days are owed back.
    expect(availableOn(balance({ accrued: 5, adjustment: -8 }), '2025-06-01')).toBe(-3)
  })
})

describe('drawDown', () => {
  it('spends carryover before accrued days', () => {
    const r = drawDown(balance({ accrued: 10, carriedOver: 3 }), [
      { date: '2025-05-01', amount: 1 },
      { date: '2025-05-02', amount: 1 },
      { date: '2025-05-05', amount: 1 },
      { date: '2025-05-06', amount: 1 },
    ])
    expect(r.ok).toBe(true)
    expect(r.fromCarryover).toBe(3)
    expect(r.fromAccrued).toBe(1)
  })

  it('stops using carryover that expires partway through the request', () => {
    const b = balance({ accrued: 5, carriedOver: 3, carryoverExpiresOn: '2025-03-31' })
    const r = drawDown(b, [
      { date: '2025-03-30', amount: 1 },
      { date: '2025-03-31', amount: 1 },
      { date: '2025-04-01', amount: 1 },
      { date: '2025-04-02', amount: 1 },
    ])
    expect(r.ok).toBe(true)
    expect(r.fromCarryover).toBe(2)
    expect(r.fromAccrued).toBe(2)
    expect(r.expiredMidRequest).toBe(1)
  })

  it('fails on the first day the balance cannot cover, naming that day', () => {
    const r = drawDown(balance({ accrued: 2 }), [
      { date: '2025-05-01', amount: 1 },
      { date: '2025-05-02', amount: 1 },
      { date: '2025-05-05', amount: 1 },
    ])
    expect(r.ok).toBe(false)
    expect(r.shortfallOn).toBe('2025-05-05')
  })

  it('handles half days without float drift', () => {
    const r = drawDown(balance({ accrued: 2 }), [
      { date: '2025-05-01', amount: 0.5 },
      { date: '2025-05-02', amount: 0.5 },
      { date: '2025-05-05', amount: 0.5 },
      { date: '2025-05-06', amount: 0.5 },
    ])
    expect(r.ok).toBe(true)
    expect(r.fromAccrued).toBe(2)
  })

  it('rejects a request outright when a negative adjustment has sunk the balance', () => {
    const r = drawDown(balance({ accrued: 5, adjustment: -8 }), [
      { date: '2025-05-01', amount: 1 },
    ])
    expect(r.ok).toBe(false)
    expect(r.shortfallOn).toBe('2025-05-01')
  })

  it('evaluates days in date order regardless of input order', () => {
    const b = balance({ accrued: 1, carriedOver: 1, carryoverExpiresOn: '2025-03-31' })
    const r = drawDown(b, [
      { date: '2025-04-01', amount: 1 },
      { date: '2025-03-30', amount: 1 },
    ])
    expect(r.ok).toBe(true)
    expect(r.fromCarryover).toBe(1)
    expect(r.fromAccrued).toBe(1)
  })
})
