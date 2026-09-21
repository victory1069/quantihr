/** Period arithmetic for training plans, shared by the list, the editor and the manager view. */

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** First day of next month — the period an employee is normally planning. */
export function nextPeriodStart(): string {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10)
}

/** First day of the quarter containing a date. */
export function quarterStart(date: string): string {
  const [y, m] = date.split('-').map(Number)
  const q = Math.floor((m! - 1) / 3) * 3 + 1
  return `${y}-${String(q).padStart(2, '0')}-01`
}

export function periodName(periodStart: string, periodType: 'month' | 'quarter' = 'month'): string {
  const [y, m] = periodStart.split('-').map(Number)
  if (periodType === 'quarter') return `Q${Math.floor((m! - 1) / 3) + 1} ${y}`
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString(undefined, { month: 'long' })
}
