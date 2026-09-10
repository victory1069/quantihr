/**
 * Attendance — every way the employee was present, in one tab.
 *
 * Three sub-tabs, because presence is gathered by three unrelated mechanisms
 * and they fail in different ways:
 *
 *   - **Morning clock-ins** come from a geofence and a rotating code.
 *   - **Physical meetings** come from a room code typed on the way in.
 *   - **Virtual meetings** come from Google's conference record.
 *
 * Merging them into one list would make a gap unreadable: a missing row could
 * mean you were absent, or that nobody started the meeting, or that the
 * conference never happened. Separated, each list can explain its own silence.
 *
 * Clock-ins lead, because the reason someone opens this tab in the morning is
 * to check in and that has to be the first thing under the thumb.
 *
 * Throughout, raw minutes late are shown next to the status. Grace applies to
 * the *status*, not the number, so an employee sees the same figures their
 * manager sees — spec §3, evidence is always visible.
 */

import { useMemo, useState } from 'react'
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
  SegmentedTabs,
  Skeleton,
} from '../src/ui/components'
import { Figure, Label, Stat, StatRow } from '../src/ui/primitives'
import { colour, font, space, statusColour, statusLabel } from '../src/ui/theme'
import {
  useAttendanceHistory,
  useAttendanceStatus,
  useMeetingAttendance,
  type MeetingAttendanceRow,
} from '../src/api/queries'

type Tab = 'clock_ins' | 'physical' | 'virtual'

const TABS: { value: Tab; label: string }[] = [
  { value: 'clock_ins', label: 'Clock-ins' },
  { value: 'physical', label: 'In person' },
  { value: 'virtual', label: 'Virtual' },
]

export default function Attendance() {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<Tab>('clock_ins')

  const clockIns = useAttendanceStatus()
  const physical = useMeetingAttendance('in_person')
  const virtual = useMeetingAttendance('google_meet')

  const refreshing =
    clockIns.isRefetching || physical.isRefetching || virtual.isRefetching

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
      <Appear index={0}>
        <Text style={styles.title}>Attendance</Text>
      </Appear>

      <Appear index={1}>
        <SegmentedTabs options={TABS} value={tab} onChange={setTab} />
      </Appear>

      {tab === 'clock_ins' ? (
        <ClockIns />
      ) : (
        <Meetings
          kind={tab}
          query={tab === 'physical' ? physical : virtual}
        />
      )}
    </Screen>
  )
}

// ---------------------------------------------------------------------------
// Morning clock-ins
// ---------------------------------------------------------------------------

function ClockIns() {
  const router = useRouter()
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
    <>
      {/* Today's action stays at the top — it is why this tab gets opened. */}
      <Appear index={2}>
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

            <Text style={styles.body}>
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

      <Appear index={3}>
        <Label>Last 30 days</Label>
      </Appear>

      <Appear index={4}>
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

      <Appear index={5}>
        <Label>Your record</Label>
      </Appear>

      <Appear index={6}>
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
                    <StatusCell status={r.status} minutesLate={r.minutesLate} />
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

      <Appear index={7}>
        <Text style={styles.footnote}>
          Minutes late are shown before grace is applied, so you see the same figures your
          manager does. Something wrong? Open the record and dispute it.
        </Text>
      </Appear>
    </>
  )
}

// ---------------------------------------------------------------------------
// Meeting attendance — physical and virtual share everything but their copy
// ---------------------------------------------------------------------------

