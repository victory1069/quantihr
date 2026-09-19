/**
 * Team attendance (spec §5): weekly summary, drill-down per employee,
 * employees approaching a lateness threshold flagged.
 *
 * The flag is informational in the MVP — the query engine that would act on it
 * is deliberately out of scope until attendance data has run clean for a month
 * (spec §1). The screen says so, so nobody mistakes it for a disciplinary tool.
 */

import { useMemo, useState } from 'react'
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useQueryClient } from '@tanstack/react-query'
import { addDays, type ISODate } from '@quanti/shared'
import {
  Badge,
  Card,
  Divider,
  EmptyState,
  ErrorNotice,
  Screen,
  Skeleton,
} from '../../src/ui/components'
import { colour, font, space, statusLabel } from '../../src/ui/theme'
import { keys, useTeamAttendance } from '../../src/api/queries'
import { api } from '../../src/api/client'
import { isManager, useSession } from '../../src/store/session'
import { useQuery } from '@tanstack/react-query'

export default function TeamAttendance() {
  const queryClient = useQueryClient()
  const me = useSession((s) => s.me)
  const canManage = isManager(me)
  const [weeksBack, setWeeksBack] = useState(0)
  const [drilldown, setDrilldown] = useState<{ id: string; name: string } | null>(null)

  const { from, to, label } = useMemo(() => weekBounds(weeksBack), [weeksBack])
  const summary = useTeamAttendance(from, to, canManage)

  const detail = useQuery({
    queryKey: ['team', 'attendance', 'detail', drilldown?.id, from, to],
    queryFn: () =>
      api.get<{ records: DetailRecord[] }>(
        `/v1/team/attendance/${drilldown!.id}?from=${from}&to=${to}`,
      ),
    enabled: !!drilldown,
  })

  if (!canManage) {
    return (
      <Screen>
        <EmptyState title="Manager access only" />
      </Screen>
    )
  }

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={summary.isRefetching}
          onRefresh={() =>
            void queryClient.invalidateQueries({ queryKey: keys.teamAttendance(from, to) })
          }
          tintColor={colour.primary}
        />
      }
    >
      <Text style={styles.title}>Team attendance</Text>

      <Card>
        <View style={styles.weekNav}>
          <Pressable onPress={() => setWeeksBack((w) => w + 1)} style={styles.navButton}>
            <Text style={styles.navText}>‹</Text>
          </Pressable>
          <Text style={styles.weekLabel}>{label}</Text>
          <Pressable
            onPress={() => setWeeksBack((w) => Math.max(0, w - 1))}
            style={[styles.navButton, weeksBack === 0 && styles.navDisabled]}
            disabled={weeksBack === 0}
          >
            <Text style={styles.navText}>›</Text>
          </Pressable>
        </View>
      </Card>

      {summary.data ? (
        summary.data.rows.length > 0 ? (
          <Card>
            {summary.data.rows.map((row, i) => (
              <View key={row.employeeId}>
                {i > 0 ? <Divider /> : null}
                <Pressable
                  onPress={() =>
                    setDrilldown(
                      drilldown?.id === row.employeeId
                        ? null
                        : { id: row.employeeId, name: row.employeeName },
                    )
                  }
                  style={styles.personRow}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.personName}>{row.employeeName}</Text>
                    <Text style={styles.personMeta}>
                      {row.daysPresent} on time · {row.daysLate} late
                      {row.totalMinutesLate > 0 ? ` · ${row.totalMinutesLate} min total` : ''}
                    </Text>
                  </View>
                  {row.approachingThreshold ? (
                    <Badge label="Watch" tone="warning" />
                  ) : (
                    <Badge label="Fine" tone="success" />
                  )}
                </Pressable>

                {drilldown?.id === row.employeeId ? (
                  <View style={styles.drilldown}>
                    {detail.data ? (
                      detail.data.records.length > 0 ? (
                        detail.data.records.map((r) => (
                          <View key={r.date} style={styles.detailRow}>
                            <Text style={styles.detailDate}>{r.date}</Text>
                            <Text style={styles.detailTime}>
                              {r.checkedInAt
                                ? new Date(r.checkedInAt).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })
                                : '—'}
                            </Text>
                            <Text
                              style={[
                                styles.detailStatus,
                                r.status === 'late' && { color: colour.warning },
                                r.status === 'rejected' && { color: colour.danger },
                              ]}
                            >
                              {statusLabel(r.status)}
                              {r.minutesLate > 0 ? ` (+${r.minutesLate}m)` : ''}
                              {r.recordedOffline ? ' · offline' : ''}
                            </Text>
                          </View>
                        ))
                      ) : (
                        <Text style={styles.personMeta}>No records in this week.</Text>
                      )
                    ) : (
                      <Skeleton height={48} />
                    )}
                  </View>
                ) : null}
              </View>
            ))}
          </Card>
        ) : (
          <EmptyState title="No one reports to you yet" />
        )
      ) : (
        <Card>
          <Skeleton height={100} />
        </Card>
      )}

      {summary.data ? (
        <ErrorNotice
          tone="info"
          message={`"Watch" appears at ${summary.data.latenessThreshold} or more late arrivals in the period. It is informational only — Quanti HR does not generate disciplinary letters in this version.`}
        />
      ) : null}
    </Screen>
  )
}

interface DetailRecord {
  date: string
  status: string
  checkedInAt: string | null
  minutesLate: number
  recordedOffline: boolean
  rejectionReason: string | null
}

/** Monday-to-Sunday week, `weeksBack` weeks ago. */
function weekBounds(weeksBack: number): { from: ISODate; to: ISODate; label: string } {
  const today = new Date().toISOString().slice(0, 10) as ISODate
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay()
  const mondayOffset = dow === 0 ? -6 : 1 - dow
  const monday = addDays(today, mondayOffset - weeksBack * 7)
  const sunday = addDays(monday, 6)
  return {
    from: monday,
    to: sunday,
    label:
      weeksBack === 0
        ? `This week · ${monday} → ${sunday}`
        : `${monday} → ${sunday}`,
  }
}

const styles = StyleSheet.create({
  title: {
    fontSize: font.size.xxl,
    fontWeight: font.weight.bold,
    color: colour.text,
    paddingTop: space.lg,
  },
  weekNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  navButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colour.surfaceRaised,
  },
  navDisabled: { opacity: 0.4 },
  navText: { fontSize: 22, color: colour.text, lineHeight: 23 },
  weekLabel: { fontSize: font.size.sm, fontWeight: font.weight.semibold, color: colour.text },

  personRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  personName: { fontSize: font.size.md, fontWeight: font.weight.medium, color: colour.text },
  personMeta: { fontSize: font.size.sm, color: colour.textMuted },

  drilldown: {
    backgroundColor: colour.surfaceRaised,
    borderRadius: 8,
    padding: space.md,
    gap: space.xs,
    marginBottom: space.sm,
  },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  detailDate: { fontSize: font.size.sm, color: colour.text, width: 96 },
  detailTime: { fontSize: font.size.sm, color: colour.textMuted, width: 64 },
  detailStatus: { fontSize: font.size.sm, color: colour.success, flex: 1 },
})
