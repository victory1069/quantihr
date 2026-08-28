/**
 * Calendar-date arithmetic on plain ISO `YYYY-MM-DD` strings.
 *
 * Everything here is deliberately timezone-free. A leave day is a calendar day
 * in the org's timezone, not an instant; the moment you let a `Date` object with
 * a local offset near this logic, a request submitted at 23:00 lands on the
 * wrong day. Instants are the API layer's problem, not the accrual engine's.
 */

export type ISODate = string // YYYY-MM-DD

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/

export function isISODate(value: string): value is ISODate {
  if (!ISO_RE.test(value)) return false
  const { y, m, d } = parts(value)
  if (m < 1 || m > 12) return false
  return d >= 1 && d <= daysInMonth(y, m)
}

export function assertISODate(value: string): ISODate {
  if (!isISODate(value)) throw new RangeError(`Not a valid calendar date: ${value}`)
  return value
}

export function parts(date: ISODate): { y: number; m: number; d: number } {
  return {
    y: Number(date.slice(0, 4)),
    m: Number(date.slice(5, 7)),
    d: Number(date.slice(8, 10)),
  }
}

export function fromParts(y: number, m: number, d: number): ISODate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

export function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28
  return [4, 6, 9, 11].includes(m) ? 30 : 31
}

export function daysInYear(y: number): number {
  return isLeapYear(y) ? 366 : 365
}

/** Days since the Unix epoch. Pure integer math, no Date object, no DST. */
export function toEpochDay(date: ISODate): number {
  const { y, m, d } = parts(date)
  // Howard Hinnant's civil-from-days, inverted.
  const yAdj = m <= 2 ? y - 1 : y
  const era = Math.floor(yAdj / 400)
  const yoe = yAdj - era * 400
  const mp = (m + 9) % 12
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

export function fromEpochDay(days: number): ISODate {
  let z = days + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const y = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp < 10 ? mp + 3 : mp - 9
  return fromParts(m <= 2 ? y + 1 : y, m, d)
}

export function addDays(date: ISODate, n: number): ISODate {
  return fromEpochDay(toEpochDay(date) + n)
}

/** Calendar-month arithmetic, clamping to the end of a short month (Jan 31 + 1mo = Feb 28/29). */
export function addMonths(date: ISODate, n: number): ISODate {
  const { y, m, d } = parts(date)
  const total = y * 12 + (m - 1) + n
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  return fromParts(ny, nm, Math.min(d, daysInMonth(ny, nm)))
}

export function addYears(date: ISODate, n: number): ISODate {
  return addMonths(date, n * 12)
}

/** Inclusive-of-`a`, exclusive-of-`b` day count. */
export function diffDays(a: ISODate, b: ISODate): number {
  return toEpochDay(b) - toEpochDay(a)
}

export function compare(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export const min = (a: ISODate, b: ISODate): ISODate => (a <= b ? a : b)
export const max = (a: ISODate, b: ISODate): ISODate => (a >= b ? a : b)

/** 0 = Sunday … 6 = Saturday, matching `work_schedules.working_days`. */
export function dayOfWeek(date: ISODate): number {
  return ((toEpochDay(date) + 4) % 7 + 7) % 7
}

export function eachDay(from: ISODate, toInclusive: ISODate): ISODate[] {
  const out: ISODate[] = []
  for (let d = from; d <= toInclusive; d = addDays(d, 1)) out.push(d)
  return out
}

export interface DateRange {
  start: ISODate
  /** Inclusive. */
  end: ISODate
}

export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return a.start <= b.end && b.start <= a.end
}

export function intersect(a: DateRange, b: DateRange): DateRange | null {
  const start = max(a.start, b.start)
  const end = min(a.end, b.end)
  return start <= end ? { start, end } : null
}

/**
 * Fractional months between `start` (inclusive) and `endExclusive`.
 *
 * Whole calendar months are counted first, then the leftover days are divided by
 * the length of the month they fall in. So 2025-07-01 → 2026-01-01 is exactly
 * 6.0, and a joiner halfway through a 30-day month contributes ~0.5 rather than
 * being rounded to a whole month in either direction.
 */
export function monthsBetween(start: ISODate, endExclusive: ISODate): number {
  if (endExclusive <= start) return 0
  let months = 0
  let cursor = start
  for (;;) {
    const next = addMonths(cursor, 1)
    if (next > endExclusive) break
    months += 1
    cursor = next
  }
  const remainder = diffDays(cursor, endExclusive)
  if (remainder === 0) return months
  const span = diffDays(cursor, addMonths(cursor, 1))
  return months + remainder / span
}
