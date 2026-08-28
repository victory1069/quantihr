/**
 * Geofence evaluation for check-in.
 *
 * Deliberately conservative: a fix too imprecise to place the employee inside
 * the fence is rejected rather than accepted, because an accepted bad fix
 * becomes a disciplinary record nobody can defend later (spec §7).
 */

export interface Coordinates {
  latitude: number
  longitude: number
}

export interface LocationFence extends Coordinates {
  geofenceRadiusM: number
}

export interface GeofenceInput extends Coordinates {
  accuracyM: number
}

export type GeofenceFailure =
  | 'outside_geofence'
  | 'accuracy_too_low'
  | 'accuracy_exceeds_radius'

export interface GeofenceResult {
  inside: boolean
  distanceM: number
  /** Worst-case distance given the reported accuracy. */
  worstCaseDistanceM: number
  failure: GeofenceFailure | null
}

const EARTH_RADIUS_M = 6_371_008.8

export function haversineMeters(a: Coordinates, b: Coordinates): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.latitude - a.latitude)
  const dLng = toRad(b.longitude - a.longitude)
  const lat1 = toRad(a.latitude)
  const lat2 = toRad(b.latitude)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

export interface GeofenceOptions {
  /** Reject fixes less precise than this. */
  maxAccuracyM: number
}

export const DEFAULT_GEOFENCE_OPTIONS: GeofenceOptions = { maxAccuracyM: 100 }

export function evaluateGeofence(
  fix: GeofenceInput,
  fence: LocationFence,
  opts: GeofenceOptions = DEFAULT_GEOFENCE_OPTIONS,
): GeofenceResult {
  const distanceM = haversineMeters(fix, fence)
  const worstCaseDistanceM = distanceM + Math.max(0, fix.accuracyM)

  if (fix.accuracyM > opts.maxAccuracyM) {
    return { inside: false, distanceM, worstCaseDistanceM, failure: 'accuracy_too_low' }
  }
  // A ±80m fix against a 50m fence cannot prove presence even when it reads as
  // dead centre. Treat it as unprovable rather than as a pass.
  if (fix.accuracyM > fence.geofenceRadiusM) {
    return {
      inside: false,
      distanceM,
      worstCaseDistanceM,
      failure: 'accuracy_exceeds_radius',
    }
  }
  if (distanceM > fence.geofenceRadiusM) {
    return { inside: false, distanceM, worstCaseDistanceM, failure: 'outside_geofence' }
  }
  return { inside: true, distanceM, worstCaseDistanceM, failure: null }
}
