/**
 * Money formatting for display.
 *
 * Everything crossing the API is integer minor units (kobo). Conversion to a
 * human string happens here and nowhere else, so no screen invents its own
 * rounding and shows a figure that disagrees with the payslip total.
 */

const FORMATTER = new Intl.NumberFormat('en-NG', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatNaira(kobo: number, options: { sign?: boolean } = {}): string {
  const value = kobo / 100
  const body = `₦${FORMATTER.format(Math.abs(value))}`
  if (!options.sign) return value < 0 ? `−${body}` : body
  if (value === 0) return body
  return `${value > 0 ? '+' : '−'}${body}`
}

export function formatNairaCompact(kobo: number): string {
  const value = Math.abs(kobo / 100)
  if (value >= 1_000_000) return `₦${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `₦${Math.round(value / 1_000)}k`
  return formatNaira(kobo)
}
