/**
 * A training plan, for the manager to decide.
 *
 * Every course shows the employee's stated need beside it, because that is
 * what the decision is about — not the course, the reason. Declining or
 * asking for changes requires a note; the employee gets it word for word.
 */

import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ApiError } from '@quanti/shared'
import { BackLink, Button, Card, ErrorNotice, HeroSheet } from '../../../src/ui/components'
import { Avatar, DataRow, Label } from '../../../src/ui/primitives'
import { colour, font, radius, space } from '../../../src/ui/theme'
import { useDecideTrainingPlan, useTeamTraining } from '../../../src/api/queries'
import { formatRange } from '../../../src/lib/dates'
import { formatNaira } from '../../../src/lib/money'

export default function TrainingDecision() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const team = useTeamTraining(true)
  const decide = useDecideTrainingPlan()
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const plan = team.data?.plans.find((p) => p.id === id)
  const hero = (
    <View>
      <BackLink label="Queue" onPress={() => router.back()} />
      <Text style={styles.heroTitle}>{plan ? `${plan.employeeName.split(' ')[0]}'s plan` : 'Training plan'}</Text>
    </View>
  )

  if (!plan) {
    return (
      <HeroSheet hero={hero} dimmed>
        <Text style={styles.name}>{team.data ? 'This plan is no longer waiting.' : 'Loading…'}</Text>
        <Button label="Back to the queue" variant="secondary" onPress={() => router.back()} />
      </HeroSheet>
    )
  }

  const total = plan.items.reduce((sum, i) => sum + (i.costKobo ?? 0), 0)
  const waiting = plan.status === 'submitted'

  const act = async (decision: 'approve' | 'decline' | 'request_changes') => {
    setError(null)
    if (decision !== 'approve' && note.trim().length < 5) {
      setError('Say why — they need to know what to change.')
      return
    }
    try {
      await decide.mutateAsync({ id: plan.id, decision, ...(note.trim() ? { note: note.trim() } : {}) })
      router.back()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not record that decision.')
    }
  }

  return (
    <HeroSheet hero={hero} dimmed maxSheet={0.92}>
      <View style={styles.head}>
        <Avatar name={plan.employeeName} size={52} colour={colour.accent} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.name}>{plan.employeeName}</Text>
          <Text style={styles.role}>
            {plan.periodLabel} · {plan.items.length} course{plan.items.length === 1 ? '' : 's'}
            {total > 0 ? ` · ${formatNaira(total)}` : ''}
          </Text>
        </View>
      </View>

      {plan.items.map((item) => (
        <Card key={item.id}>
          <Text style={styles.courseTitle}>{item.title}</Text>
          <DataRow
            label="When"
            value={formatRange(item.startDate, item.endDate)}
          />
          <DataRow
            label="How"
            value={`${item.mode === 'physical' ? 'In person' : 'Virtual'}${item.provider ? ` · ${item.provider}` : ''}`}
            mono={false}
          />
          <DataRow label="Cost" value={item.costKobo ? formatNaira(item.costKobo) : 'Free / unknown'} last />
          <Label>Why they need it</Label>
          <Text style={styles.need}>“{item.need}”</Text>
        </Card>
      ))}

      {waiting ? (
        <>
          <View style={{ gap: space.sm }}>
            <Text style={styles.label}>Note to {plan.employeeName.split(' ')[0]} — required unless approving</Text>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="e.g. Approved — book it through Ify so the invoice comes to us."
              placeholderTextColor={colour.textFaint}
              style={styles.input}
              multiline
              accessibilityLabel="Note to the employee"
            />
          </View>

          {error ? <ErrorNotice message={error} /> : null}

          <Button
            label="Approve"
            loading={decide.isPending && decide.variables?.decision === 'approve'}
            onPress={() => void act('approve')}
          />
          <View style={styles.row}>
            <Button
              label="Ask for changes"
              variant="secondary"
              loading={decide.isPending && decide.variables?.decision === 'request_changes'}
              onPress={() => void act('request_changes')}
              style={styles.grow}
            />
            <Button
              label="Decline"
              variant="ghost"
              loading={decide.isPending && decide.variables?.decision === 'decline'}
              onPress={() => void act('decline')}
            />
          </View>
        </>
      ) : (
        <Text style={styles.decided}>
          {plan.status === 'approved' ? 'Approved' : plan.status === 'declined' ? 'Declined' : 'Changes requested'}
          {plan.decisionNote ? ` — “${plan.decisionNote}”` : ''}
        </Text>
      )}
    </HeroSheet>
  )
}

const styles = StyleSheet.create({
  heroTitle: {
    fontSize: font.size.display,
    fontWeight: font.weight.bold,
    color: colour.text,
    letterSpacing: font.tracking.tight,
    fontFamily: font.family,
    paddingBottom: space.lg,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  name: { fontSize: font.size.xl, fontWeight: font.weight.bold, color: colour.text, fontFamily: font.family },
  role: { fontSize: font.size.md, color: colour.textMuted, fontFamily: font.family },
  courseTitle: { fontSize: font.size.lg, fontWeight: font.weight.bold, color: colour.text, fontFamily: font.family },
  need: { fontSize: font.size.md, color: colour.text, lineHeight: 21, fontStyle: 'italic', fontFamily: font.family },
  label: { fontSize: font.size.md, color: colour.textMuted, fontFamily: font.family },
  input: {
    borderWidth: 1,
    borderColor: colour.border,
    borderRadius: radius.lg,
    padding: space.lg,
    minHeight: 96,
    fontSize: font.size.lg,
    lineHeight: 24,
    color: colour.text,
    backgroundColor: colour.surfaceSunken,
    textAlignVertical: 'top',
    fontFamily: font.family,
  },
  row: { flexDirection: 'row', gap: space.sm },
  grow: { flex: 1 },
  decided: { fontSize: font.size.md, color: colour.textMuted, fontFamily: font.family },
})
