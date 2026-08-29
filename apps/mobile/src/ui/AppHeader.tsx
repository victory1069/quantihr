/**
 * Top bar: mark, manager-mode switch, avatar.
 *
 * The avatar is where Profile went when it lost its tab. It is also where the
 * "six sessions a year" rule is tested hardest — so it is a real avatar with
 * initials, not a gear icon, because people look for themselves rather than for
 * a settings glyph.
 */

import { useRef } from 'react'
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter, usePathname } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LogoMark } from './Logo'
import { colour, font, MAX_CONTENT_WIDTH, radius, space } from './theme'
import { isManager, useSession } from '../store/session'

export function AppHeader() {
  const router = useRouter()
  const pathname = usePathname()
  const insets = useSafeAreaInsets()
  const me = useSession((s) => s.me)
  const managerMode = useSession((s) => s.managerMode)
  const setManagerMode = useSession((s) => s.setManagerMode)

  const canManage = isManager(me)
  const onProfile = pathname.startsWith('/profile')

  const initials = me
    ? `${me.employee.firstName[0] ?? ''}${me.employee.lastName[0] ?? ''}`.toUpperCase()
    : '··'

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + space.sm }]}>
      <View style={styles.inner}>
        <Pressable
          onPress={() => router.push('/')}
          accessibilityRole="button"
          accessibilityLabel="Quanti home"
          hitSlop={8}
        >
          <LogoMark size={30} />
        </Pressable>

        <View style={styles.right}>
          {canManage ? <ModeSwitch on={managerMode} onChange={(next) => {
            setManagerMode(next)
            router.replace(next ? '/manage/approvals' : '/')
          }} /> : null}

          <Pressable
            onPress={() => router.push('/profile')}
            accessibilityRole="button"
            accessibilityLabel="Your profile and settings"
            hitSlop={8}
            style={[styles.avatar, onProfile && styles.avatarActive]}
          >
            <Text style={styles.avatarText}>{initials}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  )
}

/**
 * Manager-mode switch.
 *
 * A segmented control rather than a toggle: a toggle makes you remember which
 * way is which, a segment shows you both states and which one you are in.
 */
function ModeSwitch({ on, onChange }: { on: boolean; onChange: (next: boolean) => void }) {
  const slide = useRef(new Animated.Value(on ? 1 : 0)).current

  const move = (next: boolean) => {
    Animated.timing(slide, {
      toValue: next ? 1 : 0,
      duration: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start()
    onChange(next)
  }

  return (
    <View style={styles.switch} accessibilityRole="tablist">
      <Animated.View
        style={[
          styles.switchThumb,
          {
            transform: [
              { translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [0, 52] }) },
            ],
          },
        ]}
      />
      {(['Me', 'Team'] as const).map((label, i) => {
        const selected = on === (i === 1)
        return (
          <Pressable
            key={label}
            onPress={() => move(i === 1)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            style={styles.switchOption}
          >
            <Text style={[styles.switchLabel, selected && styles.switchLabelActive]}>
              {label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colour.bg,
    paddingBottom: space.sm,
  },
  inner: {
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  right: { flexDirection: 'row', alignItems: 'center', gap: space.md },

  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colour.surfaceRaised,
    borderWidth: 1,
    borderColor: colour.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarActive: { borderColor: colour.primary },
  avatarText: {
    fontSize: font.size.xs,
    fontWeight: font.weight.bold,
    color: colour.text,
    fontFamily: font.family,
    letterSpacing: font.tracking.wide,
  },

  switch: {
    flexDirection: 'row',
    backgroundColor: colour.surfaceSunken,
    borderRadius: radius.pill,
    padding: 3,
    borderWidth: 1,
    borderColor: colour.border,
  },
  switchThumb: {
    position: 'absolute',
    top: 3,
    left: 3,
    width: 52,
    height: 28,
    borderRadius: radius.pill,
    backgroundColor: colour.primarySoft,
    borderWidth: 1,
    borderColor: colour.primaryBorder,
  },
  switchOption: {
    width: 52,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  switchLabel: {
    fontSize: font.size.xs,
    color: colour.textFaint,
    fontFamily: font.family,
    fontWeight: font.weight.medium,
  },
  switchLabelActive: { color: colour.primary, fontWeight: font.weight.semibold },
})
