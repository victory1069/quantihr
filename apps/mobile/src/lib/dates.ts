/** Short human dates for lists — a manager reads a dozen of these at once. */

/** "28 Sep–2 Oct", "20–24 Sep", "5 Sep". */
export function formatRange(start: string, end: string): string {
  const from = new Date(`${start}T00:00:00`)
  const to = new Date(`${end}T00:00:00`)
  const month = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' })
  const day = (d: Date) => d.getDate()
  // Built explicitly rather than from a locale-formatted range: asking the
  // locale for day + month gives "Sep 24" in one place and "24 Sep" in
  // another, which once turned "20–24 Sep" into "20–Sep 24".
  if (start === end) return `${day(from)} ${month(from)}`
  if (start.slice(0, 7) === end.slice(0, 7)) return `${day(from)}–${day(to)} ${month(to)}`
  return `${day(from)} ${month(from)}–${day(to)} ${month(to)}`
}

/** "Mon–Wed" for a range inside one week, "Today" for a single day that is today. */
export function formatWeekdays(start: string, end: string, today: string): string {
  if (start === end) return start === today ? 'Today' : weekday(start)
  return `${weekday(start)}–${weekday(end)}`
}

function weekday(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short' })
}
