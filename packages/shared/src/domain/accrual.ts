/**
 * Leave accrual engine.
 *
 * Pure functions over plain values: no database, no clock, no timezone. The
 * nightly job supplies `asOf` and persists the result to `leave_balances`; this
 * module only decides the arithmetic. That split is what makes the mid-year
 * joiner / leap year / carryover-expiry cases cheap to test exhaustively.
 */

import {
  addDays,
  addMonths,
  addYears,
  compare,
  daysInMonth,
  fromParts,
  intersect,
  monthsBetween,
  parts,
  type DateRange,
  type ISODate,
} from './dates.js'

export type AccrualMethod =
  | 'annual_fixed'
  | 'annual_anniversary'
  | 'monthly'
  | 'per_hours_worked'

export type RoundingRule = 'up' | 'down' | 'nearest_half'

export interface LeaveTypeConfig {
  id: string
  name: string
  accrualMethod: AccrualMethod
  /**
   * Days per leave year for `annual_fixed` / `annual_anniversary`.
   * Days per completed month for `monthly`.
   */
  accrualRate: number
  maxBalance: number | null
  carryoverCap: number | null
  carryoverExpiryMonths: number | null
}

export interface EmploymentWindow {
  startDate: ISODate
  /** Last day of employment, inclusive. `null` for current employees. */
  endDate: ISODate | null
}

/** Inclusive on both ends — a leave year runs to its last calendar day. */
export type AccrualPeriod = DateRange

export class AccrualNotImplementedError extends Error {
  constructor(readonly method: AccrualMethod) {
    super(`Accrual method "${method}" is defined but not implemented`)
    this.name = 'AccrualNotImplementedError'
  }
}

/** Round to the org's configured granularity. `up`/`down` are whole days. */
export function roundDays(value: number, rule: RoundingRule): number {
  // Nudge away from binary float error before rounding: 2.9999999999999996
  // must round down to 2 under `down`, not become 3 under a naive epsilon.
  const v = Math.abs(value % 1 - 0.5) < 1e-9 ? value : Number(value.toFixed(9))
  switch (rule) {
    case 'up':
      return Math.ceil(v)
    case 'down':
      return Math.floor(v)
    case 'nearest_half':
      return Math.round(v * 2) / 2
  }
}

/**
 * The leave period containing `asOf`.
 *
 * `annual_anniversary` keys off the employee's start date; everything else keys
 * off the org's leave-year start (an `MM-DD` string, e.g. `"01-01"`).
 */
export function resolvePeriod(
  method: AccrualMethod,
  asOf: ISODate,
  opts: { leaveYearStart: string; employmentStart: ISODate },
): AccrualPeriod {
  const anchor =
    method === 'annual_anniversary'
      ? parts(opts.employmentStart)
      : (() => {
          const [m, d] = opts.leaveYearStart.split('-').map(Number)
          return { y: 0, m: m ?? 1, d: d ?? 1 }
        })()

  const { y } = parts(asOf)
  // Feb 29 anniversaries land on Feb 28 in common years via addMonths clamping.
  let start = clampToMonth(y, anchor.m, anchor.d)
  if (compare(asOf, start) < 0) start = clampToMonth(y - 1, anchor.m, anchor.d)
  const end = addDays(addYears(start, 1), -1)
  return { start, end }
}

/** A Feb 29 anniversary falls on Feb 28 in a common year. */
function clampToMonth(y: number, m: number, d: number): ISODate {
  return fromParts(y, m, Math.min(d, daysInMonth(y, m)))
}

export interface AccrualInput {
  leaveType: LeaveTypeConfig
  employment: EmploymentWindow
  period: AccrualPeriod
  /** Accrue up to and including this date. Usually "today" in the org's timezone. */
  asOf: ISODate
  rounding: RoundingRule
}

export interface AccrualResult {
  accrued: number
  /** Before rounding and before the `maxBalance` cap — useful for debugging a disputed figure. */
  raw: number
  /** Fraction of the period the employee was actually employed, 0..1. */
  proRataFactor: number
  cappedByMaxBalance: boolean
}

/**
 * Days accrued within `period` as of `asOf`.
 *
 * Employment is intersected with the period first, so a mid-year joiner and a
 * mid-year leaver fall out of the same code path rather than needing special
 * cases at either end.
 */
