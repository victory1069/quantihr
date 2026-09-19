/**
 * Unlock — screens R1 and R2.
 *
 * Two things this gets right that a bare Face ID prompt does not:
 *
 *  - **Whose account is loaded is shown before the scan.** Shared and
 *    hand-me-down phones are common, and discovering you are in a colleague's
 *    account after unlocking is both a privacy incident and a support call.
 *  - **Failure names a physical cause.** "Face ID didn't recognise you" invites
 *    self-blame; masks, sunglasses and bright sun are the actual reasons, and
 *    naming them stops people retrying identically five times.
 *
 * The sign-in escape stays visible throughout. A product with
 * no visible way past a failed biometric is a product people get locked out of.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LogoMark } from '../src/ui/Logo'
import { Aurora } from '../src/ui/Aurora'
import { colour, font, MAX_CONTENT_WIDTH, radius, space } from '../src/ui/theme'
import { authenticate } from '../src/ui/BiometricGate'
import { clearTokens, useSession } from '../src/store/session'

const PASSCODE_LENGTH = 6

export default function Unlock() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const me = useSession((s) => s.me)
  const setUnlocked = useSession((s) => s.setUnlocked)

  const [mode, setMode] = useState<'biometric' | 'passcode'>('biometric')
  const [passcode, setPasscode] = useState('')
  const [checking, setChecking] = useState(false)

  const name = me ? `${me.employee.firstName} ${me.employee.lastName}` : ''

  const scan = useCallback(async () => {
    setChecking(true)
    try {
      const ok = await authenticate('Unlock Quanti')
      if (ok) {
        setUnlocked(true)
        router.replace('/')
      } else {
        setMode('passcode')
      }
    } finally {
      setChecking(false)
    }
  }, [router, setUnlocked])

  useEffect(() => {
    if (mode === 'biometric') void scan()
  }, [mode, scan])

  if (mode === 'passcode') {
    return (
      <View style={[styles.root, { paddingTop: insets.top + space.xl }]}>
        <View style={styles.column}>
          <Text style={styles.passTitle}>Enter your passcode</Text>
          <Text style={styles.lede}>
            Unlock didn&apos;t recognise you. Masks, sunglasses and bright sun all get in the
            way.
          </Text>

          <View style={styles.dots}>
            {Array.from({ length: PASSCODE_LENGTH }, (_, i) => (
              <View
                key={i}
                style={[styles.dotBox, i < passcode.length && styles.dotBoxFilled]}
              >
                {i < passcode.length ? <View style={styles.dot} /> : null}
              </View>
            ))}
          </View>

          <Keypad
            onDigit={(d) => setPasscode((p) => (p.length < PASSCODE_LENGTH ? p + d : p))}
            onDelete={() => setPasscode((p) => p.slice(0, -1))}
            onBiometric={() => {
              setPasscode('')
              setMode('biometric')
            }}
          />

          <View style={styles.spacer} />

          {/* The passcode is not implemented server-side; the magic link is the
              real recovery path and stays one tap away. */}
          <Pressable
            onPress={async () => {
              await clearTokens()
              router.replace('/sign-in')
            }}
            accessibilityRole="link"
            style={styles.escape}
            hitSlop={8}
          >
            <Text style={styles.escapeText}>
              Forgotten it? <Text style={styles.escapeLink}>Email me a sign-in link</Text>
            </Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <Aurora intensity={0.35} />
      <View style={[styles.column, styles.centred]}>
        <View style={styles.glow} pointerEvents="none" />
        <LogoMark size={64} />

        <ScanBadge active={checking} />
        <Text style={styles.scanTitle}>Look at your phone</Text>
        {/* Whose account is loaded, before the scan: shared and hand-me-down
            phones are common, and this is the line that stops the wrong
            person unlocking into a colleague's pay. */}
        <Text style={styles.welcomeBack}>{name ? `Signed in as ${name}` : 'Signed in'}</Text>

        <View style={styles.spacer} />

        <Pressable
          onPress={() => setMode('passcode')}
          style={styles.secondaryButton}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryLabel}>Use passcode</Text>
        </Pressable>

        <Pressable
          onPress={async () => {
            await clearTokens()
            router.replace('/sign-in')
          }}
          accessibilityRole="link"
          hitSlop={8}
        >
          <Text style={styles.escapeText}>
            Not you? <Text style={styles.escapeLink}>Switch account</Text>
          </Text>
        </Pressable>
      </View>
    </View>
  )
}

