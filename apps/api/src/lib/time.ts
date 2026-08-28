/**
 * Server instant → the org's local wall clock.
 *
 * The server decides lateness against its own clock, never the device's (spec
 * §4), but "its own clock" has to be read in the org's timezone or a Lagos
 * check-in gets judged against UTC. `Intl` does the conversion using the
 * platform's tz database, so DST and offset changes are handled for us.
 */

import type { ISODate } from '@quanti/shared'

export interface OrgClock {
  /** Calendar date in the org's timezone. */
  date: ISODate
  /** Minutes from local midnight. */
  minutes: number
  /** The underlying instant, unchanged. */
  instant: Date
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    formatters.set(timezone, f)
  }
  return f
}

export function orgClock(timezone: string, at: Date = new Date()): OrgClock {
  const parts = formatterFor(timezone).formatToParts(at)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '00'

  // `hour12: false` still yields "24" at midnight in some ICU versions.
  const hour = Number(get('hour')) % 24
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + Number(get('minute')),
    instant: at,
  }
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

export function hoursBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / 3_600_000
}
