import { describe, expect, it } from 'vitest'
import {
  applyBands,
  computePayroll,
  explainPayslip,
  loanInstalment,
  naira,
  solveNetToGross,
  totalsFor,
  toNaira,
  type Compensation,
  type PayrollInput,
} from '../src/domain/payroll.js'
import { FLAT_RATE_TEMPLATE, NG_PAYE_2020, scheduleFor } from '../src/domain/tax-schedules.js'

/**
 * The worked example used throughout.
 *
 *   basic     ₦200,000   housing ₦100,000   transport ₦50,000
 *   gross     ₦350,000/month → ₦4,200,000/year
 *
 * Hand-computed under the Finance Act 2020 basis:
 *   pensionable base            ₦350,000
 *   pension (8%)                 ₦28,000/month  → ₦336,000/year
 *   NHF (2.5% of basic)           ₦5,000/month  →  ₦60,000/year
 *   CRA = max(200,000, 1%×4.2m) + 20%×4.2m
 *       = 200,000 + 840,000     = ₦1,040,000
 *   reliefs = 1,040,000 + 396,000 = ₦1,436,000
 *   taxable = 4,200,000 − 1,436,000 = ₦2,764,000
 *   PAYE:  300k@7%   =  21,000
 *          300k@11%  =  33,000
 *          500k@15%  =  75,000
 *          500k@19%  =  95,000
 *        1,164k@21%  = 244,440
 *                      ─────────
 *                      ₦468,440/year → ₦39,036.67/month
 *   net = 350,000 − 28,000 − 5,000 − 39,036.67 = ₦277,963.33
 */
const COMP: Compensation = {
  basic: naira(200_000),
  housing: naira(100_000),
  transport: naira(50_000),
  allowances: [],
}

const base = (over: Partial<PayrollInput> = {}): PayrollInput => ({
  compensation: COMP,
  deductions: [],
  schedule: NG_PAYE_2020,
  periodsPerYear: 12,
  headcount: 25,
  nhfEnabled: true,
  ...over,
})

describe('money handling', () => {
  it('round-trips naira and kobo as integers', () => {
    expect(naira(350_000)).toBe(35_000_000)
    expect(toNaira(35_000_000)).toBe(350_000)
    expect(Number.isInteger(naira(1234.56))).toBe(true)
  })

  it('does not accumulate float drift across many lines', () => {
    const result = computePayroll(
      base({
        compensation: {
          basic: naira(0.1),
          housing: naira(0.2),
          transport: 0,
          allowances: Array.from({ length: 100 }, (_, i) => ({
            name: `a${i}`,
            amount: naira(0.01),
            taxable: true,
            pensionable: false,
          })),
        },
      }),
    )
    expect(Number.isInteger(result.gross)).toBe(true)
    expect(result.gross).toBe(naira(0.1) + naira(0.2) + 100 * naira(0.01))
  })
})

describe('applyBands', () => {
  it('returns zero for zero or negative taxable income', () => {
    expect(applyBands(0, NG_PAYE_2020)).toBe(0)
    expect(applyBands(naira(-500), NG_PAYE_2020)).toBe(0)
  })

  it('taxes the first band only', () => {
    // ₦100,000 @ 7%
    expect(applyBands(naira(100_000), NG_PAYE_2020)).toBe(naira(7_000))
  })

  it('is exact at a band boundary', () => {
    // Exactly ₦300,000 → all at 7%, nothing spills into the 11% band.
    expect(applyBands(naira(300_000), NG_PAYE_2020)).toBe(naira(21_000))
    // One naira over → 7% on 300k plus 11% on ₦1.
    expect(applyBands(naira(300_001), NG_PAYE_2020)).toBe(naira(21_000) + naira(0.11))
  })

  it('matches the hand-computed multi-band figure', () => {
    expect(applyBands(naira(2_764_000), NG_PAYE_2020)).toBe(naira(468_440))
  })

  it('applies the top open-ended band', () => {
    // Filling every band up to ₦3.2m:
    //   300k@7% 21,000 + 300k@11% 33,000 + 500k@15% 75,000
    // + 500k@19% 95,000 + 1,600k@21% 336,000 = ₦560,000
    const lower = applyBands(naira(3_200_000), NG_PAYE_2020)
    expect(lower).toBe(naira(560_000))
    expect(applyBands(naira(4_200_000), NG_PAYE_2020)).toBe(lower + naira(240_000))
  })
})

