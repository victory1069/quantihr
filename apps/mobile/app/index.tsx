/**
 * Home — screen E1.
 *
 * Order is the argument: leave and pay first, check-in second, open items
 * third, activity last. This app watches people, and the spec's rule is that
 * what an employee *gets* leads over what the employer *takes*. Putting the
 * check-in prompt above the balances would invert that on the one screen
 * everyone sees.
 *
 * Everything renders from cache with a skeleton fallback — never a full-screen
 * spinner (spec §5).
 */

import { useEffect, useMemo } from 'react'
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import {
  Appear,
  SheetPage,
  Button,
  Card,
  Divider,
  EmptyState,
  Skeleton,
} from '../src/ui/components'
import { Figure, Label, Stat, StatRow } from '../src/ui/primitives'
import { Icon } from '../src/ui/Icon'
import { colour, font, radius, space, statusLabel } from '../src/ui/theme'
import {
  useAttendanceStatus,
  useBalances,
  useLeaveRequests,
  useMe,
  usePayslips,
} from '../src/api/queries'
import { useSession } from '../src/store/session'
import { formatNairaCompact } from '../src/lib/money'

export default function Home() {
  const router = useRouter()
  const queryClient = useQueryClient()

  const me = useMe()
  const status = useAttendanceStatus()
  const balances = useBalances()
  const requests = useLeaveRequests('pending')
  const payslips = usePayslips()
  const deviceReview = useSession((s) => s.deviceReviewRequired)

  // Mirror the fetched profile into the session store. In an effect, not the
  // render body: calling a store setter while rendering updates every other
  // subscriber mid-render, which React flags as "Cannot update a component
  // (BiometricGate) while rendering a different component (Home)".
  useEffect(() => {
    if (me.data && useSession.getState().me?.employee.id !== me.data.employee.id) {
      useSession.getState().setMe(me.data)
    }
  }, [me.data])

  const refreshing =
    me.isRefetching || status.isRefetching || balances.isRefetching || requests.isRefetching

  const primary = usePrimaryAction(status.data)
  const first = me.data?.employee.firstName

  const greeting = useMemo(() => {
    const hour = new Date().getHours()
    const part = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening'
    return first ? `${part}, ${first}` : part
  }, [first])

  const today = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      }),
    [],
  )

  const annual = balances.data?.balances[0]
  const latestPayslip = payslips.data?.payslips[0]
  const pendingDays = balances.data?.balances.reduce((sum, b) => sum + b.pending, 0) ?? 0

  return (
    <SheetPage
      eyebrow={today}
      title={greeting}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void queryClient.invalidateQueries()}
          tintColor={colour.primary}
        />
      }
    >

      {/* Leave and pay lead, per spec §3 "give before you take". */}
      <Appear index={1}>
        <StatRow>
          {balances.data && annual ? (
            <Stat
              label="Leave left"
              value={annual.available}
              caption={pendingDays > 0 ? `${pendingDays} days pending` : 'none pending'}
            />
          ) : (
            <Card style={styles.statSkeleton}>
              <Skeleton height={14} width={72} />
              <Skeleton height={28} width={60} />
            </Card>
          )}

          {payslips.data ? (
            latestPayslip ? (
              <Stat
                label={`Paid ${formatDay(latestPayslip.payDate)}`}
                value={formatNairaCompact(latestPayslip.netPay)}
                caption="net"
              />
            ) : (
              <Stat label="Pay" value="—" caption="no payslip yet" />
            )
          ) : (
            <Card style={styles.statSkeleton}>
              <Skeleton height={14} width={72} />
              <Skeleton height={28} width={80} />
            </Card>
          )}
        </StatRow>
      </Appear>

      {deviceReview ? (
        <Appear index={2}>
          <Card tone="warning">
            <Text style={styles.warnTitle}>New device awaiting HR approval</Text>
            <Text style={styles.warnBody}>
              You can use the app, but check-ins from this device are flagged for review until
              HR approves it.
            </Text>
          </Card>
        </Appear>
      ) : null}

      {/* Check-in */}
      <Appear index={3}>
        {status.data ? (
          <Card tone={primary.actionLabel ? 'primary' : 'default'}>
            <Label tone={primary.actionLabel ? 'primary' : 'faint'}>{primary.eyebrow}</Label>
            <Text style={styles.checkinBody}>{primary.detail}</Text>
            {primary.actionLabel ? (
              <Button label={primary.actionLabel} onPress={() => router.push('/checkin')} />
            ) : null}
          </Card>
        ) : (
          <Card>
            <Skeleton height={14} width={160} />
            <Skeleton height={20} />
            <Skeleton height={52} />
          </Card>
        )}
      </Appear>

      {/* Waiting on a decision. Violet: pink is reserved for absent and overdue. */}
      {requests.data && requests.data.requests.length > 0 ? (
        <Appear index={4}>
          <Card tone="pending" onPress={() => router.push('/leave')}>
            <View style={styles.actionRow}>
              <View style={styles.actionDot} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.actionTitle}>
                  {requests.data.requests.length === 1
                    ? 'A leave request is awaiting a decision'
                    : `${requests.data.requests.length} leave requests awaiting a decision`}
                </Text>
                <Text style={styles.actionSub}>
                  {requests.data.requests[0]!.start} → {requests.data.requests[0]!.end}
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </View>
          </Card>
        </Appear>
      ) : null}

      {/* Policy assistant entry point — spec §5.6 requires it reachable from
          home, not buried in a tab. */}
      <Appear index={5}>
        <Card onPress={() => router.push('/ask')}>
          <View style={styles.actionRow}>
            <View style={styles.aiBadge}>
              <Text style={styles.aiGlyph}>✦</Text>
            </View>
            <Text style={styles.askLabel}>Ask about a policy</Text>
            <Text style={styles.chevron}>›</Text>
          </View>
        </Card>
      </Appear>

      {/* Recent activity */}
      <Appear index={6}>
        <Label>Recent</Label>
      </Appear>

      <Appear index={7}>
        <View style={styles.recent}>
          {requests.data && payslips.data ? (
            recentItems(requests.data.requests, payslips.data.payslips).length > 0 ? (
              recentItems(requests.data.requests, payslips.data.payslips).map((item, i, all) => (
                <View key={item.key}>
                  <Pressable
                    onPress={() => router.push(item.href as never)}
                    style={styles.recentRow}
                    accessibilityRole="button"
                  >
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.recentTitle}>{item.title}</Text>
                      {item.sub ? <Text style={styles.recentSub}>{item.sub}</Text> : null}
                    </View>
                    {item.trailing}
                  </Pressable>
                  {i < all.length - 1 ? <Divider /> : null}
                </View>
              ))
            ) : (
              <EmptyState
                title="Nothing yet"
                body="Leave requests and payslips will appear here."
              />
            )
          ) : (
            <Skeleton height={64} />
          )}
        </View>
      </Appear>
    </SheetPage>
  )
}

