/**
 * Coverage rule evaluation.
 *
 * Returns warnings rather than a hard block. A manager may approve against any
 * of these, but the API requires an `override_reason` when they do (spec §5), so
 * the decision is recorded rather than silently absorbed.
 */

import { eachDay, rangesOverlap, type DateRange, type ISODate } from './dates.js'

export type CoverageWarningCode =
  | 'blackout_period'
  | 'max_concurrent_absent'
  | 'max_concurrent_percent'
  | 'critical_role_uncovered'
  | 'insufficient_notice'

export interface CoverageWarning {
  code: CoverageWarningCode
  /** Shown to the manager on the approval card and to the employee before submit. */
  message: string
  /** The first date the rule is breached, for jumping the calendar to it. */
  date: ISODate | null
  /** `true` when approving requires an override reason. */
  requiresOverride: boolean
}

export interface BlackoutPeriod extends DateRange {
  name: string
}

export interface CoverageRule {
  maxConcurrentAbsent: number | null
  maxConcurrentPercent: number | null
  blackoutPeriods: BlackoutPeriod[]
  criticalRoleIds: string[]
}

export interface ConcurrentAbsence extends DateRange {
  employeeId: string
  roleId: string | null
}

export interface CoverageInput {
  request: DateRange & { employeeId: string; roleId: string | null }
  rule: CoverageRule
  /** Approved and pending absences for the same department, excluding this request. */
  existingAbsences: ConcurrentAbsence[]
  departmentHeadcount: number
  /** Days of notice given. `null` when the leave type has no notice requirement. */
  noticeDays: number | null
  minNoticeDays: number | null
}

export function evaluateCoverage(input: CoverageInput): CoverageWarning[] {
  const warnings: CoverageWarning[] = []
  const { request, rule, existingAbsences, departmentHeadcount } = input

  for (const blackout of rule.blackoutPeriods) {
    if (rangesOverlap(request, blackout)) {
      warnings.push({
        code: 'blackout_period',
        message: `Overlaps the "${blackout.name}" blackout period (${blackout.start} to ${blackout.end}).`,
        date: request.start > blackout.start ? request.start : blackout.start,
        requiresOverride: true,
      })
      break
    }
  }

  if (input.minNoticeDays !== null && input.noticeDays !== null) {
    if (input.noticeDays < input.minNoticeDays) {
      warnings.push({
        code: 'insufficient_notice',
        message: `${input.noticeDays} days notice given; this leave type requires ${input.minNoticeDays}.`,
        date: request.start,
        requiresOverride: true,
      })
    }
  }

  // Concurrency is a per-day question: a request can sit comfortably under the
  // cap on its first day and breach it on its third.
  let firstAbsentBreach: ISODate | null = null
  let peakConcurrent = 0
  let firstPercentBreach: ISODate | null = null
  let peakPercent = 0
  let firstCriticalBreach: ISODate | null = null

  const criticalRoles = new Set(rule.criticalRoleIds)
  const requesterIsCritical = request.roleId !== null && criticalRoles.has(request.roleId)

  for (const day of eachDay(request.start, request.end)) {
    const onDay = existingAbsences.filter(
      (a) => a.employeeId !== request.employeeId && a.start <= day && day <= a.end,
    )
    const concurrent = onDay.length + 1 // including this request

    if (concurrent > peakConcurrent) peakConcurrent = concurrent
    if (
      rule.maxConcurrentAbsent !== null &&
      concurrent > rule.maxConcurrentAbsent &&
      firstAbsentBreach === null
    ) {
      firstAbsentBreach = day
    }

    if (rule.maxConcurrentPercent !== null && departmentHeadcount > 0) {
      const percent = (concurrent / departmentHeadcount) * 100
      if (percent > peakPercent) peakPercent = percent
      if (percent > rule.maxConcurrentPercent && firstPercentBreach === null) {
        firstPercentBreach = day
      }
    }

    if (requesterIsCritical && firstCriticalBreach === null) {
      const otherCriticalAway = onDay.some(
        (a) => a.roleId !== null && criticalRoles.has(a.roleId),
      )
      // Only a problem when the request would leave no one in the critical role.
      if (otherCriticalAway) firstCriticalBreach = day
    }
  }

  if (firstAbsentBreach !== null) {
    warnings.push({
      code: 'max_concurrent_absent',
      message: `${peakConcurrent} people would be away at once; the limit for this team is ${rule.maxConcurrentAbsent}.`,
      date: firstAbsentBreach,
      requiresOverride: true,
    })
  }

  if (firstPercentBreach !== null) {
    warnings.push({
      code: 'max_concurrent_percent',
      message: `${Math.round(peakPercent)}% of the team would be away; the limit is ${rule.maxConcurrentPercent}%.`,
      date: firstPercentBreach,
      requiresOverride: true,
    })
  }

  if (firstCriticalBreach !== null) {
    warnings.push({
      code: 'critical_role_uncovered',
      message: 'Another person in a critical role is already away on these dates.',
      date: firstCriticalBreach,
      requiresOverride: true,
    })
  }

  return warnings
}

export function requiresOverride(warnings: CoverageWarning[]): boolean {
  return warnings.some((w) => w.requiresOverride)
}
