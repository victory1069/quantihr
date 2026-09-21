/**
 * Home, in manager mode.
 *
 * A manager opens the app for the queue, so the queue is the headline: how
 * many things need them, and how soon the oldest one escalates. The team's
 * day — who is in, who is off, who is drifting late — sits in the sheet, then
 * the queue itself, then the manager's own check-in, which they still owe
 * like everyone else.
 *
 * Numbers come from the same endpoints the manager tabs use, so what this
 * screen says and what those screens show can never disagree.
 */

import { useMemo } from 'react'
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import { Appear, Button, Card, Divider, SheetPage, Skeleton } from './components'
import { Avatar, Stat, StatRow } from './primitives'
import { colour, font, space } from './theme'
import {
  useApprovals,
  useAttendanceStatus,
  useTeamAttendance,
  useTeamCalendar,
} from '../api/queries'

const ESCALATION_HOURS = 48

export function ManagerHome() {
  const router = useRouter()
  const queryClient = useQueryClient()

  const today = new Date().toISOString().slice(0, 10)
  const approvals = useApprovals(true)
  const attendance = useTeamAttendance(today, today, true)
  const calendar = useTeamCalendar(today, today)
  const own = useAttendanceStatus()

  const refreshing = approvals.isRefetching || attendance.isRefetching || calendar.isRefetching

  const queue = approvals.data?.approvals ?? []
  const rows = attendance.data?.rows ?? []
  const threshold = attendance.data?.latenessThreshold ?? 3

  // "Flags" are people drifting towards the lateness threshold — the server
  // marks them, we only count. Only those the manager should talk to now.
  const flags = rows.filter((r) => r.approachingThreshold)
  const inToday = rows.filter((r) => r.daysPresent > 0).length
  const onLeave = new Set(
    (calendar.data?.entries ?? [])
      .filter((e) => e.status === 'approved' && e.start <= today && e.end >= today)
      .map((e) => e.employeeId),
  ).size
  const headcount = calendar.data?.headcount ?? rows.length

  const needs = queue.length + flags.length
  const oldest = queue.reduce((max, a) => Math.max(max, a.waitingHours), 0)
  const escalatesIn = queue.length > 0 ? Math.max(0, Math.round(ESCALATION_HOURS - oldest)) : null

  const dateLine = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }),
    [],
  )

  const title =
    needs === 0
      ? 'Nothing needs you'
      : `${needs === 1 ? 'One thing needs' : `${WORDS[needs] ?? needs} things need`} you`

  const ownWindow = own.data?.window
  const ownRecord = own.data?.record
  const ownLine =
    ownRecord && (ownRecord.status === 'present' || ownRecord.status === 'late')
      ? null
      : ownWindow?.reason === 'open'
        ? `Your own check-in · by ${ownWindow.closesAt}`
        : ownWindow?.reason === 'too_early'
          ? `Your own check-in · opens ${ownWindow.opensAt}`
          : null

  return (
    <SheetPage
      tone="manager"
      eyebrow={dateLine}
      title={title}
      heroBody={
        <>
          {escalatesIn !== null ? (
            <Text style={styles.escalates}>
              {escalatesIn === 0
                ? 'One has passed the 48-hour mark'
                : `One escalates in ${escalatesIn} hours`}
            </Text>
          ) : needs === 0 ? (
            <Text style={styles.escalates}>Your queue is clear.</Text>
          ) : null}
          {queue.length > 0 ? (
            <Button
              label="Open my queue"
              variant="accent"
              onPress={() => router.push('/manage/approvals')}
            />
          ) : null}
        </>
      }
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void queryClient.invalidateQueries()}
          tintColor={colour.accent}
        />
      }
    >
      <Appear index={1}>
        <StatRow>
          {attendance.data ? (
            <Stat
              label="In today"
              value={`${inToday}/${headcount}`}
              tone={inToday === headcount ? 'success' : 'default'}
            />
          ) : (
            <Card style={styles.statSkeleton}>
              <Skeleton height={12} width={56} />
              <Skeleton height={24} width={40} />
            </Card>
          )}
          <Stat label="On leave" value={calendar.data ? onLeave : '—'} />
          <Stat
            label="Flags"
            value={attendance.data ? flags.length : '—'}
            tone={flags.length > 0 ? 'warning' : 'default'}
          />
        </StatRow>
      </Appear>

      {queue.slice(0, 2).map((a, i) => (
        <Appear key={a.id} index={2 + i}>
          <Card onPress={() => router.push('/manage/approvals')}>
            <View style={styles.row}>
              <Avatar name={a.employeeName} size={40} colour={colour.primary} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.rowTitle}>
                  {a.employeeName.split(' ')[0]} · {a.leaveTypeName.toLowerCase()}
                </Text>
                <Text style={[styles.rowSub, { color: colour.danger }]}>
                  {a.warnings.length > 0
                    ? `${a.warnings.length} conflict${a.warnings.length === 1 ? '' : 's'} · `
                    : ''}
                  {Math.max(0, Math.round(ESCALATION_HOURS - a.waitingHours))}h left
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </View>
          </Card>
        </Appear>
      ))}

      {flags.slice(0, 2).map((r, i) => (
        <Appear key={r.employeeId} index={4 + i}>
          <Card onPress={() => router.push('/manage/attendance')}>
            <View style={styles.row}>
              <View style={styles.flagMark}>
                <Text style={styles.flagGlyph}>!</Text>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.rowTitle}>
                  {r.employeeName.split(' ')[0]} · {r.daysLate} late{r.daysLate === 1 ? '' : 's'}
                </Text>
                <Text style={[styles.rowSub, { color: colour.warning }]}>
                  Talk before it reaches {threshold}
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </View>
          </Card>
        </Appear>
      ))}

      {ownLine ? (
        <Appear index={6}>
          <Pressable
            onPress={() => router.push('/checkin')}
            accessibilityRole="button"
            style={styles.ownRow}
          >
            <View style={styles.ownDot} />
            <Text style={styles.ownTitle}>{ownLine}</Text>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        </Appear>
      ) : null}

      {needs === 0 && attendance.data ? (
        <Appear index={3}>
          <Divider />
          <Text style={styles.quiet}>
            Approvals and lateness flags appear here as they come in.
          </Text>
        </Appear>
      ) : null}
    </SheetPage>
  )
}

