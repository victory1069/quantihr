/**
 * Manager approval queue (spec §5).
 *
 * **Collapsed by default.** A queue of full cards meant three requests filled
 * the screen and a manager with a dozen was scrolling past detail they had not
 * asked for yet. Each row now carries only what triage needs — who, what kind
 * of leave, how many days, and the dates — and opens on tap.
 *
 * Nothing is decided from the collapsed row, deliberately. Approve and decline
 * live inside the expanded card next to the coverage warnings and the balance,
 * because those are the facts the decision turns on and a one-tap approve
 * beside a summary invites deciding without them.
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
  Appear,
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  ErrorNotice,
  Press,
  Screen,
  Skeleton,
} from '../../src/ui/components'
import { colour, font, radius, space } from '../../src/ui/theme'
import { keys, useApprovals, useDecideApproval, useMe } from '../../src/api/queries'
import { isManager, useSession } from '../../src/store/session'

export default function Approvals() {
  const queryClient = useQueryClient()
  // `me` is null both before it loads and when the account genuinely has no
  // manager role, and those are not the same answer. Treating them as one told
  // a manager on a cold start that they lacked permission, which reads as an
  // account problem rather than a spinner.
  const meQuery = useMe()
  const me = useSession((s) => s.me) ?? meQuery.data ?? null
  const canManage = isManager(me)
  const approvals = useApprovals(canManage)
  const decide = useDecideApproval()

  const [expanded, setExpanded] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [override, setOverride] = useState('')
  const [error, setError] = useState<{ id: string; message: string } | null>(null)

  if (!me) {
    return (
      <Screen>
        <Card>
          <Skeleton height={24} width={160} />
          <Skeleton height={64} />
        </Card>
      </Screen>
    )
  }

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
          approvals.data.approvals.map((a, index) => {
            const isOpen = expanded === a.id
            const overdue = a.waitingHours >= 48

            return (
              <Appear key={a.id} index={index}>
                <Card>
                  {/* Summary. Everything needed to decide whether this one
                      warrants opening, and nothing else. */}
                  <Press
                    accessibilityLabel={`${a.employeeName}, ${a.leaveTypeName}, ${a.daysCount} days`}
                    accessibilityHint={isOpen ? 'Collapses this request' : 'Opens this request'}
                    scaleTo={0.99}
                    onPress={() => {
                      setExpanded(isOpen ? null : a.id)
                      setNote('')
                      setOverride('')
                      setError(null)
                    }}
                  >
                    <View style={styles.summaryRow}>
                      <View style={styles.summaryMain}>
                        <Text style={styles.who}>{a.employeeName}</Text>
                        <Text style={styles.what}>
                          {a.leaveTypeName} · {a.daysCount} day{a.daysCount === 1 ? '' : 's'}
                        </Text>
                        <Text style={styles.when}>
                          {formatRange(a.start, a.end)}
                        </Text>
                      </View>

                      <View style={styles.summaryEnd}>
                        {overdue ? (
                          <Badge label={`${Math.round(a.waitingHours)}h`} tone="warning" />
                        ) : a.warnings.length > 0 ? (
                          <Badge label="Coverage" tone="warning" />
                        ) : null}
                        <Text style={styles.chevron}>{isOpen ? '⌃' : '⌄'}</Text>
                      </View>
                    </View>
                  </Press>

                  {isOpen ? (
                    <>
                      <Divider />

                      {a.reason ? <Text style={styles.reason}>“{a.reason}”</Text> : null}

                      <View style={styles.contextRow}>
                        <Context label="Balance after" value={String(a.balanceAfter)} />
                        <Context
                          label="Waiting"
                          value={`${Math.round(a.waitingHours)}h`}
                          tone={overdue ? 'warn' : 'default'}
                        />
                        <Context
                          label="Coverage"
                          value={a.warnings.length === 0 ? 'Clear' : `${a.warnings.length} issue(s)`}
                          tone={a.warnings.length === 0 ? 'ok' : 'warn'}
                        />
                      </View>

                      {a.warnings.map((w) => (
                        <ErrorNotice key={w.code} tone="warning" message={w.message} />
                      ))}

                      <View style={styles.form}>
                        <Text style={styles.fieldLabel}>
                          Note to {a.employeeName.split(' ')[0]} (optional)
                        </Text>
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

                      {error?.id === a.id ? <ErrorNotice message={error.message} /> : null}

                      <View style={styles.actions}>
                        <Button
                          label="Decline"
                          variant="secondary"
                          style={styles.action}
                          onPress={() => void act(a.id, 'decline', false)}
                        />
                        <Button
                          label="Approve"
                          style={styles.action}
                          loading={decide.isPending && expanded === a.id}
                          onPress={() => void act(a.id, 'approve', a.requiresOverride)}
                        />
                      </View>
                    </>
                  ) : null}
                </Card>
              </Appear>
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

/**
 * "12–16 Aug" rather than two ISO dates. The collapsed row has one line for
 * this and a manager is reading a dozen of them.
 */
function formatRange(start: string, end: string): string {
  const from = new Date(`${start}T00:00:00`)
  const to = new Date(`${end}T00:00:00`)
  const month = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' })
  const day = (d: Date) => d.getDate()

  // Built explicitly rather than from a locale-formatted range. Asking the
  // locale for "day + month" gives "Sep 24" in one place and "24 Sep" in
  // another, which turned "20–24 Sep" into "20–Sep 24".
  if (start === end) return `${day(from)} ${month(from)}`
  if (start.slice(0, 7) === end.slice(0, 7)) {
    return `${day(from)}–${day(to)} ${month(to)}`
  }
  return `${day(from)} ${month(from)} – ${day(to)} ${month(to)}`
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
  summaryRow: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
  summaryMain: { flex: 1, gap: 2 },
  summaryEnd: { alignItems: 'flex-end', gap: space.xs },
  chevron: { fontSize: 16, color: colour.textFaint, lineHeight: 18 },
  who: { fontSize: font.size.md, fontWeight: font.weight.semibold, color: colour.text },
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
