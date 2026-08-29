/**
 * Home (spec §5).
 *
 * "Hydrates from cache instantly, revalidates in background. Never shows a
 * full-screen spinner." Every block below renders from whatever the cache has
 * and degrades to a skeleton row, so an employee opening the app in a lift sees
 * their balance rather than a loading state.
 */

import { useMemo } from 'react'
import { RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import { Badge, Button, Card, Divider, EmptyState, Screen, SectionTitle, Skeleton } from '../src/ui/components'
import { colour, font, space, statusColour, statusLabel } from '../src/ui/theme'
import { useAttendanceStatus, useBalances, useLeaveRequests, useMe } from '../src/api/queries'
import { useSession } from '../src/store/session'

export default function Home() {
  const router = useRouter()
  const queryClient = useQueryClient()

  const me = useMe()
  const status = useAttendanceStatus()
  const balances = useBalances()
  const requests = useLeaveRequests('pending')
  const deviceReview = useSession((s) => s.deviceReviewRequired)

  // Keep the store in sync for the tab bar and the biometric gate.
  if (me.data && useSession.getState().me?.employee.id !== me.data.employee.id) {
    useSession.getState().setMe(me.data)
  }

  const refreshing =
    me.isRefetching || status.isRefetching || balances.isRefetching || requests.isRefetching

  const primary = usePrimaryAction(status.data)
  const firstName = me.data?.employee.firstName

  const headline = useMemo(() => {
    const hour = new Date().getHours()
    const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
    return firstName ? `${part}, ${firstName}` : part
  }, [firstName])

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void queryClient.invalidateQueries()}
          tintColor={colour.primary}
        />
      }
    >
      <View style={styles.header}>
        <Text style={styles.greeting}>{headline}</Text>
        {me.data ? (
          <Text style={styles.sub}>
            {me.data.employee.jobTitle ?? 'Employee'}
            {me.data.employee.departmentName ? ` · ${me.data.employee.departmentName}` : ''}
          </Text>
        ) : (
          <Skeleton height={14} width={180} />
        )}
      </View>

      {deviceReview ? (
        <Card style={styles.warnCard}>
          <Text style={styles.warnTitle}>New device awaiting HR approval</Text>
          <Text style={styles.warnBody}>
            You can use the app, but check-ins from this device will be flagged for review until
            HR approves it.
          </Text>
        </Card>
      ) : null}

      {/* Today */}
      <Card>
        <View style={styles.todayRow}>
          <View style={styles.todayText}>
            <Text style={styles.cardLabel}>Today</Text>
            {status.data ? (
              <>
                <Text style={styles.todayHeadline}>{primary.headline}</Text>
                <Text style={styles.todayDetail}>{primary.detail}</Text>
              </>
            ) : (
              <>
                <Skeleton height={22} width={160} />
                <Skeleton height={14} width={220} />
              </>
            )}
          </View>
          {status.data?.record ? (
            <Badge
              label={statusLabel(status.data.record.status)}
              tone={
                status.data.record.status === 'late'
                  ? 'warning'
                  : status.data.record.status === 'rejected'
                    ? 'danger'
                    : 'success'
              }
            />
          ) : null}
        </View>

        {primary.actionLabel ? (
          <Button label={primary.actionLabel} onPress={() => router.push('/checkin')} />
        ) : null}
      </Card>

      {/* Balances */}
      <SectionTitle
        action={<Text style={styles.link} onPress={() => router.push('/leave')}>See all</Text>}
      >
        Leave balance
      </SectionTitle>

      <Card>
        {balances.data ? (
          balances.data.balances.length > 0 ? (
            balances.data.balances.map((b, i) => (
              <View key={b.leaveTypeId}>
                {i > 0 ? <Divider /> : null}
                <View style={styles.balanceRow}>
                  <View style={styles.balanceLabel}>
                    <View style={[styles.swatch, { backgroundColor: b.colour }]} />
                    <View>
                      <Text style={styles.balanceName}>{b.leaveTypeName}</Text>
                      {b.pending > 0 ? (
                        <Text style={styles.balanceNote}>{b.pending} day(s) awaiting approval</Text>
                      ) : b.carryoverExpiresOn && b.carriedOver > 0 ? (
                        <Text style={styles.balanceNote}>
                          {b.carriedOver} carried over, expires {b.carryoverExpiresOn}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                  <Text style={styles.balanceValue}>
                    {b.available}
                    <Text style={styles.balanceUnit}> days</Text>
                  </Text>
                </View>
              </View>
            ))
          ) : (
            <EmptyState title="No leave types configured yet" />
          )
        ) : (
          <View style={{ gap: space.md }}>
            <Skeleton height={20} />
            <Skeleton height={20} />
          </View>
        )}

        <Button
          label="Request leave"
          variant="secondary"
          onPress={() => router.push('/leave/new')}
        />
      </Card>

      {/* Pending items */}
      <SectionTitle>Awaiting a decision</SectionTitle>
      <Card>
        {requests.data ? (
          requests.data.requests.length > 0 ? (
            requests.data.requests.map((r, i) => (
              <View key={r.id}>
                {i > 0 ? <Divider /> : null}
                <View style={styles.requestRow}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.requestTitle}>{r.leaveTypeName}</Text>
                    <Text style={styles.requestDates}>
                      {r.start} → {r.end} · {r.daysCount} day(s)
                    </Text>
                  </View>
                  <Badge label={statusLabel(r.status)} tone="pending" dot={statusColour(r.status)} />
                </View>
              </View>
            ))
          ) : (
            <EmptyState
              title="Nothing pending"
              body="Requests you submit will appear here until your manager decides."
            />
          )
        ) : (
          <Skeleton height={40} />
        )}
      </Card>
    </Screen>
  )
}

