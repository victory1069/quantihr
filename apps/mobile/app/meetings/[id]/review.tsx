/**
 * Host review — the fifteen-second confirm (spec §9, §5.3).
 *
 * Nothing leaves this screen until the host says so: the decisions are
 * shown, each proposed task is shown with the words it came from, and a task
 * with no named owner is stopped at the door — assign it or discard it, but
 * it does not go out as "someone should". The default is to confirm what was
 * heard, because the host is checking a summary, not writing one.
 *
 * `Edit` opens the full card for each task (reword, re-own, drop). Most
 * reviews never need it.
 */

import { useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  Appear,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  HeroSheet,
  Screen,
  Skeleton,
} from '../../../src/ui/components'
import { Label } from '../../../src/ui/primitives'
import { colour, font, radius, space } from '../../../src/ui/theme'
import { useMeeting, useSubmitReview, type MeetingActionItem } from '../../../src/api/queries'

interface Draft {
  keep: boolean
  description: string
  ownerEmployeeId: string | null
  dueDate: string | null
}

export default function Review() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const meeting = useMeeting(id)
  const submit = useSubmitReview(id ?? '')
  const [editing, setEditing] = useState(false)
  const [assigning, setAssigning] = useState<string | null>(null)

  const drafts = useMemo(() => {
    const actions = meeting.data?.actions.filter((a) => a.status === 'draft') ?? []
    return actions.reduce<Record<string, Draft>>((acc, action) => {
      acc[action.id] = {
        // Kept by default. The host is confirming a summary, not building one
        // from scratch, and defaulting everything off would put the work back
        // on them.
        keep: true,
        description: action.description,
        ownerEmployeeId: action.ownerEmployeeId,
        dueDate: action.dueDate,
      }
      return acc
    }, {})
  }, [meeting.data])

  const [edits, setEdits] = useState<Record<string, Draft>>({})
  const state = { ...drafts, ...edits }

  const update = (actionId: string, patch: Partial<Draft>): void =>
    setEdits((prev) => ({
      ...prev,
      [actionId]: { ...state[actionId]!, ...patch },
    }))

  if (meeting.isLoading) {
    return (
      <Screen>
        <Skeleton height={140} />
        <Skeleton height={140} />
      </Screen>
    )
  }

  const data = meeting.data
  if (!data) {
    return (
      <Screen>
        <ErrorNotice message="That meeting could not be loaded." />
      </Screen>
    )
  }

  const pending = data.actions.filter((a) => a.status === 'draft')

  if (pending.length === 0) {
    return (
      <Screen>
        <EmptyState
          title="Nothing to review"
          body={
            data.status === 'ready'
              ? 'You have already reviewed this meeting.'
              : 'No actions were extracted from this meeting. That is a normal outcome — not every meeting produces one.'
          }
        />
        <Button label="Back" variant="ghost" onPress={() => router.back()} />
      </Screen>
    )
  }

  // What will go out: kept tasks that have an owner. An unowned task is never
  // sent — it is assigned here or dropped.
  const sending = pending.filter((a) => state[a.id]?.keep && state[a.id]?.ownerEmployeeId)
  const unowned = pending.filter((a) => state[a.id]?.keep && !state[a.id]?.ownerEmployeeId)

  const minutes =
    data.actualStart && data.actualEnd
      ? Math.max(1, Math.round((Date.parse(data.actualEnd) - Date.parse(data.actualStart)) / 60_000))
      : Math.max(
          1,
          Math.round((Date.parse(data.scheduledEnd) - Date.parse(data.scheduledStart)) / 60_000),
        )
  const required = data.participants.filter((p) => p.expected && !p.isOptional)
  const attended = required.filter(
    (p) => p.attendanceStatus === 'present' || p.attendanceStatus === 'late',
  )
  const host = data.participants.find((p) => p.employeeId === data.hostEmployeeId)
  const hostLine = data.isHost
    ? 'YOU HOSTED'
    : host
      ? `HOSTED BY ${host.employeeName.split(' ')[0]!.toUpperCase()}`
      : 'DRAFT'

  const send = () =>
    submit.mutate(
      {
        decisions: pending.map((action) => {
          const draft = state[action.id]!
          return draft.keep && draft.ownerEmployeeId
            ? {
                actionId: action.id,
                decision: 'confirm' as const,
                description: draft.description,
                ownerEmployeeId: draft.ownerEmployeeId,
                dueDate: draft.dueDate,
              }
            : { actionId: action.id, decision: 'dismiss' as const }
        }),
      },
      { onSuccess: () => router.replace(`/meetings/${id}`) },
    )

  return (
    <HeroSheet
      hero={<Text style={styles.heroTitle}>Team</Text>}
      dimmed
      tone="manager"
      maxSheet={0.92}
    >
      <View style={styles.eyebrowRow}>
        <View style={styles.aiBadge}>
          <Text style={styles.aiGlyph}>✦</Text>
        </View>
        <Text style={styles.eyebrow}>MEETING SUMMARY · {hostLine}</Text>
      </View>

      <View style={{ gap: space.xs }}>
        <Text style={styles.title}>
          {data.title} · {minutes} min
        </Text>
        <Text style={styles.meta}>
          {required.length > 0 ? `${attended.length} of ${required.length} required · ` : ''}
          {data.routeToHr ? 'summary shared with HR' : 'summary to you only'}
        </Text>
      </View>

      {data.summary && data.summary.decisions.length > 0 ? (
        <Card style={styles.decisions}>
          <Text style={styles.sectionLabel}>DECISIONS</Text>
          {data.summary.decisions.map((d, i) => (
            <Text key={i} style={styles.decision}>
              {d.decision}
            </Text>
          ))}
        </Card>
      ) : null}

      {data.unresolvedSpeakers.length > 0 ? (
        <Card tone="warning">
          <Text style={styles.body}>
            {data.unresolvedSpeakers.length}{' '}
            {data.unresolvedSpeakers.length === 1 ? 'voice was' : 'voices were'} not identified,
            so some of these have no owner.
          </Text>
          <Button
            label="Tag the speakers"
            variant="secondary"
            onPress={() => router.push(`/meetings/${id}/speakers`)}
          />
        </Card>
      ) : null}

      <Text style={styles.sectionLabel}>PROPOSED TASKS · CONFIRM BEFORE SENDING</Text>

      {editing
        ? pending.map((action, index) => (
            <Appear key={action.id} index={index}>
              <ActionCard
                action={action}
                draft={state[action.id]!}
                attendees={data.participants}
                onChange={(patch) => update(action.id, patch)}
              />
            </Appear>
          ))
        : pending.map((action, index) => {
            const draft = state[action.id]!
            const owner = data.participants.find((p) => p.employeeId === draft.ownerEmployeeId)
            const stamp = formatStamp(action.timestampMs)

            if (!draft.keep) {
              return (
                <Appear key={action.id} index={index}>
                  <Pressable
                    onPress={() => update(action.id, { keep: true })}
                    style={styles.droppedRow}
                    accessibilityRole="button"
                  >
                    <Text style={styles.droppedText}>Discarded · “{action.sourceQuote}”</Text>
                    <Text style={styles.undo}>Undo</Text>
                  </Pressable>
                </Appear>
              )
            }

            if (!owner) {
              const open = assigning === action.id
              return (
                <Appear key={action.id} index={index}>
                  <Card tone="warning">
                    <View style={styles.taskRow}>
                      <View style={[styles.who, styles.whoUnknown]}>
                        <Text style={styles.whoUnknownGlyph}>?</Text>
                      </View>
                      <Text style={styles.taskTitle}>Unassigned · “{draft.description}”</Text>
                    </View>
                    <Text style={styles.warnLine}>No owner was named. Pick one or discard.</Text>
                    {open ? (
                      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        <View style={styles.owners}>
                          {data.participants.map((person) => (
                            <Pressable
                              key={person.employeeId}
                              accessibilityRole="button"
                              onPress={() => {
                                update(action.id, { ownerEmployeeId: person.employeeId })
                                setAssigning(null)
                              }}
                              style={styles.owner}
                            >
                              <Text style={styles.ownerLabel}>{person.employeeName}</Text>
                            </Pressable>
                          ))}
                        </View>
                      </ScrollView>
                    ) : null}
                    <View style={styles.actions}>
                      <Button
                        label={open ? 'Cancel' : 'Assign'}
                        variant="secondary"
                        style={styles.warnButton}
                        onPress={() => setAssigning(open ? null : action.id)}
                      />
                      <Button
                        label="Discard"
                        variant="ghost"
                        onPress={() => update(action.id, { keep: false })}
                      />
                    </View>
                  </Card>
                </Appear>
              )
            }

            return (
              <Appear key={action.id} index={index}>
                <Card>
                  <View style={styles.taskRow}>
                    <View style={styles.who}>
                      <Text style={styles.whoInitials}>{initials(owner.employeeName)}</Text>
                    </View>
                    <Text style={styles.taskTitle}>
                      {owner.employeeName.split(' ')[0]} · {draft.description}
                    </Text>
                    <Text style={styles.tick}>✓</Text>
                  </View>
                  <Text style={styles.taskSub}>
                    {draft.dueDate ? `Due ${shortDate(draft.dueDate)} · ` : ''}“{action.sourceQuote}
                    ” ({stamp})
                  </Text>
                  {action.ownerConfidence === 'implied' ? (
                    <Badge label="Owner inferred" tone="warning" />
                  ) : null}
                </Card>
              </Appear>
            )
          })}

      <Text style={styles.footnote}>TRANSCRIPT DELETED AFTER 90 DAYS</Text>

      {submit.isError ? <ErrorNotice message="That could not be saved. Nothing was sent." /> : null}

      <View style={styles.actions}>
        <Button
          label={
            unowned.length > 0
              ? `${unowned.length} still unassigned`
              : `Send ${sending.length} task${sending.length === 1 ? '' : 's'}`
          }
          variant="accent"
          disabled={unowned.length > 0 || sending.length === 0}
          loading={submit.isPending}
          onPress={send}
          style={styles.grow}
        />
        <Button
          label={editing ? 'Done' : 'Edit'}
          variant="secondary"
          onPress={() => setEditing((e) => !e)}
        />
      </View>
    </HeroSheet>
  )
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('')
}

