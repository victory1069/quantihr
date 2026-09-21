/**
 * Check-in (spec §5, §7).
 *
 * "Shows clearly whether the window is open, and if it isn't, when it opens.
 * Failed attempts show why (out of range, wrong code, stale code) rather than a
 * generic error."
 *
 * The location status indicator resolves before the employee types, so a bad
 * fix is visible up front instead of turning into a rejection after submit.
 */

import { useCallback, useEffect, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ApiError } from '@quanti/shared'
import { Badge, Button, Card, ErrorNotice, Screen, Skeleton } from '../src/ui/components'
import { colour, font, radius, space } from '../src/ui/theme'
import { useAttendanceStatus, useCheckin } from '../src/api/queries'
import { captureFix, distanceTo, type LocationFix } from '../src/lib/location'
import { getDeviceId } from '../src/store/session'
import { NetworkError } from '../src/api/client'

type FixState =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'ready'; fix: LocationFix; distanceM: number | null }
  | { kind: 'error'; message: string }

export default function Checkin() {
  const router = useRouter()
  const status = useAttendanceStatus()
  const checkin = useCheckin()

  const [code, setCode] = useState('')
  const [fixState, setFixState] = useState<FixState>({ kind: 'idle' })
  const [result, setResult] = useState<
    { kind: 'ok'; message: string } | { kind: 'error'; message: string } | null
  >(null)

  const location = status.data?.location ?? null

  const locate = useCallback(async () => {
    setFixState({ kind: 'locating' })
    const outcome = await captureFix()
    if (!outcome.ok) {
      setFixState({ kind: 'error', message: outcome.message })
      return
    }
    setFixState({
      kind: 'ready',
      fix: outcome.fix,
      distanceM: location ? distanceTo(outcome.fix, location) : null,
    })
  }, [location])

  useEffect(() => {
    if (status.data && fixState.kind === 'idle') void locate()
  }, [status.data, fixState.kind, locate])

  const alreadyIn =
    status.data?.record?.status === 'present' || status.data?.record?.status === 'late'
  const windowOpen = status.data?.window.open ?? false
  const canSubmit = windowOpen && !alreadyIn && code.trim().length >= 4 && fixState.kind === 'ready'

  const submit = async () => {
    if (fixState.kind !== 'ready') return
    setResult(null)

    try {
      const deviceId = await getDeviceId()
      const drain = await checkin.mutateAsync({
        code: code.trim().toUpperCase(),
        latitude: fixState.fix.latitude,
        longitude: fixState.fix.longitude,
        accuracyM: fixState.fix.accuracyM,
        isMocked: fixState.fix.isMocked,
        deviceId,
      })

      if (drain.error instanceof NetworkError) {
        setResult({
          kind: 'ok',
          message:
            'You are offline. Your check-in is queued and will send automatically when you reconnect.',
        })
        return
      }
      if (drain.error instanceof ApiError) {
        setResult({ kind: 'error', message: drain.error.message })
        return
      }
      if (drain.sent > 0) {
        setResult({ kind: 'ok', message: 'Checked in. Have a good day.' })
        setCode('')
        setTimeout(() => router.replace('/'), 1200)
        return
      }
      setResult({ kind: 'error', message: 'Could not complete check-in. Try again.' })
    } catch (error) {
      setResult({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Something went wrong.',
      })
    }
  }

  return (
    <Screen>
      <Text style={styles.title}>Check in</Text>

      {/* Window state */}
      <Card>
        {status.data ? (
          <>
            <View style={styles.rowBetween}>
              <Text style={styles.cardTitle}>
                {alreadyIn
                  ? 'Already checked in today'
                  : windowOpen
                    ? 'Check-in is open'
                    : 'Check-in is closed'}
              </Text>
              <Badge
                label={windowOpen && !alreadyIn ? 'Open' : 'Closed'}
                tone={windowOpen && !alreadyIn ? 'success' : 'neutral'}
              />
            </View>
            <Text style={styles.cardBody}>{windowMessage(status.data)}</Text>
          </>
        ) : (
          <Skeleton height={44} />
        )}
      </Card>

      {/* Location indicator */}
      <Card>
        <Text style={styles.cardTitle}>Location</Text>

        {fixState.kind === 'locating' || fixState.kind === 'idle' ? (
          <Text style={styles.cardBody}>Getting your location…</Text>
        ) : fixState.kind === 'error' ? (
          <ErrorNotice
            message={fixState.message}
            action={<Button label="Try again" variant="secondary" onPress={locate} />}
          />
        ) : (
          <>
            <View style={styles.rowBetween}>
              <Text style={styles.cardBody}>
                {location
                  ? fixState.distanceM !== null && fixState.distanceM <= location.geofenceRadiusM
                    ? `You are at ${location.name}.`
                    : `You are about ${Math.round(fixState.distanceM ?? 0)}m from ${location.name}.`
                  : 'No office location assigned to you.'}
              </Text>
              <Badge
                label={
                  location && fixState.distanceM !== null
                    ? fixState.distanceM <= location.geofenceRadiusM
                      ? 'In range'
                      : 'Out of range'
                    : 'Unknown'
                }
                tone={
                  location && fixState.distanceM !== null && fixState.distanceM <= location.geofenceRadiusM
                    ? 'success'
                    : 'warning'
                }
              />
            </View>
            <Text style={styles.meta}>
              Accuracy ±{Math.round(fixState.fix.accuracyM)}m
              {fixState.fix.isMocked ? ' · simulated location detected' : ''}
            </Text>
            <Button label="Refresh location" variant="ghost" onPress={locate} />
          </>
        )}
      </Card>

      {/* Code entry */}
      <Card>
        <Text style={styles.cardTitle}>Office code</Text>
        <Text style={styles.cardBody}>
          Enter the code shown on the display at your office entrance.
        </Text>
        <TextInput
          value={code}
          onChangeText={(v) => setCode(v.toUpperCase())}
          placeholder="ABC123"
          placeholderTextColor={colour.textFaint}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={8}
          editable={windowOpen && !alreadyIn}
          style={styles.codeInput}
          accessibilityLabel="Office check-in code"
        />

        <Button
          label={alreadyIn ? 'Already checked in' : 'Check in'}
          onPress={submit}
          disabled={!canSubmit}
          loading={checkin.isPending}
        />

        {result ? (
          <ErrorNotice
            message={result.message}
            tone={result.kind === 'ok' ? 'info' : 'danger'}
          />
        ) : null}
      </Card>

      <Text style={styles.footnote}>
        Your location is read only when you tap check in, never in the background.
      </Text>
    </Screen>
  )
}