interface PrimaryAction {
  headline: string
  detail: string
  actionLabel: string | null
}

/** One primary action, chosen from today's attendance state (spec §5). */
function usePrimaryAction(
  status: ReturnType<typeof useAttendanceStatus>['data'],
): PrimaryAction {
  if (!status) {
    return { headline: '', detail: '', actionLabel: null }
  }

  const record = status.record

  if (record && (record.status === 'present' || record.status === 'late')) {
    const at = record.checkedInAt
      ? new Date(record.checkedInAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })
      : ''
    return {
      headline: `Checked in at ${at}`,
      detail:
        record.minutesLate > 0
          ? `${record.minutesLate} minute(s) after your ${status.schedule.startTime} start.`
          : `On time against your ${status.schedule.startTime} start.`,
      actionLabel: null,
    }
  }

  if (record?.status === 'pending_review') {
    return {
      headline: 'Check-in under review',
      detail: 'This device is not your registered one, so HR will review the record.',
      actionLabel: null,
    }
  }

  switch (status.window.reason) {
    case 'open':
      return {
        headline: 'Ready to check in',
        detail: `Check-in closes at ${status.window.closesAt}.`,
        actionLabel: 'Check in now',
      }
    case 'too_early':
      return {
        headline: `Check-in opens at ${status.window.opensAt}`,
        detail: `That is in ${formatMinutes(status.window.minutesUntilOpen)}.`,
        actionLabel: null,
      }
    case 'too_late':
      return {
        headline: 'Check-in has closed',
        detail: `The window closed at ${status.window.closesAt}. Speak to your manager.`,
        actionLabel: null,
      }
    case 'not_a_working_day':
    default:
      return {
        headline: 'Not a working day',
        detail: 'Enjoy it. Check-in resumes on your next scheduled day.',
        actionLabel: null,
      }
  }
}

function formatMinutes(total: number): string {
  if (total < 60) return `${total} minute(s)`
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  return minutes === 0 ? `${hours} hour(s)` : `${hours}h ${minutes}m`
}

const styles = StyleSheet.create({
  header: { paddingTop: space.lg, paddingBottom: space.sm, gap: space.xs },
  greeting: { fontSize: font.size.xxl, fontWeight: font.weight.bold, color: colour.text },
  sub: { fontSize: font.size.md, color: colour.textMuted },

  cardLabel: {
    fontSize: font.size.xs,
    fontWeight: font.weight.semibold,
    color: colour.textFaint,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  todayRow: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  todayText: { flex: 1, gap: space.xs },
  todayHeadline: { fontSize: font.size.xl, fontWeight: font.weight.semibold, color: colour.text },
  todayDetail: { fontSize: font.size.md, color: colour.textMuted, lineHeight: 21 },

  warnCard: { backgroundColor: colour.warningSoft, borderColor: '#FDE68A' },
  warnTitle: { fontSize: font.size.md, fontWeight: font.weight.semibold, color: colour.warning },
  warnBody: { fontSize: font.size.sm, color: colour.warning, lineHeight: 19 },

  balanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.sm,
    gap: space.md,
  },
  balanceLabel: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flex: 1 },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  balanceName: { fontSize: font.size.md, color: colour.text, fontWeight: font.weight.medium },
  balanceNote: { fontSize: font.size.xs, color: colour.textMuted, marginTop: 2 },
  balanceValue: { fontSize: font.size.xl, fontWeight: font.weight.bold, color: colour.text },
  balanceUnit: { fontSize: font.size.sm, fontWeight: font.weight.regular, color: colour.textMuted },

  requestRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  requestTitle: { fontSize: font.size.md, fontWeight: font.weight.medium, color: colour.text },
  requestDates: { fontSize: font.size.sm, color: colour.textMuted },

  link: { fontSize: font.size.sm, color: colour.primary, fontWeight: font.weight.semibold },
})