interface RecentItem {
  key: string
  title: string
  sub?: string
  href: string
  trailing: React.ReactNode
}

function recentItems(
  requests: { id: string; leaveTypeName: string; start: string; end: string; status: string }[],
  payslips: { id: string; netPay: number; periodStart: string }[],
): RecentItem[] {
  const leave: RecentItem[] = requests.slice(0, 2).map((r) => ({
    key: `leave-${r.id}`,
    title: `${r.leaveTypeName} · ${formatDay(r.start)}–${formatDay(r.end)}`,
    href: `/leave/${r.id}`,
    trailing: (
      <Text
        style={[
          styles.recentTrailing,
          {
            color:
              r.status === 'approved'
                ? colour.success
                : r.status === 'declined'
                  ? colour.danger
                  : colour.warning,
          },
        ]}
      >
        {statusLabel(r.status)}
      </Text>
    ),
  }))

  const pay: RecentItem[] = payslips.slice(0, 2).map((p) => ({
    key: `pay-${p.id}`,
    title: `${monthName(p.periodStart)} payslip`,
    href: `/payslips/${p.id}`,
    trailing: (
      <Figure size="sm" tone="muted">
        {formatNairaCompact(p.netPay)}
      </Figure>
    ),
  }))

  return [...leave, ...pay].slice(0, 4)
}

