import { describe, expect, it } from 'vitest'
import {
  evaluateCoverage,
  requiresOverride,
  type CoverageInput,
  type CoverageRule,
} from '../src/domain/coverage.js'

const RULE: CoverageRule = {
  maxConcurrentAbsent: 2,
  maxConcurrentPercent: null,
  blackoutPeriods: [],
  criticalRoleIds: [],
}

const input = (over: Partial<CoverageInput> = {}): CoverageInput => ({
  request: { employeeId: 'e1', roleId: null, start: '2025-09-01', end: '2025-09-05' },
  rule: RULE,
  existingAbsences: [],
  departmentHeadcount: 10,
  noticeDays: 30,
  minNoticeDays: null,
  ...over,
})

describe('evaluateCoverage — concurrency', () => {
  it('passes clean when the team is covered', () => {
    expect(evaluateCoverage(input())).toEqual([])
  })

  it('counts the request itself toward the concurrency cap', () => {
    // Cap of 2 with two others already away means this request is the third.
    const w = evaluateCoverage(
      input({
        existingAbsences: [
          { employeeId: 'e2', roleId: null, start: '2025-09-01', end: '2025-09-05' },
          { employeeId: 'e3', roleId: null, start: '2025-09-01', end: '2025-09-05' },
        ],
      }),
    )
    expect(w.map((x) => x.code)).toContain('max_concurrent_absent')
  })

  it('allows a request that exactly meets the cap', () => {
    const w = evaluateCoverage(
      input({
        existingAbsences: [
          { employeeId: 'e2', roleId: null, start: '2025-09-01', end: '2025-09-05' },
        ],
      }),
    )
    expect(w).toEqual([])
  })

  it('catches a breach that only happens partway through the request', () => {
    const w = evaluateCoverage(
      input({
        existingAbsences: [
          { employeeId: 'e2', roleId: null, start: '2025-09-03', end: '2025-09-10' },
          { employeeId: 'e3', roleId: null, start: '2025-09-04', end: '2025-09-10' },
        ],
      }),
    )
    const breach = w.find((x) => x.code === 'max_concurrent_absent')
    expect(breach).toBeDefined()
    expect(breach?.date).toBe('2025-09-04')
  })

  it('ignores the employee’s own existing absence when recounting', () => {
    const w = evaluateCoverage(
      input({
        existingAbsences: [
          { employeeId: 'e1', roleId: null, start: '2025-09-01', end: '2025-09-05' },
          { employeeId: 'e2', roleId: null, start: '2025-09-01', end: '2025-09-05' },
        ],
      }),
    )
    expect(w).toEqual([])
  })

  it('applies a percentage cap against headcount', () => {
    const w = evaluateCoverage(
      input({
        rule: { ...RULE, maxConcurrentAbsent: null, maxConcurrentPercent: 20 },
        departmentHeadcount: 10,
        existingAbsences: [
          { employeeId: 'e2', roleId: null, start: '2025-09-01', end: '2025-09-05' },
          { employeeId: 'e3', roleId: null, start: '2025-09-01', end: '2025-09-05' },
        ],
      }),
    )
    expect(w.map((x) => x.code)).toContain('max_concurrent_percent')
  })

  it('does not divide by zero on an empty department', () => {
    expect(() =>
      evaluateCoverage(
        input({
          rule: { ...RULE, maxConcurrentAbsent: null, maxConcurrentPercent: 20 },
          departmentHeadcount: 0,
        }),
      ),
    ).not.toThrow()
  })
})

describe('evaluateCoverage — blackout periods', () => {
  it('warns when the request touches a blackout period', () => {
    const w = evaluateCoverage(
      input({
        rule: {
          ...RULE,
          blackoutPeriods: [
            { name: 'Year-end close', start: '2025-09-04', end: '2025-09-20' },
          ],
        },
      }),
    )
    const b = w.find((x) => x.code === 'blackout_period')
    expect(b).toBeDefined()
    expect(b?.message).toContain('Year-end close')
    expect(b?.requiresOverride).toBe(true)
  })

  it('ignores a blackout the request does not touch', () => {
    const w = evaluateCoverage(
      input({
        rule: {
          ...RULE,
          blackoutPeriods: [{ name: 'Audit', start: '2025-11-01', end: '2025-11-30' }],
        },
      }),
    )
    expect(w).toEqual([])
  })
})

describe('evaluateCoverage — notice and critical roles', () => {
  it('warns on insufficient notice', () => {
    const w = evaluateCoverage(input({ noticeDays: 2, minNoticeDays: 14 }))
    const n = w.find((x) => x.code === 'insufficient_notice')
    expect(n).toBeDefined()
    expect(n?.message).toContain('14')
  })

  it('accepts exactly the required notice', () => {
    expect(evaluateCoverage(input({ noticeDays: 14, minNoticeDays: 14 }))).toEqual([])
  })

  it('warns when two people in a critical role would be away together', () => {
    const w = evaluateCoverage(
      input({
        request: { employeeId: 'e1', roleId: 'pharmacist', start: '2025-09-01', end: '2025-09-05' },
        rule: { ...RULE, criticalRoleIds: ['pharmacist'] },
        existingAbsences: [
          { employeeId: 'e2', roleId: 'pharmacist', start: '2025-09-02', end: '2025-09-03' },
        ],
      }),
    )
    expect(w.map((x) => x.code)).toContain('critical_role_uncovered')
  })

  it('does not warn when the other absentee holds a different role', () => {
    const w = evaluateCoverage(
      input({
        request: { employeeId: 'e1', roleId: 'pharmacist', start: '2025-09-01', end: '2025-09-05' },
        rule: { ...RULE, criticalRoleIds: ['pharmacist'] },
        existingAbsences: [
          { employeeId: 'e2', roleId: 'cashier', start: '2025-09-02', end: '2025-09-03' },
        ],
      }),
    )
    expect(w.map((x) => x.code)).not.toContain('critical_role_uncovered')
  })
})

describe('requiresOverride', () => {
  it('is false with no warnings and true with any blocking one', () => {
    expect(requiresOverride([])).toBe(false)
    expect(
      requiresOverride(evaluateCoverage(input({ noticeDays: 1, minNoticeDays: 14 }))),
    ).toBe(true)
  })
})
