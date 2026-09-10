/**
 * Check-in codes for physical meetings.
 *
 * Distinct from the building's door code, which rotates per location and is
 * HR's to display at the entrance. This is one fixed code per sitting, issued
 * by whoever is running the meeting — restricting it to HR would mean a manager
 * cannot start their own meeting without ringing someone, which is how a
 * feature stops being used.
 *
 * The code does not rotate mid-meeting on purpose. A rotation partway through
 * locks out whoever arrived late, and that is exactly the person who still
 * needs to check in.
 *
 * Displayed large and mono, because the whole interaction is someone reading it
 * off a phone held up at the front of a room.
 */

import { useState } from 'react'
import { RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native'
import { useQueryClient } from '@tanstack/react-query'
import {
  Appear,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Screen,
  Skeleton,
} from '../../src/ui/components'
import { Figure, Label } from '../../src/ui/primitives'
import { colour, font, radius, space } from '../../src/ui/theme'
import {
  keys,
  useGenerateMeetingCode,
  useMeetingCodes,
  type MeetingCodeView,
} from '../../src/api/queries'

export default function MeetingCodes() {
  const queryClient = useQueryClient()
  const codes = useMeetingCodes()
  const rows = codes.data?.meetings ?? []

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={codes.isRefetching}
          onRefresh={() => queryClient.invalidateQueries({ queryKey: keys.meetingCodes })}
          tintColor={colour.primary}
        />
      }
    >
      <Appear index={0}>
        <View style={styles.head}>
          <Text style={styles.title}>Meeting codes</Text>
          <Text style={styles.meta}>
            In-person meetings running now or soon. Attendees enter the code to check in.
          </Text>
        </View>
      </Appear>

      {codes.isLoading ? (
        <>
          <Skeleton height={140} />
          <Skeleton height={140} />
        </>
      ) : rows.length === 0 ? (
        <Appear index={1}>
          <EmptyState
            title="No meetings to code"
            body="In-person meetings from the last six hours and the next twelve appear here. Create one and it will show up."
          />
        </Appear>
      ) : (
        rows.map((row, index) => (
          <Appear key={row.meetingId} index={1 + index}>
            <CodeCard row={row} />
          </Appear>
        ))
      )}
    </Screen>
  )
}

function CodeCard({ row }: { row: MeetingCodeView }) {
  const generate = useGenerateMeetingCode()
  const [venue, setVenue] = useState(row.venue ?? '')
  const [agenda, setAgenda] = useState(row.agenda ?? '')
  const [editing, setEditing] = useState(!row.code)

  const expired = row.expiresAt !== null && new Date(row.expiresAt) < new Date()

  return (
    <Card>
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {row.title}
        </Text>
        <Text style={styles.when}>{formatWhen(row.scheduledStart)}</Text>
      </View>

      {row.venue || row.locationName ? (
        <Text style={styles.meta}>{row.venue ?? row.locationName}</Text>
      ) : null}

      {row.code && !editing ? (
        <>
          <View style={[styles.codeBox, expired && styles.codeExpired]}>
            <Figure size="display" style={styles.code}>
              {row.code}
            </Figure>
          </View>
          <Text style={styles.meta}>
            {expired
              ? 'This code has expired — generate a new one.'
              : `Valid until ${formatWhen(row.expiresAt!)} · ${row.checkedIn} checked in`}
          </Text>
          <Button
            label={expired ? 'Generate a new code' : 'Replace this code'}
            variant={expired ? 'primary' : 'ghost'}
            onPress={() => setEditing(true)}
          />
        </>
      ) : (
        <>
          <Label>Where is it?</Label>
          <TextInput
            value={venue}
            onChangeText={setVenue}
            placeholder="Boardroom, 3rd floor"
            placeholderTextColor={colour.textFaint}
            style={styles.input}
            accessibilityLabel="Venue"
          />

          <Label>What is it for?</Label>
          <TextInput
            value={agenda}
            onChangeText={setAgenda}
            placeholder="Optional. Shown to attendees when they check in."
            placeholderTextColor={colour.textFaint}
            multiline
            style={[styles.input, styles.multiline]}
            accessibilityLabel="Agenda"
          />

          <Button
            label={row.code ? 'Replace the code' : 'Generate code'}
            loading={generate.isPending}
            onPress={() =>
              generate.mutate(
                { meetingId: row.meetingId, venue: venue.trim(), agenda: agenda.trim() },
                { onSuccess: () => setEditing(false) },
              )
            }
          />
          {row.code ? (
            <Button label="Cancel" variant="ghost" onPress={() => setEditing(false)} />
          ) : null}

          {generate.isError ? (
            <ErrorNotice message="That code could not be generated. Only the host or an HR admin can issue one." />
          ) : null}
        </>
      )}
    </Card>
  )
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const styles = StyleSheet.create({
  head: { gap: space.xs, paddingTop: space.sm },
  title: {
    fontSize: font.size.xxl,
    fontWeight: font.weight.bold,
    color: colour.text,
    letterSpacing: font.tracking.tight,
    fontFamily: font.family,
  },
  meta: {
    fontSize: font.size.sm,
    color: colour.textMuted,
    lineHeight: 20,
    fontFamily: font.family,
  },

  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  cardTitle: {
    flex: 1,
    fontSize: font.size.md,
    color: colour.text,
    fontWeight: font.weight.semibold,
    fontFamily: font.family,
  },
  when: { fontSize: font.size.sm, color: colour.textMuted, fontFamily: font.family },

  codeBox: {
    backgroundColor: colour.surfaceSunken,
    borderRadius: radius.md,
    paddingVertical: space.lg,
    alignItems: 'center',
  },
  codeExpired: { opacity: 0.45 },
  code: { letterSpacing: 8, color: colour.text },

  input: {
    borderWidth: 1,
    borderColor: colour.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    minHeight: 48,
    fontSize: font.size.md,
    color: colour.text,
    backgroundColor: colour.surface,
    fontFamily: font.family,
  },
  multiline: { minHeight: 76, paddingTop: space.md, textAlignVertical: 'top' },
})
