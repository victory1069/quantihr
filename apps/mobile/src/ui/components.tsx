/**
 * Shared UI primitives.
 *
 * Every screen composes these rather than inventing its own padding — that is
 * most of what makes ten screens look like one product. Spacing here is
 * deliberately loose: `space.lg` between blocks, `space.md` within one.
 *
 * Motion is limited to opacity and transform so it can all run on the native
 * driver. Anything animating layout would jank the moment the outbox drains.
 */

import { useEffect, useRef, type ReactNode } from 'react'
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { colour, elevation, font, MAX_CONTENT_WIDTH, motion, radius, space } from './theme'

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

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
      showsVerticalScrollIndicator={false}
    >
      {inner}
    </ScrollView>
  )
}

/** Fades and lifts content in on mount, staggered by `index`. */
export function Appear({
  children,
  index = 0,
  style,
}: {
  children: ReactNode
  index?: number
  style?: StyleProp<ViewStyle>
}) {
  const progress = useRef(new Animated.Value(0)).current

  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: motion.base,
      // Capped so a long list does not take a second to finish arriving.
      delay: Math.min(index * 45, 270),
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start()
  }, [progress, index])

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [
            { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  )
}

export function Card({
  children,
  style,
  onPress,
  tone = 'default',
}: {
  children: ReactNode
  style?: StyleProp<ViewStyle>
  onPress?: () => void
  tone?: 'default' | 'primary' | 'warning' | 'danger'
}) {
  const scale = useRef(new Animated.Value(1)).current

  const spring = (to: number) =>
    Animated.spring(scale, {
      toValue: to,
      useNativeDriver: true,
      speed: 40,
      bounciness: 0,
    }).start()

  const body = <View style={[styles.card, cardTone[tone], style]}>{children}</View>

  if (!onPress) return body

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => spring(0.985)}
      onPressOut={() => spring(1)}
      accessibilityRole="button"
    >
      <Animated.View style={{ transform: [{ scale }] }}>{body}</Animated.View>
    </Pressable>
  )
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={styles.sectionTitle}>{children}</Text>
      {action}
    </View>
  )
}

export function PageTitle({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <View style={styles.pageTitleWrap}>
      <Text style={styles.pageTitle}>{children}</Text>
      {sub ? <Text style={styles.pageSub}>{sub}</Text> : null}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

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
  const scale = useRef(new Animated.Value(1)).current

  const spring = (to: number) =>
    Animated.spring(scale, { toValue: to, useNativeDriver: true, speed: 40, bounciness: 0 }).start()

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      onPress={onPress}
      disabled={isDisabled}
      onPressIn={() => spring(0.97)}
      onPressOut={() => spring(1)}
      style={style}
    >
      <Animated.View
        style={[
          styles.button,
          buttonVariant[variant],
          isDisabled && styles.buttonDisabled,
          variant === 'primary' && !isDisabled && elevation.glow,
          { transform: [{ scale }] },
        ]}
      >
        {loading ? (
          <ActivityIndicator
            color={variant === 'primary' ? colour.primaryText : colour.primary}
          />
        ) : (
          <Text style={[styles.buttonLabel, buttonLabelVariant[variant]]}>{label}</Text>
        )}
      </Animated.View>
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

/** Inline, never a blocking modal — these need reading and acting on. */
export function ErrorNotice({
  message,
  tone = 'danger',
  action,
}: {
  message: string
  tone?: 'danger' | 'warning' | 'info' | 'success'
  action?: ReactNode
}) {
  return (
    <View style={[styles.notice, noticeTone[tone]]}>
      <View style={[styles.noticeBar, { backgroundColor: noticeAccent[tone] }]} />
      <View style={styles.noticeBody}>
        <Text style={[styles.noticeText, { color: noticeAccent[tone] }]}>{message}</Text>
        {action}
      </View>
    </View>
  )
}

/** Shimmering placeholder. Content-shaped, so layout does not jump on load. */
export function Skeleton({
  height = 16,
  width = '100%',
  style,
}: {
  height?: number
  width?: number | string
  style?: StyleProp<ViewStyle>
}) {
  const shimmer = useRef(new Animated.Value(0)).current

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, {
          toValue: 1,
          duration: 800,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(shimmer, {
          toValue: 0,
          duration: 800,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [shimmer])

  return (
    <Animated.View
      style={[
        styles.skeleton,
        { height, width: width as number },
        { opacity: shimmer.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.75] }) },
        style,
      ]}
    />
  )
}

export function Divider() {
  return <View style={styles.divider} />
}

// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colour.bg },
  scrollContent: { paddingHorizontal: space.lg, paddingBottom: space.xxxl },
  column: {
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    gap: space.lg,
  },

  card: {
    backgroundColor: colour.surface,
    borderRadius: radius.lg,
    padding: space.lg,
    borderWidth: 1,
    borderColor: colour.border,
    gap: space.md,
    ...elevation.card,
  },

  pageTitleWrap: { paddingTop: space.md, gap: space.xs },
  pageTitle: {
    fontSize: font.size.xxl,
    fontWeight: font.weight.bold,
    color: colour.text,
    letterSpacing: font.tracking.tight,
    fontFamily: font.family,
  },
  pageSub: {
    fontSize: font.size.md,
    color: colour.textMuted,
    lineHeight: 22,
    fontFamily: font.family,
  },

  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.sm,
  },
  sectionTitle: {
    fontSize: font.size.xs,
    fontWeight: font.weight.semibold,
    color: colour.textFaint,
    textTransform: 'uppercase',
    letterSpacing: font.tracking.wide,
    fontFamily: font.family,
  },

  button: {
    minHeight: 52,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  buttonDisabled: { opacity: 0.4 },
  buttonLabel: {
    fontSize: font.size.md,
    fontWeight: font.weight.semibold,
    fontFamily: font.family,
    letterSpacing: font.tracking.snug,
  },

  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
    borderWidth: 1,
  },
  badgeDot: { width: 7, height: 7, borderRadius: 4 },
  badgeLabel: {
    fontSize: font.size.xs,
    fontWeight: font.weight.semibold,
    fontFamily: font.family,
  },

  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space.sm,
    gap: space.md,
  },
  rowLabel: {
    fontSize: font.size.md,
    color: colour.textMuted,
    flexShrink: 1,
    fontFamily: font.family,
  },
  rowValue: {
    fontSize: font.size.md,
    color: colour.text,
    fontWeight: font.weight.medium,
    textAlign: 'right',
    flexShrink: 1,
    fontFamily: font.family,
  },
  rowValueMuted: { color: colour.textMuted, fontWeight: font.weight.regular },

  empty: { alignItems: 'center', paddingVertical: space.xl, gap: space.sm },
  emptyTitle: {
    fontSize: font.size.lg,
    fontWeight: font.weight.semibold,
    color: colour.text,
    fontFamily: font.family,
    letterSpacing: font.tracking.snug,
  },
  emptyBody: {
    fontSize: font.size.md,
    color: colour.textMuted,
    textAlign: 'center',
    lineHeight: 22,
    fontFamily: font.family,
  },
  emptyAction: { marginTop: space.sm, alignSelf: 'stretch' },

  notice: {
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  noticeBar: { width: 3 },
  noticeBody: { flex: 1, padding: space.md, gap: space.sm },
  noticeText: { fontSize: font.size.md, lineHeight: 22, fontFamily: font.family },

  skeleton: { backgroundColor: colour.surfaceRaised, borderRadius: radius.sm },
  divider: { height: 1, backgroundColor: colour.border },
})

