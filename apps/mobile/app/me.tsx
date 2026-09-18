/**
 * Me — screen E8 plus profile.
 *
 * The personal hub: anything needing a signature, the document vault, letter
 * requests, and settings. Documents lost their own tab because a vault most
 * people open twice a year did not earn a quarter of the navigation, and this
 * is where people look for their own things anyway.
 *
 * The biometric gate sits on opening a document, not on reaching this list — a
 * list of filenames is not sensitive, and prompting for Face ID to read one
 * trains people to approve prompts without looking.
 */

import { useState } from 'react'
import {
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import {
  Appear,
  Button,
  Card,
  Divider,
  EmptyState,
  ErrorNotice,
  Screen,
  Skeleton,
  SheetPage,
} from '../src/ui/components'
import { Avatar, Chip, Label } from '../src/ui/primitives'
import { colour, font, radius, space } from '../src/ui/theme'
import { keys, useDocumentUrl, useDocuments, useMe } from '../src/api/queries'
import { API_BASE_URL } from '../src/api/client'
import { authenticate } from '../src/ui/BiometricGate'

export default function Me() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const me = useMe()
  const documents = useDocuments()
  const getUrl = useDocumentUrl()

  const [opening, setOpening] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const open = async (id: string, name: string) => {
    setError(null)
    setOpening(id)
    try {
      const unlocked = await authenticate(`Open ${name}`)
      if (!unlocked) {
        setError('Unlock cancelled. The document was not opened.')
        return
      }
      const signed = await getUrl.mutateAsync(id)
      const url = signed.url.startsWith('http') ? signed.url : `${API_BASE_URL}${signed.url}`
      if (Platform.OS === 'web') window.open(url, '_blank', 'noopener,noreferrer')
      else await Linking.openURL(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open that document.')
    } finally {
      setOpening(null)
    }
  }

  const needsSignature = documents.data?.documents.filter(
    (d) => d.requiresAcknowledgement && !d.acknowledgedAt,
  ) ?? []

  const vault = documents.data?.documents.filter(
    (d) => !(d.requiresAcknowledgement && !d.acknowledgedAt),
  ) ?? []

  return (
    <SheetPage
      title="Me"
      refreshControl={
        <RefreshControl
          refreshing={documents.isRefetching || me.isRefetching}
          onRefresh={() => {
            void queryClient.invalidateQueries({ queryKey: keys.documents })
            void queryClient.invalidateQueries({ queryKey: keys.me })
          }}
          tintColor={colour.primary}
        />
      }
    >
      {/* Identity */}
      <Appear index={0}>
        {me.data ? (
          <Card>
            <View style={styles.identity}>
              <Avatar
                name={`${me.data.employee.firstName} ${me.data.employee.lastName}`}
                size={52}
                colour={colour.primary}
              />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.name}>
                  {me.data.employee.firstName} {me.data.employee.lastName}
                </Text>
                <Text style={styles.role}>
                  {me.data.employee.jobTitle ?? 'Employee'}
                  {me.data.employee.departmentName ? ` · ${me.data.employee.departmentName}` : ''}
                </Text>
              </View>
            </View>
          </Card>
        ) : (
          <Card>
            <Skeleton height={52} />
          </Card>
        )}
      </Appear>

      {error ? <ErrorNotice message={error} /> : null}

      {/* Pay and leave live here now that the bar is Home/Attendance/Todos/Me.
          Pay is behind a biometric gate anyway, and a tab that always prompts
          for Face ID is a tab people learn not to press. */}
      <Appear index={1}>
        <Label>Your record</Label>
      </Appear>

      <Appear index={2}>
        <Card>
          <HubRow
            label="Pay"
            detail="Payslips, and what changed since last month"
            onPress={() => router.push('/payslips')}
          />
          <Divider />
          <HubRow
            label="Leave"
            detail="Balances, requests and history"
            onPress={() => router.push('/leave')}
          />
          <Divider />
          <HubRow
            label="Attendance"
            detail="Your check-in record"
            onPress={() => router.push('/attendance')}
          />
          <Divider />
          <HubRow
            label="Meetings"
            detail="Summaries, attendance and what was decided"
            onPress={() => router.push('/meetings')}
          />
          <Divider />
          <HubRow
            label="Tasks"
            detail="What you took on in meetings"
            onPress={() => router.push('/tasks')}
          />
        </Card>
      </Appear>

      {/* Anything awaiting a signature leads, in accent pink. */}
      {needsSignature.map((d, i) => (
        <Appear key={d.id} index={3 + i}>
          <Card tone="danger">
            <View style={styles.signRow}>
              <Text style={styles.signTitle}>{d.name}</Text>
              <View style={styles.signPill}>
                <Text style={styles.signPillText}>NEEDS SIGNING</Text>
              </View>
            </View>
            <Text style={styles.signBody}>
              Read it before signing. Your acknowledgement is recorded with the date.
            </Text>
            <Button
              label={opening === d.id ? 'Opening…' : 'Read & sign'}
              loading={opening === d.id}
              onPress={() => void open(d.id, d.name)}
            />
          </Card>
        </Appear>
      ))}

      {/* Vault */}
      <Appear index={4}>
        <Label>Your vault · unlocked each time</Label>
      </Appear>

      <Appear index={5}>
        <Card>
          {documents.data ? (
            vault.length > 0 ? (
              vault.map((d, i) => (
                <View key={d.id}>
                  {i > 0 ? <Divider /> : null}
                  <View style={styles.docRow}>
                    <View style={styles.docType}>
                      <Text style={styles.docTypeText}>PDF</Text>
                    </View>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.docName}>{d.name}</Text>
                      <Text style={styles.docMeta}>
                        {labelForType(d.type)} · {new Date(d.uploadedAt).toLocaleDateString()}
                      </Text>
                    </View>
                    <Button
                      label="Open"
                      variant="ghost"
                      loading={opening === d.id}
                      onPress={() => void open(d.id, d.name)}
                    />
                  </View>
                </View>
              ))
            ) : (
              <EmptyState
                title="No documents yet"
                body="Contracts, policies and letters HR uploads will appear here."
              />
            )
          ) : (
            <Skeleton height={72} />
          )}
        </Card>
      </Appear>

      {/* Letter requests — spec §5.5 self-service, the most repetitive HR ask. */}
      <Appear index={6}>
        <Label>Request a letter</Label>
      </Appear>

      <Appear index={7}>
        <Card>
          <View style={styles.chipRow}>
            <Chip label="Employment confirmation" />
            <Chip label="Salary letter" />
          </View>
          {/* Static until the letter-template endpoint exists. Showing them as
              live buttons that 404 would be worse than showing them as planned. */}
          <Text style={styles.hint}>
            Generated from a template and approved by HR, usually the same day. Not wired up
            yet — the letter templates and HR approval step are still to build.
          </Text>
        </Card>
      </Appear>

      {/* Settings */}
      <Appear index={8}>
        <Label>Settings</Label>
      </Appear>

      <Appear index={9}>
        <Card>
          <Button
            label="Profile and notifications"
            variant="secondary"
            onPress={() => router.push('/profile')}
          />
        </Card>
      </Appear>
    </SheetPage>
  )
}

