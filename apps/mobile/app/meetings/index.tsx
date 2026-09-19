/**
 * Meetings — upcoming and past (meeting-assistant spec §9).
 *
 * Past entries lead with their processing state, because the only reason to
 * open this screen for a meeting that already happened is to find out whether
 * the summary is ready or whether it is waiting on you.
 */

import { useState } from 'react'
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import {
  Appear,
  Badge,
  Card,
  EmptyState,
  Screen,
  SegmentedTabs,
  Skeleton,
} from '../../src/ui/components'
import { Label } from '../../src/ui/primitives'
import { colour, font, space } from '../../src/ui/theme'
import { keys, useMeetings, type MeetingListItemView } from '../../src/api/queries'

type Window = 'past' | 'upcoming'
type Tab = Window | 'codes'

/**
 * Codes sits alongside the two windows rather than in its own place in the tab
 * bar. It is the same subject — meetings — and it is only ever wanted while one
 * is about to start, so burying it a level down would mean hunting for it in
 * the thirty seconds before a room fills up.
 */
const TABS: { value: Tab; label: string }[] = [
  { value: 'past', label: 'Past' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'codes', label: 'Codes' },
]

export default function Meetings() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [window, setWindow] = useState<Window>('past')
  const meetings = useMeetings(window)

  const rows = meetings.data?.meetings ?? []
  const waiting = rows.filter((m) => m.awaitingYourReview)

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={meetings.isRefetching}
          onRefresh={() => queryClient.invalidateQueries({ queryKey: keys.meetings(window) })}
          tintColor={colour.primary}
        />
      }
    >
      <Appear index={0}>
        <SegmentedTabs
          options={TABS}
          value={window}
          onChange={(next) => {
            if (next === 'codes') {
              router.push('/meetings/codes')
              return
            }
            setWindow(next)
          }}
        />
      </Appear>

      {waiting.length > 0 && window === 'past' ? (
        <Appear index={1}>
          <Card style={styles.waiting}>
            <Label tone="violet">Waiting on you</Label>
            <Text style={styles.waitingText}>
              {waiting.length === 1
                ? 'One meeting summary needs your review before the tasks go out.'
                : `${waiting.length} meeting summaries need your review before the tasks go out.`}
            </Text>
          </Card>
        </Appear>
      ) : null}

      {meetings.isLoading ? (
        <>
          <Skeleton height={92} />
          <Skeleton height={92} />
          <Skeleton height={92} />
        </>
      ) : rows.length === 0 ? (
        <Appear index={2}>
          <EmptyState
            title={window === 'past' ? 'No meetings yet' : 'Nothing scheduled'}
            body={
              window === 'past'
                ? 'Meetings appear here once they have run. Summaries arrive a few minutes after the meeting ends.'
                : 'Meetings from your calendar will show up here before they start.'
            }
          />
        </Appear>
      ) : (
        rows.map((meeting, index) => (
          <Appear key={meeting.id} index={2 + index}>
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                router.push(
                  meeting.awaitingYourReview
                    ? `/meetings/${meeting.id}/review`
                    : `/meetings/${meeting.id}`,
                )
              }
            >
              <Card>
                <View style={styles.head}>
                  <Text style={styles.title} numberOfLines={1}>
                    {meeting.title}
                  </Text>
                  <StatusBadge meeting={meeting} />
                </View>

                <Text style={styles.meta}>
                  {formatWhen(meeting.scheduledStart)} ·{' '}
                  {meeting.source === 'in_person' ? 'In person' : 'Google Meet'} ·{' '}
                  {meeting.participantCount}{' '}
                  {meeting.participantCount === 1 ? 'person' : 'people'}
                </Text>

                {meeting.routeToHr ? (
                  // Shown before the meeting rather than discovered afterwards.
                  // People behave differently when HR reads the transcript, and
                  // that is their right — but only if they know (§8.3).
                  <Text style={styles.hr}>Shared with HR</Text>
                ) : null}
              </Card>
            </Pressable>
          </Appear>
        ))
      )}
    </Screen>
  )
}

function StatusBadge({ meeting }: { meeting: MeetingListItemView }) {
  if (meeting.awaitingYourReview) return <Badge label="Review" tone="pending" />
  if (meeting.status === 'did_not_occur') return <Badge label="Did not run" tone="neutral" />
  if (meeting.status === 'processing') return <Badge label="Processing" tone="info" />
  if (meeting.status === 'awaiting_review') return <Badge label="With the host" tone="neutral" />
  if (meeting.status === 'failed') return <Badge label="Failed" tone="danger" />
  if (meeting.status === 'ready') {
    return (
      <Badge
        label={meeting.actionCount === 1 ? '1 action' : `${meeting.actionCount} actions`}
        tone="success"
      />
    )
  }
  return <Badge label="Scheduled" tone="neutral" />
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const styles = StyleSheet.create({

  waiting: { borderColor: colour.primaryBorder },
  waitingText: {
    fontSize: font.size.md,
    color: colour.text,
    lineHeight: 20,
    fontFamily: font.family,
  },

  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  title: {
    flex: 1,
    fontSize: font.size.md,
    color: colour.text,
    fontWeight: font.weight.semibold,
    fontFamily: font.family,
  },
  meta: { fontSize: font.size.sm, color: colour.textMuted, fontFamily: font.family },
  hr: { fontSize: font.size.sm, color: colour.warning, fontFamily: font.family },
})
