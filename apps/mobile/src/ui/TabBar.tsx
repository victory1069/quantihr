/**
 * Persistent bottom navigation.
 *
 * Manager mode is a toggle in this bar for users who hold the role, not a
 * separate app or a separate login (spec §5). Switching swaps the tab set in
 * place, so a manager is one tap from their queue and one tap back to their own
 * leave balance.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter, usePathname } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colour, font, MAX_CONTENT_WIDTH, radius, space } from './theme'
import { isManager, useSession } from '../store/session'
import { useApprovals } from '../api/queries'

interface Tab {
  href: string
  label: string
  glyph: string
  /** Match nested routes, so /leave/new keeps the Leave tab active. */
  match: (path: string) => boolean
}

const EMPLOYEE_TABS: Tab[] = [
  { href: '/', label: 'Home', glyph: '⌂', match: (p) => p === '/' },
  { href: '/checkin', label: 'Check in', glyph: '◎', match: (p) => p.startsWith('/checkin') },
  { href: '/leave', label: 'Leave', glyph: '≡', match: (p) => p.startsWith('/leave') },
  { href: '/payslips', label: 'Pay', glyph: '₦', match: (p) => p.startsWith('/payslips') },
  { href: '/documents', label: 'Docs', glyph: '▤', match: (p) => p.startsWith('/documents') },
  { href: '/profile', label: 'Profile', glyph: '◍', match: (p) => p.startsWith('/profile') },
]

const MANAGER_TABS: Tab[] = [
  { href: '/manage/approvals', label: 'Approvals', glyph: '✓', match: (p) => p.startsWith('/manage/approvals') },
  { href: '/manage/calendar', label: 'Calendar', glyph: '▦', match: (p) => p.startsWith('/manage/calendar') },
  { href: '/manage/attendance', label: 'Attendance', glyph: '◔', match: (p) => p.startsWith('/manage/attendance') },
  { href: '/profile', label: 'Profile', glyph: '◍', match: (p) => p.startsWith('/profile') },
]

export function TabBar() {
  const router = useRouter()
  const pathname = usePathname()
  const insets = useSafeAreaInsets()
  const me = useSession((s) => s.me)
  const managerMode = useSession((s) => s.managerMode)
  const setManagerMode = useSession((s) => s.setManagerMode)

  const canManage = isManager(me)
  const approvals = useApprovals(canManage)
  const waiting = approvals.data?.approvals.length ?? 0

  const tabs = managerMode && canManage ? MANAGER_TABS : EMPLOYEE_TABS

  return (
    <View style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
      <View style={styles.inner}>
        {canManage ? (
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: managerMode }}
            accessibilityLabel={managerMode ? 'Switch to my view' : 'Switch to manager view'}
            onPress={() => {
              const next = !managerMode
              setManagerMode(next)
              router.replace(next ? '/manage/approvals' : '/')
            }}
            style={[styles.modeToggle, managerMode && styles.modeToggleOn]}
          >
            <Text style={[styles.modeLabel, managerMode && styles.modeLabelOn]}>
              {managerMode ? 'Manager' : 'Me'}
            </Text>
            {!managerMode && waiting > 0 ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{waiting > 9 ? '9+' : waiting}</Text>
              </View>
            ) : null}
          </Pressable>
        ) : null}

        {tabs.map((tab) => {
          const active = tab.match(pathname)
          const showBadge = tab.href === '/manage/approvals' && waiting > 0
          return (
            <Pressable
              key={tab.href}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={tab.label}
              onPress={() => router.push(tab.href as never)}
              style={styles.tab}
            >
              <View>
                <Text style={[styles.glyph, active && styles.glyphActive]}>{tab.glyph}</Text>
                {showBadge ? (
                  <View style={styles.tabBadge}>
                    <Text style={styles.badgeText}>{waiting > 9 ? '9+' : waiting}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>
                {tab.label}
              </Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: 1,
    borderTopColor: colour.border,
    backgroundColor: colour.surface,
    paddingTop: space.sm,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: space.sm,
    gap: space.xs,
  },
  tab: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: space.xs, minHeight: 44 },
  glyph: { fontSize: 20, color: colour.textFaint },
  glyphActive: { color: colour.primary },
  label: { fontSize: font.size.xs, color: colour.textFaint },
  labelActive: { color: colour.primary, fontWeight: font.weight.semibold },

  modeToggle: {
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colour.surfaceAlt,
    marginRight: space.xs,
  },
  modeToggleOn: { backgroundColor: colour.primary },
  modeLabel: { fontSize: font.size.xs, fontWeight: font.weight.semibold, color: colour.textMuted },
  modeLabelOn: { color: colour.textInverse },

  badge: {
    position: 'absolute',
    top: -4,
    right: -6,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colour.danger,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  tabBadge: {
    position: 'absolute',
    top: -4,
    right: -10,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colour.danger,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: font.weight.bold },
})
