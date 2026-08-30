/**
 * Sign in — magic link, no passwords (spec §12).
 *
 * The design problem here is set by "assume six sessions a year": this screen
 * is most people's *first* screen every time, months apart, on a phone they may
 * have changed. So there is exactly one field and one button, no password to
 * have forgotten, and no account to have to remember creating.
 *
 * The response is identical whether or not the address is known — a different
 * message would turn this into a way to enumerate who works at the company.
 */

import { useEffect, useRef, useState } from 'react'
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { API_BASE_URL } from '../src/api/client'
import { Button, Card, ErrorNotice } from '../src/ui/components'
import { Label } from '../src/ui/primitives'
import { LogoMark } from '../src/ui/Logo'
import { colour, font, MAX_CONTENT_WIDTH, radius, space } from '../src/ui/theme'

interface MagicLinkResponse {
  sent: boolean
  message: string
  devLink?: string
}

type State = 'idle' | 'sending' | 'sent' | 'error'

export default function SignIn() {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<State>('idle')
  const [message, setMessage] = useState('')
  const [devLink, setDevLink] = useState<string | null>(null)
  const router = useRouter()
  const insets = useSafeAreaInsets()

  const enter = useRef(new Animated.Value(0)).current

  useEffect(() => {
    Animated.timing(enter, {
      toValue: 1,
      duration: 420,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start()
  }, [enter])

  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())

  const submit = async () => {
    if (!valid) return
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

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Animated.View
        style={[
          styles.column,
          {
            paddingTop: insets.top + space.xxxl,
            paddingBottom: insets.bottom + space.xl,
            opacity: enter,
            transform: [
              { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) },
            ],
          },
        ]}
      >
        {/* Brand */}
        <View style={styles.brand}>
          <LogoMark size={56} />
          <Text style={styles.wordmark}>Quanti</Text>
          <Text style={styles.tagline}>
            Your leave, your pay, your documents — in one place.
          </Text>
        </View>

        <View style={styles.spacer} />

        {state === 'sent' ? (
          <Card>
            <Label tone="primary">Check your email</Label>
            <Text style={styles.sentTitle}>{email.trim()}</Text>
            <Text style={styles.sentBody}>{message}</Text>

            {devLink ? (
              <>
                {/* Development affordance. The API only returns this outside
                    production, where env() refuses to boot with a dev secret. */}
                <Button
                  label="Open the link (development)"
                  variant="secondary"
                  onPress={openDevLink}
                />
              </>
            ) : null}

            <Button
              label="Use a different address"
              variant="ghost"
              onPress={() => {
                setState('idle')
                setDevLink(null)
              }}
            />
          </Card>
        ) : (
          <Card>
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
              textContentType="emailAddress"
              inputMode="email"
              returnKeyType="go"
              style={styles.input}
              onSubmitEditing={submit}
              accessibilityLabel="Work email address"
              editable={state !== 'sending'}
            />

            <Button
              label="Email me a sign-in link"
              onPress={submit}
              loading={state === 'sending'}
              disabled={!valid}
            />

            {state === 'error' ? <ErrorNotice message={message} /> : null}
          </Card>
        )}

        <Text style={styles.footnote}>
          No passwords, ever. Links last 15 minutes and work once.
        </Text>
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
    paddingHorizontal: space.lg,
    gap: space.lg,
  },
  spacer: { flex: 1 },

  brand: { gap: space.md },
  wordmark: {
    fontSize: font.size.display,
    fontWeight: font.weight.bold,
    color: colour.text,
    letterSpacing: font.tracking.tight,
    fontFamily: font.family,
  },
  tagline: {
    fontSize: font.size.lg,
    color: colour.textMuted,
    lineHeight: 26,
    fontFamily: font.family,
  },

  input: {
    borderWidth: 1,
    borderColor: colour.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    minHeight: 56,
    fontSize: font.size.lg,
    color: colour.text,
    backgroundColor: colour.surfaceSunken,
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
    lineHeight: 23,
    fontFamily: font.family,
  },

  footnote: {
    fontSize: font.size.sm,
    color: colour.textFaint,
    textAlign: 'center',
    lineHeight: 20,
    fontFamily: font.family,
  },
})
