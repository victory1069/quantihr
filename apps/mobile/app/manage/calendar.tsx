/**
 * Team calendar — who is away, and where cover breaks (spec §6).
 *
 * Working days only. A five-column month is what a manager plans against;
 * the weekends were empty tiles that made every row wider and every number
 * smaller. Each tile carries one of three states: nobody away, someone away
 * (teal), or more away than the coverage rule allows (pink). The breaches
 * get a card of their own under the grid, because a pink tile says *that*
 * something is wrong and the manager needs to know *what* to do about it.
 *
 * "Off this week" is the list a manager actually consults on a Monday.
 */

import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { addDays, eachDay, type ISODate } from '@quanti/shared'
import { Appear, Card, EmptyState, Fab, SheetPage, Skeleton } from '../../src/ui/components'
import { Avatar, Label } from '../../src/ui/primitives'
import { colour, font, radius, space } from '../../src/ui/theme'
import { useMe, useMeetings, useTeamCalendar } from '../../src/api/queries'
import { isManager, useSession } from '../../src/store/session'
import { formatRange, formatWeekdays } from '../../src/lib/dates'

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F']

export default function TeamCalendar() {
  const router = useRouter()
  const meQuery = useMe()
  const me = useSession((s) => s.me) ?? meQuery.data ?? null
  const canManage = isManager(me)
  const [monthOffset, setMonthOffset] = useState(0)

  const { first, last, label } = useMemo(() => monthBounds(monthOffset), [monthOffset])
  const calendar = useTeamCalendar(first, last, true)
  const meetings = useMeetings('upcoming')
  const [selected, setSelected] = useState<ISODate | null>(null)

  const today = new Date().toISOString().slice(0, 10) as ISODate
  const week = useMemo(() => weekBounds(today), [today])

  const byDate = useMemo(() => {
    const map = new Map<string, { name: string; colour: string; type: string }[]>()
    for (const entry of calendar.data?.entries ?? []) {
      for (const day of eachDay(entry.start as ISODate, entry.end as ISODate)) {
        if (day < first || day > last) continue
        if (!map.has(day)) map.set(day, [])
        map.get(day)!.push({ name: entry.employeeName, colour: entry.colour, type: entry.leaveTypeName })
      }
    }
    return map
  }, [calendar.data, first, last])

  const gapByDate = useMemo(
    () => new Map((calendar.data?.gaps ?? []).map((g) => [g.date, g])),
    [calendar.data],
  )
  const meetingDays = useMemo(
    () => new Set((meetings.data?.meetings ?? []).map((m) => m.scheduledStart.slice(0, 10))),
    [meetings.data],
  )

  // Consecutive breached days become one gap: "29–30 Sep", not two cards.
  const gaps = useMemo(() => {
    const breached = (calendar.data?.gaps ?? [])
      .filter((g) => g.breached)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
    const runs: { start: string; end: string; absent: number; limit: number | null }[] = []
    for (const g of breached) {
      const last = runs[runs.length - 1]
      if (last && addDays(last.end as ISODate, 1) === g.date) {
        last.end = g.date
        last.absent = Math.max(last.absent, g.absentCount)
      } else {
        runs.push({ start: g.date, end: g.date, absent: g.absentCount, limit: g.limit })
      }
    }
    return runs
  }, [calendar.data])

  const offThisWeek = useMemo(
    () =>
      (calendar.data?.entries ?? [])
        .filter((e) => e.status === 'approved' && e.start <= week.end && e.end >= week.start)
        .sort((a, b) => (a.start < b.start ? -1 : 1)),
    [calendar.data, week],
  )

  const weeks = useMemo(() => buildWeeks(first, last), [first, last])
  const headcount = calendar.data?.headcount

  return (
    <SheetPage
      tone={canManage ? 'manager' : 'default'}
      eyebrow="Team"
      eyebrowTrailing={
        <View style={styles.nav}>
          <Pressable
            onPress={() => setMonthOffset((m) => m - 1)}
            style={styles.navButton}
            accessibilityLabel="Previous month"
          >
            <Text style={styles.navText}>‹</Text>
          </Pressable>
          <Pressable
            onPress={() => setMonthOffset((m) => m + 1)}
            style={styles.navButton}
            accessibilityLabel="Next month"
          >
            <Text style={styles.navText}>›</Text>
          </Pressable>
        </View>
      }
      title={label}
      heroBody={
        headcount ? (
          <Text style={styles.headcount}>{`TEAM · ${headcount}`}</Text>
        ) : undefined
      }
      floating={
        canManage ? <Fab label="Create a meeting" onPress={() => router.push('/meetings/new')} /> : null
      }
    >
      <View style={styles.weekRow}>
        {WEEKDAYS.map((d, i) => (
          <Text key={i} style={styles.weekday}>
            {d}
          </Text>
        ))}
      </View>

      {calendar.data ? (
        <View style={styles.grid}>
          {weeks.map((row, r) => (
            <View key={r} style={styles.gridRow}>
              {row.map((cell, i) => {
                if (!cell) return <View key={`pad-${r}-${i}`} style={styles.tileEmpty} />
                const away = byDate.get(cell) ?? []
                const gap = gapByDate.get(cell)
                const state = gap?.breached ? 'breached' : away.length > 0 ? 'away' : 'clear'
                const isSelected = selected === cell
                const isToday = cell === today
                return (
                  <Pressable
                    key={cell}
                    onPress={() => setSelected(isSelected ? null : cell)}
                    style={[
                      styles.tile,
                      state === 'away' && styles.tileAway,
                      state === 'breached' && styles.tileBreached,
                      isSelected && styles.tileSelected,
                    ]}
                    accessibilityLabel={`${cell}, ${away.length} away`}
                  >
                    <Text
                      style={[
                        styles.tileDay,
                        state === 'away' && { color: colour.primary },
                        state === 'breached' && { color: colour.danger },
                        isToday && styles.tileToday,
                      ]}
                    >
                      {Number(cell.slice(8, 10))}
                    </Text>
                    {meetingDays.has(cell) ? <View style={styles.meetingBar} /> : null}
                  </Pressable>
                )
              })}
            </View>
          ))}
        </View>
      ) : (
        <Skeleton height={260} />
      )}

      {selected ? (
        <Appear>
          <Card>
            <Label>{formatRange(selected, selected)}</Label>
            {(byDate.get(selected) ?? []).length > 0 ? (
              (byDate.get(selected) ?? []).map((a, i) => (
                <View key={i} style={styles.awayRow}>
                  <View style={[styles.dot, { backgroundColor: a.colour }]} />
                  <Text style={styles.awayName}>{a.name}</Text>
                  <Text style={styles.awayType}>{a.type}</Text>
                </View>
              ))
            ) : (
              <Text style={styles.muted}>Everyone is in.</Text>
            )}
          </Card>
        </Appear>
      ) : null}

      {gaps.map((g, i) => (
        <Appear key={g.start} index={i}>
          <Card tone="danger">
            <Text style={styles.gapTitle}>Coverage gap · {formatRange(g.start, g.end)}</Text>
            <Text style={styles.gapBody}>
              {g.absent} away{g.limit !== null ? `, limit is ${g.limit}` : ''}. Decline one, or
              arrange cover.
            </Text>
          </Card>
        </Appear>
      ))}

      {calendar.data ? (
        <>
          <Label>Off this week</Label>
          {offThisWeek.length > 0 ? (
            offThisWeek.map((e, i) => (
              <View key={`${e.employeeId}-${e.start}`} style={styles.offRow}>
                <Avatar name={e.employeeName} size={36} />
                <Text style={styles.offName}>
                  {e.employeeName.split(' ')[0]} · {e.leaveTypeName.toLowerCase()}
                </Text>
                <Text style={styles.offWhen}>
                  {formatWeekdays(
                    e.start < week.start ? week.start : e.start,
                    e.end > week.end ? week.end : e.end,
                    today,
                  )}
                </Text>
              </View>
            ))
          ) : (
            <Text style={styles.muted}>Nobody is off this week.</Text>
          )}
        </>
      ) : null}

      {calendar.data && calendar.data.entries.length === 0 && gaps.length === 0 ? (
        <EmptyState
          title="No leave booked this month"
          body="Approved and pending leave for your team will show here."
        />
      ) : null}
    </SheetPage>
  )
}

