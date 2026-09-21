/**
 * Leave request detail — the deep-link target for "Leave approved or declined"
 * (spec §10). Reached from a notification tap, so it must stand alone rather
 * than assume the list screen was visited first.
 */

import { StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  Badge,
  Button,
  Card,
  Divider,
  ErrorNotice,
  Row,
  Screen,
  Skeleton,
} from '../../src/ui/components'
import { colour, font, space, statusColour, statusLabel } from '../../src/ui/theme'
import { useCancelLeaveRequest, useLeaveRequests } from '../../src/api/queries'

export default function LeaveDetail() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const requests = useLeaveRequests()
  const cancel = useCancelLeaveRequest()

  const request = requests.data?.requests.find((r) => r.id === id)

  if (!requests.data) {
    return (
      <Screen>
        <Card>
          <Skeleton height={28} />
          <Skeleton height={80} />
        </Card>
      </Screen>
    )
  }

  if (!request) {
    return (
      <Screen>
        <Card>
          <ErrorNotice message="That request could not be found. It may have been cancelled." />
          <Button label="Back to leave" onPress={() => router.replace('/leave')} />
        </Card>
      </Screen>
    )
  }

  return (
    <Screen>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <View style={[styles.swatch, { backgroundColor: request.colour }]} />
          <Text style={styles.title}>{request.leaveTypeName}</Text>
        </View>
        <Badge
          label={statusLabel(request.status)}
          tone={
            request.status === 'approved'
              ? 'success'
              : request.status === 'declined'
                ? 'danger'
                : request.status === 'cancelled'
                  ? 'neutral'
                  : 'pending'
          }
          dot={statusColour(request.status)}
        />
      </View>

      <Card>
        <Row label="From" value={request.start} />
        <Divider />
        <Row label="To" value={request.end} />
        <Divider />
        <Row label="Days charged" value={`${request.daysCount}`} />
        {request.halfDayStart || request.halfDayEnd ? (
          <>
            <Divider />
            <Row
              label="Half days"
              value={[
                request.halfDayStart ? 'first day' : null,
                request.halfDayEnd ? 'last day' : null,
              ]
                .filter(Boolean)
                .join(', ')}
            />
          </>
        ) : null}
        <Divider />
        <Row
          label="Submitted"
          value={new Date(request.submittedAt).toLocaleDateString()}
          muted
        />
      </Card>

      {request.reason ? (
        <Card>
          <Text style={styles.label}>Your reason</Text>
          <Text style={styles.body}>{request.reason}</Text>
        </Card>
      ) : null}

      {request.status !== 'pending' ? (
        <Card>
          <Text style={styles.label}>Decision</Text>
          <Text style={styles.body}>
            {statusLabel(request.status)}
            {request.decidedByName ? ` by ${request.decidedByName}` : ''}
            {request.decidedAt
              ? ` on ${new Date(request.decidedAt).toLocaleDateString()}`
              : ''}
            .
          </Text>
          {request.decisionNote ? (
            <Text style={styles.quote}>“{request.decisionNote}”</Text>
          ) : null}
          {request.overrideReason ? (
            <ErrorNotice
              tone="warning"
              message={`Approved against a coverage rule: ${request.overrideReason}`}
            />
          ) : null}
        </Card>
      ) : null}

      {request.warnings.length > 0 ? (
        <Card>
          <Text style={styles.label}>Coverage notes</Text>
          {request.warnings.map((w) => (
            <ErrorNotice key={w.code} tone="warning" message={w.message} />
          ))}
        </Card>
      ) : null}

      {request.status === 'pending' ? (
        <Button
          label="Cancel this request"
          variant="danger"
          loading={cancel.isPending}
          onPress={() => {
            cancel.mutate(request.id, { onSuccess: () => router.replace('/leave') })
          }}
        />
      ) : null}

      <Button label="Back to leave" variant="ghost" onPress={() => router.replace('/leave')} />
    </Screen>
  )
}

const styles = StyleSheet.create({
  header: {
    paddingTop: space.lg,
    gap: space.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flex: 1 },
  swatch: { width: 12, height: 12, borderRadius: 6 },
  title: { fontSize: font.size.xl, fontWeight: font.weight.bold, color: colour.text, flex: 1 },
  label: { fontSize: font.size.sm, fontWeight: font.weight.semibold, color: colour.textMuted },
  body: { fontSize: font.size.md, color: colour.text, lineHeight: 19 },
  quote: { fontSize: font.size.md, color: colour.textMuted, fontStyle: 'italic', lineHeight: 19 },
})