describe('computePayroll — worked example', () => {
  const result = computePayroll(base())

  it('computes gross from the compensation split', () => {
    expect(result.gross).toBe(naira(350_000))
    expect(result.annual.gross).toBe(naira(4_200_000))
  })

  it('computes pension on basic + housing + transport', () => {
    expect(result.pensionableBase).toBe(naira(350_000))
    expect(result.pensionEmployee).toBe(naira(28_000))
    expect(result.pensionEmployer).toBe(naira(35_000))
  })

  it('computes NHF on basic only', () => {
    expect(result.nhf).toBe(naira(5_000))
  })

  it('computes consolidated relief as the fixed floor plus 20%', () => {
    expect(result.annual.consolidatedRelief).toBe(naira(1_040_000))
  })

  it('computes taxable income after all reliefs', () => {
    expect(result.annual.taxableIncome).toBe(naira(2_764_000))
  })

  it('computes annual and monthly PAYE', () => {
    expect(result.annual.paye).toBe(naira(468_440))
    expect(result.paye).toBe(Math.round(naira(468_440) / 12))
    expect(result.annual.minimumTaxApplied).toBe(false)
  })

  it('computes net pay', () => {
    const expected = naira(350_000) - naira(28_000) - naira(5_000) - Math.round(naira(468_440) / 12)
    expect(result.netPay).toBe(expected)
    expect(toNaira(result.netPay)).toBeCloseTo(277_963.33, 2)
  })

  it('reports employer cost separately from the employee deduction', () => {
    expect(result.employerNsitf).toBe(naira(3_500))
    expect(result.employerTotalCost).toBe(naira(350_000) + naira(35_000) + naira(3_500))
    // NSITF is an employer levy and must never reduce net pay.
    expect(result.totalDeductions).not.toContain(result.employerNsitf)
  })
})

describe('computePayroll — NHF', () => {
  it('is omitted when the org has not opted in', () => {
    const r = computePayroll(base({ nhfEnabled: false }))
    expect(r.nhf).toBe(0)
    // Removing a relief raises taxable income and therefore PAYE.
    expect(r.annual.taxableIncome).toBe(naira(2_824_000))
    expect(r.annual.paye).toBe(naira(481_040))
  })

  it('is skipped below the statutory monthly earnings floor', () => {
    const r = computePayroll(
      base({
        compensation: { basic: naira(2_000), housing: 0, transport: 0, allowances: [] },
      }),
    )
    expect(r.nhf).toBe(0)
  })
})

describe('computePayroll — pension exemption', () => {
  it('exempts an employer below the statutory headcount', () => {
    const r = computePayroll(base({ headcount: 2 }))
    expect(r.pensionEmployee).toBe(0)
    expect(r.pensionEmployer).toBe(0)
  })

  it('applies at exactly the threshold', () => {
    const r = computePayroll(base({ headcount: 3 }))
    expect(r.pensionEmployee).toBe(naira(28_000))
  })
})

describe('computePayroll — minimum tax floor', () => {
  it('applies when reliefs wipe out taxable income entirely', () => {
    // ₦20,000/month → ₦240,000/year. CRA alone (₦248,000) exceeds gross.
    const r = computePayroll(
      base({
        compensation: { basic: naira(20_000), housing: 0, transport: 0, allowances: [] },
        nhfEnabled: false,
      }),
    )
    expect(r.annual.taxableIncome).toBe(0)
    expect(r.annual.minimumTaxApplied).toBe(true)
    expect(r.annual.paye).toBe(naira(2_400))
    expect(r.paye).toBe(naira(200))
  })

  it('does not charge tax on a zero-earning period', () => {
    const r = computePayroll(
      base({ compensation: { basic: 0, housing: 0, transport: 0, allowances: [] } }),
    )
    expect(r.annual.paye).toBe(0)
    expect(r.paye).toBe(0)
    expect(r.netPay).toBe(0)
  })

  it('is not applied by a schedule that disables the floor', () => {
    const r = computePayroll(
      base({
        schedule: FLAT_RATE_TEMPLATE,
        compensation: { basic: naira(20_000), housing: 0, transport: 0, allowances: [] },
      }),
    )
    expect(r.paye).toBe(0)
    expect(r.annual.minimumTaxApplied).toBe(false)
  })
})

