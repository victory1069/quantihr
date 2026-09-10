/**
 * Design-system pieces that repeat across the mockups.
 *
 * These exist so a screen never hand-rolls a stat tile or an uppercase label
 * and drifts by two pixels from the one next to it. Anything appearing on more
 * than two screens belongs here.
 *
 * As in `components.tsx`: layout in the stylesheet, colour resolved at render
 * through `useColour()` so the app follows the system appearance.
 */

import { useEffect, useRef, type ReactNode } from 'react'
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native'
import { font, motion, radius, space, useColour, type Palette } from './theme'

/**
 * A recorded figure. Always mono, so numbers align down a column and read as
 * data rather than prose.
 */
export function Figure({
  children,
  size = 'md',
  tone = 'default',
  style,
}: {
  children: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'display'
  tone?: 'default' | 'muted' | 'primary' | 'success' | 'warning' | 'danger'
  style?: StyleProp<TextStyle>
}) {
  const c = useColour()
  return (
    <Text style={[styles.figure, figureSize[size], { color: figureTone(c)[tone] }, style]}>
      {children}
    </Text>
  )
}

/** Uppercase, letterspaced section label. `RECENT`, `WHAT WAS RECORDED`. */
export function Label({
  children,
  tone = 'faint',
  style,
}: {
  children: ReactNode
  tone?: 'faint' | 'primary' | 'accent' | 'violet'
  style?: StyleProp<TextStyle>
}) {
  const c = useColour()
  return <Text style={[styles.label, { color: labelTone(c)[tone] }, style]}>{children}</Text>
}

/**
 * A stat tile — the paired "Leave left / Pay 25 Sep" blocks on Home.
 *
 * Caption sits under the figure rather than beside it so two tiles stay the
 * same height regardless of how long each caption runs.
 */
export function Stat({
  label,
  value,
  caption,
  tone = 'default',
  style,
}: {
  label: string
  value: ReactNode
  caption?: string
  tone?: 'default' | 'primary' | 'success' | 'warning'
  style?: StyleProp<ViewStyle>
}) {
  const c = useColour()
  return (
    <View
      style={[styles.stat, { backgroundColor: c.surface, borderColor: c.border }, style]}
    >
      <Text style={[styles.statLabel, { color: c.textMuted }]}>{label}</Text>
      <Figure size="xl" tone={tone === 'default' ? 'default' : tone}>
        {value}
      </Figure>
      {caption ? (
        <Text style={[styles.statCaption, { color: c.textFaint }]}>{caption}</Text>
      ) : null}
    </View>
  )
}

/** Two stats side by side, equal width. */
export function StatRow({ children }: { children: ReactNode }) {
  return <View style={styles.statRow}>{children}</View>
}

/**
 * A key/value line inside a "what was recorded" block.
 *
 * The value is mono by default because these blocks are evidence: times,
 * distances, methods, who can see it.
 */
export function DataRow({
  label,
  value,
  tone = 'default',
  mono = true,
  last,
}: {
  label: string
  value: ReactNode
  tone?: 'default' | 'muted' | 'primary' | 'success' | 'warning' | 'danger'
  mono?: boolean
  last?: boolean
}) {
  const c = useColour()
  return (
    <View style={[styles.dataRow, !last && { borderBottomWidth: 1, borderBottomColor: c.border }]}>
      <Text style={[styles.dataLabel, { color: c.textMuted }]}>{label}</Text>
      {typeof value === 'string' && mono ? (
        <Figure size="sm" tone={tone}>
          {value}
        </Figure>
      ) : typeof value === 'string' ? (
        <Text style={[styles.dataValue, { color: figureTone(c)[tone] }]}>{value}</Text>
      ) : (
        value
      )}
    </View>
  )
}

/** Selectable chip — leave types, late reasons, letter requests. */
export function Chip({
  label,
  selected,
  onPress,
  tone = 'default',
}: {
  label: string
  selected?: boolean
  onPress?: () => void
  tone?: 'default' | 'violet'
}) {
  const c = useColour()

  const base: StyleProp<ViewStyle> = [
    styles.chip,
    { borderColor: c.borderStrong },
    selected && chipSelected(c)[tone],
  ]
  const labelStyle: StyleProp<TextStyle> = [
    styles.chipLabel,
    { color: c.text },
    selected && chipLabelSelected(c)[tone],
  ]

  if (!onPress) {
    return (
      <View style={base}>
        <Text style={labelStyle}>{label}</Text>
      </View>
    )
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      style={({ pressed }) => [base, pressed && { opacity: 0.7 }]}
    >
      <Text style={labelStyle}>{label}</Text>
    </Pressable>
  )
}

