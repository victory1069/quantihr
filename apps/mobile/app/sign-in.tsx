/**
 * Magic-link sign-in (spec §9). No passwords.
 *
 * In development the API returns the link in the response so the web preview is
 * usable without an email provider; the button below only appears when that
 * field is present, which it never is in production.
 */

import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import { API_BASE_URL } from '../src/api/client'
import { Button, Card, ErrorNotice, Screen } from '../src/ui/components'
import { colour, font, space } from '../src/ui/theme'

interface MagicLinkResponse {
  sent: boolean
  message: string
  devLink?: string
}

export default function SignIn() {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [devLink, setDevLink] = useState<string | null>(null)
  const router = useRouter()

  const submit = async () => {
    if (!email.trim()) return
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
    <Screen>
      <View style={styles.hero}>
        <Text style={styles.brand}>Quanti HR</Text>
        <Text style={styles.tagline}>Attendance, leave and your documents in one place.</Text>
      </View>

      <Card>
        <Text style={styles.label}>Work email</Text>
        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder="you@company.com"
          placeholderTextColor={colour.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          style={styles.input}
          onSubmitEditing={submit}
          accessibilityLabel="Work email address"
        />

        <Button
          label={state === 'sent' ? 'Send another link' : 'Email me a sign-in link'}
          onPress={submit}
          loading={state === 'sending'}
          disabled={!email.trim()}
        />

        {state === 'sent' ? (
          <ErrorNotice
            tone="info"
            message={message}
            action={
              devLink ? (
                <Button label="Open the link (development)" variant="secondary" onPress={openDevLink} />
              ) : undefined
            }
          />
        ) : null}

        {state === 'error' ? <ErrorNotice message={message} /> : null}
      </Card>

      <Text style={styles.footnote}>
        We never ask for a password. Links expire after 15 minutes and can be used once.
      </Text>
    </Screen>
  )
}

const styles = StyleSheet.create({
  hero: { paddingVertical: space.xxl, gap: space.sm },
  brand: { fontSize: font.size.xxl, fontWeight: font.weight.bold, color: colour.text },
  tagline: { fontSize: font.size.md, color: colour.textMuted, lineHeight: 22 },
  label: { fontSize: font.size.sm, fontWeight: font.weight.semibold, color: colour.textMuted },
  input: {
    borderWidth: 1,
    borderColor: colour.borderStrong,
    borderRadius: 12,
    paddingHorizontal: space.md,
    minHeight: 48,
    fontSize: font.size.md,
    color: colour.text,
    backgroundColor: colour.surface,
  },
  footnote: {
    fontSize: font.size.sm,
    color: colour.textFaint,
    textAlign: 'center',
    marginTop: space.md,
    lineHeight: 19,
  },
})
