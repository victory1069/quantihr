/**
 * Leave overview (spec §5): balance by type, request history, new request.
 */

import { RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import {
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  Screen,
  SectionTitle,
  Skeleton,
} from '../../src/ui/components'
import { colour, font, space, statusColour, statusLabel } from '../../src/ui/theme'
import { keys, useBalances, useLeaveRequests } from '../../src/api/queries'

export default function LeaveIndex() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const balances = useBalances()
  const requests = useLeaveRequests()

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={balances.isRefetching || requests.isRefetching}
          onRefresh={() => {
            void queryClient.invalidateQueries({ queryKey: keys.balances })
            void queryClient.invalidateQueries({ queryKey: ['leave', 'requests'] })
          }}
          tintColor={colour.primary}
        />
      }
    >
      <View style={styles.header}>
        <Text style={styles.title}>Leave</Text>
        <Button label="Request leave" onPress={() => router.push('/leave/new')} />
      </View>

      <SectionTitle>Your balances</SectionTitle>

      {balances.data ? (
        balances.data.balances.map((b) => (
          <Card key={b.leaveTypeId}>
            <View style={styles.balanceHead}>
              <View style={styles.balanceName}>
                <View style={[styles.swatch, { backgroundColor: b.colour }]} />
                <Text style={styles.typeName}>{b.leaveTypeName}</Text>
              </View>
              <Text style={styles.big}>
                {b.available}
                <Text style={styles.bigUnit}> available</Text>
              </Text>
            </View>

            <View style={styles.breakdown}>
              <Stat label="Accrued" value={b.accrued} />
              <Stat label="Carried over" value={b.carriedOver} />
              <Stat label="Taken" value={b.taken} />
              <Stat label="Pending" value={b.pending} />
              {b.adjustment !== 0 ? <Stat label="Adjustment" value={b.adjustment} /> : null}
            </View>

            <Text style={styles.period}>
              Leave year {b.periodStart} → {b.periodEnd}
            </Text>

            {b.carryoverExpiresOn && b.carriedOver > 0 ? (
              <Text style={styles.expiry}>
                {b.carriedOver} carried-over day(s) expire on {b.carryoverExpiresOn}.
              </Text>
            ) : null}
          </Card>
        ))
      ) : (
        <Card>
          <Skeleton height={24} />
          <Skeleton height={48} />
        </Card>
      )}

      <SectionTitle>History</SectionTitle>
      <Card>
        {requests.data ? (
          requests.data.requests.length > 0 ? (
            requests.data.requests.map((r, i) => (
              <View key={r.id}>
                {i > 0 ? <Divider /> : null}
                <View style={styles.requestRow} onStartShouldSetResponder={() => false}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.requestTitle}>{r.leaveTypeName}</Text>
                    <Text style={styles.requestDates}>
                      {r.start} → {r.end} · {r.daysCount} day(s)
                    </Text>
                    {r.decisionNote ? (
                      <Text style={styles.note}>“{r.decisionNote}”</Text>
                    ) : null}
                  </View>
                  <Badge
                    label={statusLabel(r.status)}
                    tone={
                      r.status === 'approved'
                        ? 'success'
                        : r.status === 'declined'
                          ? 'danger'
                          : r.status === 'cancelled'
                            ? 'neutral'
                            : 'pending'
                    }
                    dot={statusColour(r.status)}
                  />
                </View>
                <Text
                  style={styles.viewLink}
                  onPress={() => router.push(`/leave/${r.id}`)}
                  accessibilityRole="link"
                >
                  View details
                </Text>
              </View>
            ))
          ) : (
            <EmptyState
              title="No leave requested yet"
              body="When you request leave it will show here with its status."
              action={<Button label="Request leave" onPress={() => router.push('/leave/new')} />}
            />
          )
        ) : (
          <Skeleton height={60} />
        )}
      </Card>
    </Screen>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  header: { paddingTop: space.lg, gap: space.md },
  title: { fontSize: font.size.xxl, fontWeight: font.weight.bold, color: colour.text },

  balanceHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.md },
  balanceName: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flex: 1 },
  swatch: { width: 12, height: 12, borderRadius: 6 },
  typeName: { fontSize: font.size.lg, fontWeight: font.weight.semibold, color: colour.text },
  big: { fontSize: font.size.xxl, fontWeight: font.weight.bold, color: colour.text },
  bigUnit: { fontSize: font.size.sm, fontWeight: font.weight.regular, color: colour.textMuted },

  breakdown: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.lg,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: colour.border,
  },
  stat: { minWidth: 72 },
  statValue: { fontSize: font.size.lg, fontWeight: font.weight.semibold, color: colour.text },
  statLabel: { fontSize: font.size.xs, color: colour.textMuted, marginTop: 2 },

  period: { fontSize: font.size.sm, color: colour.textFaint },
  expiry: { fontSize: font.size.sm, color: colour.warning },

  requestRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingTop: space.sm },
  requestTitle: { fontSize: font.size.md, fontWeight: font.weight.medium, color: colour.text },
  requestDates: { fontSize: font.size.sm, color: colour.textMuted },
  note: { fontSize: font.size.sm, color: colour.textMuted, fontStyle: 'italic', marginTop: 2 },
  viewLink: {
    fontSize: font.size.sm,
    color: colour.primary,
    fontWeight: font.weight.semibold,
    paddingVertical: space.sm,
  },
})
