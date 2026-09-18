/**
 * Shared UI primitives.
 *
 * Every screen composes these rather than inventing its own padding — that is
 * most of what makes ten screens look like one product. Spacing here is
 * deliberately loose: `space.lg` between blocks, `space.md` within one.
 *
 * **Colour is resolved at render, layout is not.** `StyleSheet.create` captures
 * its values once at import, so anything that changes with the system
 * appearance has to come from `useColour()` and be applied inline. Layout,
 * radii and type live in the stylesheet where they belong. The split looks
 * fussy in a diff and is what lets the app follow the phone's setting without
 * a restart.
 *
 * Motion is limited to opacity and transform so it can all run on the native
 * driver. Anything animating layout would jank the moment the outbox drains —
 * the one exception is `Counter`, which is explained where it is defined.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
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
  type TextStyle,
  type ViewStyle,
} from 'react-native'
import {
  font,
  MAX_CONTENT_WIDTH,
  motion,
  radius,
  shadow,
  space,
  useColour,
  useScheme,
  type Palette,
} from './theme'

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

export function Screen({
  children,
  scroll = true,
  refreshControl,
  floating,
}: {
  children: ReactNode
  scroll?: boolean
  refreshControl?: React.ReactElement
  /**
   * Pinned above the content, outside the scroll. A floating action inside a
   * ScrollView scrolls away with the page, which defeats the point of it.
   */
  floating?: ReactNode
}) {
  const c = useColour()
  const inner = <View style={styles.column}>{children}</View>

  const body = !scroll ? (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>{inner}</View>
  ) : (
    <ScrollView
      style={[styles.screen, { backgroundColor: c.bg }]}
      contentContainerStyle={[
        styles.scrollContent,
        // Room for the action to sit over the end of the list rather than on
        // top of the last row.
        floating ? { paddingBottom: 112 + 72 } : null,
      ]}
      refreshControl={refreshControl}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {inner}
    </ScrollView>
  )

  if (!floating) return body

  return (
    <View style={styles.screen}>
      {body}
      <View style={styles.floating} pointerEvents="box-none">
        {floating}
      </View>
    </View>
  )
}

/**
 * A page whose content rises in a sheet over its own title.
 *
 * The title sits dimmed at the top — it is context, not content — and the
 * sheet carries everything the person came for. On mount the sheet springs up
 * from below while the title fades in above it, so a screen arrives as one
 * gesture rather than assembling itself. That is what "fluid" means here: the
 * motion describes the structure (this is a layer over that) instead of
 * decorating it.
 *
 * Transform and opacity only, so it runs on the native driver.
 */
export function SheetPage({
  title,
  eyebrow,
  tone = 'default',
  children,
  refreshControl,
  floating,
}: {
  title: string
  /** Small line above the title — a date, a mode, a section. */
  eyebrow?: string
  /** `manager` tints the head violet, as the mockups do for manager mode. */
  tone?: 'default' | 'manager'
  children: ReactNode
  refreshControl?: React.ReactElement
  floating?: ReactNode
}) {
  const c = useColour()
  const rise = useRef(new Animated.Value(0)).current

  useEffect(() => {
    Animated.spring(rise, { toValue: 1, useNativeDriver: true, ...motion.enter }).start()
  }, [rise])

  const headTint = tone === 'manager' ? c.accentSoft : 'transparent'

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <Animated.View
        style={[
          styles.sheetHead,
          { backgroundColor: headTint },
          { opacity: rise.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }) },
        ]}
      >
        {eyebrow ? (
          <Text style={[styles.sheetEyebrow, { color: tone === 'manager' ? c.accent : c.textMuted }]}>
            {eyebrow}
          </Text>
        ) : null}
        <Text style={[styles.sheetTitle, { color: c.textFaint }]} numberOfLines={2}>
          {title}
        </Text>
      </Animated.View>

      <Animated.View
        style={[
          styles.sheet,
          { backgroundColor: c.surface, borderColor: c.border },
          {
            transform: [
              { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [48, 0] }) },
            ],
          },
        ]}
      >
        <View style={[styles.sheetHandle, { backgroundColor: c.borderStrong }]} />
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { paddingTop: space.sm },
            floating ? { paddingBottom: 112 + 72 } : null,
          ]}
          refreshControl={refreshControl}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.column}>{children}</View>
        </ScrollView>
      </Animated.View>

      {floating ? (
        <View style={styles.floating} pointerEvents="box-none">
          {floating}
        </View>
      ) : null}
    </View>
  )
}