/** Small circular avatar with initials. */
export function Avatar({
  name,
  size = 36,
  colour: tint,
}: {
  name: string
  size?: number
  colour?: string
}) {
  const c = useColour()
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')

  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: tint ?? c.surfaceSunken,
        },
      ]}
    >
      <Text
        style={[styles.avatarText, { fontSize: size * 0.34, color: tint ? c.textInverse : c.text }]}
      >
        {initials}
      </Text>
    </View>
  )
}

/**
 * Thin progress track — leave balance, goal progress.
 *
 * The fill grows into place on mount. Width cannot run on the native driver, so
 * this is a JS-driven animation; it is affordable because a meter is small,
 * there are rarely more than a handful on screen, and it runs once.
 */
export function Meter({
  value,
  max,
  tone = 'primary',
  animate = true,
}: {
  value: number
  max: number
  tone?: 'primary' | 'success' | 'warning'
  animate?: boolean
}) {
  const c = useColour()
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(1, value / max))
  const grow = useRef(new Animated.Value(animate ? 0 : pct)).current

  useEffect(() => {
    if (!animate) {
      grow.setValue(pct)
      return
    }
    Animated.timing(grow, {
      toValue: pct,
      duration: motion.slow,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
  }, [grow, pct, animate])

  return (
    <View
      style={[styles.meterTrack, { backgroundColor: c.surfaceSunken }]}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max, now: value }}
    >
      <Animated.View
        style={[
          styles.meterFill,
          {
            backgroundColor: meterTone(c)[tone],
            width: grow.interpolate({
              inputRange: [0, 1],
              outputRange: ['0%', '100%'],
            }),
          },
        ]}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  figure: { fontFamily: font.mono, fontVariant: ['tabular-nums'] },

  label: {
    fontSize: font.size.xs,
    fontFamily: font.mono,
    textTransform: 'uppercase',
    letterSpacing: font.tracking.label,
  },

  stat: {
    flex: 1,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.xs,
  },
  statLabel: { fontSize: font.size.md, fontFamily: font.family },
  statCaption: { fontSize: font.size.sm, fontFamily: font.family },
  statRow: { flexDirection: 'row', gap: space.md },

  dataRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingVertical: space.md,
  },
  dataLabel: { fontSize: font.size.md, fontFamily: font.family, flexShrink: 1 },
  dataValue: {
    fontSize: font.size.md,
    fontFamily: font.family,
    fontWeight: font.weight.medium,
    textAlign: 'right',
  },

  chip: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    backgroundColor: 'transparent',
    minHeight: 40,
    justifyContent: 'center',
  },
  chipLabel: { fontSize: font.size.md, fontFamily: font.family, textAlign: 'center' },

  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontWeight: font.weight.bold, fontFamily: font.family },

  meterTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  meterFill: { height: '100%', borderRadius: 3 },
})

const figureSize: Record<string, TextStyle> = {
  sm: { fontSize: font.size.md },
  md: { fontSize: font.size.lg },
  lg: { fontSize: font.size.xl, fontWeight: font.weight.bold },
  xl: { fontSize: font.size.xxl, fontWeight: font.weight.bold },
  display: { fontSize: font.size.display, fontWeight: font.weight.bold },
}

const figureTone = (c: Palette): Record<string, string> => ({
  default: c.text,
  muted: c.textMuted,
  primary: c.primary,
  success: c.success,
  warning: c.warning,
  danger: c.danger,
})

const labelTone = (c: Palette): Record<string, string> => ({
  faint: c.textFaint,
  primary: c.primary,
  accent: c.accent,
  violet: c.pending,
})

const chipSelected = (c: Palette): Record<string, ViewStyle> => ({
  default: { backgroundColor: c.primary, borderColor: c.primary },
  violet: { backgroundColor: c.pending, borderColor: c.pending },
})

const chipLabelSelected = (c: Palette): Record<string, TextStyle> => ({
  default: { color: c.primaryText, fontWeight: font.weight.semibold },
  violet: { color: c.primaryText, fontWeight: font.weight.semibold },
})

const meterTone = (c: Palette): Record<string, string> => ({
  primary: c.primary,
  success: c.success,
  warning: c.warning,
})
