/**
 * Statutory rate schedules, as versioned data rather than constants in code.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE RUNNING REAL PAYROLL
 *
 * These figures encode the Nigerian PAYE regime as amended by the Finance Act
 * 2020 (Personal Income Tax Act, consolidated relief and the six-band table),
 * plus the Pension Reform Act 2014, the NHF Act and the Employee Compensation
 * Act. They are provided as a STARTING POINT, not as legal fact.
 *
 * Nigerian rates move with each Finance Act, and a schedule that is a year stale
 * does not fail loudly — it silently produces a wrong net pay for every
 * employee, every month, and the customer discovers it at a tax audit.
 *
 * Finance must confirm the active schedule against current law before the first
 * live run. `payroll_runs` records which schedule id was used, so a later
 * correction can identify exactly which runs are affected.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Schedules are immutable and additive: never edit one that has been used for a
 * committed run. Add a new one with a later `effectiveFrom` instead, or the
 * audit trail stops matching the money that actually moved.
 */

import type { ISODate } from './dates.js'

export interface TaxBand {
  /** Upper bound of this band in annual currency units. `null` = no ceiling. */
  upTo: number | null
  /** Marginal rate applied to income falling inside this band, 0..1. */
  rate: number
}

export interface ConsolidatedRelief {
  /** Flat component, whichever is greater against `minPercentOfGross`. */
  fixed: number
  /** Floor on the flat component, as a fraction of gross. */
  minPercentOfGross: number
  /** Additional component, as a fraction of gross. */
  percentOfGross: number
}

export type PensionBase = 'basic_housing_transport' | 'gross'

export interface PensionRules {
  employeePercent: number
  employerPercent: number
  /** Pension Reform Act 2014 defines the base as basic + housing + transport. */
  base: PensionBase
  /** Employers below this headcount may be exempt; 0 disables the check. */
  minimumHeadcount: number
}

export interface NhfRules {
  percentOfBasic: number
  /** Contribution applies at or above this monthly gross. */
  minMonthlyGross: number
  /** NHF is voluntary for many employers; opt in per org. */
  enabledByDefault: boolean
}

export interface NsitfRules {
  /** Employer-only levy on total monthly payroll. Never deducted from staff. */
  percentOfPayroll: number
}

export interface TaxSchedule {
  id: string
  jurisdiction: string
  label: string
  effectiveFrom: ISODate
  effectiveTo: ISODate | null
  currency: string
  /** Annual cumulative bands, ascending. */
  bands: TaxBand[]
  consolidatedRelief: ConsolidatedRelief
  /**
   * Floor expressed as a fraction of gross income. Applied when the computed
   * PAYE falls below it. `null` disables the floor.
   */
  minimumTaxPercentOfGross: number | null
  pension: PensionRules
  nhf: NhfRules
  nsitf: NsitfRules
  /** Shown in the console so Finance can see what they are confirming. */
  sourceNote: string
}

/**
 * Nigeria, Finance Act 2020 basis.
 *
 * Band boundaries below are *widths* converted to cumulative ceilings:
 * first 300k, next 300k, next 500k, next 500k, next 1.6m, remainder.
 */
export const NG_PAYE_2020: TaxSchedule = {
  id: 'ng-paye-fa2020',
  jurisdiction: 'NG',
  label: 'Nigeria PAYE (Finance Act 2020 basis)',
  effectiveFrom: '2021-01-01',
  effectiveTo: null,
  currency: 'NGN',
  bands: [
    { upTo: 300_000, rate: 0.07 },
    { upTo: 600_000, rate: 0.11 },
    { upTo: 1_100_000, rate: 0.15 },
    { upTo: 1_600_000, rate: 0.19 },
    { upTo: 3_200_000, rate: 0.21 },
    { upTo: null, rate: 0.24 },
  ],
  consolidatedRelief: {
    fixed: 200_000,
    minPercentOfGross: 0.01,
    percentOfGross: 0.2,
  },
  minimumTaxPercentOfGross: 0.01,
  pension: {
    employeePercent: 0.08,
    employerPercent: 0.1,
    base: 'basic_housing_transport',
    minimumHeadcount: 3,
  },
  nhf: {
    percentOfBasic: 0.025,
    minMonthlyGross: 3_000,
    enabledByDefault: false,
  },
  nsitf: {
    percentOfPayroll: 0.01,
  },
  sourceNote:
    'Personal Income Tax Act as amended by Finance Act 2020; Pension Reform Act 2014 s.4(1); ' +
    'National Housing Fund Act s.4; Employee Compensation Act s.33. ' +
    'CONFIRM AGAINST CURRENT LAW BEFORE LIVE USE.',
}

/**
 * A deliberately neutral schedule for orgs outside Nigeria, or for testing.
 * Flat rate, no reliefs, no statutory contributions.
 */
export const FLAT_RATE_TEMPLATE: TaxSchedule = {
  id: 'flat-template',
  jurisdiction: 'XX',
  label: 'Flat rate template (configure before use)',
  effectiveFrom: '2000-01-01',
  effectiveTo: null,
  currency: 'NGN',
  bands: [{ upTo: null, rate: 0 }],
  consolidatedRelief: { fixed: 0, minPercentOfGross: 0, percentOfGross: 0 },
  minimumTaxPercentOfGross: null,
  pension: {
    employeePercent: 0,
    employerPercent: 0,
    base: 'basic_housing_transport',
    minimumHeadcount: 0,
  },
  nhf: { percentOfBasic: 0, minMonthlyGross: 0, enabledByDefault: false },
  nsitf: { percentOfPayroll: 0 },
  sourceNote: 'Placeholder with no statutory deductions. Configure before use.',
}

export const BUILT_IN_SCHEDULES: readonly TaxSchedule[] = [NG_PAYE_2020, FLAT_RATE_TEMPLATE]

/** The schedule in force on `date`, newest first. */
export function scheduleFor(
  schedules: readonly TaxSchedule[],
  jurisdiction: string,
  date: ISODate,
): TaxSchedule | null {
  const candidates = schedules
    .filter((s) => s.jurisdiction === jurisdiction)
    .filter((s) => s.effectiveFrom <= date)
    .filter((s) => s.effectiveTo === null || date <= s.effectiveTo)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))
  return candidates[0] ?? null
}