/**
 * The primary create action on a list screen.
 *
 * A circle with a plus rather than a labelled bar, because it sits over content
 * and a bar wide enough to read would cover the last row it is meant to sit
 * beside. The accessible name carries what the glyph cannot.
 */
export function Fab({
  onPress,
  label,
  icon = '+',
}: {
  onPress: () => void
  label: string
  icon?: string
}) {
  const c = useColour()
  const scheme = useScheme()

  return (
    <Press onPress={onPress} accessibilityLabel={label} scaleTo={0.92}>
      <View
        style={[styles.fab, { backgroundColor: c.primary }, shadow(scheme).lifted]}
      >
        <Text style={[styles.fabIcon, { color: c.primaryText }]}>{icon}</Text>
      </View>
    </Press>
  )
}

/**
 * Fades and lifts content in on mount, staggered by `index`.
 *
 * The stagger is capped rather than linear: past `motion.staggerCap` items
 * everything remaining enters together, because a cascade that runs longer than
 * about a third of a second means the last card lands after the reader has
 * already moved past it.
 */
export function Appear({
  children,
  index = 0,
  from = 'below',
  style,
}: {
  children: ReactNode
  index?: number
  /** Direction the content travels from. `scale` suits a single hero element. */
  from?: 'below' | 'side' | 'scale'
  style?: StyleProp<ViewStyle>
}) {
  const progress = useRef(new Animated.Value(0)).current

  useEffect(() => {
    const delay = Math.min(index, motion.staggerCap) * motion.stagger
    const timer = setTimeout(() => {
      Animated.spring(progress, {
        toValue: 1,
        useNativeDriver: true,
        ...motion.enter,
      }).start()
    }, delay)
    return () => clearTimeout(timer)
  }, [progress, index])

  const transform =
    from === 'scale'
      ? [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }]
      : from === 'side'
        ? [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) }]
        : [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }]

  return (
    <Animated.View style={[style, { opacity: progress, transform }]}>{children}</Animated.View>
  )
}

/**
 * Spring press feedback around arbitrary content.
 *
 * Extracted so a tappable row does not have to reimplement the scale each time,
 * and so the whole app depresses by the same amount.
 */
export function Press({
  children,
  onPress,
  scaleTo = 0.97,
  disabled,
  style,
  accessibilityLabel,
  accessibilityHint,
}: {
  children: ReactNode
  onPress: () => void
  scaleTo?: number
  disabled?: boolean
  style?: StyleProp<ViewStyle>
  accessibilityLabel?: string
  accessibilityHint?: string
}) {
  const scale = useRef(new Animated.Value(1)).current

  const spring = (to: number) =>
    Animated.spring(scale, { toValue: to, useNativeDriver: true, ...motion.press }).start()

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      onPressIn={() => spring(scaleTo)}
      onPressOut={() => spring(1)}
      style={style}
    >
      <Animated.View style={{ transform: [{ scale }] }}>{children}</Animated.View>
    </Pressable>
  )
}

/**
 * A figure that counts up to its value.
 *
 * The one animation in the kit that cannot use the native driver: there is no
 * way to interpolate a driven value into formatted text, so this listens on the
 * JS thread and re-renders. That is affordable because it runs for a third of a
 * second on mount and then stops — but it is why this is a deliberate component
 * rather than something to sprinkle on every number.
 *
 * It settles rather than bounces. A balance that overshoots and comes back has
 * shown the employee a figure that was never true.
 */