describe('computePayroll — allowances', () => {
  it('excludes a non-taxable allowance from taxable gross but not from net', () => {
    const withAllowance = computePayroll(
      base({
        compensation: {
          ...COMP,
          allowances: [
            { name: 'Meal (non-taxable)', amount: naira(20_000), taxable: false, pensionable: false },
          ],
        },
      }),
    )
    const without = computePayroll(base())

    expect(withAllowance.gross).toBe(without.gross + naira(20_000))
    // Not taxable, so PAYE is unchanged...
    expect(withAllowance.annual.paye).toBe(without.annual.paye)
    // ...and the employee keeps the full amount.
    expect(withAllowance.netPay).toBe(without.netPay + naira(20_000))
  })

  it('includes a pensionable allowance in the pension base', () => {
    const r = computePayroll(
      base({
        compensation: {
          ...COMP,
          allowances: [
            { name: 'Shift', amount: naira(50_000), taxable: true, pensionable: true },
          ],
        },
      }),
    )
    expect(r.pensionableBase).toBe(naira(400_000))
    expect(r.pensionEmployee).toBe(naira(32_000))
  })
})

describe('computePayroll — deductions', () => {
  it('treats a post-tax deduction as reducing net only', () => {
    const r = computePayroll(
      base({
        deductions: [
          { name: 'Staff loan', kind: 'loan_repayment', amount: naira(25_000), preTax: false },
        ],
      }),
    )
    const plain = computePayroll(base())
    expect(r.annual.paye).toBe(plain.annual.paye)
    expect(r.netPay).toBe(plain.netPay - naira(25_000))
  })

  it('treats a pre-tax deduction as reducing taxable income', () => {
    const r = computePayroll(
      base({
        deductions: [
          { name: 'Life assurance', kind: 'other', amount: naira(25_000), preTax: true },
        ],
      }),
    )
    const plain = computePayroll(base())
    expect(r.annual.taxableIncome).toBeLessThan(plain.annual.taxableIncome)
    expect(r.annual.paye).toBeLessThan(plain.annual.paye)
  })
})

describe('computePayroll — pro-rating', () => {
  it('scales earnings for a mid-month joiner', () => {
    const half = computePayroll(base({ proRataFactor: 0.5 }))
    expect(half.gross).toBe(naira(175_000))
    expect(half.pensionEmployee).toBe(naira(14_000))
  })

  it('is a no-op at a factor of 1', () => {
    expect(computePayroll(base({ proRataFactor: 1 })).gross).toBe(
      computePayroll(base()).gross,
    )
  })
})

describe('solveNetToGross', () => {
  it('recovers the gross that produces a known net', () => {
    const target = computePayroll(base()).netPay
    const solved = solveNetToGross(target, base())

    expect(solved.converged).toBe(true)
    expect(Math.abs(solved.gross - naira(350_000))).toBeLessThanOrEqual(naira(1))
  })

  it('solves across a tax band boundary', () => {
    // A high target pushes the solve into the 24% band.
    const solved = solveNetToGross(naira(1_200_000), base())
    expect(solved.converged).toBe(true)
    const check = computePayroll(
      base({
        compensation: scaleTo(COMP, solved.gross),
      }),
    )
    expect(Math.abs(check.netPay - naira(1_200_000))).toBeLessThanOrEqual(naira(2))
  })

  it('handles a small target without overshooting into negative gross', () => {
    const solved = solveNetToGross(naira(30_000), base())
    expect(solved.gross).toBeGreaterThan(0)
    expect(solved.converged).toBe(true)
  })

  it('reports failure rather than silently returning zero for an empty template', () => {
    const solved = solveNetToGross(naira(100_000), {
      ...base(),
      compensation: { basic: 0, housing: 0, transport: 0, allowances: [] },
    })
    expect(solved.converged).toBe(false)
  })
})

/** Scales a compensation template so its gross equals `target`. */
function scaleTo(template: Compensation, target: number): Compensation {
  const gross =
    template.basic +
    template.housing +
    template.transport +
    template.allowances.reduce((s, a) => s + a.amount, 0)
  const k = target / gross
  return {
    basic: Math.round(template.basic * k),
    housing: Math.round(template.housing * k),
    transport: Math.round(template.transport * k),
    allowances: template.allowances.map((a) => ({ ...a, amount: Math.round(a.amount * k) })),
  }
}

