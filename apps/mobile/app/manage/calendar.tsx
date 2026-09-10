/**
 * Team calendar (spec §5): month view, who is off, what is scheduled, coverage
 * gaps highlighted.
 *
 * Rendered as a real month grid rather than a list, because the question a
 * manager actually has is "which week is thin", and a list of date ranges does
 * not answer that.
 *
 * Leave and meetings share the grid on purpose. They are the same question
 * asked twice — a briefing on a day three people are off is a problem you want
 * to see while looking at the day, not after scheduling it.
 *
 * The two are marked differently rather than by colour alone: leave shows as
 * dots, meetings as a bar under the date. Colour-only encoding fails for the
 * people most likely to be scanning a rota quickly.
 */

import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { addDays, eachDay, type ISODate } from '@quanti/shared'
import {
  Badge,
  Card,
  EmptyState,
  Fab,
  Screen,
  SectionTitle,
  Skeleton,
} from '../../src/ui/components'
import { colour, font, radius, space } from '../../src/ui/theme'
import { useMe, useMeetings, useTeamCalendar } from '../../src/api/queries'
import { isManager, useSession } from '../../src/store/session'

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

export default function TeamCalendar() {
  const router = useRouter()
  // Same reason as the approvals screen: `me` is null both before it loads and
  // when the account is not a manager. Gating the create action on the
  // undifferentiated value meant the button simply never appeared on a cold
  // start, with nothing to explain why.
  const meQuery = useMe()
  const me = useSession((s) => s.me) ?? meQuery.data ?? null
  const canManage = isManager(me)
  const [monthOffset, setMonthOffset] = useState(0)

  const { first, last, label } = useMemo(() => monthBounds(monthOffset), [monthOffset])
  const calendar = useTeamCalendar(first, last, true)
  const [selected, setSelected] = useState<ISODate | null>(null)

  const byDate = useMemo(() => {
    const map = new Map<string, { name: string; colour: string; type: string }[]>()
    for (const entry of calendar.data?.entries ?? []) {
      for (const day of eachDay(entry.start as ISODate, entry.end as ISODate)) {
        if (day < first || day > last) continue
        if (!map.has(day)) map.set(day, [])
        map.get(day)!.push({
          name: entry.employeeName,
          colour: entry.colour,
          type: entry.leaveTypeName,
        })
      }
    }
    return map
  }, [calendar.data, first, last])

  const gapByDate = useMemo(
    () => new Map((calendar.data?.gaps ?? []).map((g) => [g.date, g])),
    [calendar.data],
  )

  const meetings = useMeetings('upcoming')

  const meetingsByDate = useMemo(() => {
    const map = new Map<string, { id: string; title: string; source: string; at: string }[]>()
    for (const m of meetings.data?.meetings ?? []) {
      const day = m.scheduledStart.slice(0, 10)
      if (day < first || day > last) continue
      if (!map.has(day)) map.set(day, [])
      map.get(day)!.push({
        id: m.id,
        title: m.title,
        source: m.source,
        at: new Date(m.scheduledStart).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        }),
      })
    }
    return map
  }, [meetings.data, first, last])

  const cells = useMemo(() => buildGrid(first, last), [first, last])

  return (
    <Screen
      floating={
        canManage ? (
          <Fab label="Create a meeting" onPress={() => router.push('/meetings/new')} />
        ) : null
      }
    >
      <Text style={styles.title}>Team calendar</Text>

      <Card>
        <View style={styles.monthNav}>
          <Pressable
            onPress={() => setMonthOffset((m) => m - 1)}
            style={styles.navButton}
            accessibilityLabel="Previous month"
          >
            <Text style={styles.navText}>‹</Text>
          </Pressable>
          <Text style={styles.monthLabel}>{label}</Text>
          <Pressable
            onPress={() => setMonthOffset((m) => m + 1)}
            style={styles.navButton}
            accessibilityLabel="Next month"
          >
            <Text style={styles.navText}>›</Text>
          </Pressable>
        </View>

        <View style={styles.weekRow}>
          {WEEKDAYS.map((d, i) => (
            <Text key={i} style={styles.weekday}>
              {d}
            </Text>
          ))}
        </View>

        {calendar.data ? (
          <View style={styles.grid}>
            {cells.map((cell, i) => {
              if (!cell) return <View key={`pad-${i}`} style={styles.cell} />
              const away = byDate.get(cell) ?? []
              const booked = meetingsByDate.get(cell) ?? []
              const gap = gapByDate.get(cell)
              const isSelected = selected === cell
              return (
                <Pressable
                  key={cell}
                  onPress={() => setSelected(isSelected ? null : cell)}
                  style={[
                    styles.cell,
                    away.length > 0 && styles.cellHasLeave,
                    gap?.breached && styles.cellBreached,
                    isSelected && styles.cellSelected,
                  ]}
                  accessibilityLabel={`${cell}, ${away.length} away`}
                >
                  <Text style={[styles.cellDay, gap?.breached && styles.cellDayBreached]}>
                    {Number(cell.slice(8, 10))}
                  </Text>
                  <View style={styles.dots}>
                    {away.slice(0, 3).map((a, j) => (
                      <View key={j} style={[styles.dot, { backgroundColor: a.colour }]} />
                    ))}
                    {away.length > 3 ? <Text style={styles.more}>+{away.length - 3}</Text> : null}
                  </View>
                  {booked.length > 0 ? <View style={styles.meetingBar} /> : null}
                </Pressable>
              )
            })}
          </View>
        ) : (
          <Skeleton height={220} />
        )}

        <View style={styles.legend}>
          <View style={styles.legendItem}>
            <View style={[styles.legendSwatch, { backgroundColor: colour.primarySoft }]} />
            <Text style={styles.legendText}>Someone away</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendSwatch, { backgroundColor: colour.dangerSoft }]} />
            <Text style={styles.legendText}>Over coverage limit</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={styles.legendBar} />
            <Text style={styles.legendText}>Meeting</Text>
          </View>
        </View>
      </Card>

      {selected ? (
        <>
          <SectionTitle>{selected}</SectionTitle>
          <Card>
            {(byDate.get(selected) ?? []).length > 0 ? (
              (byDate.get(selected) ?? []).map((a, i) => (
                <View key={i} style={styles.awayRow}>
                  <View style={[styles.dot, { backgroundColor: a.colour }]} />
                  <Text style={styles.awayName}>{a.name}</Text>
                  <Text style={styles.awayType}>{a.type}</Text>
                </View>
              ))
            ) : (
              <Text style={styles.noneAway}>Everyone is in.</Text>
            )}
            {gapByDate.get(selected)?.breached ? (
              <Badge
                label={`${gapByDate.get(selected)!.absentCount} away, limit is ${gapByDate.get(selected)!.limit}`}
                tone="danger"
              />
            ) : null}
          </Card>

          {(meetingsByDate.get(selected) ?? []).length > 0 ? (
            <Card>
              <SectionTitle>Scheduled</SectionTitle>
              {(meetingsByDate.get(selected) ?? []).map((m) => (
                <Pressable
                  key={m.id}
                  onPress={() => router.push(`/meetings/${m.id}`)}
                  accessibilityRole="button"
                  style={styles.meetingRow}
                >
                  <View style={styles.meetingDot} />
                  <Text style={styles.meetingTitle} numberOfLines={1}>
                    {m.title}
                  </Text>
                  <Text style={styles.meetingMeta}>
                    {m.at} · {m.source === 'in_person' ? 'In person' : 'Virtual'}
                  </Text>
                </Pressable>
              ))}
            </Card>
          ) : null}
        </>
      ) : null}

      {calendar.data && calendar.data.entries.length === 0 ? (
        <EmptyState
          title="No leave booked this month"
          body={
            canManage
              ? 'Approved and pending leave for your team will show here.'
              : 'Leave for people on your team will show here.'
          }
        />
      ) : null}
    </Screen>
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
    first: firstDate.toISOString().slice(0, 10),
    last: lastDate.toISOString().slice(0, 10),
    label: firstDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
  }
}

