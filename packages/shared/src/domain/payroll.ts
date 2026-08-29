/**
 * Payroll computation engine (spec §10).
 *
 * MONEY IS INTEGER MINOR UNITS (kobo). Never floats.
 *
 * `0.1 + 0.2 !== 0.3` is a curiosity in most code and a reconciliation failure
 * here: a half-kobo of drift per line, across 400 employees and twelve months,
 * is a bank file that does not balance and a statutory filing that does not
 * match the payslips. Every value in and out of this module is an integer.
 *
 * The engine is pure — no database, no clock, no I/O — so the arithmetic can be
 * tested exhaustively against worked examples, which is the only way to have any
 * confidence in it. Statutory rates live in `tax-schedules.ts` as versioned
 * data, deliberately not as constants here.
 */

import type { ISODate } from './dates.js'
import type { PensionBase, TaxSchedule } from './tax-schedules.js'

/** Integer minor units. 1 NGN = 100 kobo. */
export type Money = number

export const naira = (amount: number): Money => Math.round(amount * 100)
export const toNaira = (kobo: Money): number => kobo / 100

/** Half-up rounding on integers, the convention statutory tables assume. */
function roundMoney(value: number): Money {
  return Math.sign(value) * Math.round(Math.abs(value))
}

function pct(amount: Money, fraction: number): Money {
  return roundMoney(amount * fraction)
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface Allowance {
  name: string
  amount: Money
  /** Counts toward taxable gross. Almost always true. */
  taxable: boolean
  /** Counts toward the pensionable base. */
  pensionable: boolean
}

export interface Compensation {
  basic: Money
  housing: Money
  transport: Money
  allowances: Allowance[]
}

export type DeductionKind =
  | 'loan_repayment'
  | 'salary_advance'
  | 'union_dues'
  | 'cooperative'
  | 'absence'
  | 'other'

export interface Deduction {
  name: string
  kind: DeductionKind
  amount: Money
  /**
   * Reduces taxable income (e.g. an approved life assurance premium).
   * Most voluntary deductions are post-tax; defaulting to post-tax is the
   * conservative choice because the alternative under-withholds PAYE.
   */
  preTax: boolean
}

export interface PayrollInput {
  compensation: Compensation
  deductions: Deduction[]
  schedule: TaxSchedule
  /** Pay periods per year. 12 = monthly, 26 = fortnightly. */
  periodsPerYear: number
  /** Employer headcount, for the pension exemption threshold. */
  headcount: number
  /** Org opted into NHF. */
  nhfEnabled: boolean
  /** Approved voluntary pension top-up, per period. */
  voluntaryPension?: Money
  /** NHIS contribution, per period. Deductible before PAYE. */
  nhis?: Money
  /**
   * Proportion of the period actually worked, 0..1, for a mid-month joiner or
   * leaver. Applied to earnings before any statutory computation.
   */
  proRataFactor?: number
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface PayrollLine {
  code: string
  label: string
  amount: Money
  category: 'earning' | 'statutory' | 'deduction' | 'employer_cost'
}

export interface PayrollResult {
  /** Total earnings for the period. */
  gross: Money
  /** Base the pension percentages were applied to. */
  pensionableBase: Money

  pensionEmployee: Money
  pensionEmployer: Money
  voluntaryPension: Money
  nhf: Money
  nhis: Money

  /** Annualised figures, which is the basis PAYE is actually assessed on. */
  annual: {
    gross: Money
    consolidatedRelief: Money
    reliefs: Money
    taxableIncome: Money
    paye: Money
    /** True when the statutory floor bound rather than the band table. */
    minimumTaxApplied: boolean
  }

  paye: Money
  preTaxDeductions: Money
  postTaxDeductions: Money
  totalDeductions: Money
  netPay: Money

  /** Employer's cost beyond gross — never deducted from the employee. */
  employerPension: Money
  employerNsitf: Money
  employerTotalCost: Money

  lines: PayrollLine[]
  scheduleId: string
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function pensionableBaseOf(comp: Compensation, base: PensionBase): Money {
  if (base === 'gross') {
    return (
      comp.basic +
      comp.housing +
      comp.transport +
      comp.allowances.reduce((sum, a) => sum + a.amount, 0)
    )
  }
  // Pension Reform Act 2014: basic + housing + transport, plus any allowance
  // the org has explicitly marked pensionable.
  return (
    comp.basic +
    comp.housing +
    comp.transport +
    comp.allowances.filter((a) => a.pensionable).reduce((sum, a) => sum + a.amount, 0)
  )
}

function applyProRata(comp: Compensation, factor: number): Compensation {
  if (factor >= 1) return comp
  return {
    basic: pct(comp.basic, factor),
    housing: pct(comp.housing, factor),
    transport: pct(comp.transport, factor),
    allowances: comp.allowances.map((a) => ({ ...a, amount: pct(a.amount, factor) })),
  }
}

/** Applies the cumulative band table to an annual taxable income. */
export function applyBands(taxableAnnual: Money, schedule: TaxSchedule): Money {
  if (taxableAnnual <= 0) return 0

  let remaining = taxableAnnual
  let lowerBound = 0
  let tax = 0

  for (const band of schedule.bands) {
    if (remaining <= 0) break
    const ceiling = band.upTo === null ? Infinity : naira(band.upTo)
    const width = ceiling - lowerBound
    const slice = Math.min(remaining, width)
    tax += slice * band.rate
    remaining -= slice
    lowerBound = ceiling
  }

  return roundMoney(tax)
}

export function computePayroll(input: PayrollInput): PayrollResult {
  const schedule = input.schedule
  const periods = input.periodsPerYear
  const comp = applyProRata(input.compensation, input.proRataFactor ?? 1)

  const gross =
    comp.basic +
    comp.housing +
    comp.transport +
    comp.allowances.reduce((sum, a) => sum + a.amount, 0)

  const taxableGross =
    comp.basic +
    comp.housing +
    comp.transport +
    comp.allowances.filter((a) => a.taxable).reduce((sum, a) => sum + a.amount, 0)

  // --- Pension -------------------------------------------------------------
  // Employers below the statutory headcount are exempt from the mandatory
  // scheme; a small org must not have contributions deducted it never remitted.
  const pensionApplies =
    schedule.pension.minimumHeadcount === 0 ||
    input.headcount >= schedule.pension.minimumHeadcount

  const pensionableBase = pensionableBaseOf(comp, schedule.pension.base)
  const pensionEmployee = pensionApplies ? pct(pensionableBase, schedule.pension.employeePercent) : 0
  const pensionEmployer = pensionApplies ? pct(pensionableBase, schedule.pension.employerPercent) : 0
  const voluntaryPension = input.voluntaryPension ?? 0

  // --- NHF -----------------------------------------------------------------
  const nhfApplies =
    input.nhfEnabled && gross >= naira(schedule.nhf.minMonthlyGross) && schedule.nhf.percentOfBasic > 0
  const nhf = nhfApplies ? pct(comp.basic, schedule.nhf.percentOfBasic) : 0

  const nhis = input.nhis ?? 0

  // --- PAYE ----------------------------------------------------------------
  // Assessed annually, then spread across periods. Computing tax on a single
  // month in isolation would push everyone into the lowest band.
  const annualGross = taxableGross * periods

  const craFixed = Math.max(
    naira(schedule.consolidatedRelief.fixed),
    pct(annualGross, schedule.consolidatedRelief.minPercentOfGross),
  )
  const consolidatedRelief =
    craFixed + pct(annualGross, schedule.consolidatedRelief.percentOfGross)

  const preTaxDeductions = input.deductions
    .filter((d) => d.preTax)
    .reduce((sum, d) => sum + d.amount, 0)

  const statutoryReliefs =
    (pensionEmployee + voluntaryPension + nhf + nhis + preTaxDeductions) * periods

  const reliefs = consolidatedRelief + statutoryReliefs
  const taxableIncome = Math.max(0, annualGross - reliefs)

  let payeAnnual = applyBands(taxableIncome, schedule)
  let minimumTaxApplied = false

  if (schedule.minimumTaxPercentOfGross !== null) {
    const floor = pct(annualGross, schedule.minimumTaxPercentOfGross)
    // The floor only bites where there is income to tax at all; a zero-earning
    // period must not generate a tax charge.
    if (annualGross > 0 && payeAnnual < floor) {
      payeAnnual = floor
      minimumTaxApplied = true
    }
  }

  const paye = roundMoney(payeAnnual / periods)

  // --- Net -----------------------------------------------------------------
  const postTaxDeductions = input.deductions
    .filter((d) => !d.preTax)
    .reduce((sum, d) => sum + d.amount, 0)

  const totalDeductions =
    pensionEmployee + voluntaryPension + nhf + nhis + paye + preTaxDeductions + postTaxDeductions

  const netPay = gross - totalDeductions

  const employerNsitf = pct(gross, schedule.nsitf.percentOfPayroll)

  // --- Lines ---------------------------------------------------------------
  // Annotated before filtering so the literal categories keep their narrow type;
  // inferring from the array and then filtering widens `category` to `string`.
  const allLines: PayrollLine[] = [
    { code: 'basic', label: 'Basic salary', amount: comp.basic, category: 'earning' },
    { code: 'housing', label: 'Housing allowance', amount: comp.housing, category: 'earning' },
    { code: 'transport', label: 'Transport allowance', amount: comp.transport, category: 'earning' },
    ...comp.allowances.map((a) => ({
      code: `allowance:${a.name}`,
      label: a.name,
      amount: a.amount,
      category: 'earning' as const,
    })),
    { code: 'paye', label: 'PAYE tax', amount: paye, category: 'statutory' as const },
    { code: 'pension', label: 'Pension (employee)', amount: pensionEmployee, category: 'statutory' as const },
    ...(voluntaryPension > 0
      ? [{ code: 'pension_voluntary', label: 'Voluntary pension', amount: voluntaryPension, category: 'statutory' as const }]
      : []),
    ...(nhf > 0 ? [{ code: 'nhf', label: 'NHF', amount: nhf, category: 'statutory' as const }] : []),
    ...(nhis > 0 ? [{ code: 'nhis', label: 'NHIS', amount: nhis, category: 'statutory' as const }] : []),
    ...input.deductions.map((d) => ({
      code: `deduction:${d.kind}:${d.name}`,
      label: d.name,
      amount: d.amount,
      category: 'deduction' as const,
    })),
    { code: 'employer_pension', label: 'Pension (employer)', amount: pensionEmployer, category: 'employer_cost' as const },
    { code: 'employer_nsitf', label: 'NSITF', amount: employerNsitf, category: 'employer_cost' as const },
  ]

  // Zero-value lines are noise on a payslip, but basic always shows even at zero
  // so an unpaid period still renders a recognisable document.
  const lines = allLines.filter((l) => l.amount !== 0 || l.code === 'basic')

  return {
    gross,
    pensionableBase,
    pensionEmployee,
    pensionEmployer,
    voluntaryPension,
    nhf,
    nhis,
    annual: {
      gross: annualGross,
      consolidatedRelief,
      reliefs,
      taxableIncome,
      paye: payeAnnual,
      minimumTaxApplied,
    },
    paye,
    preTaxDeductions,
    postTaxDeductions,
    totalDeductions,
    netPay,
    employerPension: pensionEmployer,
    employerNsitf,
    employerTotalCost: gross + pensionEmployer + employerNsitf,
    lines,
    scheduleId: schedule.id,
  }
}

// ---------------------------------------------------------------------------
// Net-to-gross
// ---------------------------------------------------------------------------

export interface NetToGrossResult {
  gross: Money
  achievedNet: Money
  /** Difference from the target, in kobo. Zero on an exact solve. */
  residual: Money
  iterations: number
  converged: boolean
}

/**
 * Solves for the gross that yields a target net.
 *
 * PAYE is piecewise-linear in gross, so there is no closed form that stays
 * correct across a band boundary. Bisection is used rather than a fixed-point
 * iteration because it cannot oscillate, and it converges to the kobo in about
 * fifty steps over any realistic salary range.
 *
 * The compensation split is scaled proportionally, preserving the basic/housing
 * /transport ratio — which matters, because pension and NHF are computed from
 * those components rather than from gross.
 */
export function solveNetToGross(
  targetNet: Money,
  input: Omit<PayrollInput, 'compensation'> & { compensation: Compensation },
  maxIterations = 80,
): NetToGrossResult {
  const template = input.compensation
  const templateGross =
    template.basic +
    template.housing +
    template.transport +
    template.allowances.reduce((sum, a) => sum + a.amount, 0)

  if (templateGross <= 0) {
    return { gross: 0, achievedNet: 0, residual: targetNet, iterations: 0, converged: false }
  }

  const netAtScale = (scale: number): { net: Money; gross: Money } => {
    const scaled: Compensation = {
      basic: roundMoney(template.basic * scale),
      housing: roundMoney(template.housing * scale),
      transport: roundMoney(template.transport * scale),
      allowances: template.allowances.map((a) => ({ ...a, amount: roundMoney(a.amount * scale) })),
    }
    const result = computePayroll({ ...input, compensation: scaled })
    return { net: result.netPay, gross: result.gross }
  }

  let low = 0
  // Grow the upper bound until it overshoots, so an unusually high target
  // (or heavy deductions) does not silently clamp at the initial guess.
  let high = 2
  let guard = 0
  while (netAtScale(high).net < targetNet && guard < 40) {
    high *= 2
    guard += 1
  }

  let best = netAtScale(high)
  let iterations = 0

  for (; iterations < maxIterations; iterations++) {
    const mid = (low + high) / 2
    const attempt = netAtScale(mid)
    best = attempt

    if (attempt.net === targetNet) break
    if (attempt.net < targetNet) low = mid
    else high = mid

    if (high - low < 1e-12) break
  }

  return {
    gross: best.gross,
    achievedNet: best.net,
    residual: targetNet - best.net,
    iterations,
    // Within one kobo is an exact solve for money purposes.
    converged: Math.abs(targetNet - best.net) <= 1,
  }
}

// ---------------------------------------------------------------------------
// Payslip explainer (spec §5.5)
// ---------------------------------------------------------------------------

export interface PayslipChange {
  code: string
  label: string
  previous: Money
  current: Money
  delta: Money
  direction: 'increase' | 'decrease' | 'new' | 'removed'
}

export interface PayslipExplanation {
  netDelta: Money
  grossDelta: Money
  /** Ordered by absolute impact on net pay, largest first. */
  changes: PayslipChange[]
  /** Deterministic prose, safe to show without a model in the loop. */
  summary: string
}

/**
 * Answers "why is my net pay different this month" by diffing two payslips.
 *
 * Deliberately deterministic. The spec frames this as an AI feature, but the
 * part employees actually need — which line changed and by how much — is
 * arithmetic, and arithmetic does not hallucinate a deduction that was never
 * applied. A language model can rephrase this output later; it must not be the
 * thing that decides which numbers moved.
 */
export function explainPayslip(
  previous: PayrollResult,
  current: PayrollResult,
): PayslipExplanation {
  const byCode = (r: PayrollResult) => new Map(r.lines.map((l) => [l.code, l]))
  const prevLines = byCode(previous)
  const currLines = byCode(current)
  const codes = new Set([...prevLines.keys(), ...currLines.keys()])

  const changes: PayslipChange[] = []

  for (const code of codes) {
    const p = prevLines.get(code)
    const c = currLines.get(code)
    // Employer costs never touch net pay, so they would only be noise here.
    const category = c?.category ?? p?.category
    if (category === 'employer_cost') continue

    const previousAmount = p?.amount ?? 0
    const currentAmount = c?.amount ?? 0
    if (previousAmount === currentAmount) continue

    changes.push({
      code,
      label: c?.label ?? p?.label ?? code,
      previous: previousAmount,
      current: currentAmount,
      delta: currentAmount - previousAmount,
      direction: !p ? 'new' : !c ? 'removed' : currentAmount > previousAmount ? 'increase' : 'decrease',
    })
  }

  changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  const netDelta = current.netPay - previous.netPay
  const grossDelta = current.gross - previous.gross

  return {
    netDelta,
    grossDelta,
    changes,
    summary: buildSummary(netDelta, changes),
  }
}

function buildSummary(netDelta: Money, changes: PayslipChange[]): string {
  if (changes.length === 0) {
    return 'Your pay is unchanged from last period.'
  }

  const money = (kobo: Money) =>
    `₦${Math.abs(toNaira(kobo)).toLocaleString('en-NG', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`

  const direction = netDelta > 0 ? 'higher' : netDelta < 0 ? 'lower' : 'unchanged'
  const lead =
    netDelta === 0
      ? 'Your net pay is the same as last period, but some lines changed.'
      : `Your net pay is ${money(netDelta)} ${direction} than last period.`

  // Name at most three lines; beyond that a payslip diff stops being readable.
  const top = changes.slice(0, 3).map((c) => {
    if (c.direction === 'new') return `${c.label} was added (${money(c.current)})`
    if (c.direction === 'removed') return `${c.label} was removed (was ${money(c.previous)})`
    const verb = c.delta > 0 ? 'rose' : 'fell'
    return `${c.label} ${verb} by ${money(c.delta)}`
  })

  const rest = changes.length > 3 ? ` and ${changes.length - 3} smaller change(s)` : ''
  return `${lead} ${capitalise(top.join(', '))}${rest}.`
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ---------------------------------------------------------------------------
// Loans and advances
// ---------------------------------------------------------------------------

export interface LoanSchedule {
  principal: Money
  /** Instalments already taken. */
  paid: Money
  perPeriod: Money
}

/**
 * The instalment due this period, never exceeding the outstanding balance.
 *
 * Without the clamp, a final instalment over-recovers and the employee has to
 * chase a refund — a small bug with a disproportionate effect on trust.
 */
export function loanInstalment(loan: LoanSchedule): Money {
  const outstanding = Math.max(0, loan.principal - loan.paid)
  return Math.min(loan.perPeriod, outstanding)
}

export interface PayrollRunTotals {
  employeeCount: number
  gross: Money
  paye: Money
  pensionEmployee: Money
  pensionEmployer: Money
  nhf: Money
  nsitf: Money
  netPay: Money
  employerTotalCost: Money
}

/** Aggregates a run for the approval screen and the statutory filings. */
export function totalsFor(results: readonly PayrollResult[]): PayrollRunTotals {
  const sum = (pick: (r: PayrollResult) => Money) => results.reduce((t, r) => t + pick(r), 0)
  return {
    employeeCount: results.length,
    gross: sum((r) => r.gross),
    paye: sum((r) => r.paye),
    pensionEmployee: sum((r) => r.pensionEmployee + r.voluntaryPension),
    pensionEmployer: sum((r) => r.pensionEmployer),
    nhf: sum((r) => r.nhf),
    nsitf: sum((r) => r.employerNsitf),
    netPay: sum((r) => r.netPay),
    employerTotalCost: sum((r) => r.employerTotalCost),
  }
}