/** A navigation line inside the hub card. */
function HubRow({
  label,
  detail,
  onPress,
}: {
  label: string
  detail: string
  onPress: () => void
}) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={styles.hubRow}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.hubLabel}>{label}</Text>
        <Text style={styles.hubDetail}>{detail}</Text>
      </View>
      <Text style={styles.hubChevron}>›</Text>
    </Pressable>
  )
}

function labelForType(type: string): string {
  switch (type) {
    case 'contract':
      return 'Contract'
    case 'policy':
      return 'Policy'
    case 'certificate':
      return 'Certificate'
    case 'letter':
      return 'Letter'
    default:
      return 'Document'
  }
}

const styles = StyleSheet.create({
  identity: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  name: {
    fontSize: font.size.lg,
    fontWeight: font.weight.bold,
    color: colour.text,
    fontFamily: font.family,
    letterSpacing: font.tracking.snug,
  },
  role: { fontSize: font.size.md, color: colour.textMuted, fontFamily: font.family },

  signRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  signTitle: {
    flex: 1,
    fontSize: font.size.md,
    fontWeight: font.weight.bold,
    color: colour.text,
    fontFamily: font.family,
  },
  signPill: {
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colour.accent,
  },
  signPillText: {
    fontSize: 10,
    fontWeight: font.weight.bold,
    color: colour.bg,
    fontFamily: font.mono,
    letterSpacing: 1,
  },
  signBody: {
    fontSize: font.size.sm,
    color: colour.textMuted,
    lineHeight: 20,
    fontFamily: font.family,
  },

  docRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  docType: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    backgroundColor: colour.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  docTypeText: {
    fontSize: 10,
    color: colour.textMuted,
    fontFamily: font.mono,
    letterSpacing: 1,
  },
  docName: {
    fontSize: font.size.md,
    fontWeight: font.weight.medium,
    color: colour.text,
    fontFamily: font.family,
  },
  docMeta: { fontSize: font.size.sm, color: colour.textMuted, fontFamily: font.family },

  hubRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  hubLabel: {
    fontSize: font.size.md,
    fontWeight: font.weight.semibold,
    color: colour.text,
    fontFamily: font.family,
  },
  hubDetail: { fontSize: font.size.sm, color: colour.textMuted, fontFamily: font.family },
  hubChevron: { fontSize: 22, color: colour.textFaint },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  hint: {
    fontSize: font.size.sm,
    color: colour.textFaint,
    lineHeight: 20,
    fontFamily: font.family,
  },
})