function formatStamp(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const sec = total % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  })
}

function ActionCard({
  action,
  draft,
  attendees,
  onChange,
}: {
  action: MeetingActionItem
  draft: Draft
  attendees: { employeeId: string; employeeName: string }[]
  onChange: (patch: Partial<Draft>) => void
}) {
  const [editing, setEditing] = useState(false)

  return (
    <Card style={draft.keep ? undefined : styles.dropped}>
      <View style={styles.actionHead}>
        {editing ? (
          <TextInput
            value={draft.description}
            onChangeText={(description) => onChange({ description })}
            onBlur={() => setEditing(false)}
            multiline
            autoFocus
            style={styles.editInput}
            accessibilityLabel="Task description"
          />
        ) : (
          <Text
            style={[styles.actionText, !draft.keep && styles.struck]}
            onPress={() => setEditing(true)}
            accessibilityRole="button"
            accessibilityHint="Tap to edit the wording"
          >
            {draft.description}
          </Text>
        )}

        {action.ownerConfidence === 'implied' ? (
          // Pre-filled, but flagged. The model inferred this owner rather than
          // hearing them named, and the host should know which is which.
          <Badge label="Inferred" tone="warning" />
        ) : action.ownerConfidence === 'unclear' ? (
          <Badge label="No owner" tone="neutral" />
        ) : null}
      </View>

      {/* Always visible, never truncated away. */}
      <View style={styles.quote}>
        <Text style={styles.quoteText}>“{action.sourceQuote}”</Text>
      </View>

      <Label>Owner</Label>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.owners}>
          {attendees.map((person) => {
            const selected = draft.ownerEmployeeId === person.employeeId
            return (
              <Pressable
                key={person.employeeId}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() =>
                  onChange({ ownerEmployeeId: selected ? null : person.employeeId })
                }
                style={[styles.owner, selected && styles.ownerSelected]}
              >
                <Text style={[styles.ownerLabel, selected && styles.ownerLabelSelected]}>
                  {person.employeeName}
                </Text>
              </Pressable>
            )
          })}
        </View>
      </ScrollView>

      {action.ownerStated && !draft.ownerEmployeeId ? (
        <Text style={styles.faint}>Heard as “{action.ownerStated}” — pick who that was.</Text>
      ) : null}

      {action.dueDate || draft.dueDate ? (
        <Text style={styles.faint}>Due {draft.dueDate ?? action.dueDate}</Text>
      ) : null}

      <Button
        label={draft.keep ? 'Drop this one' : 'Keep it after all'}
        variant="ghost"
        onPress={() => onChange({ keep: !draft.keep })}
      />
    </Card>
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
  eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  aiBadge: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colour.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiGlyph: { color: '#FFFFFF', fontSize: font.size.lg },
  eyebrow: {
    flex: 1,
    fontSize: font.size.sm,
    letterSpacing: font.tracking.label,
    color: colour.accent,
    fontFamily: font.mono,
  },
  title: {
    fontSize: font.size.xxl,
    color: colour.text,
    fontWeight: font.weight.bold,
    letterSpacing: font.tracking.snug,
    fontFamily: font.family,
  },
  meta: { fontSize: font.size.md, color: colour.textMuted, fontFamily: font.family },
  sectionLabel: {
    fontSize: font.size.xs,
    letterSpacing: font.tracking.label,
    color: colour.accent,
    fontFamily: font.mono,
  },
  decisions: { backgroundColor: colour.surfaceRaised },
  decision: { fontSize: font.size.lg, color: colour.text, lineHeight: 24, fontFamily: font.family },

  taskRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  who: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colour.successSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  whoInitials: { fontSize: font.size.xs, fontWeight: font.weight.bold, color: colour.success },
  whoUnknown: { backgroundColor: colour.warningSoft },
  whoUnknownGlyph: { fontSize: font.size.md, fontWeight: font.weight.bold, color: colour.warning },
  taskTitle: {
    flex: 1,
    fontSize: font.size.lg,
    fontWeight: font.weight.bold,
    color: colour.text,
    lineHeight: 22,
    fontFamily: font.family,
  },
  tick: { fontSize: font.size.lg, color: colour.success },
  taskSub: { fontSize: font.size.md, color: colour.textMuted, lineHeight: 20, fontFamily: font.family },
  warnLine: { fontSize: font.size.md, color: colour.warning, fontFamily: font.family },
  warnButton: { backgroundColor: colour.warning, borderColor: colour.warning },
  droppedRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.xs },
  droppedText: {
    flex: 1,
    fontSize: font.size.sm,
    color: colour.textFaint,
    textDecorationLine: 'line-through',
    fontFamily: font.family,
  },
  undo: { fontSize: font.size.sm, color: colour.primary, fontWeight: font.weight.semibold },
  footnote: {
    fontSize: font.size.xs,
    letterSpacing: font.tracking.label,
    color: colour.textFaint,
    fontFamily: font.mono,
  },
  actions: { flexDirection: 'row', gap: space.sm },
  grow: { flex: 1 },

  body: {
    fontSize: font.size.md,
    color: colour.text,
    lineHeight: 20,
    fontFamily: font.family,
  },

  dropped: { opacity: 0.5 },
  actionHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  actionText: {
    flex: 1,
    fontSize: font.size.md,
    color: colour.text,
    fontWeight: font.weight.semibold,
    lineHeight: 20,
    fontFamily: font.family,
  },
  struck: { textDecorationLine: 'line-through', color: colour.textMuted },
  editInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colour.primaryBorder,
    borderRadius: radius.sm,
    padding: space.sm,
    fontSize: font.size.md,
    color: colour.text,
    backgroundColor: colour.surfaceSunken,
    fontFamily: font.family,
  },

  quote: {
    borderLeftWidth: 2,
    borderLeftColor: colour.borderStrong,
    paddingLeft: space.md,
  },
  quoteText: {
    fontSize: font.size.sm,
    color: colour.textMuted,
    lineHeight: 19,
    fontStyle: 'italic',
    fontFamily: font.family,
  },

  owners: { flexDirection: 'row', gap: space.sm, paddingVertical: space.xs },
  owner: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colour.border,
  },
  ownerSelected: { borderColor: colour.primaryBorder, backgroundColor: colour.primarySoft },
  ownerLabel: { fontSize: font.size.sm, color: colour.textMuted, fontFamily: font.family },
  ownerLabelSelected: { color: colour.primary, fontWeight: font.weight.semibold },

  faint: { fontSize: font.size.sm, color: colour.textMuted, fontFamily: font.family },
})