export function computeAccrual(input: AccrualInput): AccrualResult {
  const { leaveType, employment, period, asOf, rounding } = input

  if (leaveType.accrualMethod === 'per_hours_worked') {
    // Interface is stubbed per spec §8 — implement when a customer needs it.
    throw new AccrualNotImplementedError('per_hours_worked')
  }

  const employed: DateRange = {
    start: employment.startDate,
    end: employment.endDate ?? '9999-12-31',
  }
  const overlap = intersect(period, employed)
  if (!overlap) {
    return { accrued: 0, raw: 0, proRataFactor: 0, cappedByMaxBalance: false }
  }

  const periodMonths = monthsBetween(period.start, addDays(period.end, 1))
  const employedMonths = monthsBetween(overlap.start, addDays(overlap.end, 1))
  const proRataFactor = periodMonths === 0 ? 0 : employedMonths / periodMonths

  let raw: number
  if (leaveType.accrualMethod === 'monthly') {
    // Monthly accrual credits at the end of each completed month, and only up
    // to `asOf` — an employee three months into the year has three months of
    // entitlement, not the full year's.
    const earnedTo = min3(asOf, overlap.end, period.end)
    const completed =
      compare(earnedTo, overlap.start) < 0
        ? 0
        : Math.floor(monthsBetween(overlap.start, addDays(earnedTo, 1)))
    raw = leaveType.accrualRate * completed
  } else {
    // Annual grant: the whole entitlement is available from the start of the
    // period, pro-rated only for partial employment.
    raw = leaveType.accrualRate * proRataFactor
  }

  const rounded = roundDays(raw, rounding)
  const capped =
    leaveType.maxBalance !== null && rounded > leaveType.maxBalance
      ? leaveType.maxBalance
      : rounded

  return {
    accrued: capped,
    raw,
    proRataFactor,
    cappedByMaxBalance: capped !== rounded,
  }
}

function min3(a: ISODate, b: ISODate, c: ISODate): ISODate {
  return [a, b, c].sort(compare)[0] as ISODate
}

export interface CarryoverResult {
  carriedOver: number
  /** Last day the carried-over days may be used, inclusive. `null` = never expires. */
  expiresOn: ISODate | null
  forfeited: number
}

/**
 * Carryover into `newPeriodStart`, capped and given an expiry.
 *
 * `forfeited` is returned rather than silently dropped so HR can answer "where
 * did my four days go" with a number instead of a shrug.
 */
export function computeCarryover(
  previousAvailable: number,
  leaveType: LeaveTypeConfig,
  newPeriodStart: ISODate,
): CarryoverResult {
  const eligible = Math.max(0, previousAvailable)
  const cap = leaveType.carryoverCap
  const carriedOver = cap === null ? eligible : Math.min(eligible, cap)
  const expiresOn =
    leaveType.carryoverExpiryMonths === null
      ? null
      : addDays(addMonths(newPeriodStart, leaveType.carryoverExpiryMonths), -1)
  return { carriedOver, expiresOn, forfeited: eligible - carriedOver }
}

export interface LeaveBalance {
  accrued: number
  carriedOver: number
  adjustment: number
  taken: number
  pending: number
  carryoverExpiresOn: ISODate | null
}

/**
 * `available = accrued + carried_over + adjustment − taken − pending`
 *
 * Pending is deducted (spec §8): without it an employee submits three
 * overlapping requests and the third is approved against days already spoken for.
 * Expired carryover drops out as of `asOf`.
 */
export function availableOn(balance: LeaveBalance, asOf: ISODate): number {
  const carry = carryoverValidOn(balance, asOf)
  return round2(
    balance.accrued + carry + balance.adjustment - balance.taken - balance.pending,
  )
}

function carryoverValidOn(balance: LeaveBalance, asOf: ISODate): number {
  if (balance.carryoverExpiresOn && compare(asOf, balance.carryoverExpiresOn) > 0) return 0
  return balance.carriedOver
}

export interface Draw {
  date: ISODate
  /** 1 for a full day, 0.5 for a half day. */
  amount: number
}

export interface DrawDownResult {
  ok: boolean
  fromCarryover: number
  fromAccrued: number
  /** First day the balance could not cover. Set only when `ok` is false. */
  shortfallOn: ISODate | null
  /** Carryover that expires partway through the request and cannot be used. */
  expiredMidRequest: number
}

/**
 * Walk a request day by day, spending carryover first.
 *
 * Point-in-time arithmetic gets the mid-request carryover expiry wrong in both
 * directions: checking the start date lets an employee spend days that expire
 * before they take them, and checking the end date forfeits days they were
 * entitled to on the days they actually took. Only a day-by-day draw-down is
 * correct, and this is the case that shows up in the one number employees check.
 */
export function drawDown(balance: LeaveBalance, draws: Draw[]): DrawDownResult {
  const ordered = [...draws].sort((a, b) => compare(a.date, b.date))
  let carry = balance.carriedOver
  let base = round2(balance.accrued + balance.adjustment - balance.taken - balance.pending)
  let fromCarryover = 0
  let fromAccrued = 0
  let expiredMidRequest = 0

  for (const draw of ordered) {
    if (
      balance.carryoverExpiresOn &&
      compare(draw.date, balance.carryoverExpiresOn) > 0 &&
      carry > 0
    ) {
      expiredMidRequest += carry
      carry = 0
    }

    let need = draw.amount
    const spendCarry = Math.min(carry, need)
    carry = round2(carry - spendCarry)
    need = round2(need - spendCarry)
    fromCarryover = round2(fromCarryover + spendCarry)

    if (need > 1e-9) {
      if (base + 1e-9 < need) {
        return {
          ok: false,
          fromCarryover,
          fromAccrued,
          shortfallOn: draw.date,
          expiredMidRequest,
        }
      }
      base = round2(base - need)
      fromAccrued = round2(fromAccrued + need)
    }
  }

  return { ok: true, fromCarryover, fromAccrued, shortfallOn: null, expiredMidRequest }
}

/** Money-style rounding to avoid 0.30000000000000004 surfacing in a balance. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}
