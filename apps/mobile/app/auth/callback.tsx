/**
 * Magic-link exchange.
 *
 * Also the point at which this phone is bound to the employee for attendance
 * verification (spec §9). The binding itself happens server-side; what matters
 * here is that a first-time device is routed into onboarding so the employee is
 * *told* it happened, rather than discovering it when a check-in is flagged.
 */

import { useEffect, useRef, useState } from 'react'
import { Platform, StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { API_BASE_URL } from '../../src/api/client'
import {
  getDeviceId,
  hasOnboarded,
  setTokens,
  useSession,
} from '../../src/store/session'
import { Button, Card, ErrorNotice } from '../../src/ui/components'
import { LogoLoader } from '../../src/ui/Logo'
import { colour, font, MAX_CONTENT_WIDTH, space } from '../../src/ui/theme'

export default function AuthCallback() {
  const { token } = useLocalSearchParams<{ token?: string }>()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const exchanged = useRef(false)

  useEffect(() => {
    if (!token || exchanged.current) return
    exchanged.current = true

    void (async () => {
      try {
        const deviceId = await getDeviceId()
        const response = await fetch(`${API_BASE_URL}/v1/auth/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token,
            deviceId,
            deviceName: Platform.OS === 'web' ? 'Browser' : `${Platform.OS} device`,
            platform: Platform.OS === 'web' ? 'web' : Platform.OS,
          }),
        })

        if (!response.ok) {
          const body = (await response.json()) as { message?: string }
          setError(body.message ?? 'That sign-in link could not be used.')
          return
        }

        const session = (await response.json()) as {
          accessToken: string
          refreshToken: string
          deviceReviewRequired: boolean
          mustChangePassword?: boolean
        }
        await setTokens(session.accessToken, session.refreshToken)
        useSession.getState().setDeviceReviewRequired(session.deviceReviewRequired)
        useSession.getState().setMustChangePassword(session.mustChangePassword ?? false)

        // The welcome link and a temporary password arrive in the same
        // email; whichever door is used, the temporary password has to go
        // before anything else is seen.
        if (session.mustChangePassword) {
          router.replace('/change-password')
          return
        }

        // First time on this device: explain the binding, biometrics and
        // notifications before dropping them on Home.
        router.replace((await hasOnboarded()) ? '/' : '/welcome')
      } catch {
        setError('Could not reach the server. Check your connection and try again.')
      }
    })()
  }, [token, router])

  if (!token || error) {
    return (
      <View style={styles.centreColumn}>
        <Card>
          <ErrorNotice
            message={error ?? 'That link is missing its sign-in token.'}
          />
          <Button label="Request a new link" onPress={() => router.replace('/sign-in')} />
        </Card>
      </View>
    )
  }

  return (
    <View style={styles.centre}>
      <LogoLoader size={72} />
      <Text style={styles.text}>Signing you in…</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  centre: {
    flex: 1,
    backgroundColor: colour.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xl,
  },
  centreColumn: {
    flex: 1,
    backgroundColor: colour.bg,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
  },
  text: {
    fontSize: font.size.md,
    color: colour.textMuted,
    fontFamily: font.mono,
    letterSpacing: font.tracking.wide,
  },
})