export function Counter({
  value,
  format = (n) => String(Math.round(n)),
  style,
  duration = motion.slow,
}: {
  value: number
  format?: (n: number) => string
  style?: StyleProp<TextStyle>
  duration?: number
}) {
  const driver = useRef(new Animated.Value(0)).current
  const [shown, setShown] = useState(0)
  const target = useRef(value)
  target.current = value

  useEffect(() => {
    const id = driver.addListener(({ value: t }) => setShown(t * target.current))
    driver.setValue(0)
    Animated.timing(driver, {
      toValue: 1,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start()
    return () => driver.removeListener(id)
  }, [driver, value, duration])

  return <Text style={style}>{format(shown)}</Text>
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
  tone?: 'default' | 'primary' | 'warning' | 'danger' | 'success' | 'pending'
}) {
  const c = useColour()
  const scheme = useScheme()

  const body = (
    <View
      style={[
        styles.card,
        { backgroundColor: c.surface, borderColor: c.border },
        shadow(scheme).card,
        cardTone(c)[tone],
        style,
      ]}
    >
      {children}
    </View>
  )

  if (!onPress) return body

  return (
    <Press onPress={onPress} scaleTo={0.985}>
      {body}
    </Press>
  )
}

/**
 * Sub-navigation within a screen.
 *
 * Segments are equal width, so the indicator's position is just the index over
 * the count — no per-label measurement, and the control does not reflow when a
 * label changes length. The container's width is measured once on layout
 * because `translateX` cannot take a percentage.
 *
 * The indicator slides rather than jumping. On a tab strip that is the whole
 * point: the movement is what tells you the two panels are siblings and which
 * direction you just travelled.
 */
export function SegmentedTabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  const c = useColour()
  const [width, setWidth] = useState(0)
  const slide = useRef(new Animated.Value(0)).current
  const index = Math.max(0, options.findIndex((o) => o.value === value))

  useEffect(() => {
    Animated.spring(slide, {
      toValue: index,
      useNativeDriver: true,
      ...motion.enter,
    }).start()
  }, [slide, index])

  const segment = width > 0 ? width / options.length : 0

  return (
    <View
      style={[styles.segments, { backgroundColor: c.surfaceSunken, borderColor: c.border }]}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      accessibilityRole="tablist"
    >
      {segment > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.segmentIndicator,
            {
              width: segment - 4,
              backgroundColor: c.surface,
              borderColor: c.border,
              transform: [
                {
                  translateX: slide.interpolate({
                    inputRange: options.map((_, i) => i),
                    outputRange: options.map((_, i) => i * segment + 2),
                  }),
                },
              ],
            },
          ]}
        />
      ) : null}

      {options.map((option) => {
        const selected = option.value === value
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={styles.segment}
          >
            <Text
              numberOfLines={1}
              style={[
                styles.segmentLabel,
                { color: selected ? c.text : c.textMuted },
                selected && { fontWeight: font.weight.semibold },
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  const c = useColour()
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={[styles.sectionTitle, { color: c.textFaint }]}>{children}</Text>
      {action}
    </View>
  )
}

export function PageTitle({ children, sub }: { children: ReactNode; sub?: string }) {
  const c = useColour()
  return (
    <View style={styles.pageTitleWrap}>
      <Text style={[styles.pageTitle, { color: c.text }]}>{children}</Text>
      {sub ? <Text style={[styles.pageSub, { color: c.textMuted }]}>{sub}</Text> : null}
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
  const c = useColour()
  const scheme = useScheme()
  const isDisabled = disabled || loading
  const scale = useRef(new Animated.Value(1)).current

  const spring = (to: number) =>
    Animated.spring(scale, { toValue: to, useNativeDriver: true, ...motion.press }).start()

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
          buttonVariant(c)[variant],
          // Disabled is an explicit neutral fill, not a tint of the live
          // colour. The old system dropped to 40% opacity, which read clearly
          // as "off" against a near-black ground — on warm white the same
          // treatment just looks like a paler, still-tappable button.
          isDisabled && { backgroundColor: c.surfaceSunken, borderColor: c.border },
          // A real shadow now the ground is light. The old system glowed
          // because a near-black ground swallows a conventional shadow.
          variant === 'primary' && !isDisabled && shadow(scheme).card,
          { transform: [{ scale }] },
        ]}
      >
        {loading ? (
          <ActivityIndicator color={variant === 'primary' ? c.primaryText : c.primary} />
        ) : (
          <Text
            style={[
              styles.buttonLabel,
              buttonLabelVariant(c)[variant],
              isDisabled && { color: c.textFaint },
            ]}
          >
            {label}
          </Text>
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
  const c = useColour()
  return (
    <View style={[styles.badge, badgeTone(c)[tone]]}>
      {dot ? <View style={[styles.badgeDot, { backgroundColor: dot }]} /> : null}
      <Text style={[styles.badgeLabel, badgeLabelTone(c)[tone]]}>{label}</Text>
    </View>
  )
}

export function Row({ label, value, muted }: { label: string; value: ReactNode; muted?: boolean }) {
  const c = useColour()
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: c.textMuted }]}>{label}</Text>
      {typeof value === 'string' ? (
        <Text style={[styles.rowValue, { color: muted ? c.textMuted : c.text }]}>{value}</Text>
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
  const c = useColour()
  return (
    <Appear from="scale">
      <View style={styles.empty}>
        <Text style={[styles.emptyTitle, { color: c.text }]}>{title}</Text>
        {body ? <Text style={[styles.emptyBody, { color: c.textMuted }]}>{body}</Text> : null}
        {action ? <View style={styles.emptyAction}>{action}</View> : null}
      </View>
    </Appear>
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
  const c = useColour()
  const accent = noticeAccent(c)[tone]!

  return (
    <Appear from="scale">
      <View style={[styles.notice, noticeTone(c)[tone]]}>
        <View style={[styles.noticeBar, { backgroundColor: accent }]} />
        <View style={styles.noticeBody}>
          <Text style={[styles.noticeText, { color: accent }]}>{message}</Text>
          {action}
        </View>
      </View>
    </Appear>
  )
}

/**
 * Shimmering placeholder. Content-shaped, so layout does not jump on load.
 *
 * A travelling highlight rather than an opacity pulse: on a light ground a
 * pulse is nearly invisible, and the sweep reads unambiguously as "loading"
 * rather than "disabled".
 */
export function Skeleton({
  height = 16,
  width = '100%',
  style,
}: {
  height?: number
  width?: number | string
  style?: StyleProp<ViewStyle>
}) {
  const c = useColour()
  const sweep = useRef(new Animated.Value(0)).current

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(sweep, {
        toValue: 1,
        duration: 1200,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }),
    )
    loop.start()
    return () => loop.stop()
  }, [sweep])

  return (
    <View
      style={[
        styles.skeleton,
        { height, width: width as number, backgroundColor: c.skeleton },
        style,
      ]}
    >
      <Animated.View
        style={[
          styles.skeletonSweep,
          {
            backgroundColor: c.skeletonHighlight,
            transform: [
              { translateX: sweep.interpolate({ inputRange: [0, 1], outputRange: [-160, 320] }) },
              { skewX: '-18deg' },
            ],
          },
        ]}
      />
    </View>
  )
}

export function Divider() {
  const c = useColour()
  return <View style={[styles.divider, { backgroundColor: c.border }]} />
}

// ---------------------------------------------------------------------------
// Layout only — nothing here varies by scheme
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  screen: { flex: 1 },
  sheetHead: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xl,
    gap: space.xs,
  },
  sheetEyebrow: { fontSize: font.size.md, fontFamily: font.family },
  sheetTitle: {
    fontSize: font.size.display,
    fontWeight: font.weight.bold,
    letterSpacing: font.tracking.tight,
    fontFamily: font.family,
    lineHeight: 48,
  },
  sheet: {
    flex: 1,
    borderTopLeftRadius: radius.xl + 8,
    borderTopRightRadius: radius.xl + 8,
    borderWidth: 1,
    borderBottomWidth: 0,
    overflow: 'hidden',
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 44,
    height: 4,
    borderRadius: 2,
    marginTop: space.md,
    marginBottom: space.xs,
  },
  floating: {
    position: 'absolute',
    right: space.lg,
    bottom: space.lg,
    alignItems: 'flex-end',
    gap: space.sm,
  },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabIcon: { fontSize: 30, lineHeight: 34, fontWeight: font.weight.regular },
  // Clears the floating tab bar (52 + padding + inset) with room to spare.
  scrollContent: { paddingHorizontal: space.lg, paddingBottom: 112 },
  column: {
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    gap: space.lg,
  },

  card: {
    borderRadius: radius.lg,
    padding: space.lg,
    borderWidth: 1,
    gap: space.md,
  },

  pageTitleWrap: { paddingTop: space.md, gap: space.xs },
  pageTitle: {
    fontSize: font.size.xxl,
    fontWeight: font.weight.bold,
    letterSpacing: font.tracking.tight,
    fontFamily: font.family,
  },
  pageSub: { fontSize: font.size.md, lineHeight: 22, fontFamily: font.family },

  segments: {
    flexDirection: 'row',
    borderRadius: radius.md,
    borderWidth: 1,
    padding: 2,
    minHeight: 44,
  },
  segmentIndicator: {
    position: 'absolute',
    top: 2,
    bottom: 2,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  segment: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.sm },
  segmentLabel: { fontSize: font.size.sm, fontFamily: font.family },

  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.sm,
  },
  sectionTitle: {
    fontSize: font.size.xs,
    fontWeight: font.weight.semibold,
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
  badgeLabel: { fontSize: font.size.xs, fontWeight: font.weight.semibold, fontFamily: font.family },

  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space.sm,
    gap: space.md,
  },
  rowLabel: { fontSize: font.size.md, flexShrink: 1, fontFamily: font.family },
  rowValue: {
    fontSize: font.size.md,
    fontWeight: font.weight.medium,
    textAlign: 'right',
    flexShrink: 1,
    fontFamily: font.family,
  },

  empty: { alignItems: 'center', paddingVertical: space.xl, gap: space.sm },
  emptyTitle: {
    fontSize: font.size.lg,
    fontWeight: font.weight.semibold,
    fontFamily: font.family,
    letterSpacing: font.tracking.snug,
  },
  emptyBody: {
    fontSize: font.size.md,
    textAlign: 'center',
    lineHeight: 22,
    fontFamily: font.family,
  },
  emptyAction: { marginTop: space.sm, alignSelf: 'stretch' },

  notice: { borderRadius: radius.md, borderWidth: 1, flexDirection: 'row', overflow: 'hidden' },
  noticeBar: { width: 3 },
  noticeBody: { flex: 1, padding: space.md, gap: space.sm },
  noticeText: { fontSize: font.size.md, lineHeight: 22, fontFamily: font.family },

  skeleton: { borderRadius: radius.sm, overflow: 'hidden' },
  skeletonSweep: { position: 'absolute', top: 0, bottom: 0, width: 90, opacity: 0.9 },

  divider: { height: 1 },
})

