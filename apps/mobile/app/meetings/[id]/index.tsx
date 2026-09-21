/**
 * Meeting detail — summary, attendance, actions (spec §9).
 *
 * Read-only for everyone but the host. The one thing an attendee can do here is
 * query their own attendance record, and that goes to the host rather than to
 * HR: the host was in the room and can settle it in one tap (§7.4).
 */

import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  Appear,
  Badge,
  Button,
  Card,
  ErrorNotice,
  Screen,
  SectionTitle,
  Skeleton,
} from '../../../src/ui/components'
import { DataRow, Label } from '../../../src/ui/primitives'
import { colour, font, radius, space } from '../../../src/ui/theme'
import { useMeeting, useRaiseDispute, useRsvp } from '../../../src/api/queries'
import { useSession } from '../../../src/store/session'

export default function MeetingDetail() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const meeting = useMeeting(id)
  const rsvp = useRsvp(id ?? '')
  const myEmployeeId = useSession((s) => s.me?.employee.id)
  const dispute = useRaiseDispute(id ?? '')
  const [reason, setReason] = useState('')
  const [querying, setQuerying] = useState(false)

  if (meeting.isLoading) {
    return (
      <Screen>
        <Skeleton height={120} />
        <Skeleton height={200} />
      </Screen>
    )
  }

  const data = meeting.data
  if (!data) {
    return (
      <Screen>
        <ErrorNotice message="That meeting could not be loaded." />
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
            {formatWhen(data.actualStart ?? data.scheduledStart)} ·{' '}
            {data.source === 'in_person' ? 'In person' : 'Google Meet'}
          </Text>
          {data.routeToHr ? <Badge label="Shared with HR" tone="warning" /> : null}
        </View>
      </Appear>

      {/* The invitation, for someone who has not answered yet. */}
      {(() => {
        const mine = data.participants.find((p) => p.employeeId === myEmployeeId)
        if (!mine || data.status !== 'scheduled' || data.isHost) return null
        if (mine.inviteStatus !== 'needs_action' && mine.inviteStatus !== 'tentative') {
          return (
            <Appear index={1}>
              <Text style={styles.faint}>
                You {mine.inviteStatus === 'accepted' ? 'accepted' : 'declined'} this invitation.
              </Text>
            </Appear>
          )
        }
        return (
          <Appear index={1}>
            <Card tone="primary">
              <Label tone="primary">
                {mine.isOptional ? 'You are invited · optional' : 'You are expected'}
              </Label>
              <Text style={styles.body}>
                {mine.isOptional
                  ? 'Come if it is useful to you; nothing is recorded if you do not.'
                  : 'Your attendance will be recorded. If you cannot make it, the host is told now rather than on the day.'}
              </Text>
              <View style={styles.rsvpRow}>
                <Button
                  label="Accept"
                  loading={rsvp.isPending && rsvp.variables === 'accepted'}
                  onPress={() => rsvp.mutate('accepted')}
                  style={styles.rsvpGrow}
                />
                <Button
                  label="Decline"
                  variant="secondary"
                  loading={rsvp.isPending && rsvp.variables === 'declined'}
                  onPress={() => rsvp.mutate('declined')}
                />
              </View>
            </Card>
          </Appear>
        )
      })()}

      {data.isHost && data.status === 'awaiting_review' ? (
        <Appear index={1}>
          <Card style={styles.review}>
            <Label tone="violet">Waiting on you</Label>
            <Text style={styles.body}>
              Nothing has been sent to anyone yet. Confirm the actions and they go out.
            </Text>
            <Button
              label="Review the actions"
              onPress={() => router.push(`/meetings/${id}/review`)}
            />
          </Card>
        </Appear>
      ) : null}

      {data.attendanceResolution === 'did_not_occur' ? (
        <Appear index={2}>
          <Card>
            <Text style={styles.body}>
              This meeting was in the calendar but never ran, so no attendance was recorded
              for anyone.
            </Text>
          </Card>
        </Appear>
      ) : data.attendanceResolution === 'too_short' ? (
        <Appear index={2}>
          <Card>
            <Text style={styles.body}>
              This meeting ended too quickly to record attendance against, so nobody was
              marked present or absent.
            </Text>
          </Card>
        </Appear>
      ) : null}

      {data.summary ? (
        <Appear index={3}>
          <Card>
            <SectionTitle>Summary</SectionTitle>
            <Text style={styles.body}>{data.summary.overview}</Text>

            {data.summary.decisions.length > 0 ? (
              <View style={styles.block}>
                <Label>Decisions</Label>
                {data.summary.decisions.map((decision, i) => (
                  <Text key={i} style={styles.bullet}>
                    · {decision.decision}
                    {decision.context ? <Text style={styles.faint}> — {decision.context}</Text> : null}
                  </Text>
                ))}
              </View>
            ) : null}

            {data.summary.topics.map((topic, i) => (
              <View key={i} style={styles.block}>
                <Label>{topic.topic}</Label>
                {topic.points.map((point, j) => (
                  <Text key={j} style={styles.bullet}>
                    · {point}
                  </Text>
                ))}
              </View>
            ))}

            {data.summary.openQuestions.length > 0 ? (
              <View style={styles.block}>
                <Label>Left open</Label>
                {data.summary.openQuestions.map((question, i) => (
                  <Text key={i} style={styles.bullet}>
                    · {question}
                  </Text>
                ))}
              </View>
            ) : null}
          </Card>
        </Appear>
      ) : data.status === 'processing' ? (
        <Appear index={3}>
          <Card>
            <Text style={styles.body}>The summary is still being produced.</Text>
          </Card>
        </Appear>
      ) : null}

      {data.actions.length > 0 ? (
        <Appear index={4}>
          <Card>
            <SectionTitle>Actions</SectionTitle>
            {data.actions
              .filter((action) => action.status !== 'dismissed')
              .map((action) => (
                <View key={action.id} style={styles.action}>
                  <Text style={styles.actionText}>{action.description}</Text>
                  <Text style={styles.faint}>
                    {action.ownerName ?? 'Unassigned'}
                    {action.dueDate ? ` · due ${action.dueDate}` : ''}
                    {action.status === 'draft' ? ' · not yet confirmed' : ''}
                  </Text>
                </View>
              ))}
          </Card>
        </Appear>
      ) : null}

      <Appear index={5}>
        <Card>
          <SectionTitle>{data.status === 'scheduled' ? 'Invited' : 'Attendance'}</SectionTitle>
          {data.participants.map((person) => (
            <DataRow
              key={person.employeeId}
              label={`${person.employeeName}${person.isOptional ? ' · optional' : ''}`}
              value={
                data.status === 'scheduled'
                  ? describeInvite(person.inviteStatus)
                  : describeAttendance(person.attendanceStatus, person.minutesLate)
              }
              tone={
                data.status === 'scheduled'
                  ? person.inviteStatus === 'accepted'
                    ? 'success'
                    : person.inviteStatus === 'declined'
                      ? 'danger'
                      : 'muted'
                  : 'default'
              }
            />
          ))}
        </Card>
      </Appear>

      {/* Any attendee may query their own record, within the window. */}
      <Appear index={6}>
        {querying ? (
          <Card>
            <Label>What was wrong?</Label>
            <TextInput
              value={reason}
              onChangeText={setReason}
              placeholder="I was in the room from the start…"
              placeholderTextColor={colour.textFaint}
              multiline
              style={styles.input}
              accessibilityLabel="Why the record is wrong"
            />
            <Text style={styles.faint}>
              This goes to the host of the meeting, not to HR.
            </Text>
            <Button
              label={dispute.isSuccess ? 'Sent' : 'Send to the host'}
              disabled={reason.trim().length === 0 || dispute.isSuccess}
              loading={dispute.isPending}
              onPress={() => dispute.mutate(reason.trim())}
            />
            {dispute.isError ? (
              <ErrorNotice message="That could not be sent. The window to query this meeting may have closed." />
            ) : null}
          </Card>
        ) : (
          <Button
            label="My attendance looks wrong"
            variant="ghost"
            onPress={() => setQuerying(true)}
          />
        )}
      </Appear>

      <Appear index={7}>
        <Button label="Back" variant="ghost" onPress={() => router.back()} />
      </Appear>
    </Screen>
  )
}

