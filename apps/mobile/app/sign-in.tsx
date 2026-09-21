/**
 * Sign in — password, or a magic link (spec §12, amended).
 *
 * The screen was built around "assume six sessions a year": most people's
 * *first* screen every time, months apart, on a phone they may have changed.
 * The link is still the door that needs nothing remembered. The password is
 * the door for a first morning: HR hands a new joiner a temporary one on
 * paper and they are in before their email works. It has to be changed on
 * first use, so a Post-it never stays a credential.
 *
 * Both doors answer identically for an unknown address — a different message
 * would turn this into a way to enumerate who works at the company.
 */

import { useEffect, useRef, useState } from 'react'
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { API_BASE_URL, request } from '../src/api/client'
import { getDeviceId, hasOnboarded, setTokens, useSession } from '../src/store/session'
import { Button, Card, ErrorNotice } from '../src/ui/components'
import { Label } from '../src/ui/primitives'
import { LogoMark } from '../src/ui/Logo'
import { Aurora } from '../src/ui/Aurora'
import { useGoogleIdToken } from '../src/lib/google'
import { colour, font, MAX_CONTENT_WIDTH, radius, space } from '../src/ui/theme'

interface MagicLinkResponse {
  sent: boolean
  message: string
  devLink?: string
}

interface SessionResponse {
  accessToken: string
  refreshToken: string
  deviceReviewRequired: boolean
  mustChangePassword: boolean
}

type Door = 'password' | 'link'

const WAKING = 'Waking the server up — the first sign-in in a while can take up to a minute.'
type State = 'idle' | 'sending' | 'sent' | 'error'