function windowMessage(status: NonNullable<ReturnType<typeof useAttendanceStatus>['data']>): string {
  if (status.record?.status === 'present' || status.record?.status === 'late') {
    const at = status.record.checkedInAt
      ? new Date(status.record.checkedInAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })
      : ''
    return `Recorded at ${at}. Nothing more to do today.`
  }

  switch (status.window.reason) {
    case 'open':
      return `Open until ${status.window.closesAt}. Your day starts at ${status.schedule.startTime}, with ${status.schedule.gracePeriodMinutes} minutes grace.`
    case 'too_early':
      return `Opens at ${status.window.opensAt}, in ${status.window.minutesUntilOpen} minute(s).`
    case 'too_late':
      return `Closed at ${status.window.closesAt}. Speak to your manager to record today.`
    case 'not_a_working_day':
    default:
      return 'Today is not a working day on your schedule.'
  }
}

const styles = StyleSheet.create({
  title: {
    fontSize: font.size.xxl,
    fontWeight: font.weight.bold,
    color: colour.text,
    paddingTop: space.lg,
  },
  cardTitle: { fontSize: font.size.lg, fontWeight: font.weight.semibold, color: colour.text },
  cardBody: { fontSize: font.size.md, color: colour.textMuted, lineHeight: 19, flex: 1 },
  meta: { fontSize: font.size.sm, color: colour.textFaint },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  codeInput: {
    borderWidth: 1,
    borderColor: colour.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    minHeight: 50,
    fontSize: 24,
    letterSpacing: 6,
    textAlign: 'center',
    fontWeight: font.weight.semibold,
    color: colour.text,
    backgroundColor: colour.surface,
  },
  footnote: {
    fontSize: font.size.sm,
    color: colour.textFaint,
    textAlign: 'center',
    lineHeight: 17,
  },
})