const cardTone: Record<string, ViewStyle> = {
  default: {},
  primary: { backgroundColor: colour.primarySoft, borderColor: colour.primaryBorder },
  warning: { backgroundColor: colour.warningSoft, borderColor: 'rgba(255,176,32,0.3)' },
  danger: { backgroundColor: colour.dangerSoft, borderColor: 'rgba(255,61,138,0.3)' },
}

const buttonVariant: Record<string, ViewStyle> = {
  primary: { backgroundColor: colour.primary },
  secondary: { backgroundColor: colour.primarySoft, borderColor: colour.primaryBorder },
  danger: { backgroundColor: colour.dangerSoft, borderColor: 'rgba(255,61,138,0.4)' },
  ghost: { backgroundColor: 'transparent' },
}

const buttonLabelVariant: Record<string, { color: string }> = {
  primary: { color: colour.primaryText },
  secondary: { color: colour.primary },
  danger: { color: colour.danger },
  ghost: { color: colour.textMuted },
}

const badgeTone: Record<string, ViewStyle> = {
  neutral: { backgroundColor: colour.surfaceRaised, borderColor: colour.border },
  success: { backgroundColor: colour.successSoft, borderColor: 'rgba(61,220,151,0.3)' },
  warning: { backgroundColor: colour.warningSoft, borderColor: 'rgba(255,176,32,0.3)' },
  danger: { backgroundColor: colour.dangerSoft, borderColor: 'rgba(255,61,138,0.3)' },
  info: { backgroundColor: colour.infoSoft, borderColor: colour.primaryBorder },
  pending: { backgroundColor: colour.pendingSoft, borderColor: 'rgba(123,92,255,0.3)' },
}

const badgeLabelTone: Record<string, { color: string }> = {
  neutral: { color: colour.textMuted },
  success: { color: colour.success },
  warning: { color: colour.warning },
  danger: { color: colour.danger },
  info: { color: colour.primary },
  pending: { color: colour.pending },
}

const noticeTone: Record<string, ViewStyle> = {
  danger: { backgroundColor: colour.dangerSoft, borderColor: 'rgba(255,61,138,0.28)' },
  warning: { backgroundColor: colour.warningSoft, borderColor: 'rgba(255,176,32,0.28)' },
  info: { backgroundColor: colour.infoSoft, borderColor: colour.primaryBorder },
  success: { backgroundColor: colour.successSoft, borderColor: 'rgba(61,220,151,0.28)' },
}

const noticeAccent: Record<string, string> = {
  danger: colour.danger,
  warning: colour.warning,
  info: colour.primary,
  success: colour.success,
}
