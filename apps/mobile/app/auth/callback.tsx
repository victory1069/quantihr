/**
 * Magic-link exchange.
 *
 * Binds this device to the employee on first sign-in (spec §9). A second device
 * is registered but held for HR approval, and the employee is told so plainly
 * rather than discovering it when a check-in is flagged.
 */

import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { Platform } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { API_BASE_URL } from '../../src/api/client'
import { getDeviceId, setTokens, useSession } from '../../src/store/session'
import { Button, Card, ErrorNotice, Screen } from '../../src/ui/components'
import { colour, font, space } from '../../src/ui/theme'

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
        }
        await setTokens(session.accessToken, session.refreshToken)
        useSession.getState().setDeviceReviewRequired(session.deviceReviewRequired)
        router.replace('/')
      } catch {
        setError('Could not reach the server. Check your connection and try again.')
      }
    })()
  }, [token, router])

  if (!token) {
    return (
      <Screen>
        <Card>
          <ErrorNotice message="That link is missing its sign-in token." />
          <Button label="Back to sign in" onPress={() => router.replace('/sign-in')} />
        </Card>
      </Screen>
    )
  }

  if (error) {
    return (
      <Screen>
        <Card>
          <ErrorNotice message={error} />
          <Button label="Request a new link" onPress={() => router.replace('/sign-in')} />
        </Card>
      </Screen>
    )
  }

  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={colour.primary} />
      <Text style={styles.text}>Signing you in…</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    backgroundColor: colour.bg,
  },
  text: { fontSize: font.size.md, color: colour.textMuted },
})