function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, d ?? 1)).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  })
}

function monthName(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  return new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, 1)).toLocaleDateString(undefined, {
    month: 'long',
  })
}

interface PrimaryAction {
  eyebrow: string
  detail: string
  actionLabel: string | null
}

/** One contextual action, derived from today's attendance state. */
function usePrimaryAction(
  status: ReturnType<typeof useAttendanceStatus>['data'],
): PrimaryAction {
  if (!status) return { eyebrow: '', detail: '', actionLabel: null }

  const record = status.record
  const where = status.location?.name ?? 'your office'

  if (record && (record.status === 'present' || record.status === 'late')) {
    const at = record.checkedInAt
      ? new Date(record.checkedInAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })
      : ''
    return {
      eyebrow: `CHECKED IN · ${at}`,
      detail:
        record.minutesLate > 0
          ? `${record.minutesLate} minutes after your ${status.schedule.startTime} start.`
          : `On time against your ${status.schedule.startTime} start.`,
      actionLabel: null,
    }
  }

  if (record?.status === 'pending_review') {
    return {
      eyebrow: 'CHECK-IN UNDER REVIEW',
      detail: 'This is not your registered device, so HR will review the record.',
      actionLabel: null,
    }
  }

  switch (status.window.reason) {
    case 'open':
      return {
        eyebrow: `CHECK-IN OPEN · CLOSES ${status.window.closesAt}`,
        detail: `${where} · tap to record today`,
        actionLabel: 'Check in',
      }
    case 'too_early':
      return {
        eyebrow: `CHECK-IN OPENS ${status.window.opensAt}`,
        detail: `That is in ${formatMinutes(status.window.minutesUntilOpen)}.`,
        actionLabel: null,
      }
    case 'too_late':
      return {
        eyebrow: 'CHECK-IN CLOSED',
        detail: `The window closed at ${status.window.closesAt}. Speak to your manager.`,
        actionLabel: null,
      }
    default:
      return {
        eyebrow: 'NOT A WORKING DAY',
        detail: 'Check-in resumes on your next scheduled day.',
        actionLabel: null,
      }
  }
}

function formatMinutes(total: number): string {
  if (total < 60) return `${total} minutes`
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  return minutes === 0 ? `${hours} hours` : `${hours}h ${minutes}m`
}

const styles = StyleSheet.create({
  header: { paddingTop: space.sm, gap: 2 },

  statSkeleton: { flex: 1, gap: space.sm },

  checkinBody: {
    fontSize: font.size.md,
    color: colour.text,
    lineHeight: 22,
    fontFamily: font.family,
  },

  warnTitle: {
    fontSize: font.size.md,
    fontWeight: font.weight.semibold,
    color: colour.warning,
    fontFamily: font.family,
  },
  warnBody: {
    fontSize: font.size.sm,
    color: colour.warning,
    lineHeight: 20,
    fontFamily: font.family,
  },

  actionRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  actionDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colour.accent },
  actionTitle: {
    fontSize: font.size.md,
    fontWeight: font.weight.semibold,
    color: colour.text,
    fontFamily: font.family,
  },
  actionSub: { fontSize: font.size.sm, color: colour.textMuted, fontFamily: font.family },
  chevron: { fontSize: 22, color: colour.textFaint },

  aiBadge: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    backgroundColor: colour.pending,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiGlyph: { color: colour.text, fontSize: 16 },
  askLabel: {
    flex: 1,
    fontSize: font.size.lg,
    fontWeight: font.weight.semibold,
    color: colour.text,
    fontFamily: font.family,
  },

  recent: { gap: 0 },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
  },
  recentTitle: { fontSize: font.size.md, color: colour.text, fontFamily: font.family },
  recentSub: { fontSize: font.size.sm, color: colour.textMuted, fontFamily: font.family },
  recentTrailing: {
    fontSize: font.size.md,
    fontWeight: font.weight.bold,
    fontFamily: font.family,
  },
})
