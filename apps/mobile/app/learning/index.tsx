/**
 * Learning — the employee's training plans, period by period.
 *
 * The screen answers three questions in order: is there a plan for the
 * period coming up (and if not, the button to write one), what did the
 * manager say, and which courses still owe proof. Proof is the thing that
 * closes the loop, so a course waiting on it gets a button, not a status.
 */

import { RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import type { TrainingPlanView } from '@quanti/shared'
import {
  Appear,
  Badge,
  Button,
  Card,
  EmptyState,
  SheetPage,
  Skeleton,
} from '../../src/ui/components'
import { colour, font, radius, space } from '../../src/ui/theme'
import { keys, useSubmitTrainingPlan, useTrainingPlans } from '../../src/api/queries'
import { formatRange } from '../../src/lib/dates'
import { nextPeriodStart, periodName, today } from '../../src/lib/training'

export default function Learning() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const plans = useTrainingPlans()
  const submit = useSubmitTrainingPlan()

  const rows = plans.data?.plans ?? []
  const next = nextPeriodStart()
  const upcoming = rows.find((p) => p.periodStart >= next)
  const owing = rows
    .filter((p) => p.status === 'approved')
    .flatMap((p) => p.items.filter((i) => i.status === 'planned' && i.endDate < today()))

  return (
    <SheetPage
      eyebrow="Learning & development"
      title={
        owing.length > 0
          ? `${owing.length} course${owing.length === 1 ? '' : 's'} owe proof`
          : upcoming
            ? upcoming.status === 'approved'
              ? 'Your plan is approved'
              : upcoming.status === 'submitted'
                ? 'With your manager'
                : 'Finish your plan'
            : 'Plan your training'
      }
      heroBody={
        !upcoming ? (
          <>
            <Text style={styles.lede}>
              What will you attend in {periodName(next)}, and why? Your manager approves it, then
              we remind you as each course starts and ask for proof when it ends.
            </Text>
            <Button label={`Plan ${periodName(next)}`} onPress={() => router.push('/learning/plan')} />
          </>
        ) : upcoming.status === 'draft' || upcoming.status === 'changes_requested' ? (
          <>
            {upcoming.decisionNote ? (
              <Text style={styles.lede}>“{upcoming.decisionNote}”</Text>
            ) : (
              <Text style={styles.lede}>Saved, not yet sent. Submit it when it is ready.</Text>
            )}
            <View style={styles.row}>
              <Button
                label="Submit for approval"
                loading={submit.isPending}
                onPress={() => submit.mutate(upcoming.id)}
                style={styles.grow}
              />
              <Button label="Edit" variant="secondary" onPress={() => router.push('/learning/plan')} />
            </View>
          </>
        ) : undefined
      }
      refreshControl={
        <RefreshControl
          refreshing={plans.isRefetching}
          onRefresh={() => void queryClient.invalidateQueries({ queryKey: keys.training })}
          tintColor={colour.primary}
        />
      }
    >
      {plans.data ? (
        rows.length > 0 ? (
          rows.map((plan, i) => (
            <Appear key={plan.id} index={i}>
              <PlanCard plan={plan} onProof={(id) => router.push(`/learning/proof/${id}`)} />
            </Appear>
          ))
        ) : (
          <EmptyState
            title="Nothing planned yet"
            body="Your training plans and the proof you submit will build up here, period by period."
          />
        )
      ) : (
        <Card>
          <Skeleton height={20} width={140} />
          <Skeleton height={64} />
        </Card>
      )}
    </SheetPage>
  )
}

function PlanCard({ plan, onProof }: { plan: TrainingPlanView; onProof: (id: string) => void }) {
  return (
    <Card>
      <View style={styles.head}>
        <Text style={styles.period}>{plan.periodLabel}</Text>
        <Badge label={statusLabel(plan.status)} tone={statusTone(plan.status)} />
      </View>
      {plan.decisionNote && plan.status !== 'approved' ? (
        <Text style={styles.note}>“{plan.decisionNote}”</Text>
      ) : null}
      {plan.items.map((item) => {
        const owes = plan.status === 'approved' && item.status === 'planned' && item.endDate < today()
        return (
          <View key={item.id} style={styles.item}>
            <View style={[styles.dot, item.status === 'completed' && styles.dotDone]} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.itemTitle}>{item.title}</Text>
              <Text style={styles.itemMeta}>
                {formatRange(item.startDate, item.endDate)} · {item.mode === 'physical' ? 'In person' : 'Virtual'}
                {item.provider ? ` · ${item.provider}` : ''}
              </Text>
              {item.status === 'completed' ? (
                <Text style={styles.done}>Completed{item.proofDocumentId ? ' · certificate on file' : ''}</Text>
              ) : owes ? (
                <Button label="Add proof" variant="secondary" onPress={() => onProof(item.id)} style={styles.proof} />
              ) : null}
            </View>
          </View>
        )
      })}
    </Card>
  )
}

function statusLabel(s: TrainingPlanView['status']): string {
  return (
    { draft: 'Draft', submitted: 'Awaiting approval', approved: 'Approved', declined: 'Declined', changes_requested: 'Changes requested' } as const
  )[s]
}
function statusTone(s: TrainingPlanView['status']) {
  return (
    { draft: 'neutral', submitted: 'pending', approved: 'success', declined: 'danger', changes_requested: 'warning' } as const
  )[s]
}

const styles = StyleSheet.create({
  lede: { fontSize: font.size.lg, color: colour.textMuted, lineHeight: 23, fontFamily: font.family },
  row: { flexDirection: 'row', gap: space.sm },
  grow: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  period: { fontSize: font.size.lg, fontWeight: font.weight.bold, color: colour.text, fontFamily: font.family },
  note: { fontSize: font.size.md, color: colour.warning, fontStyle: 'italic', fontFamily: font.family },
  item: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start', paddingTop: space.sm },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colour.textFaint, marginTop: 6 },
  dotDone: { backgroundColor: colour.success },
  itemTitle: { fontSize: font.size.md, fontWeight: font.weight.semibold, color: colour.text, fontFamily: font.family },
  itemMeta: { fontSize: font.size.sm, color: colour.textMuted, fontFamily: font.family },
  done: { fontSize: font.size.sm, color: colour.success, fontFamily: font.family },
  proof: { alignSelf: 'flex-start', marginTop: space.xs, borderRadius: radius.pill },
})
