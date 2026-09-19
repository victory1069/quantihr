/**
 * Host review — the core screen (meeting-assistant spec §9).
 *
 * Target: fifteen seconds for a typical meeting. Everything here is shaped by
 * that number.
 *
 *   - The whole set is confirmed in one call, not one per action. A round trip
 *     per row does not fit inside fifteen seconds.
 *   - `owner_confidence` drives the default state, so the common case is
 *     reading and pressing one button: explicit owners are pre-filled, implied
 *     owners are pre-filled with a visible flag, unclear owners are left empty.
 *   - The verbatim quote is always on screen. A host who disagrees with an
 *     assignment can see immediately whether the model misread the room or
 *     whether they misremember what they said — and a hallucinated action is
 *     obvious at a glance rather than after it has been dispatched.
 *
 * Nothing has been sent to anyone when this screen opens. That is the point of
 * it existing.
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
  const keeping = pending.filter((a) => state[a.id]?.keep).length

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

  return (
    <Screen>
      <Appear index={0}>
        <View style={styles.head}>
          <Text style={styles.title}>{data.title}</Text>
          <Text style={styles.meta}>
            {pending.length} {pending.length === 1 ? 'action' : 'actions'} · nothing has been
            sent yet
          </Text>
        </View>
      </Appear>

      {data.unresolvedSpeakers.length > 0 ? (
        <Appear index={1}>
          <Card style={styles.nudge}>
            <Text style={styles.body}>
              {data.unresolvedSpeakers.length}{' '}
              {data.unresolvedSpeakers.length === 1 ? 'voice was' : 'voices were'} not
              identified, so some of these have no owner.
            </Text>
            <Button
              label="Tag the speakers"
              variant="secondary"
              onPress={() => router.push(`/meetings/${id}/speakers`)}
            />
          </Card>
        </Appear>
      ) : null}

      {pending.map((action, index) => (
        <Appear key={action.id} index={2 + index}>
          <ActionCard
            action={action}
            draft={state[action.id]!}
            attendees={data.participants}
            onChange={(patch) => update(action.id, patch)}
          />
        </Appear>
      ))}

      <Appear index={2 + pending.length}>
        <View style={styles.footer}>
          <Button
            label={
              keeping === pending.length
                ? `Confirm all ${pending.length}`
                : `Confirm ${keeping}, drop ${pending.length - keeping}`
            }
            loading={submit.isPending}
            onPress={() =>
              submit.mutate(
                {
                  decisions: pending.map((action) => {
                    const draft = state[action.id]!
                    return draft.keep
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
            }
          />
          {submit.isError ? (
            <ErrorNotice message="That could not be saved. Nothing was sent." />
          ) : null}
        </View>
      </Appear>
    </Screen>
  )
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
  head: { gap: space.xs, paddingTop: space.sm },
  title: {
    fontSize: font.size.xl,
    color: colour.text,
    fontWeight: font.weight.bold,
    fontFamily: font.family,
  },
  meta: { fontSize: font.size.sm, color: colour.textMuted, fontFamily: font.family },

  nudge: { borderColor: colour.warning },
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
  footer: { gap: space.sm },
})