/** Pads the grid so the first day lands under the right weekday column. */
function buildGrid(first: ISODate, last: ISODate): (ISODate | null)[] {
  const firstDow = new Date(`${first}T00:00:00Z`).getUTCDay()
  const days = eachDay(first, last)
  return [...Array<null>(firstDow).fill(null), ...days]
}

const styles = StyleSheet.create({
  title: {
    fontSize: font.size.xxl,
    fontWeight: font.weight.bold,
    color: colour.text,
    paddingTop: space.lg,
  },
  monthNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  navButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: colour.surfaceSunken,
  },
  navText: { fontSize: 22, color: colour.text, lineHeight: 26 },
  monthLabel: { fontSize: font.size.lg, fontWeight: font.weight.semibold, color: colour.text },

  weekRow: { flexDirection: 'row' },
  weekday: {
    flex: 1,
    textAlign: 'center',
    fontSize: font.size.xs,
    color: colour.textFaint,
    fontWeight: font.weight.semibold,
  },

  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {
    width: `${100 / 7}%`,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    gap: 2,
  },
  cellHasLeave: { backgroundColor: colour.primarySoft },
  cellBreached: { backgroundColor: colour.dangerSoft },
  cellSelected: { borderWidth: 2, borderColor: colour.primary },
  cellDay: { fontSize: font.size.sm, color: colour.text },
  cellDayBreached: { color: colour.danger, fontWeight: font.weight.semibold },

  dots: { flexDirection: 'row', gap: 2, alignItems: 'center', minHeight: 8 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  more: { fontSize: 9, color: colour.textMuted },
  // A bar rather than another dot: leave and meetings must be distinguishable
  // without relying on colour.
  meetingBar: {
    height: 2,
    width: '55%',
    borderRadius: 1,
    backgroundColor: colour.pending,
  },

  legend: { flexDirection: 'row', gap: space.lg, paddingTop: space.sm },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  legendSwatch: { width: 12, height: 12, borderRadius: 3 },
  legendText: { fontSize: font.size.xs, color: colour.textMuted },
  legendBar: { width: 12, height: 2, borderRadius: 1, backgroundColor: colour.pending },

  meetingRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  meetingDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colour.pending },
  meetingTitle: { flex: 1, fontSize: font.size.md, color: colour.text, fontFamily: font.family },
  meetingMeta: { fontSize: font.size.sm, color: colour.textMuted, fontFamily: font.family },

  awayRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs },
  awayName: { fontSize: font.size.md, color: colour.text, flex: 1 },
  awayType: { fontSize: font.size.sm, color: colour.textMuted },
  noneAway: { fontSize: font.size.md, color: colour.textMuted },
})
