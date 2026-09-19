/**
 * Create a meeting.
 *
 * Physical or virtual is the first question rather than a detail buried in the
 * form, because it changes what the rest of the screen is for: a physical
 * meeting needs a venue and a check-in code, a virtual one needs neither and
 * gets its attendance from the conference record instead.
 *
 * The code is issued as part of creating the meeting, not as a second errand.
 * A manager setting up a briefing already knows whether people are walking into
 * a room; making them come back for the code later is the step that gets
 * forgotten in the thirty seconds before it starts.
 */

import { useMemo, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import { addDays, type ISODate } from '@quanti/shared'
import {
  Appear,
  Button,
  Card,
  ErrorNotice,
  Press,
  Screen,
  SegmentedTabs,
} from '../../src/ui/components'
import { Figure, Label } from '../../src/ui/primitives'
import { colour, font, radius, space } from '../../src/ui/theme'
import { useCreateMeeting, useTeamAttendance } from '../../src/api/queries'

type Kind = 'physical' | 'virtual'

const KINDS: { value: Kind; label: string }[] = [
  { value: 'physical', label: 'In person' },
  { value: 'virtual', label: 'Virtual' },
]

export default function NewMeeting() {
  const router = useRouter()
  const create = useCreateMeeting()

  const today = useMemo(() => new Date().toISOString().slice(0, 10) as ISODate, [])
  const [kind, setKind] = useState<Kind>('physical')
  const [title, setTitle] = useState('')
  const [date, setDate] = useState<string>(today)
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('10:00')
  const [venue, setVenue] = useState('')
  const [invitees, setInvitees] = useState<string[]>([])

  // The manager's own team is the roster worth offering. Anyone else in the org
  // can still check in with the code; they simply are not expected, so they
  // never generate an absence.
  const team = useTeamAttendance(addDays(today, -30), today, true)
  const roster = team.data?.rows ?? []

  const [issued, setIssued] = useState<{ id: string; code: string | null } | null>(null)

  const valid = title.trim().length > 0 && startTime < endTime

  if (issued) {
    return (
      <Screen>
        <Appear index={0} from="scale">
          <Card tone="success">
            <Label tone="primary">Meeting created</Label>
            <Text style={styles.body}>{title.trim()}</Text>
            {issued.code ? (
              <>
                <Text style={styles.meta}>Attendees enter this code to check in.</Text>
                <View style={styles.codeBox}>
                  <Figure size="display" style={styles.code}>
                    {issued.code}
                  </Figure>
                </View>
              </>
            ) : (
              <Text style={styles.meta}>
                Attendance for a virtual meeting comes from the conference record — there is
                no code to hand out.
              </Text>
            )}
          </Card>
        </Appear>

        <Appear index={1}>
          <Button label="Open the meeting" onPress={() => router.replace(`/meetings/${issued.id}`)} />
        </Appear>
        <Appear index={2}>
          <Button label="Back to calendar" variant="ghost" onPress={() => router.back()} />
        </Appear>
      </Screen>
    )
  }

  return (
    <Screen>
      <Appear index={0}>
        <Text style={styles.title}>New meeting</Text>
      </Appear>

      <Appear index={1}>
        <SegmentedTabs options={KINDS} value={kind} onChange={setKind} />
      </Appear>

      <Appear index={2}>
        <Card>
          <Label>What is it?</Label>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Shift briefing"
            placeholderTextColor={colour.textFaint}
            style={styles.input}
            accessibilityLabel="Meeting title"
          />

          <Label>When?</Label>
          <TextInput
            value={date}
            onChangeText={setDate}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colour.textFaint}
            style={styles.input}
            accessibilityLabel="Date"
          />

          <View style={styles.times}>
            <View style={styles.timeField}>
              <Label>Starts</Label>
              <TextInput
                value={startTime}
                onChangeText={setStartTime}
                placeholder="09:00"
                placeholderTextColor={colour.textFaint}
                style={styles.input}
                accessibilityLabel="Start time"
              />
            </View>
            <View style={styles.timeField}>
              <Label>Ends</Label>
              <TextInput
                value={endTime}
                onChangeText={setEndTime}
                placeholder="10:00"
                placeholderTextColor={colour.textFaint}
                style={styles.input}
                accessibilityLabel="End time"
              />
            </View>
          </View>

          {kind === 'physical' ? (
            <>
              <Label>Where?</Label>
              <TextInput
                value={venue}
                onChangeText={setVenue}
                placeholder="Boardroom, 3rd floor"
                placeholderTextColor={colour.textFaint}
                style={styles.input}
                accessibilityLabel="Venue"
              />
            </>
          ) : null}
        </Card>
      </Appear>

      <Appear index={3}>
        <Card>
          <Label>Who is expected?</Label>
          <Text style={styles.meta}>
            Only people you pick can be marked absent. Anyone else can still check in.
          </Text>
          <View style={styles.people}>
            {roster.map((person) => {
              const on = invitees.includes(person.employeeId)
              return (
                <Press
                  key={person.employeeId}
                  accessibilityLabel={person.employeeName}
                  scaleTo={0.96}
                  onPress={() =>
                    setInvitees((prev) =>
                      on
                        ? prev.filter((id) => id !== person.employeeId)
                        : [...prev, person.employeeId],
                    )
                  }
                >
                  <View style={[styles.person, on && styles.personOn]}>
                    <Text style={[styles.personLabel, on && styles.personLabelOn]}>
                      {person.employeeName}
                    </Text>
                  </View>
                </Press>
              )
            })}
            {roster.length === 0 ? (
              <Text style={styles.meta}>No team members found on your reporting line.</Text>
            ) : null}
          </View>
        </Card>
      </Appear>

      <Appear index={4}>
        <View style={styles.footer}>
          <Button
            label={kind === 'physical' ? 'Create and generate code' : 'Create meeting'}
            disabled={!valid}
            loading={create.isPending}
            onPress={() =>
              create.mutate(
                {
                  title: title.trim(),
                  scheduledStart: new Date(`${date}T${startTime}:00`).toISOString(),
                  scheduledEnd: new Date(`${date}T${endTime}:00`).toISOString(),
                  inviteeIds: invitees,
                  physical: kind === 'physical',
                  venue: venue.trim(),
                },
                { onSuccess: (result) => setIssued(result) },
              )
            }
          />
          {!valid && title.trim().length > 0 ? (
            <Text style={styles.meta}>The end time has to be after the start.</Text>
          ) : null}
          {create.isError ? (
            <ErrorNotice message="That meeting could not be created. Check the date and times." />
          ) : null}
          <Button label="Cancel" variant="ghost" onPress={() => router.back()} />
        </View>
      </Appear>
    </Screen>
  )
}

const styles = StyleSheet.create({
  title: {
    fontSize: font.size.xxl,
    fontWeight: font.weight.bold,
    color: colour.text,
    letterSpacing: font.tracking.tight,
    paddingTop: space.sm,
    fontFamily: font.family,
  },
  body: {
    fontSize: font.size.lg,
    color: colour.text,
    fontWeight: font.weight.semibold,
    fontFamily: font.family,
  },
  meta: {
    fontSize: font.size.sm,
    color: colour.textMuted,
    lineHeight: 18,
    fontFamily: font.family,
  },

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
  times: { flexDirection: 'row', gap: space.md },
  timeField: { flex: 1, gap: space.xs },

  people: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  person: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colour.border,
  },
  personOn: { borderColor: colour.primaryBorder, backgroundColor: colour.primarySoft },
  personLabel: { fontSize: font.size.sm, color: colour.textMuted, fontFamily: font.family },
  personLabelOn: { color: colour.primary, fontWeight: font.weight.semibold },

  codeBox: {
    backgroundColor: colour.surfaceSunken,
    borderRadius: radius.md,
    paddingVertical: space.lg,
    alignItems: 'center',
  },
  code: { letterSpacing: 8, color: colour.text },

  footer: { gap: space.sm },
})
