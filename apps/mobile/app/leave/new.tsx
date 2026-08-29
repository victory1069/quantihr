/**
 * New leave request (spec §5).
 *
 * "Type picker, date range, half-day toggles, live balance projection, conflict
 * warnings shown inline before submit, reason field."
 *
 * The conflict check runs as the dates change, so the employee sees the coverage
 * clash and the projected balance before they commit — not as a rejection after.
 */

import { useCallback, useEffect, useState } from 'react'
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ApiError, addDays, isISODate } from '@quanti/shared'
import { Badge, Button, Card, ErrorNotice, Screen, Skeleton } from '../../src/ui/components'
import { colour, font, radius, space } from '../../src/ui/theme'
import {
  useCheckConflicts,
  useCreateLeaveRequest,
  useLeaveTypes,
} from '../../src/api/queries'
import { NetworkError } from '../../src/api/client'

export default function NewLeaveRequest() {
  const router = useRouter()
  const types = useLeaveTypes()
  const conflicts = useCheckConflicts()
  const create = useCreateLeaveRequest()

  const today = new Date().toISOString().slice(0, 10)
  const [leaveTypeId, setLeaveTypeId] = useState<string | null>(null)
  const [start, setStart] = useState(addDays(today, 7))
  const [end, setEnd] = useState(addDays(today, 9))
  const [halfDayStart, setHalfDayStart] = useState(false)
  const [halfDayEnd, setHalfDayEnd] = useState(false)
  const [reason, setReason] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    if (!leaveTypeId && types.data?.types.length) {
      setLeaveTypeId(types.data.types[0]!.id)
    }
  }, [types.data, leaveTypeId])

  const datesValid = isISODate(start) && isISODate(end) && start <= end

  const check = useCallback(() => {
    if (!leaveTypeId || !datesValid) return
    conflicts.mutate({ leaveTypeId, start, end, halfDayStart, halfDayEnd })
    // `conflicts` is a stable mutation object; including it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaveTypeId, start, end, halfDayStart, halfDayEnd, datesValid])

  useEffect(() => {
    const timer = setTimeout(check, 350)
    return () => clearTimeout(timer)
  }, [check])

  const preview = conflicts.data
  const selectedType = types.data?.types.find((t) => t.id === leaveTypeId)
  const blocked = preview ? !preview.sufficientBalance || preview.overlapsExistingRequest : false

  const submit = async () => {
    if (!leaveTypeId || !datesValid) return
    setSubmitError(null)

    const drain = await create.mutateAsync({
      leaveTypeId,
      start,
      end,
      halfDayStart,
      halfDayEnd,
      reason: reason.trim() || undefined,
    })

    if (drain.error instanceof NetworkError) {
      router.replace('/leave')
      return
    }
    if (drain.error instanceof ApiError) {
      setSubmitError(drain.error.message)
      return
    }
    if (drain.sent > 0) {
      router.replace('/leave')
      return
    }
    setSubmitError('Could not submit the request. Try again.')
  }

  return (
    <Screen>
      <Text style={styles.title}>Request leave</Text>

      {/* Type */}
      <Card>
        <Text style={styles.label}>Type</Text>
        {types.data ? (
          <View style={styles.typeRow}>
            {types.data.types.map((t) => {
              const active = t.id === leaveTypeId
              return (
                <Pressable
                  key={t.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  onPress={() => setLeaveTypeId(t.id)}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <View style={[styles.swatch, { backgroundColor: t.colour }]} />
                  <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>
                    {t.name}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        ) : (
          <Skeleton height={36} />
        )}

        {selectedType?.minNoticeDays ? (
          <Text style={styles.hint}>
            Needs {selectedType.minNoticeDays} days notice.
            {selectedType.requiresDocument ? ' A supporting document is required.' : ''}
          </Text>
        ) : selectedType?.requiresDocument ? (
          <Text style={styles.hint}>A supporting document is required for this type.</Text>
        ) : null}
      </Card>

      {/* Dates */}
      <Card>
        <Text style={styles.label}>Dates</Text>
        <View style={styles.dateRow}>
          <View style={styles.dateField}>
            <Text style={styles.fieldLabel}>From</Text>
            <TextInput
              value={start}
              onChangeText={setStart}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colour.textFaint}
              autoCapitalize="none"
              style={[styles.input, !isISODate(start) && styles.inputError]}
              accessibilityLabel="Start date"
            />
          </View>
          <View style={styles.dateField}>
            <Text style={styles.fieldLabel}>To</Text>
            <TextInput
              value={end}
              onChangeText={setEnd}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colour.textFaint}
              autoCapitalize="none"
              style={[styles.input, !isISODate(end) && styles.inputError]}
              accessibilityLabel="End date"
            />
          </View>
        </View>

        {!datesValid ? (
          <Text style={styles.errorText}>
            Enter dates as YYYY-MM-DD, with the end on or after the start.
          </Text>
        ) : null}

        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>Half day on the first day</Text>
          <Switch value={halfDayStart} onValueChange={setHalfDayStart} />
        </View>
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>Half day on the last day</Text>
          <Switch value={halfDayEnd} onValueChange={setHalfDayEnd} />
        </View>
      </Card>

      {/* Live projection */}
      <Card>
        <Text style={styles.label}>Projection</Text>
        {conflicts.isPending ? (
          <Skeleton height={40} />
        ) : preview ? (
          <>
            <View style={styles.projectionRow}>
              <Projection label="Days used" value={String(preview.daysCount)} />
              <Projection label="Balance now" value={String(preview.balanceBefore)} />
              <Projection
                label="After this"
                value={String(preview.balanceAfter)}
                tone={preview.balanceAfter < 0 ? 'danger' : 'default'}
              />
            </View>

            {preview.skipped.length > 0 ? (
              <Text style={styles.hint}>
                {preview.skipped.length} day(s) not charged — weekends and public holidays are
                skipped.
              </Text>
            ) : null}

            {!preview.sufficientBalance ? (
              <ErrorNotice
                message={
                  preview.shortfallOn
                    ? `Your balance runs out on ${preview.shortfallOn}.`
                    : 'You do not have enough days for this request.'
                }
              />
            ) : null}

            {preview.expiredMidRequest > 0 ? (
              <ErrorNotice
                tone="warning"
                message={`${preview.expiredMidRequest} carried-over day(s) expire partway through these dates and cannot be used.`}
              />
            ) : null}

            {preview.overlapsExistingRequest ? (
              <ErrorNotice message="You already have a request covering some of these dates." />
            ) : null}

            {preview.warnings.map((w) => (
              <ErrorNotice key={w.code} tone="warning" message={w.message} />
            ))}

            {preview.warnings.length > 0 ? (
              <Text style={styles.hint}>
                You can still submit. Your manager will need to give a reason to approve it.
              </Text>
            ) : null}
          </>
        ) : (
          <Text style={styles.hint}>Pick a type and dates to see the effect on your balance.</Text>
        )}
      </Card>

      {/* Reason */}
      <Card>
        <Text style={styles.label}>Reason (optional)</Text>
        <TextInput
          value={reason}
          onChangeText={setReason}
          placeholder="Anything your manager should know"
          placeholderTextColor={colour.textFaint}
          multiline
          numberOfLines={3}
          style={[styles.input, styles.textarea]}
          accessibilityLabel="Reason for leave"
        />
        <Text style={styles.hint}>
          Your reason is never shown in notification previews.
        </Text>
      </Card>

      {submitError ? <ErrorNotice message={submitError} /> : null}

      <Button
        label="Submit request"
        onPress={submit}
        disabled={!datesValid || !leaveTypeId || blocked}
        loading={create.isPending}
      />
      <Button label="Cancel" variant="ghost" onPress={() => router.back()} />
    </Screen>
  )
}

function Projection({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string
  tone?: 'default' | 'danger'
}) {
  return (
    <View style={styles.projection}>
      <Text style={[styles.projectionValue, tone === 'danger' && { color: colour.danger }]}>
        {value}
      </Text>
      <Text style={styles.projectionLabel}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  title: {
    fontSize: font.size.xxl,
    fontWeight: font.weight.bold,
    color: colour.text,
    paddingTop: space.lg,
  },
  label: { fontSize: font.size.sm, fontWeight: font.weight.semibold, color: colour.textMuted },
  fieldLabel: { fontSize: font.size.xs, color: colour.textMuted, marginBottom: 4 },
  hint: { fontSize: font.size.sm, color: colour.textMuted, lineHeight: 19 },
  errorText: { fontSize: font.size.sm, color: colour.danger },

  typeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colour.border,
    backgroundColor: colour.surfaceAlt,
    minHeight: 40,
  },
  chipActive: { borderColor: colour.primary, backgroundColor: colour.primarySoft },
  chipLabel: { fontSize: font.size.sm, color: colour.textMuted, fontWeight: font.weight.medium },
  chipLabelActive: { color: colour.primary, fontWeight: font.weight.semibold },
  swatch: { width: 8, height: 8, borderRadius: 4 },

  dateRow: { flexDirection: 'row', gap: space.md },
  dateField: { flex: 1 },
  input: {
    borderWidth: 1,
    borderColor: colour.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    minHeight: 48,
    fontSize: font.size.md,
    color: colour.text,
    backgroundColor: colour.surface,
  },
  inputError: { borderColor: colour.danger },
  textarea: { minHeight: 88, paddingTop: space.md, textAlignVertical: 'top' },

  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.xs,
    gap: space.md,
  },
  toggleLabel: { fontSize: font.size.md, color: colour.text, flex: 1 },

  projectionRow: { flexDirection: 'row', gap: space.xl },
  projection: {},
  projectionValue: { fontSize: font.size.xl, fontWeight: font.weight.bold, color: colour.text },
  projectionLabel: { fontSize: font.size.xs, color: colour.textMuted, marginTop: 2 },
})