// ---------------------------------------------------------------------------
// Tone maps — functions of the palette so they follow the scheme
// ---------------------------------------------------------------------------

const cardTone = (c: Palette): Record<string, ViewStyle> => ({
  default: {},
  primary: { backgroundColor: c.primarySoft, borderColor: c.primaryBorder },
  warning: { backgroundColor: c.warningSoft, borderColor: c.warning },
  danger: { backgroundColor: c.dangerSoft, borderColor: c.danger },
  success: { backgroundColor: c.successSoft, borderColor: c.success },
  // Waiting on someone. Violet, not pink: in this palette pink is absent,
  // overdue and deadline, and a request that is simply pending is none of
  // those.
  pending: { backgroundColor: c.pendingSoft, borderColor: c.pending },
})

const buttonVariant = (c: Palette): Record<string, ViewStyle> => ({
  primary: { backgroundColor: c.primary },
  secondary: { backgroundColor: c.primarySoft, borderColor: c.primaryBorder },
  danger: { backgroundColor: c.dangerSoft, borderColor: c.danger },
  ghost: { backgroundColor: 'transparent' },
})

const buttonLabelVariant = (c: Palette): Record<string, TextStyle> => ({
  primary: { color: c.primaryText },
  secondary: { color: c.primary },
  danger: { color: c.danger },
  ghost: { color: c.textMuted },
})

