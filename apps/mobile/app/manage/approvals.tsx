/**
 * The manager's queue (spec §6).
 *
 * One list of everything that needs a decision or a conversation: leave
 * requests first, then people drifting towards the lateness threshold. Each
 * request card carries its own decision. A clean request can be approved
 * from the card; one with coverage conflicts opens the detail sheet, because
 * approving against a rule needs a written reason and that reason is
 * recorded against the manager's name.
 *
 * The 48-hour line is the product's promise to the employee: a request left
 * that long escalates. The headline counts down to it.
 */

import { useMemo, useState } from 'react'
import { RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError } from '@quanti/shared'
import {
  Appear,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Press,
  SheetPage,
  Skeleton,
} from '../../src/ui/components'
import { Avatar } from '../../src/ui/primitives'
import { colour, font, space } from '../../src/ui/theme'
import {
  keys,
  useApprovals,
  useDecideApproval,
  useMe,
  useTeamAttendance,
  useTeamTraining,
} from '../../src/api/queries'
import { isManager, useSession } from '../../src/store/session'
import { formatRange } from '../../src/lib/dates'

const ESCALATION_HOURS = 48

export default function Approvals() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const meQuery = useMe()
  const me = useSession((s) => s.me) ?? meQuery.data ?? null
  const canManage = isManager(me)
  const approvals = useApprovals(canManage)
  const decide = useDecideApproval()
  const [error, setError] = useState<{ id: string; message: string } | null>(null)

  // Lateness over the last 30 days — the window the threshold is judged on.
  const { from, to } = useMemo(() => {
    const today = new Date()
    const start = new Date(today)
    start.setDate(start.getDate() - 30)
    return { from: start.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) }
  }, [])
  const attendance = useTeamAttendance(from, to, canManage)
  const training = useTeamTraining(canManage)

  if (!me) {
    return (
      <SheetPage tone="manager" eyebrow="Manager mode" title="Loading">
        <Card>
          <Skeleton height={24} width={160} />
          <Skeleton height={64} />
        </Card>
      </SheetPage>
    )
  }

  if (!canManage) {
    return (
      <SheetPage title="Approvals">
        <EmptyState
          title="Manager access only"
          body="Your account does not have approval permissions."
        />
      </SheetPage>
    )
  }

  const queue = approvals.data?.approvals ?? []
  const threshold = attendance.data?.latenessThreshold ?? 3
  // Worth a word once they are one late arrival from the threshold.
  const flags = (attendance.data?.rows ?? []).filter(
    (r) => r.daysLate >= Math.max(1, threshold - 1),
  )

  const plansWaiting = (training.data?.plans ?? []).filter((p) => p.status === 'submitted')
  const needs = queue.length + flags.length + plansWaiting.length
  const oldest = queue.reduce((max, a) => Math.max(max, a.waitingHours), 0)
  const escalatesIn = queue.length > 0 ? Math.max(0, Math.round(ESCALATION_HOURS - oldest)) : null

  const approveClean = async (id: string) => {
    setError(null)
    try {
      await decide.mutateAsync({ id, decision: 'approve' })
    } catch (e) {
      setError({ id, message: e instanceof ApiError ? e.message : 'Could not record that decision.' })
    }
  }

  const declineFromCard = async (id: string) => {
    setError(null)
    try {
      await decide.mutateAsync({ id, decision: 'decline' })
    } catch (e) {
      setError({ id, message: e instanceof ApiError ? e.message : 'Could not record that decision.' })
    }
  }

  return (
    <SheetPage
      tone="manager"
      eyebrow="Manager mode"
      title={needs === 0 ? 'Nothing needs you' : `${needs} need you`}
      heroBody={
        escalatesIn !== null ? (
          <Text style={styles.escalates}>
            {escalatesIn === 0 ? '1 has passed the 48-hour mark' : `1 escalates in ${escalatesIn} hours`}
          </Text>
        ) : undefined
      }
      refreshControl={
        <RefreshControl
          refreshing={approvals.isRefetching}
          onRefresh={() => void queryClient.invalidateQueries({ queryKey: keys.approvals })}
          tintColor={colour.accent}
        />
      }
    >
      {approvals.data ? (
        queue.map((a, index) => {
          const conflicts = a.warnings.length
          const busy = decide.isPending && decide.variables?.id === a.id
          const first = a.employeeName.split(' ')[0]
          const open = () => router.push(`/manage/approvals/${a.id}`)
          return (
            <Appear key={a.id} index={index}>
              <Card>
                <Press onPress={open} scaleTo={0.99} accessibilityLabel={`Open ${a.employeeName}'s request`}>
                  <View style={styles.row}>
                    <Avatar
                      name={a.employeeName}
                      size={44}
                      colour={conflicts > 0 ? colour.primary : colour.accent}
                    />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.rowTitle}>
                        {first} · {a.leaveTypeName.toLowerCase()}
                      </Text>
                      <Text style={[styles.rowSub, conflicts > 0 && { color: colour.warning }]}>
                        {formatRange(a.start, a.end)} ·{' '}
                        {conflicts > 0
                          ? `${conflicts} conflict${conflicts === 1 ? '' : 's'}`
                          : 'no conflicts'}
                      </Text>
                    </View>
                  </View>
                </Press>

                {error?.id === a.id ? <ErrorNotice message={error.message} /> : null}

                <View style={styles.actions}>
                  {a.requiresOverride || conflicts > 0 ? (
                    <>
                      <Button label="Review" onPress={open} style={styles.grow} />
                      <Button
                        label="Decline"
                        variant="secondary"
                        loading={busy}
                        onPress={() => void declineFromCard(a.id)}
                      />
                    </>
                  ) : (
                    <>
                      <Button
                        label="Approve"
                        loading={busy}
                        onPress={() => void approveClean(a.id)}
                        style={styles.grow}
                      />
                      <Button label="Open" variant="secondary" onPress={open} />
                    </>
                  )}
                </View>
              </Card>
            </Appear>
          )
        })
      ) : (
        <Card>
          <Skeleton height={24} />
          <Skeleton height={80} />
        </Card>
      )}

      {plansWaiting.map((p, i) => (
        <Appear key={p.id} index={queue.length + i}>
          <Card onPress={() => router.push(`/manage/training/${p.id}`)}>
            <View style={styles.row}>
              <Avatar name={p.employeeName} size={44} colour={colour.accent} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.rowTitle}>
                  {p.employeeName.split(' ')[0]} · training plan
                </Text>
                <Text style={[styles.rowSub, { color: colour.accent }]}>
                  {p.periodLabel} · {p.items.length} course{p.items.length === 1 ? '' : 's'} · needs approval
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </View>
          </Card>
        </Appear>
      ))}

      {flags.map((r, i) => (
        <Appear key={r.employeeId} index={queue.length + plansWaiting.length + i}>
          <Card tone="warning" onPress={() => router.push('/manage/attendance')}>
            <View style={styles.row}>
              <View style={styles.flagMark}>
                <Text style={styles.flagGlyph}>!</Text>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.rowTitle}>
                  {r.employeeName.split(' ')[0]} · {r.daysLate} late{r.daysLate === 1 ? '' : 's'} in
                  30 days
                </Text>
                <Text style={[styles.rowSub, { color: colour.warning }]}>
                  {r.daysLate >= threshold
                    ? `At the threshold of ${threshold}`
                    : `Talk to them before it hits ${threshold}`}
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </View>
          </Card>
        </Appear>
      ))}

      {approvals.data && needs === 0 ? (
        <EmptyState
          title="Nothing waiting"
          body="Requests from your team will appear here as soon as they are submitted."
        />
      ) : null}
    </SheetPage>
  )
}

const styles = StyleSheet.create({
  escalates: { fontSize: font.size.lg, color: colour.textMuted, fontFamily: font.family },

  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rowTitle: {
    fontSize: font.size.lg,
    fontWeight: font.weight.bold,
    color: colour.text,
    fontFamily: font.family,
  },
  rowSub: { fontSize: font.size.md, color: colour.textMuted, fontFamily: font.family },
  chevron: { fontSize: font.size.xl, color: colour.textFaint, fontFamily: font.family },

  actions: { flexDirection: 'row', gap: space.sm },
  grow: { flex: 1 },

  flagMark: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colour.warningSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flagGlyph: {
    fontSize: font.size.xl,
    fontWeight: font.weight.bold,
    color: colour.warning,
    fontFamily: font.family,
  },
})
