/**
 * Profile (spec §5): editable personal fields, read-only employment fields,
 * notification settings, sign out.
 *
 * The read-only/editable split is deliberate and visible: an employee changing
 * their own start date or department is an HR data-integrity problem, so those
 * fields are shown but not editable, with a line saying who to ask.
 */

import { useEffect, useState } from 'react'
import { StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import {
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  ErrorNotice,
  Row,
  Screen,
  SectionTitle,
  Skeleton,
} from '../src/ui/components'
import { colour, font, radius, space } from '../src/ui/theme'
import { useMe, useUpdateMe } from '../src/api/queries'
import { clearTokens, useSession } from '../src/store/session'
import { discard, failed, type OutboxRow } from '../src/lib/outbox'
import { drainOutbox } from '../src/api/sync'

const PREFERENCES: { key: string; label: string; description: string }[] = [
  { key: 'leaveDecisions', label: 'Leave decisions', description: 'When a request is approved or declined' },
  { key: 'checkinReminders', label: 'Check-in reminders', description: 'Shortly before your window opens' },
  { key: 'balanceExpiry', label: 'Expiring leave', description: 'When carried-over days are about to expire' },
  { key: 'documents', label: 'New documents', description: 'When HR uploads something for you' },
]

export default function Profile() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const me = useMe()
  const update = useUpdateMe()
  const [phone, setPhone] = useState('')
  const [dirty, setDirty] = useState(false)
  const [rejected, setRejected] = useState<OutboxRow[]>([])

  useEffect(() => {
    if (me.data && !dirty) setPhone(me.data.employee.phone ?? '')
  }, [me.data, dirty])

  useEffect(() => {
    void failed().then(setRejected)
  }, [])

  const prefs = (me.data?.user as { notificationPreferences?: Record<string, boolean> } | undefined)
    ?.notificationPreferences ?? {}

  const signOut = async () => {
    await clearTokens()
    queryClient.clear()
    useSession.getState().reset()
    router.replace('/sign-in')
  }

  return (
    <Screen>
      <Text style={styles.title}>Profile</Text>

      {me.data ? (
        <Card>
          <View style={styles.identity}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {me.data.employee.firstName[0]}
                {me.data.employee.lastName[0]}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>
                {me.data.employee.firstName} {me.data.employee.lastName}
              </Text>
              <Text style={styles.role}>
                {me.data.employee.jobTitle ?? 'Employee'}
                {me.data.employee.band ? ` · Band ${me.data.employee.band}` : ''}
              </Text>
            </View>
          </View>
        </Card>
      ) : (
        <Card>
          <Skeleton height={56} />
        </Card>
      )}

      {/* Editable */}
      <SectionTitle>Your details</SectionTitle>
      <Card>
        <Text style={styles.fieldLabel}>Phone</Text>
        <TextInput
          value={phone}
          onChangeText={(v) => {
            setPhone(v)
            setDirty(true)
          }}
          placeholder="+234…"
          placeholderTextColor={colour.textFaint}
          keyboardType="phone-pad"
          style={styles.input}
          accessibilityLabel="Phone number"
        />
        {dirty ? (
          <Button
            label="Save"
            loading={update.isPending}
            onPress={() =>
              update.mutate(
                { phone: phone.trim() || null },
                { onSuccess: () => setDirty(false) },
              )
            }
          />
        ) : null}
      </Card>

      {/* Read-only */}
      <SectionTitle>Employment</SectionTitle>
      <Card>
        {me.data ? (
          <>
            <Row label="Employee number" value={me.data.employee.employeeNumber} muted />
            <Divider />
            <Row label="Email" value={me.data.employee.email} muted />
            <Divider />
            <Row label="Department" value={me.data.employee.departmentName ?? '—'} muted />
            <Divider />
            <Row label="Location" value={me.data.employee.locationName ?? '—'} muted />
            <Divider />
            <Row label="Manager" value={me.data.employee.managerName ?? '—'} muted />
            <Divider />
            <Row label="Started" value={me.data.employee.startDate} muted />
            <Divider />
            <Row
              label="Status"
              value={<Badge label={me.data.employee.status} tone="neutral" />}
            />
            <Text style={styles.hint}>
              These are maintained by HR. Ask them if something here is wrong.
            </Text>
          </>
        ) : (
          <Skeleton height={120} />
        )}
      </Card>

      {/* Notifications */}
      <SectionTitle>Notifications</SectionTitle>
      <Card>
        {PREFERENCES.map((p, i) => (
          <View key={p.key}>
            {i > 0 ? <Divider /> : null}
            <View style={styles.prefRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.prefLabel}>{p.label}</Text>
                <Text style={styles.prefDescription}>{p.description}</Text>
              </View>
              <Switch
                value={prefs[p.key] !== false}
                onValueChange={(value) =>
                  update.mutate({ notificationPreferences: { [p.key]: value } })
                }
              />
            </View>
          </View>
        ))}
      </Card>

      {/* Security */}
      <SectionTitle>Security</SectionTitle>
      <Card>
        <View style={styles.prefRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.prefLabel}>Biometric unlock</Text>
            <Text style={styles.prefDescription}>
              Require Face ID or a fingerprint to open the app and your documents
            </Text>
          </View>
          <Switch
            value={me.data?.user.biometricEnabled ?? false}
            onValueChange={(value) => update.mutate({ biometricEnabled: value })}
          />
        </View>
      </Card>

      {/* Refused writes */}
      {rejected.length > 0 ? (
        <>
          <SectionTitle>Actions that could not be sent</SectionTitle>
          <Card>
            {rejected.map((row, i) => (
              <View key={row.id}>
                {i > 0 ? <Divider /> : null}
                <Text style={styles.prefLabel}>{describeEndpoint(row.endpoint)}</Text>
                <Text style={styles.prefDescription}>{row.lastError}</Text>
                <Button
                  label="Discard"
                  variant="ghost"
                  onPress={() =>
                    void discard(row.id).then(() => failed().then(setRejected))
                  }
                />
              </View>
            ))}
            <Button
              label="Retry all"
              variant="secondary"
              onPress={() => void drainOutbox().then(() => failed().then(setRejected))}
            />
          </Card>
        </>
      ) : null}

      <Button label="Sign out" variant="danger" onPress={signOut} />
    </Screen>
  )
}

function describeEndpoint(endpoint: string): string {
  if (endpoint.includes('checkin')) return 'Check-in'
  if (endpoint.includes('leave/requests')) return 'Leave request'
  return endpoint
}

const styles = StyleSheet.create({
  title: {
    fontSize: font.size.xxl,
    fontWeight: font.weight.bold,
    color: colour.text,
    paddingTop: space.lg,
  },
  identity: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  avatar: {
    width: 52,
    height: 48,
    borderRadius: 26,
    backgroundColor: colour.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: font.size.lg, fontWeight: font.weight.bold, color: colour.primary },
  name: { fontSize: font.size.lg, fontWeight: font.weight.semibold, color: colour.text },
  role: { fontSize: font.size.md, color: colour.textMuted },

  fieldLabel: { fontSize: font.size.sm, fontWeight: font.weight.semibold, color: colour.textMuted },
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
  hint: { fontSize: font.size.sm, color: colour.textFaint, marginTop: space.sm, lineHeight: 17 },

  prefRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  prefLabel: { fontSize: font.size.md, color: colour.text, fontWeight: font.weight.medium },
  prefDescription: { fontSize: font.size.sm, color: colour.textMuted, marginTop: 2, lineHeight: 16 },
})
