/**
 * Manager approval queue (spec §5).
 *
 * "Queue, swipe or tap to approve, conflict context surfaced on each request,
 * override reason required when approving against a coverage rule."
 *
 * The coverage context is re-evaluated server-side when this list is fetched, so
 * a manager decides against today's team calendar rather than the warnings that
 * were true when the employee submitted.
 */

import { useState } from 'react'
import { RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError } from '@quanti/shared'
import {
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  ErrorNotice,
  Screen,
  Skeleton,
} from '../../src/ui/components'
import { colour, font, radius, space } from '../../src/ui/theme'
import { keys, useApprovals, useDecideApproval } from '../../src/api/queries'
import { isManager, useSession } from '../../src/store/session'

export default function Approvals() {
  const queryClient = useQueryClient()
  const me = useSession((s) => s.me)
  const canManage = isManager(me)
  const approvals = useApprovals(canManage)
  const decide = useDecideApproval()

  const [expanded, setExpanded] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [override, setOverride] = useState('')
  const [error, setError] = useState<{ id: string; message: string } | null>(null)

  if (!canManage) {
    return (
      <Screen>
        <EmptyState
          title="Manager access only"
          body="Your account does not have approval permissions."
        />
      </Screen>
    )
  }

  const act = async (
    id: string,
    decision: 'approve' | 'decline',
    requiresOverride: boolean,
  ) => {
    setError(null)

    if (decision === 'approve' && requiresOverride && override.trim().length < 10) {
      setError({
        id,
        message: 'This request breaches a coverage rule. Give a reason (at least 10 characters) to approve it.',
      })
      setExpanded(id)
      return
    }

    try {
      await decide.mutateAsync({
        id,
        decision,
        note: note.trim() || undefined,
        overrideReason: requiresOverride ? override.trim() : undefined,
      })
      setExpanded(null)
      setNote('')
      setOverride('')
    } catch (e) {
      setError({
        id,
        message: e instanceof ApiError ? e.message : 'Could not record that decision.',
      })
    }
  }

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={approvals.isRefetching}
          onRefresh={() => void queryClient.invalidateQueries({ queryKey: keys.approvals })}
          tintColor={colour.primary}
        />
      }
    >
      <Text style={styles.title}>Approvals</Text>

      {approvals.data ? (
        approvals.data.approvals.length > 0 ? (
          approvals.data.approvals.map((a) => {
            const isOpen = expanded === a.id
            const overdue = a.waitingHours >= 48
            return (
              <Card key={a.id}>
                <View style={styles.head}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.who}>{a.employeeName}</Text>
                    <Text style={styles.what}>
                      {a.leaveTypeName} · {a.daysCount} day(s)
                    </Text>
                    <Text style={styles.when}>
                      {a.start} → {a.end}
                    </Text>
                  </View>
                  <Badge
                    label={overdue ? `${Math.round(a.waitingHours)}h waiting` : 'New'}
                    tone={overdue ? 'warning' : 'info'}
                  />
                </View>

                {a.reason ? <Text style={styles.reason}>“{a.reason}”</Text> : null}

                <Divider />

                <View style={styles.contextRow}>
                  <Context label="Balance after" value={String(a.balanceAfter)} />
                  <Context
                    label="Coverage"
                    value={a.warnings.length === 0 ? 'Clear' : `${a.warnings.length} issue(s)`}
                    tone={a.warnings.length === 0 ? 'ok' : 'warn'}
                  />
                </View>

                {a.warnings.map((w) => (
                  <ErrorNotice key={w.code} tone="warning" message={w.message} />
                ))}

                {isOpen ? (
                  <View style={styles.form}>
                    <Text style={styles.fieldLabel}>Note to {a.employeeName.split(' ')[0]} (optional)</Text>
                    <TextInput
                      value={note}
                      onChangeText={setNote}
                      placeholder="Anything they should know"
                      placeholderTextColor={colour.textFaint}
                      style={styles.input}
                      multiline
                    />

                    {a.requiresOverride ? (
                      <>
                        <Text style={styles.fieldLabel}>
                          Reason for approving against the coverage rule (required)
                        </Text>
                        <TextInput
                          value={override}
                          onChangeText={setOverride}
                          placeholder="e.g. Cover arranged with the Lagos team"
                          placeholderTextColor={colour.textFaint}
                          style={styles.input}
                          multiline
                        />
                      </>
                    ) : null}
                  </View>
                ) : null}

                {error?.id === a.id ? <ErrorNotice message={error.message} /> : null}

                <View style={styles.actions}>
                  <Button
                    label="Decline"
                    variant="secondary"
                    style={styles.action}
                    onPress={() => void act(a.id, 'decline', false)}
                  />
                  <Button
                    label={a.requiresOverride && !isOpen ? 'Approve…' : 'Approve'}
                    style={styles.action}
                    loading={decide.isPending && expanded === a.id}
                    onPress={() => {
                      if (a.requiresOverride && !isOpen) {
                        setExpanded(a.id)
                        return
                      }
                      void act(a.id, 'approve', a.requiresOverride)
                    }}
                  />
                </View>

                {!isOpen ? (
                  <Button
                    label="Add a note"
                    variant="ghost"
                    onPress={() => {
                      setExpanded(a.id)
                      setNote('')
                      setOverride('')
                    }}
                  />
                ) : null}
              </Card>
            )
          })
        ) : (
          <EmptyState
            title="Nothing waiting"
            body="Requests from your team will appear here as soon as they are submitted."
          />
        )
      ) : (
        <Card>
          <Skeleton height={24} />
          <Skeleton height={80} />
        </Card>
      )}
    </Screen>
  )
}

function Context({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string
  tone?: 'default' | 'ok' | 'warn'
}) {
  return (
    <View>
      <Text
        style={[
          styles.contextValue,
          tone === 'ok' && { color: colour.success },
          tone === 'warn' && { color: colour.warning },
        ]}
      >
        {value}
      </Text>
      <Text style={styles.contextLabel}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  title: {
    fontSize: font.size.xxl,
    fontWeight: font.weight.bold,
    color: colour.text,
    paddingTop: space.lg,
  },
  head: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  who: { fontSize: font.size.lg, fontWeight: font.weight.semibold, color: colour.text },
  what: { fontSize: font.size.md, color: colour.text },
  when: { fontSize: font.size.sm, color: colour.textMuted },
  reason: { fontSize: font.size.md, color: colour.textMuted, fontStyle: 'italic', lineHeight: 21 },

  contextRow: { flexDirection: 'row', gap: space.xl },
  contextValue: { fontSize: font.size.lg, fontWeight: font.weight.semibold, color: colour.text },
  contextLabel: { fontSize: font.size.xs, color: colour.textMuted, marginTop: 2 },

  form: { gap: space.sm },
  fieldLabel: { fontSize: font.size.sm, fontWeight: font.weight.semibold, color: colour.textMuted },
  input: {
    borderWidth: 1,
    borderColor: colour.borderStrong,
    borderRadius: radius.md,
    padding: space.md,
    minHeight: 64,
    fontSize: font.size.md,
    color: colour.text,
    backgroundColor: colour.surface,
    textAlignVertical: 'top',
  },

  actions: { flexDirection: 'row', gap: space.sm },
  action: { flex: 1 },
})
