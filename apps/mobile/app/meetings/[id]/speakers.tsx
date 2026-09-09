/**
 * Speaker tagging (meeting-assistant spec §6).
 *
 * Diarisation splits a recording into distinct voices. It does not know their
 * names — every provider hands back "Speaker 0", "Speaker 1". Without names,
 * task extraction cannot assign anything, which removes most of the value.
 *
 * This screen closes that gap the unglamorous way: the candidate list is the
 * people who checked into the room, so it is six names rather than the whole
 * company, and the host taps once per voice. Voice enrolment would remove the
 * step, but it adds a biometric data category with its own consent bar and it
 * degrades badly on poor room audio. A product that asks for six taps and then
 * works beats one that guesses and is wrong.
 *
 * Skippable throughout. A meeting with untagged voices still gets a summary,
 * with the unassignable actions surfacing as unassigned rather than vanishing.
 */

import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  Appear,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Screen,
  Skeleton,
} from '../../../src/ui/components'
import { Label } from '../../../src/ui/primitives'
import { colour, font, radius, space } from '../../../src/ui/theme'
import { useSpeakers, useTagSpeakers } from '../../../src/api/queries'

export default function Speakers() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const speakers = useSpeakers(id)
  const tag = useTagSpeakers(id ?? '')
  const [mapping, setMapping] = useState<Record<string, string | null>>({})

  if (speakers.isLoading) {
    return (
      <Screen>
        <Skeleton height={140} />
        <Skeleton height={140} />
      </Screen>
    )
  }

  const data = speakers.data
  if (!data) {
    return (
      <Screen>
        <ErrorNotice message="The transcript for this meeting is not ready yet." />
        <Button label="Back" variant="ghost" onPress={() => router.back()} />
      </Screen>
    )
  }

  if (data.speakers.length === 0) {
    return (
      <Screen>
        <EmptyState
          title="Every voice is identified"
          body="There is nothing to tag for this meeting."
        />
        <Button label="Back" variant="ghost" onPress={() => router.back()} />
      </Screen>
    )
  }

  const tagged = data.speakers.filter(
    (s) => (mapping[s.speakerLabel] ?? s.employeeId) !== null,
  ).length

  return (
    <Screen>
      <Appear index={0}>
        <View style={styles.head}>
          <Text style={styles.title}>Who was speaking?</Text>
          <Text style={styles.meta}>
            {data.speakers.length} {data.speakers.length === 1 ? 'voice' : 'voices'} to match
            against the {data.attendees.length} people who checked in.
          </Text>
        </View>
      </Appear>

      {data.speakers.map((speaker, index) => {
        const selected = mapping[speaker.speakerLabel] ?? speaker.employeeId

        return (
          <Appear key={speaker.speakerLabel} index={1 + index}>
            <Card>
              <Label>{speaker.speakerLabel.replace('unknown_', 'Voice ')}</Label>

              {/* The longest turn, not the first. The first thing anyone says
                  in a meeting is "can you hear me", which identifies nobody. */}
              <View style={styles.clip}>
                <Text style={styles.clipText}>“{speaker.text}”</Text>
                <Text style={styles.clipMeta}>at {formatOffset(speaker.startMs)}</Text>
              </View>

              <View style={styles.options}>
                {data.attendees.map((person) => {
                  const active = selected === person.employeeId
                  return (
                    <Pressable
                      key={person.employeeId}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      onPress={() =>
                        setMapping((prev) => ({
                          ...prev,
                          [speaker.speakerLabel]: active ? null : person.employeeId,
                        }))
                      }
                      style={[styles.option, active && styles.optionSelected]}
                    >
                      <Text style={[styles.optionLabel, active && styles.optionLabelSelected]}>
                        {person.employeeName}
                      </Text>
                    </Pressable>
                  )
                })}
              </View>
            </Card>
          </Appear>
        )
      })}

      <Appear index={1 + data.speakers.length}>
        <View style={styles.footer}>
          <Button
            label={
              tagged === data.speakers.length
                ? 'Save and summarise'
                : `Save ${tagged} of ${data.speakers.length}`
            }
            loading={tag.isPending}
            onPress={() =>
              tag.mutate(
                data.speakers.map((speaker) => ({
                  speakerLabel: speaker.speakerLabel,
                  employeeId: mapping[speaker.speakerLabel] ?? speaker.employeeId,
                })),
                { onSuccess: () => router.replace(`/meetings/${id}`) },
              )
            }
          />

          {/* Skipping is a supported outcome, not a failure. */}
          <Button
            label="Skip — summarise without names"
            variant="ghost"
            onPress={() =>
              tag.mutate([], { onSuccess: () => router.replace(`/meetings/${id}`) })
            }
          />

          {tag.isError ? <ErrorNotice message="That could not be saved." /> : null}
        </View>
      </Appear>
    </Screen>
  )
}

function formatOffset(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

const styles = StyleSheet.create({
  head: { gap: space.xs, paddingTop: space.sm },
  title: {
    fontSize: font.size.xl,
    color: colour.text,
    fontWeight: font.weight.bold,
    fontFamily: font.family,
  },
  meta: {
    fontSize: font.size.sm,
    color: colour.textMuted,
    lineHeight: 21,
    fontFamily: font.family,
  },

  clip: {
    borderLeftWidth: 2,
    borderLeftColor: colour.borderStrong,
    paddingLeft: space.md,
    gap: space.xs,
  },
  clipText: {
    fontSize: font.size.md,
    color: colour.text,
    lineHeight: 22,
    fontStyle: 'italic',
    fontFamily: font.family,
  },
  clipMeta: { fontSize: font.size.sm, color: colour.textFaint, fontFamily: font.family },

  options: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  option: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colour.border,
  },
  optionSelected: { borderColor: colour.primaryBorder, backgroundColor: colour.primarySoft },
  optionLabel: { fontSize: font.size.sm, color: colour.textMuted, fontFamily: font.family },
  optionLabelSelected: { color: colour.primary, fontWeight: font.weight.semibold },

  footer: { gap: space.sm },
})
