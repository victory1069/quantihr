/**
 * Pieces shared across the sign-up, sign-in and recovery flows.
 *
 * Kept together because these screens are the ones a user meets once, under
 * mild stress, often on a bad connection — so consistency between them matters
 * more than in the rest of the app.
 */

import { useEffect, useRef, useState } from 'react'
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { colour, font, radius, space } from './theme'
import { Figure } from './primitives'

/**
 * Segmented progress rail.
 *
 * Segments rather than a continuous bar because the user is being asked to
 * complete a known, countable number of things — "two more" is more reassuring
 * than a bar at 60%. Completed segments turn green, the current one is cyan,
 * and a failed step turns magenta in place (screen L6).
 */
export function ProgressRail({
  total,
  index,
  failed,
  onBack,
}: {
  total: number
  index: number
  failed?: boolean
  onBack?: () => void
}) {
  return (
    <View style={styles.rail}>
      {onBack ? (
        <Pressable
          onPress={onBack}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Text style={styles.backChevron}>‹</Text>
        </Pressable>
      ) : (
        <View style={styles.backSpacer} />
      )}

      <View
        style={styles.railTrack}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: total, now: index + 1 }}
      >
        {Array.from({ length: total }, (_, i) => (
          <View
            key={i}
            style={[
              styles.railSegment,
              i < index && styles.railDone,
              i === index && (failed ? styles.railFailed : styles.railActive),
            ]}
          />
        ))}
      </View>
    </View>
  )
}

/**
 * One-time code entry.
 *
 * A single hidden field drives the boxes rather than one input per digit.
 * Per-box inputs fight SMS autofill, which delivers the whole code at once, and
 * autofill is the difference between a two-second step and a fifteen-second one.
 */
export function CodeInput({
  length = 6,
  value,
  onChange,
  onComplete,
  state = 'idle',
  autoFocus = true,
}: {
  length?: number
  value: string
  onChange: (next: string) => void
  onComplete?: (code: string) => void
  state?: 'idle' | 'error'
  autoFocus?: boolean
}) {
  const input = useRef<TextInput>(null)
  const shake = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (state !== 'error') return
    Animated.sequence([
      Animated.timing(shake, { toValue: 1, duration: 60, useNativeDriver: true }),
      Animated.timing(shake, { toValue: -1, duration: 60, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 0.5, duration: 60, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 0, duration: 60, useNativeDriver: true }),
    ]).start()
  }, [state, shake])

  const digits = Array.from({ length }, (_, i) => value[i] ?? null)

  return (
    <Pressable onPress={() => input.current?.focus()} accessibilityRole="none">
      <Animated.View
        style={[
          styles.codeRow,
          {
            transform: [
              { translateX: shake.interpolate({ inputRange: [-1, 1], outputRange: [-8, 8] }) },
            ],
          },
        ]}
      >
        {digits.map((digit, i) => {
          const active = i === value.length
          return (
            <View
              key={i}
              style={[
                styles.codeBox,
                digit !== null && styles.codeBoxFilled,
                active && styles.codeBoxActive,
                state === 'error' && styles.codeBoxError,
              ]}
            >
              <Text
                style={[styles.codeDigit, state === 'error' && { color: colour.accent }]}
              >
                {digit ?? '–'}
              </Text>
            </View>
          )
        })}
      </Animated.View>

      {/* Off-screen rather than hidden: a display:none input is skipped by
          autofill on both platforms. */}
      <TextInput
        ref={input}
        value={value}
        onChangeText={(next) => {
          const cleaned = next.replace(/\D/g, '').slice(0, length)
          onChange(cleaned)
          if (cleaned.length === length) onComplete?.(cleaned)
        }}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={length}
        autoFocus={autoFocus}
        style={styles.hiddenInput}
        accessibilityLabel={`${length} digit verification code`}
      />
    </Pressable>
  )
}

