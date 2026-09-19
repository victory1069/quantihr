/**
 * Bottom navigation.
 *
 * Cut from six tabs to four. The two that went:
 *
 *  - **Check in** was never a destination. It is a once-a-day action already
 *    surfaced as the primary button on Home, and a permanent slot for it spent
 *    a sixth of the bar on something most people tap once and never again.
 *  - **Profile** moved to the avatar in the header. Settings live behind your
 *    own face on every app anyone has used; it does not need a tab.
 *
 * Four tabs at 25% width each gives every target ~90pt on a standard phone,
 * comfortably past the 44pt minimum, with room for a real label.
 *
 * Manager mode swaps the tab set in place rather than opening a second app.
 */

import { useEffect, useRef, useState } from 'react'
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter, usePathname } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon, type IconName } from './Icon'
import { colour, font, MAX_CONTENT_WIDTH, radius, space } from './theme'
import { isManager, useSession } from '../store/session'
import { useApprovals } from '../api/queries'

interface Tab {
  href: string
  label: string
  icon: IconName
  match: (path: string) => boolean
}

/**
 * Home · Leave · Pay · Me.
 *
 * `Me` is the personal hub — documents, letters, profile, settings — rather
 * than a Documents tab. Documents alone did not earn a quarter of the bar, and
 * "Me" is where people look for their own things.
 *
 * Manager mode swaps Leave for Team and keeps everything else, so the two modes
 * differ by exactly one tab and nothing moves under the thumb.
 */
/**
 * Employee: Home · Attendance · Todos · Me.
 *
 * Pay sits under Me rather than in the bar. It is read a few times a year, and
 * it is behind a biometric gate anyway — a tab that always prompts for Face ID
 * is a tab people learn not to press.
 *
 * Todos earns its slot because it is the only place the app asks something *of*
 * the employee. Leaving those items scattered across screens is how a contract
 * goes unsigned for three weeks.
 */
const EMPLOYEE_TABS: Tab[] = [
  { href: '/', label: 'Home', icon: 'home', match: (p) => p === '/' },
  {
    href: '/attendance',
    label: 'Attendance',
    icon: 'time',
    match: (p) => p.startsWith('/attendance') || p.startsWith('/checkin'),
  },
  { href: '/todos', label: 'Todos', icon: 'todos', match: (p) => p.startsWith('/todos') },
  {
    href: '/me',
    label: 'Me',
    icon: 'profile',
    match: (p) =>
      p.startsWith('/me') ||
      p.startsWith('/documents') ||
      p.startsWith('/profile') ||
      p.startsWith('/payslips') ||
      p.startsWith('/leave'),
  },
]

/**
 * Manager: Home · Team · Calendar · Personal.
 *
 * "Personal" rather than "Me" because the distinction being drawn is between
 * the manager's team and the manager's own record — a manager is still an
 * employee with leave to book and a payslip to read.
 */
const MANAGER_TABS: Tab[] = [
  { href: '/', label: 'Home', icon: 'home', match: (p) => p === '/' },
  {
    href: '/manage/approvals',
    label: 'Team',
    icon: 'team',
    match: (p) => p.startsWith('/manage/approvals') || p.startsWith('/manage/attendance'),
  },
  {
    href: '/manage/calendar',
    label: 'Calendar',
    icon: 'calendar',
    match: (p) => p.startsWith('/manage/calendar'),
  },
  {
    href: '/me',
    label: 'Personal',
    icon: 'profile',
    match: (p) =>
      p.startsWith('/me') ||
      p.startsWith('/documents') ||
      p.startsWith('/profile') ||
      p.startsWith('/payslips') ||
      p.startsWith('/leave') ||
      p.startsWith('/attendance'),
  },
]

