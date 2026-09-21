/**
 * Choose a password.
 *
 * Two ways in. Forced: the session is on a temporary password and the layout
 * routed here before anything else could show — no current-password field,
 * because the person was handed it once and may not have it to hand, and no
 * way back but sign-out. Voluntary: from the Me screen, with the current
 * password required, and a back button.
 *
 * Length is the only rule. Composition rules produce `Password1!`; a short
 * sentence produces something both longer and rememberable, so that is what
 * the hint suggests.
 */

import { useState } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { api } from '../src/api/client'
import { keys } from '../src/api/queries'
import { clearTokens, hasOnboarded, useSession } from '../src/store/session'
import { Button, Card, ErrorNotice } from '../src/ui/components'
import { Label } from '../src/ui/primitives'
import { LogoMark } from '../src/ui/Logo'
import { Aurora } from '../src/ui/Aurora'
import { colour, font, MAX_CONTENT_WIDTH, radius, space } from '../src/ui/theme'

const MIN_LENGTH = 10

export default function ChangePassword() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const queryClient = useQueryClient()
  const forced = useSession((s) => s.mustChangePassword)
  const setMustChangePassword = useSession((s) => s.setMustChangePassword)

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const mismatch = again.length > 0 && again !== next
  const ready =
    next.length >= MIN_LENGTH && again === next && (forced || current.length > 0)

  const submit = async () => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.post('/v1/auth/password/change', {
        ...(forced ? {} : { currentPassword: current }),
        newPassword: next,
      })
      setMustChangePassword(false)
      await queryClient.invalidateQueries({ queryKey: keys.me })
      if (forced) {
        router.replace((await hasOnboarded()) ? '/' : '/welcome')
      } else {
        setDone(true)
        setCurrent('')
        setNext('')
        setAgain('')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    await clearTokens()
    router.replace('/sign-in')
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Aurora intensity={0.35} />
      <ScrollView
        contentContainerStyle={[
          styles.column,
          { paddingTop: insets.top + space.xxl, paddingBottom: insets.bottom + space.xl },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brand}>
          <LogoMark size={36} />
          <Text style={styles.title}>{forced ? 'Choose your password' : 'Change your password'}</Text>
          <Text style={styles.lede}>
            {forced
              ? 'The one you signed in with was temporary. Pick your own before you go on.'
              : 'Your phone stays signed in; only the password changes.'}
          </Text>
        </View>

        <Card>
          {forced ? null : (
            <>
              <Label>Current password</Label>
              <TextInput
                value={current}
                onChangeText={setCurrent}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="current-password"
                textContentType="password"
                style={styles.input}
                accessibilityLabel="Current password"
                editable={!busy}
              />
            </>
          )}

          <Label>New password</Label>
          <TextInput
            value={next}
            onChangeText={setNext}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="new-password"
            textContentType="newPassword"
            style={styles.input}
            accessibilityLabel="New password"
            editable={!busy}
          />
          <Text style={styles.hint}>
            At least {MIN_LENGTH} characters. A short sentence you will remember works well.
          </Text>

          <Label>Type it again</Label>
          <TextInput
            value={again}
            onChangeText={setAgain}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="new-password"
            textContentType="newPassword"
            returnKeyType="go"
            onSubmitEditing={submit}
            style={[styles.input, mismatch ? styles.inputBad : null]}
            accessibilityLabel="New password, again"
            editable={!busy}
          />
          {mismatch ? <Text style={styles.bad}>Those two do not match.</Text> : null}

          <Button
            label={forced ? 'Save and continue' : 'Change password'}
            onPress={submit}
            loading={busy}
            disabled={!ready}
          />

          {error ? <ErrorNotice message={error} /> : null}
          {done ? <ErrorNotice tone="success" message="Password changed." /> : null}

          {forced ? (
            <Button label="Sign out" variant="ghost" onPress={() => void signOut()} />
          ) : (
            <Button label="Back" variant="ghost" onPress={() => router.back()} />
          )}
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colour.bg },
  column: {
    flexGrow: 1,
    justifyContent: 'center',
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: space.lg,
    gap: space.lg,
  },
  brand: { gap: space.sm },
  title: {
    fontSize: font.size.xxl,
    fontWeight: font.weight.bold,
    color: colour.text,
    letterSpacing: font.tracking.tight,
    fontFamily: font.family,
    marginTop: space.sm,
  },
  lede: {
    fontSize: font.size.md,
    color: colour.textMuted,
    lineHeight: 21,
    fontFamily: font.family,
  },
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
  inputBad: { borderColor: colour.danger },
  hint: {
    fontSize: font.size.sm,
    color: colour.textFaint,
    lineHeight: 17,
    fontFamily: font.family,
    marginTop: -space.xs,
  },
  bad: {
    fontSize: font.size.sm,
    color: colour.danger,
    fontFamily: font.family,
    marginTop: -space.xs,
  },
})