const badgeTone = (c: Palette): Record<string, ViewStyle> => ({
  neutral: { backgroundColor: c.surfaceSunken, borderColor: c.border },
  success: { backgroundColor: c.successSoft, borderColor: c.successSoft },
  warning: { backgroundColor: c.warningSoft, borderColor: c.warningSoft },
  danger: { backgroundColor: c.dangerSoft, borderColor: c.dangerSoft },
  info: { backgroundColor: c.infoSoft, borderColor: c.primaryBorder },
  pending: { backgroundColor: c.pendingSoft, borderColor: c.pendingSoft },
})

const badgeLabelTone = (c: Palette): Record<string, TextStyle> => ({
  neutral: { color: c.textMuted },
  success: { color: c.success },
  warning: { color: c.warning },
  danger: { color: c.danger },
  info: { color: c.primary },
  pending: { color: c.pending },
})

const noticeTone = (c: Palette): Record<string, ViewStyle> => ({
  danger: { backgroundColor: c.dangerSoft, borderColor: c.dangerSoft },
  warning: { backgroundColor: c.warningSoft, borderColor: c.warningSoft },
  info: { backgroundColor: c.infoSoft, borderColor: c.primaryBorder },
  success: { backgroundColor: c.successSoft, borderColor: c.successSoft },
})

const noticeAccent = (c: Palette): Record<string, string> => ({
  danger: c.danger,
  warning: c.warning,
  info: c.primary,
  success: c.success,
})