export function TabBar() {
  const router = useRouter()
  const pathname = usePathname()
  const insets = useSafeAreaInsets()
  const me = useSession((s) => s.me)
  const managerMode = useSession((s) => s.managerMode)

  const canManage = isManager(me)
  const approvals = useApprovals(canManage)
  const waiting = approvals.data?.approvals.length ?? 0

  const tabs = managerMode && canManage ? MANAGER_TABS : EMPLOYEE_TABS
  const activeIndex = Math.max(0, tabs.findIndex((t) => t.match(pathname)))

  // A single indicator that slides between tabs, rather than each tab animating
  // itself — one moving object reads as continuous, four reads as flicker.
  const slide = useRef(new Animated.Value(activeIndex)).current

  useEffect(() => {
    Animated.spring(slide, {
      toValue: activeIndex,
      useNativeDriver: true,
      speed: 18,
      bounciness: 6,
    }).start()
  }, [activeIndex, slide])

  // Measured rather than assumed. The old bar interpolated against
  // MAX_CONTENT_WIDTH, which is only the real width on a wide screen; on a
  // phone the pill would have slid to the wrong place.
  // onLayout reports the border box, so both the padding and the border come
  // off before dividing into slots — the tabs themselves flex inside exactly
  // that content box, and the pill must agree with them to the pixel.
  const [width, setWidth] = useState(0)
  const slot = width > 0 ? (width - (PILL_PAD + BORDER) * 2) / tabs.length : 0
  const pillColour = managerMode && canManage ? colour.accent : colour.primary

  return (
    <View
      style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, space.md) }]}
      accessibilityRole="tablist"
      pointerEvents="box-none"
    >
      <View style={styles.inner} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {slot > 0 ? (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.pill,
              {
                width: slot,
                backgroundColor: pillColour,
                transform: [
                  {
                    translateX: slide.interpolate({
                      inputRange: tabs.map((_, i) => i),
                      outputRange: tabs.map((_, i) => i * slot),
                    }),
                  },
                ],
              },
            ]}
          />
        ) : null}

        {tabs.map((tab) => {
          const active = tab.match(pathname)
          const badge = tab.href === '/manage/approvals' || (tab.label === 'Team') ? waiting : 0
          return (
            <TabButton
              key={tab.href}
              tab={tab}
              active={active}
              badge={badge}
              onPress={() => router.push(tab.href as never)}
            />
          )
        })}
      </View>
    </View>
  )
}

function TabButton({
  tab,
  active,
  badge,
  onPress,
}: {
  tab: Tab
  active: boolean
  badge: number
  onPress: () => void
}) {
  const press = useRef(new Animated.Value(0)).current

  const to = (value: number) =>
    Animated.timing(press, {
      toValue: value,
      duration: 120,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start()

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={tab.label}
      onPress={onPress}
      onPressIn={() => to(1)}
      onPressOut={() => to(0)}
      style={styles.tab}
      hitSlop={6}
    >
      <Animated.View
        style={{
          alignItems: 'center',
          gap: 5,
          transform: [
            { scale: press.interpolate({ inputRange: [0, 1], outputRange: [1, 0.92] }) },
          ],
        }}
      >
        <View>
          {/* Icon only. The label is the accessible name; on screen the filled
              pill says which tab is active more clearly than a caption did. */}
          <Icon
            name={tab.icon}
            size={22}
            color={active ? colour.textInverse : colour.textMuted}
            accent={active ? colour.textInverse : colour.textMuted}
          />
          {badge > 0 ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{badge > 9 ? '9+' : badge}</Text>
            </View>
          ) : null}
        </View>
      </Animated.View>
    </Pressable>
  )
}

/** Inset between the pill container's edge and the sliding pill. */
const PILL_PAD = 6
const BORDER = 1

const styles = StyleSheet.create({
  // Floats over the content rather than sitting under it. The screen adds
  // bottom padding so the last row is never hidden beneath.
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: space.sm,
    paddingHorizontal: space.lg,
    backgroundColor: 'transparent',
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    backgroundColor: colour.surface,
    borderRadius: radius.pill,
    borderWidth: BORDER,
    borderColor: colour.border,
    padding: PILL_PAD,
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(14px)' } : {}),
  },
  pill: {
    // Anchored at the content box's origin; the slide is a pure translate
    // from there. Left unset, an absolute child starts after the padding and
    // the translate added the padding again — the pill sat 6px right of the
    // icon it was meant to frame.
    position: 'absolute',
    left: PILL_PAD,
    top: PILL_PAD,
    bottom: PILL_PAD,
    borderRadius: radius.pill,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  badge: {
    position: 'absolute',
    top: -6,
    right: -10,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colour.danger,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    borderWidth: 2,
    borderColor: colour.surface,
  },
  badgeText: { color: colour.text, fontSize: 10, fontWeight: font.weight.bold },
})