export default function SignIn() {
  const [door, setDoor] = useState<Door>('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [state, setState] = useState<State>('idle')
  // True once a request has been in flight for a few seconds. On a hosted
  // free tier the first request after a quiet spell has to wake the server,
  // which can take most of a minute; a silent spinner that long reads as
  // broken, a line that says what is happening does not.
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (state !== 'sending') {
      setSlow(false)
      return
    }
    const t = setTimeout(() => setSlow(true), 3000)
    return () => clearTimeout(t)
  }, [state])
  const [message, setMessage] = useState('')
  const [devLink, setDevLink] = useState<string | null>(null)
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const passwordRef = useRef<TextInput>(null)

  const enter = useRef(new Animated.Value(0)).current

  useEffect(() => {
    Animated.timing(enter, {
      toValue: 1,
      duration: 420,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start()
  }, [enter])

  const validEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())
  const canSignIn = validEmail && password.length > 0

  const switchDoor = (to: Door) => {
    setDoor(to)
    setState('idle')
    setMessage('')
    setDevLink(null)
  }

  // Google: identity only. The API matches the email to an account HR made;
  // someone not yet added gets that in words, with who to ask.
  const finishSession = async (session: SessionResponse) => {
    await setTokens(session.accessToken, session.refreshToken)
    useSession.setState({
      deviceReviewRequired: session.deviceReviewRequired,
      mustChangePassword: session.mustChangePassword,
    })
    if (session.mustChangePassword) router.replace('/change-password')
    else router.replace((await hasOnboarded()) ? '/' : '/welcome')
  }

  const google = useGoogleIdToken(async (idToken) => {
    setState('sending')
    try {
      const session = await request<SessionResponse>('/v1/auth/sso/google', {
        method: 'POST',
        raw: true,
        body: {
          idToken,
          deviceId: await getDeviceId(),
          deviceName: Platform.OS === 'web' ? 'Browser' : `${Platform.OS} device`,
          platform: Platform.OS === 'web' ? 'web' : Platform.OS,
        },
      })
      await finishSession(session)
    } catch (error) {
      setState('error')
      setMessage(
        error instanceof Error && !('offline' in error)
          ? error.message
          : 'Could not reach the server. Check your connection and try again.',
      )
    }
  })

  const signInWithPassword = async () => {
    if (!canSignIn) return
    setState('sending')
    try {
      const deviceId = await getDeviceId()
      // `raw`: a 401 here is a wrong password, not an expired session, and
      // must not trigger the refresh-and-retry the client does elsewhere.
      const session = await request<SessionResponse>('/v1/auth/password', {
        method: 'POST',
        raw: true,
        body: {
          email: email.trim(),
          password,
          deviceId,
          deviceName: Platform.OS === 'web' ? 'Browser' : `${Platform.OS} device`,
          platform: Platform.OS === 'web' ? 'web' : Platform.OS,
        },
      })
      setPassword('')
      await setTokens(session.accessToken, session.refreshToken)
      useSession.setState({
        deviceReviewRequired: session.deviceReviewRequired,
        mustChangePassword: session.mustChangePassword,
      })
      if (session.mustChangePassword) {
        router.replace('/change-password')
      } else {
        router.replace((await hasOnboarded()) ? '/' : '/welcome')
      }
    } catch (error) {
      setState('error')
      setMessage(
        error instanceof Error && !('offline' in error)
          ? error.message
          : 'Could not reach the server. Check your connection and try again.',
      )
    }
  }

  const sendLink = async () => {
    if (!validEmail) return
    setState('sending')
    setDevLink(null)
    try {
      const response = await fetch(`${API_BASE_URL}/v1/auth/magic-link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })
      const body = (await response.json()) as MagicLinkResponse
      setMessage(body.message)
      setDevLink(body.devLink ?? null)
      setState('sent')
    } catch {
      setState('error')
      setMessage('Could not reach the server. Check your connection and try again.')
    }
  }

  const openDevLink = () => {
    if (!devLink) return
    const token = new URL(devLink).searchParams.get('token')
    if (token) router.replace(`/auth/callback?token=${token}`)
  }

  const emailField = (
    <>
      <Label>Work email</Label>
      <TextInput
        value={email}
        onChangeText={setEmail}
        placeholder="you@company.com"
        placeholderTextColor={colour.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        keyboardType="email-address"
        textContentType="username"
        inputMode="email"
        returnKeyType={door === 'password' ? 'next' : 'go'}
        style={styles.input}
        onSubmitEditing={door === 'password' ? () => passwordRef.current?.focus() : sendLink}
        accessibilityLabel="Work email address"
        editable={state !== 'sending'}
      />
    </>
  )

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Aurora />
      <Animated.View
        style={[
          styles.column,
          {
            paddingTop: insets.top + space.xl,
            paddingBottom: insets.bottom + space.xl,
            opacity: enter,
            transform: [
              { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) },
            ],
          },
        ]}
      >
        {/* Just the mark. The card says what the screen is for. */}
        <View style={styles.brand}>
          <LogoMark size={64} />
        </View>

        {door === 'link' && state === 'sent' ? (
          <Card>
            <Label tone="primary">Check your email</Label>
            <Text style={styles.sentTitle}>{email.trim()}</Text>
            <Text style={styles.sentBody}>{message}</Text>

            {devLink ? (
              // Development affordance. The API only returns this outside
              // production, where env() refuses to boot with a dev secret.
              <Button
                label="Open the link (development)"
                variant="secondary"
                onPress={openDevLink}
              />
            ) : null}

            <Button
              label="Use a different address"
              variant="ghost"
              onPress={() => switchDoor('link')}
            />
          </Card>
        ) : door === 'link' ? (
          <Card>
            {emailField}
            <Button
              label="Email me a sign-in link"
              onPress={sendLink}
              loading={state === 'sending'}
              disabled={!validEmail}
            />
            {slow ? <Text style={styles.slow}>{WAKING}</Text> : null}
            {state === 'error' ? <ErrorNotice message={message} /> : null}
            <Pressable
              onPress={() => switchDoor('password')}
              accessibilityRole="button"
              hitSlop={8}
            >
              <Text style={styles.switch}>I have a password</Text>
            </Pressable>
          </Card>
        ) : (
          <Card>
            {emailField}
            <Label>Password</Label>
            <TextInput
              ref={passwordRef}
              value={password}
              onChangeText={setPassword}
              placeholder="Your password or temporary password"
              placeholderTextColor={colour.textFaint}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="current-password"
              textContentType="password"
              returnKeyType="go"
              style={styles.input}
              onSubmitEditing={signInWithPassword}
              accessibilityLabel="Password"
              editable={state !== 'sending'}
            />

            <Button
              label="Sign in"
              onPress={signInWithPassword}
              loading={state === 'sending'}
              disabled={!canSignIn}
            />

            {slow ? <Text style={styles.slow}>{WAKING}</Text> : null}
            {state === 'error' ? <ErrorNotice message={message} /> : null}
            {google.error ? <ErrorNotice message={google.error} /> : null}

            {google.enabled ? (
              <Button
                label="Continue with Google"
                variant="secondary"
                disabled={!google.ready || state === 'sending'}
                onPress={google.prompt}
              />
            ) : null}

            <Pressable onPress={() => switchDoor('link')} accessibilityRole="button" hitSlop={8}>
              <Text style={styles.switch}>Email me a sign-in link instead</Text>
            </Pressable>
            <Text style={styles.footnote}>
              New here? Use the temporary password HR gave you — you will choose your own next.
            </Text>
          </Card>
        )}
      </Animated.View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colour.bg },
  column: {
    flex: 1,
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    gap: space.xxl,
  },

  brand: { alignItems: 'center' },

  input: {
    borderWidth: 1,
    borderColor: colour.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    minHeight: 50,
    fontSize: font.size.lg,
    color: colour.text,
    backgroundColor: colour.surfaceSunken,
    fontFamily: font.family,
  },

  slow: {
    fontSize: font.size.sm,
    color: colour.textMuted,
    textAlign: 'center',
    lineHeight: 18,
    fontFamily: font.family,
  },
  switch: {
    fontSize: font.size.md,
    color: colour.primary,
    fontWeight: font.weight.semibold,
    textAlign: 'center',
    paddingVertical: space.sm,
    fontFamily: font.family,
  },

  sentTitle: {
    fontSize: font.size.lg,
    color: colour.text,
    fontWeight: font.weight.semibold,
    fontFamily: font.mono,
  },
  sentBody: {
    fontSize: font.size.md,
    color: colour.textMuted,
    lineHeight: 21,
    fontFamily: font.family,
  },

  footnote: {
    fontSize: font.size.sm,
    color: colour.textFaint,
    textAlign: 'center',
    lineHeight: 18,
    fontFamily: font.family,
  },
})
