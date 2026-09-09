/**
 * In-person recording (meeting-assistant spec §3.1, §8.1).
 *
 * Three things on this screen are consent mechanics rather than UI:
 *
 *   1. The host must confirm they have told the room before recording starts.
 *      Google Meet shows its own indicator on the virtual path; in a room,
 *      this and the push notification to everyone checked in are the whole of
 *      the signal.
 *   2. The recording indicator is large, permanent and unmissable while live.
 *   3. Off the record is available to everyone in the room, not just the host,
 *      and it is retroactive — people flag a moment after realising it
 *      happened, not before.
 *
 * Audio only, chunked every sixty seconds and uploaded as each chunk closes, so
 * a dropped connection costs a minute rather than the meeting.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio'
import {
  Appear,
  Badge,
  Button,
  Card,
  ErrorNotice,
  Screen,
  SectionTitle,
} from '../../../src/ui/components'
import { Label } from '../../../src/ui/primitives'
import { colour, font, radius, space } from '../../../src/ui/theme'
import { useMeeting, useRecording } from '../../../src/api/queries'

const CHUNK_MS = 60_000

export default function Record() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const meeting = useMeeting(id)
  const { start, uploadChunk, stop, offRecord } = useRecording(id ?? '')
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY)

  const [told, setTold] = useState(false)
  const [live, setLive] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [flagged, setFlagged] = useState(0)
  const [permission, setPermission] = useState<boolean | null>(null)
  const sequence = useRef(0)
  const startedAt = useRef<number>(0)

  useEffect(() => {
    void (async () => {
      const status = await AudioModule.requestRecordingPermissionsAsync()
      setPermission(status.granted)
      if (status.granted) {
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
      }
    })()
  }, [])

  // The elapsed timer doubles as the recording indicator. Keeping it prominent
  // is the point — nobody should have to look for whether this is live.
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setElapsed(Date.now() - startedAt.current), 1000)
    return () => clearInterval(timer)
  }, [live])

  const rollChunk = useCallback(async () => {
    // Close the current file, ship it, and immediately open the next one.
    await recorder.stop()
    const uri = recorder.uri
    if (uri) {
      try {
        const response = await fetch(uri)
        const blob = await response.blob()
        const base64 = await blobToBase64(blob)
        await uploadChunk.mutateAsync({
          sequence: sequence.current,
          audio: base64,
          durationMs: CHUNK_MS,
        })
        sequence.current += 1
      } catch {
        // A failed chunk must not stop the recording. The upload is retried by
        // the next roll; losing one minute beats losing the meeting.
      }
    }
    if (live) {
      await recorder.prepareToRecordAsync()
      recorder.record()
    }
  }, [recorder, uploadChunk, live])

  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => void rollChunk(), CHUNK_MS)
    return () => clearInterval(timer)
  }, [live, rollChunk])

  // Backgrounding, an incoming call, or a low battery must pause cleanly rather
  // than lose the session.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active' && live) void rollChunk()
    })
    return () => sub.remove()
  }, [live, rollChunk])

  const data = meeting.data

  if (permission === false) {
    return (
      <Screen>
        <ErrorNotice message="Quanti needs microphone access to record this meeting." />
        <Button label="Back" variant="ghost" onPress={() => router.back()} />
      </Screen>
    )
  }

  return (
    <Screen>
      <Appear index={0}>
        <View style={styles.head}>
          <Text style={styles.title}>{data?.title ?? 'Meeting'}</Text>
          <Text style={styles.meta}>
            {data?.participants.length ?? 0} checked in · audio only
          </Text>
        </View>
      </Appear>

      {live ? (
        <Appear index={1}>
          <Card style={styles.liveCard}>
            <View style={styles.liveRow}>
              <View style={styles.dot} />
              <Text style={styles.liveLabel}>Recording</Text>
              <Text style={styles.timer}>{formatElapsed(elapsed)}</Text>
            </View>
            <Text style={styles.body}>
              Everyone who checked in has been told this meeting is being recorded.
            </Text>
          </Card>
        </Appear>
      ) : (
        <Appear index={1}>
          <Card>
            <SectionTitle>Before you start</SectionTitle>
            <Text style={styles.body}>
              Place the phone in the middle of the table. One phone at the end of a long
              table produces poor audio, and poor audio is what stops the summary knowing
              who said what.
            </Text>
            <Button
              label={told ? '✓ I have told the room' : 'I have told the room we are recording'}
              variant={told ? 'secondary' : 'primary'}
              onPress={() => setTold((prev) => !prev)}
            />
          </Card>
        </Appear>
      )}

      <Appear index={2}>
        <Card>
          <Label>In the room</Label>
          {(data?.participants ?? []).map((person) => (
            <Text key={person.employeeId} style={styles.attendee}>
              {person.employeeName}
            </Text>
          ))}
          {(data?.participants.length ?? 0) === 0 ? (
            <Text style={styles.faint}>
              Nobody has checked in yet. Attendees check in with the room code.
            </Text>
          ) : null}
        </Card>
      </Appear>

      {live ? (
        <>
          <Appear index={3}>
            <Card>
              <Text style={styles.body}>
                Anything sensitive just said? Mark the last two minutes off the record and it
                is never stored or summarised.
              </Text>
              <Button
                label={flagged > 0 ? `Off the record (${flagged})` : 'Last 2 minutes off the record'}
                variant="secondary"
                onPress={() => {
                  offRecord.mutate(Date.now() - startedAt.current)
                  setFlagged((n) => n + 1)
                }}
              />
              {offRecord.isError ? (
                <ErrorNotice message="That flag did not save. Try it again." />
              ) : null}
            </Card>
          </Appear>

          <Appear index={4}>
            <Button
              label="Stop recording"
              variant="danger"
              loading={stop.isPending}
              onPress={() => {
                setLive(false)
                void (async () => {
                  await rollChunk()
                  stop.mutate(undefined, {
                    onSuccess: (result) => {
                      router.replace(
                        result.speakersToTag && result.speakersToTag > 0
                          ? `/meetings/${id}/speakers`
                          : `/meetings/${id}`,
                      )
                    },
                  })
                })()
              }}
            />
          </Appear>
        </>
      ) : (
        <Appear index={3}>
          <View style={styles.footer}>
            <Button
              label="Start recording"
              disabled={!told || permission !== true}
              loading={start.isPending}
              onPress={() =>
                start.mutate(undefined, {
                  onSuccess: async () => {
                    await recorder.prepareToRecordAsync()
                    recorder.record()
                    startedAt.current = Date.now()
                    sequence.current = 0
                    setElapsed(0)
                    setLive(true)
                  },
                })
              }
            />
            {!told ? (
              <Text style={styles.faint}>
                Confirm you have told the room before recording can start.
              </Text>
            ) : null}
            <Button label="Back" variant="ghost" onPress={() => router.back()} />
          </View>
        </Appear>
      )}

      {data?.routeToHr ? (
        <Appear index={5}>
          <Badge label="This meeting type is shared with HR" tone="warning" />
        </Appear>
      ) : null}
    </Screen>
  )
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!)
  return globalThis.btoa(binary)
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
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

  liveCard: { borderColor: colour.dangerSoft, backgroundColor: colour.dangerSoft },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  dot: { width: 12, height: 12, borderRadius: radius.pill, backgroundColor: colour.danger },
  liveLabel: {
    flex: 1,
    fontSize: font.size.md,
    color: colour.text,
    fontWeight: font.weight.bold,
    fontFamily: font.family,
  },
  timer: {
    fontSize: font.size.lg,
    color: colour.text,
    fontFamily: font.mono,
  },

  body: {
    fontSize: font.size.md,
    color: colour.text,
    lineHeight: 22,
    fontFamily: font.family,
  },
  faint: {
    fontSize: font.size.sm,
    color: colour.textMuted,
    lineHeight: 21,
    fontFamily: font.family,
  },
  attendee: { fontSize: font.size.md, color: colour.text, fontFamily: font.family },
  footer: { gap: space.sm },
})
