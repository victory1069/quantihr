/**
 * Google sign-in on the app.
 *
 * Wraps expo-auth-session's Google provider so the sign-in screen only has
 * to ask two things: is this configured, and give me an ID token. Client
 * ids come from EXPO_PUBLIC_GOOGLE_*_CLIENT_ID at build time; with none set
 * the hook reports `enabled: false` and the button is not rendered.
 *
 * The API checks the token with Google and matches the email to an account
 * HR created. Nothing here decides whether someone may sign in.
 */

import { useEffect, useState } from 'react'
import * as WebBrowser from 'expo-web-browser'
import * as Google from 'expo-auth-session/providers/google'

// Closes the browser tab on the redirect back, instead of leaving it open.
WebBrowser.maybeCompleteAuthSession()

const WEB = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID
const ANDROID = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID
const IOS = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID

export const googleEnabled = !!(WEB || ANDROID || IOS)

export function useGoogleIdToken(onToken: (idToken: string) => void): {
  enabled: boolean
  ready: boolean
  prompt: () => void
  error: string | null
} {
  const [error, setError] = useState<string | null>(null)
  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
    clientId: WEB ?? ANDROID ?? IOS ?? 'unconfigured',
    androidClientId: ANDROID,
    iosClientId: IOS,
    webClientId: WEB,
  })

  useEffect(() => {
    if (!response) return
    if (response.type === 'success') {
      const idToken = response.params.id_token
      if (idToken) onToken(idToken)
      else setError('Google did not return a sign-in token.')
    } else if (response.type === 'error') {
      setError(response.error?.message ?? 'Google sign-in failed.')
    }
    // `onToken` is stable enough per screen; re-running on it would re-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response])

  return {
    enabled: googleEnabled,
    ready: !!request,
    prompt: () => {
      setError(null)
      void promptAsync()
    },
    error,
  }
}
