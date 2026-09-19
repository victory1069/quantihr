/**
 * One request, in full, with the decision at the bottom.
 *
 * Reached from the queue for anything that is not a plain approve: a request
 * with coverage conflicts, or one the manager wants to read before deciding.
 * The facts are laid out as evidence — dates, balance after, notice given —
 * and the conflicts are named, because "approve anyway" has to be a decision
 * about something specific.
 *
 * The override reason is required by the server when a rule is breached, and
 * the footer says where it goes: recorded under the manager's name, visible
 * to HR and to the employee. That line is the reason the box gets filled in
 * honestly.
 */

import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ApiError } from '@quanti/shared'
import { Button, Card, ErrorNotice, HeroSheet } from '../../../src/ui/components'
import { Avatar, DataRow } from '../../../src/ui/primitives'
import { colour, font, radius, space } from '../../../src/ui/theme'
import { useApprovals, useDecideApproval } from '../../../src/api/queries'
import { formatRange } from '../../../src/lib/dates'

export default function ApprovalDetail() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const approvals = useApprovals(true)
  const decide = useDecideApproval()

  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const item = approvals.data?.approvals.find((a) => a.id === id)
  const waiting = approvals.data?.approvals.length ?? 0
  const title = waiting === 0 ? 'Nothing needs you' : `${waiting} need you`

  if (!item) {
    return (
      <HeroSheet hero={<Text style={styles.heroTitle}>{title}</Text>} dimmed>
        <Text style={styles.name}>{approvals.data ? 'This request has been decided.' : 'Loading…'}</Text>
        <Button label="Back to the queue" variant="secondary" onPress={() => router.back()} />
      </HeroSheet>
    )
  }

  const first = item.employeeName.split(' ')[0]
  const needsReason = item.requiresOverride
  const ready = !needsReason || reason.trim().length >= 10
  const noticeDays = Math.max(
    0,
    Math.round(
      (new Date(`${item.start}T00:00:00`).getTime() - new Date(item.submittedAt).getTime()) /
        86_400_000,
    ),
  )

  const act = async (decision: 'approve' | 'decline') => {
    setError(null)
    if (decision === 'approve' && !ready) {
      setError('Give a reason of at least 10 characters to approve against the rule.')
      return
    }
    try {
      await decide.mutateAsync({
        id: item.id,
        decision,
        ...(needsReason && decision === 'approve'
          ? { overrideReason: reason.trim() }
          : reason.trim()
            ? { note: reason.trim() }
            : {}),
      })
      router.back()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not record that decision.')
    }
  }

  return (
    <HeroSheet hero={<Text style={styles.heroTitle}>{title}</Text>} dimmed maxSheet={0.92}>
      <View style={styles.head}>
        <Avatar name={item.employeeName} size={56} colour={colour.primary} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.name}>{item.employeeName}</Text>
          <Text style={styles.role}>
            {item.leaveTypeName} · {item.daysCount} day{item.daysCount === 1 ? '' : 's'}
          </Text>
        </View>
      </View>

      <Card>
        <DataRow label="Dates" value={`${formatRange(item.start, item.end)} · ${item.daysCount}d`} />
        <DataRow
          label="Balance after"
          value={`${item.balanceAfter} days`}
          tone={item.balanceAfter < 0 ? 'danger' : 'success'}
        />
        <DataRow label="Notice given" value={`${noticeDays} days`} last />
      </Card>

      {item.reason ? <Text style={styles.quote}>“{item.reason}”</Text> : null}

      {item.warnings.length > 0 ? (
        <Card tone="warning">
          <Text style={styles.conflictsTitle}>
            {item.warnings.length} conflict{item.warnings.length === 1 ? '' : 's'}
          </Text>
          {item.warnings.map((w) => (
            <Text key={w.code} style={styles.conflict}>
              {w.message}
            </Text>
          ))}
        </Card>
      ) : null}

      <View style={{ gap: space.sm }}>
        <Text style={styles.label}>
          {needsReason ? 'Reason for overriding — required' : `Note to ${first} — optional`}
        </Text>
        <TextInput
          value={reason}
          onChangeText={setReason}
          placeholder={
            needsReason
              ? 'e.g. Sept close is light this quarter; Musa covers dispatch.'
              : 'Anything they should know'
          }
          placeholderTextColor={colour.textFaint}
          style={styles.input}
          multiline
          accessibilityLabel={needsReason ? 'Reason for overriding' : 'Note'}
        />
        <Text style={styles.recorded}>
          RECORDED WITH YOUR NAME{'\n'}VISIBLE TO HR AND TO {first.toUpperCase()}
        </Text>
      </View>

      {error ? <ErrorNotice message={error} /> : null}

      <View style={styles.actions}>
        <Button
          label={needsReason ? 'Approve anyway' : 'Approve'}
          loading={decide.isPending && decide.variables?.decision === 'approve'}
          disabled={!ready}
          onPress={() => void act('approve')}
          style={styles.grow}
        />
        <Button
          label="Decline"
          variant="secondary"
          loading={decide.isPending && decide.variables?.decision === 'decline'}
          onPress={() => void act('decline')}
        />
      </View>
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
  name: {
    fontSize: font.size.xl,
    fontWeight: font.weight.bold,
    color: colour.text,
    fontFamily: font.family,
  },
  role: { fontSize: font.size.md, color: colour.textMuted, fontFamily: font.family },
  quote: {
    fontSize: font.size.md,
    color: colour.textMuted,
    fontStyle: 'italic',
    lineHeight: 20,
    fontFamily: font.family,
  },
  conflictsTitle: {
    fontSize: font.size.lg,
    fontWeight: font.weight.bold,
    color: colour.warning,
    fontFamily: font.family,
  },
  conflict: { fontSize: font.size.md, color: colour.text, lineHeight: 20, fontFamily: font.family },
  label: { fontSize: font.size.md, color: colour.textMuted, fontFamily: font.family },
  input: {
    borderWidth: 1,
    borderColor: colour.border,
    borderRadius: radius.lg,
    padding: space.lg,
    minHeight: 120,
    fontSize: font.size.lg,
    lineHeight: 24,
    color: colour.text,
    backgroundColor: colour.surfaceSunken,
    textAlignVertical: 'top',
    fontFamily: font.family,
  },
  recorded: {
    fontSize: font.size.xs,
    lineHeight: 18,
    letterSpacing: font.tracking.label,
    color: colour.textFaint,
    fontFamily: font.mono,
  },
  actions: { flexDirection: 'row', gap: space.sm },
  grow: { flex: 1 },
})