function monthBounds(offset: number): { first: ISODate; last: ISODate; label: string } {
  const now = new Date()
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1))
  const year = base.getUTCFullYear()
  const month = base.getUTCMonth()
  const firstDate = new Date(Date.UTC(year, month, 1))
  const lastDate = new Date(Date.UTC(year, month + 1, 0))
  return {
    first: firstDate.toISOString().slice(0, 10) as ISODate,
    last: lastDate.toISOString().slice(0, 10) as ISODate,
    label: firstDate.toLocaleDateString(undefined, { month: 'long' }),
  }
}

/** Monday to Sunday around a date. */
function weekBounds(day: ISODate): { start: ISODate; end: ISODate } {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay() // 0 = Sunday
  const back = dow === 0 ? 6 : dow - 1
  const start = addDays(day, -back)
  return { start, end: addDays(start, 6) }
}

/** Rows of Mon–Fri; weekends dropped, the first row padded to its weekday. */
function buildWeeks(first: ISODate, last: ISODate): (ISODate | null)[][] {
  const rows: (ISODate | null)[][] = []
  let row: (ISODate | null)[] = []
  const firstDow = new Date(`${first}T00:00:00Z`).getUTCDay()
  const pad = firstDow === 0 ? 0 : firstDow === 6 ? 0 : firstDow - 1
  for (let i = 0; i < pad; i += 1) row.push(null)
  for (const day of eachDay(first, last)) {
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay()
    if (dow === 0 || dow === 6) continue
    if (dow === 1 && row.length > 0) {
      rows.push(row)
      row = []
    }
    row.push(day)
  }
  if (row.length > 0) {
    while (row.length < 5) row.push(null)
    rows.push(row)
  }
  return rows
}

