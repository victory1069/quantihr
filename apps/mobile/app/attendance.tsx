/**
 * Attendance — the employee's own record.
 *
 * Today's action sits above the history, because the reason someone opens this
 * tab in the morning is to check in and the reason they open it later is to see
 * what was recorded. Both are served without a sub-navigation.
 *
 * The history deliberately shows raw minutes late alongside the status. Grace is
 * applied to the *status*, not the number, so an employee can see the same
 * figures their manager sees — spec §3, evidence is always visible.
 */

import { useMemo } from 'react'
import { RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import { addDays } from '@quanti/shared'
import {
  Appear,
  Button,
  Card,
  Divider,
  EmptyState,
  Screen,
  Skeleton,
} from '../src/ui/components'
import { Figure, Label, Stat, StatRow } from '../src/ui/primitives'
import { colour, font, space, statusColour, statusLabel } from '../src/ui/theme'
import { useAttendanceHistory, useAttendanceStatus } from '../src/api/queries'

export default function Attendance() {
  const router = useRouter()
  const queryClient = useQueryClient()

  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const from = useMemo(() => addDays(today, -29), [today])

  const status = useAttendanceStatus()
  const history = useAttendanceHistory(from, today)

  const records = history.data?.records ?? []
  const onTime = records.filter((r) => r.status === 'present').length
  const late = records.filter((r) => r.status === 'late').length
  const totalLateMinutes = records.reduce((sum, r) => sum + r.minutesLate, 0)

  const window = status.data?.window
  const record = status.data?.record
  const checkedIn = record?.status === 'present' || record?.status === 'late'

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={status.isRefetching || history.isRefetching}
          onRefresh={() => void queryClient.invalidateQueries()}
          tintColor={colour.primary}
        />
      }
    >
      <Appear index={0}>
        <Text style={styles.title}>Attendance</Text>
      </Appear>

      {/* Today */}
      <Appear index={1}>
        {status.data ? (
          <Card tone={window?.open && !checkedIn ? 'primary' : 'default'}>
            <Label tone={window?.open && !checkedIn ? 'primary' : 'faint'}>
              {checkedIn
                ? `CHECKED IN · ${formatTime(record?.checkedInAt)}`
                : window?.open
                  ? `CHECK-IN OPEN · CLOSES ${window.closesAt}`
                  : window?.reason === 'too_early'
                    ? `OPENS ${window.opensAt}`
                    : window?.reason === 'too_late'
                      ? 'CLOSED FOR TODAY'
                      : 'NOT A WORKING DAY'}
            </Label>

            <Text style={styles.todayBody}>
              {checkedIn
                ? record!.minutesLate > 0
                  ? `${record!.minutesLate} minutes after your ${status.data.schedule.startTime} start.`
                  : `On time against your ${status.data.schedule.startTime} start.`
                : window?.open
                  ? `${status.data.location?.name ?? 'Your office'} · tap to record today`
                  : window?.reason === 'too_early'
                    ? `Opens in ${window.minutesUntilOpen} minutes.`
                    : 'Nothing to record right now.'}
            </Text>

            {window?.open && !checkedIn ? (
              <Button label="Check in" onPress={() => router.push('/checkin')} />
            ) : null}
          </Card>
        ) : (
          <Card>
            <Skeleton height={14} width={180} />
            <Skeleton height={20} />
          </Card>
        )}
      </Appear>

      {/* Last 30 days */}
      <Appear index={2}>
        <Label>Last 30 days</Label>
      </Appear>

      <Appear index={3}>
        {history.data ? (
          <StatRow>
            <Stat label="On time" value={onTime} tone="success" />
            <Stat
              label="Late"
              value={late}
              tone={late > 0 ? 'warning' : 'default'}
              caption={totalLateMinutes > 0 ? `${totalLateMinutes} min total` : undefined}
            />
          </StatRow>
        ) : (
          <Card>
            <Skeleton height={44} />
          </Card>
        )}
      </Appear>

      {/* History */}
      <Appear index={4}>
        <Label>Your record</Label>
      </Appear>

      <Appear index={5}>
        <Card>
          {history.data ? (
            records.length > 0 ? (
              records.map((r, i) => (
                <View key={r.id}>
                  {i > 0 ? <Divider /> : null}
                  <View style={styles.row}>
                    <Figure size="sm" tone="muted" style={styles.date}>
                      {formatDay(r.date)}
                    </Figure>

                    <Figure size="sm" style={styles.time}>
                      {formatTime(r.checkedInAt) || '—'}
                    </Figure>

                    <View style={styles.statusCell}>
                      <View
                        style={[styles.dot, { backgroundColor: statusColour(r.status) }]}
                      />
                      <Text style={[styles.status, { color: statusColour(r.status) }]}>
                        {statusLabel(r.status)}
                        {r.minutesLate > 0 ? ` +${r.minutesLate}m` : ''}
                      </Text>
                    </View>
                  </View>

                  {r.rejectionReason ? (
                    <Text style={styles.rejection}>{r.rejectionReason}</Text>
                  ) : null}
                  {r.recordedOffline ? (
                    <Text style={styles.offline}>Recorded offline, synced later</Text>
                  ) : null}
                </View>
              ))
            ) : (
              <EmptyState
                title="No records yet"
                body="Your check-ins for the last 30 days will appear here."
              />
            )
          ) : (
            <Skeleton height={80} />
          )}
        </Card>
      </Appear>

      <Appear index={6}>
        <Text style={styles.footnote}>
          Minutes late are shown before grace is applied, so you see the same figures your
          manager does. Something wrong? Open the record and dispute it.
        </Text>
      </Appear>
    </Screen>
  )
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, d ?? 1)).toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
  })
}

const styles = StyleSheet.create({
  title: {
    fontSize: font.size.xxl,
    fontWeight: font.weight.bold,
    color: colour.text,
    letterSpacing: font.tracking.tight,
    fontFamily: font.family,
    paddingTop: space.sm,
  },
  todayBody: {
    fontSize: font.size.md,
    color: colour.text,
    lineHeight: 22,
    fontFamily: font.family,
  },

  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  date: { width: 68 },
  time: { width: 58 },
  statusCell: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm, justifyContent: 'flex-end' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  status: { fontSize: font.size.sm, fontWeight: font.weight.semibold, fontFamily: font.family },

  rejection: {
    fontSize: font.size.sm,
    color: colour.danger,
    lineHeight: 19,
    paddingBottom: space.sm,
    fontFamily: font.family,
  },
  offline: {
    fontSize: font.size.xs,
    color: colour.textFaint,
    paddingBottom: space.sm,
    fontFamily: font.family,
  },

  footnote: {
    fontSize: font.size.sm,
    color: colour.textFaint,
    lineHeight: 20,
    fontFamily: font.family,
  },
})
