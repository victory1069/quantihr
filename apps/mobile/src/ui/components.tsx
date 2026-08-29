/**
 * Shared UI primitives.
 *
 * Deliberately small: a card, a button, a badge, a screen frame and the empty /
 * error states. Screens compose these rather than each inventing their own
 * padding, which is what keeps a ten-screen app looking like one product.
 */

import type { ReactNode } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { colour, font, MAX_CONTENT_WIDTH, radius, shadow, space } from './theme'

export function Screen({
  children,
  scroll = true,
  refreshControl,
}: {
  children: ReactNode
  scroll?: boolean
  refreshControl?: React.ReactElement
}) {
  const inner = <View style={styles.column}>{children}</View>
  if (!scroll) return <View style={styles.screen}>{inner}</View>
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.scrollContent}
      refreshControl={refreshControl}
      keyboardShouldPersistTaps="handled"
    >
      {inner}
    </ScrollView>
  )
}

export function Card({
  children,
  style,
  onPress,
}: {
  children: ReactNode
  style?: StyleProp<ViewStyle>
  onPress?: () => void
}) {
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.card, style, pressed && styles.cardPressed]}
      >
        {children}
      </Pressable>
    )
  }
  return <View style={[styles.card, style]}>{children}</View>
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={styles.sectionTitle}>{children}</Text>
      {action}
    </View>
  )
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
}: {
  label: string
  onPress: () => void
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  disabled?: boolean
  loading?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const isDisabled = disabled || loading
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        buttonVariant[variant],
        isDisabled && styles.buttonDisabled,
        pressed && !isDisabled && styles.buttonPressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'secondary' || variant === 'ghost' ? colour.primary : '#fff'} />
      ) : (
        <Text style={[styles.buttonLabel, buttonLabelVariant[variant]]}>{label}</Text>
      )}
    </Pressable>
  )
}

export function Badge({
  label,
  tone = 'neutral',
  dot,
}: {
  label: string
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'pending'
  dot?: string
}) {
  return (
    <View style={[styles.badge, badgeTone[tone]]}>
      {dot ? <View style={[styles.badgeDot, { backgroundColor: dot }]} /> : null}
      <Text style={[styles.badgeLabel, badgeLabelTone[tone]]}>{label}</Text>
    </View>
  )
}

export function Row({
  label,
  value,
  muted,
}: {
  label: string
  value: ReactNode
  muted?: boolean
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {typeof value === 'string' ? (
        <Text style={[styles.rowValue, muted && styles.rowValueMuted]}>{value}</Text>
      ) : (
        value
      )}
    </View>
  )
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string
  body?: string
  action?: ReactNode
}) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {body ? <Text style={styles.emptyBody}>{body}</Text> : null}
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  )
}

/**
 * Inline error, never a blocking modal.
 *
 * Failures here are things like "you are 300m from the office" — the employee
 * needs to read it and act, not dismiss it.
 */
export function ErrorNotice({
  message,
  tone = 'danger',
  action,
}: {
  message: string
  tone?: 'danger' | 'warning' | 'info'
  action?: ReactNode
}) {
  return (
    <View style={[styles.notice, noticeTone[tone]]}>
      <Text style={[styles.noticeText, noticeTextTone[tone]]}>{message}</Text>
      {action}
    </View>
  )
}

export function Skeleton({ height = 16, width = '100%' }: { height?: number; width?: number | string }) {
  return <View style={[styles.skeleton, { height, width: width as number }]} />
}

export function Divider() {
  return <View style={styles.divider} />
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colour.bg },
  scrollContent: { padding: space.lg, paddingBottom: space.xxl * 2 },
  column: { width: '100%', maxWidth: MAX_CONTENT_WIDTH, alignSelf: 'center', gap: space.md },

  card: {
    backgroundColor: colour.surface,
    borderRadius: radius.lg,
    padding: space.lg,
    borderWidth: 1,
    borderColor: colour.border,
    gap: space.sm,
    ...shadow,
  },
  cardPressed: { backgroundColor: colour.surfaceAlt },

  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.sm,
  },
  sectionTitle: {
    fontSize: font.size.sm,
    fontWeight: font.weight.semibold,
    color: colour.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },

  button: {
    minHeight: 48,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    flexDirection: 'row',
  },
  buttonPressed: { opacity: 0.85 },
  buttonDisabled: { opacity: 0.45 },
  buttonLabel: { fontSize: font.size.md, fontWeight: font.weight.semibold },

  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  badgeDot: { width: 8, height: 8, borderRadius: 4 },
  badgeLabel: { fontSize: font.size.xs, fontWeight: font.weight.semibold },

  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space.sm,
    gap: space.md,
  },
  rowLabel: { fontSize: font.size.md, color: colour.textMuted, flexShrink: 1 },
  rowValue: {
    fontSize: font.size.md,
    color: colour.text,
    fontWeight: font.weight.medium,
    textAlign: 'right',
    flexShrink: 1,
  },
  rowValueMuted: { color: colour.textMuted, fontWeight: font.weight.regular },

  empty: { alignItems: 'center', padding: space.xl, gap: space.sm },
  emptyTitle: { fontSize: font.size.lg, fontWeight: font.weight.semibold, color: colour.text },
  emptyBody: { fontSize: font.size.md, color: colour.textMuted, textAlign: 'center' },
  emptyAction: { marginTop: space.sm },

  notice: { borderRadius: radius.md, padding: space.md, gap: space.sm, borderWidth: 1 },
  noticeText: { fontSize: font.size.md, lineHeight: 21 },

  skeleton: { backgroundColor: colour.surfaceAlt, borderRadius: radius.sm },
  divider: { height: 1, backgroundColor: colour.border, marginVertical: space.sm },
})

const buttonVariant: Record<string, ViewStyle> = {
  primary: { backgroundColor: colour.primary },
  secondary: { backgroundColor: colour.primarySoft, borderWidth: 1, borderColor: colour.primary },
  danger: { backgroundColor: colour.danger },
  ghost: { backgroundColor: 'transparent' },
}

const buttonLabelVariant: Record<string, { color: string }> = {
  primary: { color: colour.textInverse },
  secondary: { color: colour.primary },
  danger: { color: colour.textInverse },
  ghost: { color: colour.primary },
}

const badgeTone: Record<string, ViewStyle> = {
  neutral: { backgroundColor: colour.surfaceAlt },
  success: { backgroundColor: colour.successSoft },
  warning: { backgroundColor: colour.warningSoft },
  danger: { backgroundColor: colour.dangerSoft },
  info: { backgroundColor: colour.infoSoft },
  pending: { backgroundColor: '#F5F3FF' },
}

const badgeLabelTone: Record<string, { color: string }> = {
  neutral: { color: colour.textMuted },
  success: { color: colour.success },
  warning: { color: colour.warning },
  danger: { color: colour.danger },
  info: { color: colour.info },
  pending: { color: colour.pending },
}

const noticeTone: Record<string, ViewStyle> = {
  danger: { backgroundColor: colour.dangerSoft, borderColor: '#FECACA' },
  warning: { backgroundColor: colour.warningSoft, borderColor: '#FDE68A' },
  info: { backgroundColor: colour.infoSoft, borderColor: '#BAE6FD' },
}

const noticeTextTone: Record<string, { color: string }> = {
  danger: { color: colour.danger },
  warning: { color: colour.warning },
  info: { color: colour.info },
}