/** Pulses while the OS prompt is up, so the screen is not visually dead. */
function ScanBadge({ active }: { active: boolean }) {
  const pulse = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (!active) return
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [active, pulse])

  return (
    <Animated.View
      style={[
        styles.scanBadge,
        {
          opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.75, 1] }),
          transform: [
            { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] }) },
          ],
        },
      ]}
    >
      {/* Four corner brackets — a face-scan frame without needing an icon set. */}
      <View style={[styles.bracket, styles.bracketTL]} />
      <View style={[styles.bracket, styles.bracketTR]} />
      <View style={[styles.bracket, styles.bracketBL]} />
      <View style={[styles.bracket, styles.bracketBR]} />
    </Animated.View>
  )
}

function Keypad({
  onDigit,
  onDelete,
  onBiometric,
}: {
  onDigit: (digit: string) => void
  onDelete: () => void
  onBiometric: () => void
}) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'bio', '0', 'del']

  return (
    <View style={styles.keypad}>
      {keys.map((key) => {
        if (key === 'bio') {
          return (
            <Pressable
              key={key}
              onPress={onBiometric}
              style={styles.keyGhost}
              accessibilityRole="button"
              accessibilityLabel="Try unlocking again"
            >
              <Text style={styles.keyGhostLabel}>Unlock</Text>
            </Pressable>
          )
        }
        if (key === 'del') {
          return (
            <Pressable
              key={key}
              onPress={onDelete}
              style={styles.keyGhost}
              accessibilityRole="button"
              accessibilityLabel="Delete"
            >
              <Text style={styles.keyDigit}>⌫</Text>
            </Pressable>
          )
        }
        return (
          <Pressable
            key={key}
            onPress={() => onDigit(key)}
            style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
            accessibilityRole="button"
            accessibilityLabel={key}
          >
            <Text style={styles.keyDigit}>{key}</Text>
          </Pressable>
        )
      })}
    </View>
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
    paddingBottom: space.xl,
    gap: space.lg,
  },
  centred: { alignItems: 'center', justifyContent: 'center', paddingTop: space.xxxl },
  spacer: { flex: 1, minHeight: space.lg },

  welcomeBack: {
    fontSize: font.size.md,
    color: colour.textMuted,
    fontFamily: font.family,
  },
  glow: {
    position: 'absolute',
    width: 380,
    height: 380,
    borderRadius: 190,
    backgroundColor: colour.primary,
    opacity: 0.08,
  },
  scanTitle: {
    fontSize: font.size.xxl,
    fontWeight: font.weight.bold,
    color: colour.text,
    fontFamily: font.family,
    letterSpacing: font.tracking.snug,
  },

  scanBadge: {
    width: 92,
    height: 92,
    borderRadius: radius.xl,
    backgroundColor: colour.primarySoft,
    borderWidth: 1,
    borderColor: colour.primaryBorder,
    marginTop: space.xl,
  },
  bracket: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderColor: colour.primary,
  },
  bracketTL: { top: 24, left: 24, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 8 },
  bracketTR: { top: 24, right: 24, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 8 },
  bracketBL: { bottom: 24, left: 24, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 8 },
  bracketBR: { bottom: 24, right: 24, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 8 },

  passTitle: {
    fontSize: font.size.xl,
    fontWeight: font.weight.semibold,
    color: colour.text,
    fontFamily: font.family,
    paddingTop: space.lg,
  },
  lede: {
    fontSize: font.size.md,
    color: colour.textMuted,
    lineHeight: 21,
    fontFamily: font.family,
  },

  dots: { flexDirection: 'row', gap: space.sm, justifyContent: 'space-between' },
  dotBox: {
    flex: 1,
    aspectRatio: 0.9,
    maxWidth: 54,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colour.border,
    backgroundColor: colour.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotBoxFilled: { borderColor: colour.primary },
  dot: { width: 11, height: 11, borderRadius: 6, backgroundColor: colour.primary },

  keypad: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md, justifyContent: 'center' },
  key: {
    width: '30%',
    minHeight: 62,
    borderRadius: radius.md,
    backgroundColor: colour.surface,
    borderWidth: 1,
    borderColor: colour.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyPressed: { backgroundColor: colour.surfaceRaised },
  keyGhost: {
    width: '30%',
    minHeight: 62,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyDigit: { fontSize: 24, color: colour.text, fontFamily: font.mono },
  keyGhostLabel: {
    fontSize: font.size.md,
    color: colour.primary,
    fontWeight: font.weight.semibold,
    fontFamily: font.family,
  },

  secondaryButton: {
    alignSelf: 'stretch',
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colour.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryLabel: {
    fontSize: font.size.md,
    color: colour.text,
    fontWeight: font.weight.semibold,
    fontFamily: font.family,
  },

  escape: { alignItems: 'center' },
  escapeText: {
    fontSize: font.size.sm,
    color: colour.textFaint,
    fontFamily: font.family,
    textAlign: 'center',
  },
  escapeLink: { color: colour.primary, fontWeight: font.weight.bold },
})