/** Countdown before a resend is allowed. Renders its own timer. */
export function ResendTimer({
  seconds,
  label,
  onResend,
}: {
  seconds: number
  label: string
  onResend: () => void
}) {
  const [left, setLeft] = useState(seconds)

  useEffect(() => {
    setLeft(seconds)
    const timer = setInterval(() => setLeft((n) => (n <= 1 ? 0 : n - 1)), 1000)
    return () => clearInterval(timer)
  }, [seconds])

  const ready = left <= 0
  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`

  return (
    <Pressable
      onPress={() => {
        if (!ready) return
        setLeft(seconds)
        onResend()
      }}
      disabled={!ready}
      accessibilityRole="button"
      accessibilityState={{ disabled: !ready }}
      style={[styles.resend, ready && styles.resendReady]}
    >
      <Text style={[styles.resendLabel, ready && styles.resendLabelReady]}>{label}</Text>
      {ready ? (
        <Text style={styles.resendNow}>Tap to send</Text>
      ) : (
        <Figure size="sm" tone="warning">
          {mmss}
        </Figure>
      )}
    </Pressable>
  )
}

export type CheckState = 'yes' | 'no' | 'warn'

/**
 * A capability line: what works, what doesn't.
 *
 * Used on the boundary card, the offline screen and the archive screen — every
 * place the honest answer is a mixed list rather than a reassurance.
 */
export function CheckRow({
  state,
  children,
  style,
}: {
  state: CheckState
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
}) {
  return (
    <View style={[styles.checkRow, style]}>
      <Text style={[styles.checkGlyph, { color: checkColour[state] }]}>
        {state === 'yes' ? '✓' : state === 'no' ? '✕' : '!'}
      </Text>
      <Text style={styles.checkText}>{children}</Text>
    </View>
  )
}

/** A field from the HR record that the employee can confirm or flag (L7). */
export function ConfirmField({
  label,
  value,
  flagged,
  onFlag,
}: {
  label: string
  value: string
  flagged?: boolean
  onFlag: () => void
}) {
  return (
    <View style={[styles.confirm, flagged && styles.confirmFlagged]}>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={[styles.confirmLabel, flagged && { color: colour.warning }]}>
          {label}
        </Text>
        <Text style={styles.confirmValue}>{value}</Text>
      </View>

      {flagged ? (
        <View style={styles.flaggedPill}>
          <Text style={styles.flaggedPillText}>Flagged</Text>
        </View>
      ) : (
        <Pressable
          onPress={onFlag}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`Flag ${label} as wrong`}
          style={styles.flagButton}
        >
          <Text style={styles.flagButtonText}>Flag</Text>
        </Pressable>
      )}
    </View>
  )
}

const checkColour: Record<CheckState, string> = {
  yes: colour.success,
  no: colour.accent,
  warn: colour.warning,
}

const styles = StyleSheet.create({
  rail: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  backChevron: { fontSize: 30, color: colour.textMuted, lineHeight: 29, width: 18 },
  backSpacer: { width: 18 },
  railTrack: { flex: 1, flexDirection: 'row', gap: space.sm },
  railSegment: {
    flex: 1,
    height: 3,
    borderRadius: 2,
    backgroundColor: colour.surfaceRaised,
  },
  railActive: { backgroundColor: colour.primary },
  railDone: { backgroundColor: colour.success },
  railFailed: { backgroundColor: colour.accent },

  codeRow: { flexDirection: 'row', gap: space.sm, justifyContent: 'space-between' },
  codeBox: {
    flex: 1,
    aspectRatio: 0.78,
    maxWidth: 60,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colour.border,
    backgroundColor: colour.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  codeBoxFilled: { borderColor: colour.primaryBorder },
  codeBoxActive: { borderColor: colour.primary },
  codeBoxError: { borderColor: colour.accent, backgroundColor: colour.accentSoft },
  codeDigit: {
    fontSize: 26,
    color: colour.text,
    fontFamily: font.mono,
    fontWeight: font.weight.bold,
  },
  hiddenInput: {
    position: 'absolute',
    opacity: 0,
    height: 1,
    width: 1,
    top: 0,
    left: 0,
  },

  resend: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: colour.border,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    minHeight: 50,
    backgroundColor: colour.surface,
  },
  resendReady: { borderColor: colour.primaryBorder },
  resendLabel: { fontSize: font.size.md, color: colour.textMuted, fontFamily: font.family },
  resendLabelReady: { color: colour.text },
  resendNow: {
    fontSize: font.size.sm,
    color: colour.primary,
    fontWeight: font.weight.semibold,
    fontFamily: font.family,
  },

  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderWidth: 1,
    borderColor: colour.border,
    borderRadius: radius.md,
    backgroundColor: colour.surface,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: 50,
  },
  checkGlyph: { fontSize: 17, fontWeight: font.weight.bold, width: 18, textAlign: 'center' },
  checkText: {
    flex: 1,
    fontSize: font.size.md,
    color: colour.text,
    fontFamily: font.family,
    lineHeight: 19,
  },

  confirm: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderWidth: 1,
    borderColor: colour.border,
    borderRadius: radius.md,
    backgroundColor: colour.surface,
    padding: space.lg,
  },
  confirmFlagged: { borderColor: colour.warning, backgroundColor: colour.warningSoft },
  confirmLabel: {
    fontSize: font.size.xs,
    color: colour.textMuted,
    fontFamily: font.mono,
    textTransform: 'uppercase',
    letterSpacing: font.tracking.label,
  },
  confirmValue: {
    fontSize: font.size.lg,
    color: colour.text,
    fontWeight: font.weight.bold,
    fontFamily: font.family,
  },
  flagButton: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colour.borderStrong,
  },
  flagButtonText: {
    fontSize: font.size.sm,
    color: colour.textMuted,
    fontFamily: font.family,
    fontWeight: font.weight.medium,
  },
  flaggedPill: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: colour.warning,
  },
  flaggedPillText: {
    fontSize: font.size.sm,
    color: colour.bg,
    fontWeight: font.weight.bold,
    fontFamily: font.family,
  },
})
