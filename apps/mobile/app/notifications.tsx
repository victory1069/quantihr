/**
 * The inbox — everything the app has told this person, newest first.
 *
 * Push is a delivery channel, not a record: a notification swiped away on
 * the phone, or never delivered because the web has no push, still has to be
 * findable. This is where. Anything that carries actions (an invitation, a
 * request to approve) offers them here too, so nobody has to go hunting for
 * the screen the notification pointed at.
 */

import { useEffect } from 'react'
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import { Appear, Button, Card, EmptyState, SheetPage, Skeleton } from '../src/ui/components'
import { colour, font, space } from '../src/ui/theme'
import {
  keys,
  useMarkNotificationsRead,
  useNotifications,
  useRsvp,
  type NotificationItem,
} from '../src/api/queries'

export default function Notifications() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const inbox = useNotifications()
  const markRead = useMarkNotificationsRead()

  const rows = inbox.data?.notifications ?? []
  const unread = inbox.data?.unread ?? 0

  // Opening the inbox is reading it. Marked after the first successful load
  // so the badge clears when the list is actually on screen, not before.
  useEffect(() => {
    if (inbox.data && inbox.data.unread > 0) markRead.mutate(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inbox.data?.unread])

  return (
    <SheetPage
      eyebrow="Notifications"
      title={unread > 0 ? `${unread} new` : 'You are up to date'}
      refreshControl={
        <RefreshControl
          refreshing={inbox.isRefetching}
          onRefresh={() => void queryClient.invalidateQueries({ queryKey: keys.notifications })}
          tintColor={colour.primary}
        />
      }
    >
      {inbox.data ? (
        rows.length > 0 ? (
          rows.map((n, i) => (
            <Appear key={n.id} index={Math.min(i, 8)}>
              <NotificationCard item={n} onOpen={() => n.deepLink && router.push(n.deepLink as never)} />
            </Appear>
          ))
        ) : (
          <EmptyState
            title="Nothing yet"
            body="Invitations, decisions on your requests and reminders will land here."
          />
        )
      ) : (
        <Card>
          <Skeleton height={18} width={200} />
          <Skeleton height={40} />
        </Card>
      )}
    </SheetPage>
  )
}

function NotificationCard({ item, onOpen }: { item: NotificationItem; onOpen: () => void }) {
  const meetingId = typeof item.data.meetingId === 'string' ? item.data.meetingId : null
  const rsvp = useRsvp(meetingId ?? '')
  const actions = item.data.actions ?? []
  const answered = typeof item.data.answered === 'string' ? item.data.answered : null
  const fresh = !item.readAt

  return (
    // The card itself is not pressable: a button inside a pressable card is a
    // nested button, and on the web the inner tap bubbles to the outer one.
    // The text opens the deep link; the actions act.
    <Card>
      <Pressable onPress={onOpen} accessibilityRole="button" disabled={!item.deepLink}>
        <View style={styles.row}>
          <View style={[styles.dot, { backgroundColor: fresh ? toneFor(item.event) : 'transparent' }]} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[styles.title, !fresh && styles.titleRead]}>{item.title}</Text>
            <Text style={styles.body}>{item.body}</Text>
            <Text style={styles.when}>{ago(item.createdAt)}</Text>
          </View>
        </View>
      </Pressable>

      {meetingId && actions.includes('accept') ? (
        rsvp.isSuccess || answered ? (
          <Text style={styles.answered}>
            You {(answered ?? (rsvp.variables === 'accepted' ? 'accepted' : 'declined')) === 'accepted' ? 'accepted' : 'declined'}.
          </Text>
        ) : (
          <View style={styles.actions}>
            <Button
              label="Accept"
              loading={rsvp.isPending && rsvp.variables === 'accepted'}
              onPress={() => rsvp.mutate('accepted')}
              style={styles.grow}
            />
            <Button
              label="Decline"
              variant="secondary"
              loading={rsvp.isPending && rsvp.variables === 'declined'}
              onPress={() => rsvp.mutate('declined')}
            />
          </View>
        )
      ) : actions.length > 0 && item.deepLink ? (
        <Pressable onPress={onOpen} accessibilityRole="button">
          <Text style={styles.link}>
            {actions.includes('approve') ? 'Open to decide ›' : actions.includes('review') ? 'Review ›' : 'Open ›'}
          </Text>
        </Pressable>
      ) : null}
    </Card>
  )
}

function toneFor(event: string): string {
  if (event.startsWith('meeting.')) return colour.accent
  if (event.startsWith('training.')) return colour.success
  if (event.startsWith('leave.')) return colour.warning
  return colour.primary
}

function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000))
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days} d ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 7 },
  title: { fontSize: font.size.md, fontWeight: font.weight.bold, color: colour.text, fontFamily: font.family },
  titleRead: { fontWeight: font.weight.semibold, color: colour.textMuted },
  body: { fontSize: font.size.md, color: colour.textMuted, lineHeight: 20, fontFamily: font.family },
  when: { fontSize: font.size.xs, color: colour.textFaint, fontFamily: font.mono, marginTop: 2 },
  actions: { flexDirection: 'row', gap: space.sm, paddingLeft: space.md + 8 },
  grow: { flex: 1 },
  answered: { fontSize: font.size.sm, color: colour.success, fontFamily: font.family, paddingLeft: space.md + 8 },
  link: { fontSize: font.size.md, color: colour.primary, fontWeight: font.weight.semibold, fontFamily: font.family, paddingLeft: space.md + 8 },
})
