/**
 * Location capture for check-in (spec §7).
 *
 * Foreground only, read at the moment the employee taps check in. No background
 * geofencing: it draws App Store review scrutiny, drains battery, and buys
 * nothing when the employee is actively opening the app anyway.
 */

import * as Location from 'expo-location'
import { Platform } from 'react-native'

export type LocationFailure =
  | 'permission_denied'
  | 'services_disabled'
  | 'timeout'
  | 'unavailable'

export interface LocationFix {
  latitude: number
  longitude: number
  accuracyM: number
  isMocked: boolean
}

export type LocationResult =
  | { ok: true; fix: LocationFix }
  | { ok: false; failure: LocationFailure; message: string }

const MESSAGES: Record<LocationFailure, string> = {
  permission_denied:
    'Quanti HR needs location access to confirm you are at the office. Enable it in Settings and try again.',
  services_disabled:
    'Location services are turned off on this device. Turn them on and try again.',
  timeout:
    'Could not get a location fix. Move near a window or step outside, then try again.',
  unavailable: 'Location is not available on this device.',
}

export async function captureFix(timeoutMs = 12_000): Promise<LocationResult> {
  try {
    const servicesEnabled = await Location.hasServicesEnabledAsync()
    if (!servicesEnabled) {
      return { ok: false, failure: 'services_disabled', message: MESSAGES.services_disabled }
    }

    const { status } = await Location.requestForegroundPermissionsAsync()
    if (status !== Location.PermissionStatus.GRANTED) {
      return { ok: false, failure: 'permission_denied', message: MESSAGES.permission_denied }
    }

    const position = await withTimeout(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      timeoutMs,
    )

    if (!position) {
      return { ok: false, failure: 'timeout', message: MESSAGES.timeout }
    }

    return {
      ok: true,
      fix: {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        // Web returns no accuracy on some browsers; treat unknown as poor
        // rather than perfect, so the server's threshold does its job.
        accuracyM: position.coords.accuracy ?? 999,
        // `mocked` is Android-only. On iOS a jailbroken device can still spoof,
        // which is why device binding carries more weight than this flag.
        isMocked: Platform.OS === 'android' ? (position.mocked ?? false) : false,
      },
    }
  } catch {
    return { ok: false, failure: 'unavailable', message: MESSAGES.unavailable }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer!)
  }
}

/** Metres between two points — used to show live distance before submitting. */
export function distanceTo(fix: LocationFix, target: { latitude: number; longitude: number }): number {
  const R = 6_371_008.8
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(target.latitude - fix.latitude)
  const dLng = toRad(target.longitude - fix.longitude)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(toRad(fix.latitude)) * Math.cos(toRad(target.latitude))
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}
