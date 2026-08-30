/**
 * Top bar: mark, manager-mode switch, avatar.
 *
 * The avatar is where Profile went when it lost its tab. It is also where the
 * "six sessions a year" rule is tested hardest — so it is a real avatar with
 * initials, not a gear icon, because people look for themselves rather than for
 * a settings glyph.
 */

import { useEffect, useRef } from 'react'
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
 * Manager-mode pill.
 *
 * A status indicator that is also the switch. When manager mode is on it reads
 * `● MANAGER MODE` in cyan; off, it is a quiet `Manager view` affordance. This
 * replaced a segmented control — a manager needs to *know* which mode they are
 * in far more often than they need to see both options, and mistaking your own
 * queue for a colleague's is the error worth designing against.
 */
function ModeSwitch({ on, onChange }: { on: boolean; onChange: (next: boolean) => void }) {
  const pulse = useRef(new Animated.Value(0)).current

  useEffect(() => {
    Animated.timing(pulse, {
      toValue: on ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start()
  }, [on, pulse])

  return (
    <Pressable
      onPress={() => onChange(!on)}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={on ? 'Switch to your own view' : 'Switch to manager view'}
      style={[styles.pill, on && styles.pillOn]}
      hitSlop={6}
    >
      {on ? <View style={styles.pillDot} /> : null}
      <Text style={[styles.pillLabel, on && styles.pillLabelOn]}>
        {on ? 'MANAGER MODE' : 'Manager view'}
      </Text>
    </Pressable>
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

  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colour.border,
    backgroundColor: colour.surfaceSunken,
  },
  pillOn: { borderColor: colour.primaryBorder, backgroundColor: colour.primarySoft },
  pillDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colour.primary },
  pillLabel: {
    fontSize: font.size.xs,
    color: colour.textMuted,
    fontFamily: font.family,
    fontWeight: font.weight.medium,
  },
  pillLabelOn: {
    color: colour.primary,
    fontFamily: font.mono,
    letterSpacing: font.tracking.label,
    fontWeight: font.weight.bold,
  },
})
