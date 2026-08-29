/**
 * Team calendar (spec §5): month view, who is off, coverage gaps highlighted.
 *
 * Rendered as a real month grid rather than a list, because the question a
 * manager actually has is "which week is thin", and a list of date ranges does
 * not answer that.
 */

import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { addDays, eachDay, type ISODate } from '@quanti/shared'
import { Badge, Card, EmptyState, Screen, SectionTitle, Skeleton } from '../../src/ui/components'
import { colour, font, radius, space } from '../../src/ui/theme'
import { useTeamCalendar } from '../../src/api/queries'
import { isManager, useSession } from '../../src/store/session'

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

export default function TeamCalendar() {
  const me = useSession((s) => s.me)
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

  const cells = useMemo(() => buildGrid(first, last), [first, last])

  return (
    <Screen>
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
    backgroundColor: colour.surfaceAlt,
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

  legend: { flexDirection: 'row', gap: space.lg, paddingTop: space.sm },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  legendSwatch: { width: 12, height: 12, borderRadius: 3 },
  legendText: { fontSize: font.size.xs, color: colour.textMuted },

  awayRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs },
  awayName: { fontSize: font.size.md, color: colour.text, flex: 1 },
  awayType: { fontSize: font.size.sm, color: colour.textMuted },
  noneAway: { fontSize: font.size.md, color: colour.textMuted },
})
