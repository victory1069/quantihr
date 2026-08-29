/**
 * Biometric unlock (spec §9).
 *
 * Gates app open after first login and always gates the documents screen.
 * Rendered as a full-screen overlay rather than a route so it cannot be
 * navigated around, and so the screen underneath is never briefly visible.
 *
 * On a device with no enrolled biometrics the gate steps aside rather than
 * locking the employee out — the fallback is the OS passcode where one exists,
 * and otherwise nothing, because the refresh token is already in the Keychain.
 */

import { useCallback, useEffect, useState } from 'react'
import { AppState, Platform, StyleSheet, Text, View } from 'react-native'
import * as LocalAuthentication from 'expo-local-authentication'
import { Button } from './components'
import { colour, font, space } from './theme'
import { useSession } from '../store/session'

export async function authenticate(reason: string): Promise<boolean> {
  if (Platform.OS === 'web') return true

  const hasHardware = await LocalAuthentication.hasHardwareAsync()
  const enrolled = await LocalAuthentication.isEnrolledAsync()
  if (!hasHardware || !enrolled) return true

  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: reason,
    fallbackLabel: 'Use passcode',
    disableDeviceFallback: false,
  })
  return result.success
}

export function BiometricGate() {
  const status = useSession((s) => s.status)
  const me = useSession((s) => s.me)
  const unlocked = useSession((s) => s.unlocked)
  const setUnlocked = useSession((s) => s.setUnlocked)
  const [checking, setChecking] = useState(false)
  const [failedOnce, setFailedOnce] = useState(false)

  const enabled = me?.user.biometricEnabled ?? false

  const attempt = useCallback(async () => {
    setChecking(true)
    try {
      const ok = await authenticate('Unlock Quanti HR')
      setUnlocked(ok)
      setFailedOnce(!ok)
    } finally {
      setChecking(false)
    }
  }, [setUnlocked])

  useEffect(() => {
    if (status !== 'authenticated' || !enabled || unlocked) return
    void attempt()
  }, [status, enabled, unlocked, attempt])

  // Re-lock when the app goes to the background, so handing over an unlocked
  // phone does not hand over the documents screen with it.
  useEffect(() => {
    if (!enabled) return
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') setUnlocked(false)
    })
    return () => sub.remove()
  }, [enabled, setUnlocked])

  if (status !== 'authenticated' || !enabled || unlocked) return null

  return (
    <View style={styles.overlay}>
      <Text style={styles.title}>Quanti HR is locked</Text>
      <Text style={styles.body}>
        {failedOnce
          ? 'Unlock was cancelled. Try again to continue.'
          : 'Unlock with biometrics to continue.'}
      </Text>
      <Button label={checking ? 'Waiting…' : 'Unlock'} onPress={attempt} loading={checking} />
    </View>
  )
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colour.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
    zIndex: 100,
  },
  title: { fontSize: font.size.xl, fontWeight: font.weight.semibold, color: colour.text },
  body: { fontSize: font.size.md, color: colour.textMuted, textAlign: 'center' },
})