const styles = StyleSheet.create({
  headcount: {
    fontSize: font.size.sm,
    letterSpacing: font.tracking.label,
    color: colour.textMuted,
    fontFamily: font.mono,
  },
  nav: { flexDirection: 'row', gap: space.xs },
  navButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: colour.surfaceRaised,
  },
  navText: { fontSize: 20, color: colour.text, lineHeight: 22 },

  weekRow: { flexDirection: 'row', gap: space.sm, paddingHorizontal: 2 },
  weekday: {
    flex: 1,
    textAlign: 'center',
    fontSize: font.size.xs,
    letterSpacing: font.tracking.label,
    color: colour.textFaint,
    fontFamily: font.mono,
  },
  grid: { gap: space.sm },
  gridRow: { flexDirection: 'row', gap: space.sm },
  tile: {
    flex: 1,
    aspectRatio: 1.35,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: colour.surfaceRaised,
    gap: 3,
  },
  tileEmpty: { flex: 1, aspectRatio: 1.35 },
  tileAway: { backgroundColor: colour.primarySoft },
  tileBreached: { backgroundColor: colour.dangerSoft },
  tileSelected: { borderWidth: 2, borderColor: colour.primary },
  tileDay: { fontSize: font.size.md, color: colour.textMuted, fontFamily: font.mono },
  tileToday: { color: colour.text, fontWeight: font.weight.bold },
  meetingBar: { height: 2, width: 16, borderRadius: 1, backgroundColor: colour.pending },

  gapTitle: {
    fontSize: font.size.lg,
    fontWeight: font.weight.bold,
    color: colour.danger,
    fontFamily: font.family,
  },
  gapBody: { fontSize: font.size.md, color: colour.text, lineHeight: 20, fontFamily: font.family },

  offRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.xs },
  offName: { flex: 1, fontSize: font.size.lg, color: colour.text, fontFamily: font.family },
  offWhen: { fontSize: font.size.md, color: colour.textMuted, fontFamily: font.mono, textAlign: 'right' },

  awayRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs },
  dot: { width: 6, height: 6, borderRadius: 3 },
  awayName: { fontSize: font.size.md, color: colour.text, flex: 1, fontFamily: font.family },
  awayType: { fontSize: font.size.sm, color: colour.textMuted, fontFamily: font.family },
  muted: { fontSize: font.size.md, color: colour.textMuted, fontFamily: font.family },
})