describe('explainPayslip', () => {
  it('reports no change when nothing moved', () => {
    const r = computePayroll(base())
    const e = explainPayslip(r, r)
    expect(e.changes).toEqual([])
    expect(e.netDelta).toBe(0)
    expect(e.summary).toMatch(/unchanged/i)
  })

  it('names the line that moved and the direction', () => {
    const previous = computePayroll(base())
    const current = computePayroll(
      base({
        deductions: [
          { name: 'Staff loan', kind: 'loan_repayment', amount: naira(25_000), preTax: false },
        ],
      }),
    )

    const e = explainPayslip(previous, current)
    expect(e.netDelta).toBe(-naira(25_000))
    expect(e.changes[0]?.label).toBe('Staff loan')
    expect(e.changes[0]?.direction).toBe('new')
    expect(e.summary).toContain('Staff loan')
    expect(e.summary).toContain('lower')
  })

  it('orders changes by impact, largest first', () => {
    const previous = computePayroll(base())
    const current = computePayroll(
      base({
        compensation: { ...COMP, basic: naira(260_000) },
        deductions: [{ name: 'Union dues', kind: 'union_dues', amount: naira(500), preTax: false }],
      }),
    )
    const e = explainPayslip(previous, current)
    const magnitudes = e.changes.map((c) => Math.abs(c.delta))
    expect(magnitudes).toEqual([...magnitudes].sort((a, b) => b - a))
    expect(e.changes[0]?.code).toBe('basic')
  })

  it('ignores employer costs, which never touch net pay', () => {
    const previous = computePayroll(base({ headcount: 2 }))
    const current = computePayroll(base({ headcount: 25 }))
    const e = explainPayslip(previous, current)
    expect(e.changes.some((c) => c.code.startsWith('employer_'))).toBe(false)
  })

  it('summarises without naming more than three lines', () => {
    const previous = computePayroll(base())
    const current = computePayroll(
      base({
        compensation: {
          ...COMP,
          basic: naira(210_000),
          housing: naira(110_000),
          transport: naira(60_000),
          allowances: [{ name: 'Shift', amount: naira(5_000), taxable: true, pensionable: false }],
        },
      }),
    )
    const e = explainPayslip(previous, current)
    expect(e.changes.length).toBeGreaterThan(3)
    expect(e.summary).toMatch(/smaller change/)
  })
})

describe('loanInstalment', () => {
  it('takes the normal instalment mid-schedule', () => {
    expect(
      loanInstalment({ principal: naira(120_000), paid: naira(40_000), perPeriod: naira(20_000) }),
    ).toBe(naira(20_000))
  })

  it('clamps the final instalment to the outstanding balance', () => {
    // Over-recovering on the last instalment forces the employee to chase a refund.
    expect(
      loanInstalment({ principal: naira(50_000), paid: naira(40_000), perPeriod: naira(20_000) }),
    ).toBe(naira(10_000))
  })

  it('returns zero on a settled loan', () => {
    expect(
      loanInstalment({ principal: naira(50_000), paid: naira(50_000), perPeriod: naira(20_000) }),
    ).toBe(0)
  })
})

describe('totalsFor', () => {
  it('aggregates a run', () => {
    const results = [computePayroll(base()), computePayroll(base({ headcount: 2 }))]
    const t = totalsFor(results)
    expect(t.employeeCount).toBe(2)
    expect(t.gross).toBe(results[0]!.gross + results[1]!.gross)
    expect(t.netPay).toBe(results[0]!.netPay + results[1]!.netPay)
    expect(t.employerTotalCost).toBe(
      results[0]!.employerTotalCost + results[1]!.employerTotalCost,
    )
  })

  it('handles an empty run', () => {
    const t = totalsFor([])
    expect(t.employeeCount).toBe(0)
    expect(t.gross).toBe(0)
  })
})

describe('scheduleFor', () => {
  const older = { ...NG_PAYE_2020, id: 'old', effectiveFrom: '2015-01-01', effectiveTo: '2020-12-31' }

  it('picks the schedule in force on the date', () => {
    expect(scheduleFor([older, NG_PAYE_2020], 'NG', '2026-06-01')?.id).toBe('ng-paye-fa2020')
    expect(scheduleFor([older, NG_PAYE_2020], 'NG', '2019-06-01')?.id).toBe('old')
  })

  it('returns null when nothing covers the date or jurisdiction', () => {
    expect(scheduleFor([NG_PAYE_2020], 'NG', '2019-06-01')).toBeNull()
    expect(scheduleFor([NG_PAYE_2020], 'GH', '2026-06-01')).toBeNull()
  })
})