function describeAttendance(status: string | null, minutesLate: number): string {
  switch (status) {
    case 'present':
      return 'Present'
    case 'late':
      return `${minutesLate} min late`
    case 'absent':
      return 'Absent'
    case 'excused':
      return 'On leave'
    case 'void':
      return '—'
    default:
      return 'Not recorded'
  }
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function describeInvite(status: string): string {
  switch (status) {
    case 'accepted':
      return 'Accepted'
    case 'declined':
      return 'Declined'
    case 'tentative':
      return 'Maybe'
    default:
      return 'No answer yet'
  }
}

const styles = StyleSheet.create({
  rsvpRow: { flexDirection: 'row', gap: space.sm },
  rsvpGrow: { flex: 1 },
  head: { gap: space.sm, paddingTop: space.sm },
  title: {
    fontSize: font.size.xl,
    color: colour.text,
    fontWeight: font.weight.bold,
    fontFamily: font.family,
  },
  meta: { fontSize: font.size.sm, color: colour.textMuted, fontFamily: font.family },

  review: { borderColor: colour.primaryBorder },
  body: {
    fontSize: font.size.md,
    color: colour.text,
    lineHeight: 21,
    fontFamily: font.family,
  },
  block: { gap: space.xs },
  bullet: {
    fontSize: font.size.sm,
    color: colour.text,
    lineHeight: 20,
    fontFamily: font.family,
  },
  faint: { fontSize: font.size.sm, color: colour.textMuted, fontFamily: font.family },

  action: { gap: space.xs, paddingVertical: space.sm },
  actionText: {
    fontSize: font.size.md,
    color: colour.text,
    lineHeight: 20,
    fontFamily: font.family,
  },

  input: {
    borderWidth: 1,
    borderColor: colour.borderStrong,
    borderRadius: radius.md,
    padding: space.md,
    minHeight: 84,
    fontSize: font.size.md,
    color: colour.text,
    backgroundColor: colour.surface,
    textAlignVertical: 'top',
    fontFamily: font.family,
  },
})