const WORDS: Record<number, string> = {
  2: 'Two',
  3: 'Three',
  4: 'Four',
  5: 'Five',
  6: 'Six',
  7: 'Seven',
  8: 'Eight',
  9: 'Nine',
}

const styles = StyleSheet.create({
  escalates: {
    fontSize: font.size.lg,
    color: colour.accent,
    fontFamily: font.family,
  },

  statSkeleton: { flex: 1, gap: space.sm },

  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rowTitle: {
    fontSize: font.size.md,
    fontWeight: font.weight.bold,
    color: colour.text,
    fontFamily: font.family,
  },
  rowSub: { fontSize: font.size.sm, fontFamily: font.family },
  chevron: { fontSize: font.size.xl, color: colour.textFaint, fontFamily: font.family },

  flagMark: { width: 40, alignItems: 'center' },
  flagGlyph: {
    fontSize: font.size.xl,
    fontWeight: font.weight.bold,
    color: colour.warning,
    fontFamily: font.family,
  },

  ownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
  },
  ownDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colour.primary },
  ownTitle: {
    flex: 1,
    fontSize: font.size.md,
    fontWeight: font.weight.semibold,
    color: colour.text,
    fontFamily: font.family,
  },

  quiet: {
    fontSize: font.size.sm,
    color: colour.textFaint,
    textAlign: 'center',
    fontFamily: font.family,
  },
})
