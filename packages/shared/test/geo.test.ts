import { describe, expect, it } from 'vitest'
import { evaluateGeofence, haversineMeters } from '../src/domain/geo.js'

// Lagos, Victoria Island — a plausible design-partner office.
const OFFICE = { latitude: 6.4281, longitude: 3.4219, geofenceRadiusM: 100 }

describe('haversineMeters', () => {
  it('is zero for identical points', () => {
    expect(haversineMeters(OFFICE, OFFICE)).toBe(0)
  })

  it('measures a known short distance', () => {
    // 0.001° of latitude ≈ 111 m anywhere on Earth.
    const d = haversineMeters(OFFICE, { latitude: 6.4291, longitude: 3.4219 })
    expect(d).toBeGreaterThan(105)
    expect(d).toBeLessThan(118)
  })

  it('is symmetric', () => {
    const a = { latitude: 6.4281, longitude: 3.4219 }
    const b = { latitude: 6.5, longitude: 3.5 }
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6)
  })
})

describe('evaluateGeofence', () => {
  it('accepts a precise fix inside the fence', () => {
    const r = evaluateGeofence(
      { latitude: 6.4282, longitude: 3.422, accuracyM: 8 },
      OFFICE,
    )
    expect(r.inside).toBe(true)
    expect(r.failure).toBeNull()
  })

  it('rejects a precise fix outside the fence', () => {
    const r = evaluateGeofence(
      { latitude: 6.4321, longitude: 3.4219, accuracyM: 8 },
      OFFICE,
    )
    expect(r.inside).toBe(false)
    expect(r.failure).toBe('outside_geofence')
    expect(r.distanceM).toBeGreaterThan(100)
  })

  it('rejects a wildly imprecise fix rather than accepting it', () => {
    const r = evaluateGeofence(
      { latitude: 6.4281, longitude: 3.4219, accuracyM: 500 },
      OFFICE,
    )
    expect(r.inside).toBe(false)
    expect(r.failure).toBe('accuracy_too_low')
  })

  it('rejects a fix whose accuracy is looser than the fence itself', () => {
    // Dead centre on paper, but ±80 m against a 100 m fence still can't place
    // the employee inside it. This is the case that quietly passes if you only
    // compare the reported point against the radius.
    const r = evaluateGeofence(
      { latitude: 6.4281, longitude: 3.4219, accuracyM: 80 },
      { ...OFFICE, geofenceRadiusM: 50 },
    )
    expect(r.inside).toBe(false)
    expect(r.failure).toBe('accuracy_exceeds_radius')
  })

  it('reports worst-case distance for the audit record', () => {
    const r = evaluateGeofence(
      { latitude: 6.4282, longitude: 3.422, accuracyM: 20 },
      OFFICE,
    )
    expect(r.worstCaseDistanceM).toBeCloseTo(r.distanceM + 20, 6)
  })
})