function Meetings({
  kind,
  query,
}: {
  kind: 'physical' | 'virtual'
  query: ReturnType<typeof useMeetingAttendance>
}) {
  const router = useRouter()
  const data = query.data

  const copy =
    kind === 'physical'
      ? {
          empty: 'No in-person meetings recorded',
          emptyBody:
            'Meetings you check into with a room code appear here, with how long you were in the room.',
          footnote:
            'Attendance in the room comes from the code you enter on the way in. If a meeting is missing, nobody started a recording for it.',
        }
      : {
          empty: 'No virtual meetings recorded',
          emptyBody:
            'Google Meet calls from your calendar appear here once the conference record arrives.',
          footnote:
            'Join times come from Google’s own conference record, not from this app. If the host started late, lateness is measured from when the meeting actually began.',
        }

  return (
    <>
      <Appear index={2}>
        {data ? (
          <StatRow>
            <Stat label="Attended" value={data.attended} tone="success" />
            <Stat
              label={data.missed > 0 ? 'Missed' : 'Late'}
              value={data.missed > 0 ? data.missed : data.late}
              tone={data.missed > 0 ? 'warning' : data.late > 0 ? 'warning' : 'default'}
              caption={
                data.totalMinutesLate > 0 ? `${data.totalMinutesLate} min late total` : undefined
              }
            />
          </StatRow>
        ) : (
          <Card>
            <Skeleton height={44} />
          </Card>
        )}
      </Appear>

      <Appear index={3}>
        <Label>Your record</Label>
      </Appear>

      <Appear index={4}>
        <Card>
          {data ? (
            data.records.length > 0 ? (
              data.records.map((r, i) => (
                <View key={r.meetingId}>
                  {i > 0 ? <Divider /> : null}
                  <View style={styles.meetingRow}>
                    <View style={styles.meetingMain}>
                      <Text style={styles.meetingTitle} numberOfLines={1}>
                        {r.title}
                      </Text>
                      <Text style={styles.meetingMeta}>
                        {formatWhen(r.actualStart ?? r.scheduledStart)}
                        {r.totalDurationSeconds > 0
                          ? ` · ${Math.round(r.totalDurationSeconds / 60)} min`
                          : ''}
                      </Text>
                    </View>
                    <MeetingStatus row={r} />
                  </View>

                  {/* A record that produced nothing explains why, rather than
                      reading as an unexplained gap. */}
                  {r.resolution === 'did_not_occur' ? (
                    <Text style={styles.offline}>This meeting never ran — nothing recorded.</Text>
                  ) : r.resolution === 'too_short' ? (
                    <Text style={styles.offline}>Too short to record attendance against.</Text>
                  ) : null}
                </View>
              ))
            ) : (
              <EmptyState title={copy.empty} body={copy.emptyBody} />
            )
          ) : (
            <Skeleton height={80} />
          )}
        </Card>
      </Appear>

      {data && data.records.length > 0 ? (
        <Appear index={5}>
          <Button
            label="Open meetings"
            variant="ghost"
            onPress={() => router.push('/meetings')}
          />
        </Appear>
      ) : null}

      <Appear index={6}>
        <Text style={styles.footnote}>{copy.footnote}</Text>
      </Appear>
    </>
  )
}

function MeetingStatus({ row }: { row: MeetingAttendanceRow }) {
  if (row.attendanceStatus === null || row.attendanceStatus === 'void') {
    return <Text style={styles.voided}>—</Text>
  }
  if (row.attendanceStatus === 'excused') {
    return <Text style={styles.excused}>On leave</Text>
  }
  return <StatusCell status={row.attendanceStatus} minutesLate={row.minutesLate} />
}

function StatusCell({ status, minutesLate }: { status: string; minutesLate: number }) {
  return (
    <View style={styles.statusCell}>
      <View style={[styles.dot, { backgroundColor: statusColour(status) }]} />
      <Text style={[styles.status, { color: statusColour(status) }]}>
        {statusLabel(status)}
        {minutesLate > 0 ? ` +${minutesLate}m` : ''}
      </Text>
    </View>
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

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
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
  body: { fontSize: font.size.md, color: colour.text, lineHeight: 22, fontFamily: font.family },

  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  date: { width: 68 },
  time: { width: 78 },

  meetingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
  },
  meetingMain: { flex: 1, gap: 2 },
  meetingTitle: {
    fontSize: font.size.md,
    color: colour.text,
    fontWeight: font.weight.medium,
    fontFamily: font.family,
  },
  meetingMeta: { fontSize: font.size.sm, color: colour.textMuted, fontFamily: font.family },

  statusCell: { flexDirection: 'row', alignItems: 'center', gap: space.sm, justifyContent: 'flex-end' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  status: { fontSize: font.size.sm, fontWeight: font.weight.semibold, fontFamily: font.family },
  excused: { fontSize: font.size.sm, color: colour.textMuted, fontFamily: font.family },
  voided: { fontSize: font.size.sm, color: colour.textFaint, fontFamily: font.mono },

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
