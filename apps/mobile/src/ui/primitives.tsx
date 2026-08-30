/**
 * Design-system pieces that repeat across the mockups.
 *
 * These exist so a screen never hand-rolls a stat tile or an uppercase label
 * and drifts by two pixels from the one next to it. Anything appearing on more
 * than two screens belongs here.
 */

import type { ReactNode } from 'react'
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native'
import { colour, font, radius, space } from './theme'

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
  return (
    <Text style={[styles.figure, figureSize[size], { color: figureTone[tone] }, style]}>
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
  return <Text style={[styles.label, { color: labelTone[tone] }, style]}>{children}</Text>
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
  return (
    <View style={[styles.stat, style]}>
      <Text style={styles.statLabel}>{label}</Text>
      <Figure size="xl" tone={tone === 'default' ? 'default' : tone}>
        {value}
      </Figure>
      {caption ? <Text style={styles.statCaption}>{caption}</Text> : null}
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
  return (
    <View style={[styles.dataRow, !last && styles.dataRowDivider]}>
      <Text style={styles.dataLabel}>{label}</Text>
      {typeof value === 'string' && mono ? (
        <Figure size="sm" tone={tone}>
          {value}
        </Figure>
      ) : typeof value === 'string' ? (
        <Text style={[styles.dataValue, { color: figureTone[tone] }]}>{value}</Text>
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
  const Wrapper = onPress ? PressableChip : StaticChip
  return <Wrapper label={label} selected={selected} onPress={onPress} tone={tone} />
}

function StaticChip({ label, selected, tone }: { label: string; selected?: boolean; tone: string }) {
  return (
    <View style={[styles.chip, selected && chipSelected[tone]]}>
      <Text style={[styles.chipLabel, selected && chipLabelSelected[tone]]}>{label}</Text>
    </View>
  )
}

function PressableChip({
  label,
  selected,
  onPress,
  tone,
}: {
  label: string
  selected?: boolean
  onPress?: () => void
  tone: string
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      style={({ pressed }) => [
        styles.chip,
        selected && chipSelected[tone],
        pressed && { opacity: 0.7 },
      ]}
    >
      <Text style={[styles.chipLabel, selected && chipLabelSelected[tone]]}>{label}</Text>
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
          backgroundColor: tint ?? colour.surfaceRaised,
        },
      ]}
    >
      <Text
        style={[
          styles.avatarText,
          { fontSize: size * 0.34, color: tint ? colour.bg : colour.text },
        ]}
      >
        {initials}
      </Text>
    </View>
  )
}

/** Thin progress track — leave balance, goal progress. */
export function Meter({
  value,
  max,
  tone = 'primary',
}: {
  value: number
  max: number
  tone?: 'primary' | 'success' | 'warning'
}) {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(1, value / max))
  return (
    <View
      style={styles.meterTrack}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max, now: value }}
    >
      <View
        style={[
          styles.meterFill,
          { width: `${pct * 100}%`, backgroundColor: meterTone[tone] },
        ]}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  figure: {
    fontFamily: font.mono,
    fontVariant: ['tabular-nums'],
  },

  label: {
    fontSize: font.size.xs,
    fontFamily: font.mono,
    textTransform: 'uppercase',
    letterSpacing: font.tracking.label,
  },

  stat: {
    flex: 1,
    backgroundColor: colour.surface,
    borderWidth: 1,
    borderColor: colour.border,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.xs,
  },
  statLabel: {
    fontSize: font.size.md,
    color: colour.textMuted,
    fontFamily: font.family,
  },
  statCaption: {
    fontSize: font.size.sm,
    color: colour.textFaint,
    fontFamily: font.family,
  },
  statRow: { flexDirection: 'row', gap: space.md },

  dataRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingVertical: space.md,
  },
  dataRowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colour.border,
  },
  dataLabel: {
    fontSize: font.size.md,
    color: colour.textMuted,
    fontFamily: font.family,
    flexShrink: 1,
  },
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
    borderColor: colour.borderStrong,
    backgroundColor: 'transparent',
    minHeight: 40,
    justifyContent: 'center',
  },
  chipLabel: {
    fontSize: font.size.md,
    color: colour.text,
    fontFamily: font.family,
    textAlign: 'center',
  },

  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontWeight: font.weight.bold, fontFamily: font.family },

  meterTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colour.surfaceRaised,
    overflow: 'hidden',
  },
  meterFill: { height: '100%', borderRadius: 3 },
})

const figureSize: Record<string, TextStyle> = {
  sm: { fontSize: font.size.md },
  md: { fontSize: font.size.lg },
  lg: { fontSize: font.size.xl, fontWeight: font.weight.bold },
  xl: { fontSize: font.size.xxl, fontWeight: font.weight.bold },
  display: { fontSize: font.size.display, fontWeight: font.weight.bold },
}

const figureTone: Record<string, string> = {
  default: colour.text,
  muted: colour.textMuted,
  primary: colour.primary,
  success: colour.success,
  warning: colour.warning,
  danger: colour.danger,
}

const labelTone: Record<string, string> = {
  faint: colour.textFaint,
  primary: colour.primary,
  accent: colour.accent,
  violet: colour.pending,
}

const chipSelected: Record<string, ViewStyle> = {
  default: { backgroundColor: colour.primary, borderColor: colour.primary },
  violet: { backgroundColor: colour.pending, borderColor: colour.pending },
}

const chipLabelSelected: Record<string, TextStyle> = {
  default: { color: colour.primaryText, fontWeight: font.weight.semibold },
  violet: { color: colour.text, fontWeight: font.weight.semibold },
}

const meterTone: Record<string, string> = {
  primary: colour.primary,
  success: colour.success,
  warning: colour.warning,
}
