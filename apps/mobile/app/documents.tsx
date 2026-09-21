/**
 * Document vault (spec §5): list, biometric gate on open, view or download.
 *
 * The gate runs on opening a document, not on reaching the list — the list is
 * only filenames, and prompting for Face ID to see a filename trains people to
 * approve prompts without reading them.
 */

import { useState } from 'react'
import { Linking, Platform, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useQueryClient } from '@tanstack/react-query'
import { Badge, Button, Card, EmptyState, ErrorNotice, Screen, Skeleton } from '../src/ui/components'
import { colour, font, space } from '../src/ui/theme'
import { keys, useDocumentUrl, useDocuments } from '../src/api/queries'
import { API_BASE_URL } from '../src/api/client'
import { authenticate } from '../src/ui/BiometricGate'

export default function Documents() {
  const queryClient = useQueryClient()
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

      if (Platform.OS === 'web') {
        window.open(url, '_blank', 'noopener,noreferrer')
      } else {
        await Linking.openURL(url)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open that document.')
    } finally {
      setOpening(null)
    }
  }

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={documents.isRefetching}
          onRefresh={() => void queryClient.invalidateQueries({ queryKey: keys.documents })}
          tintColor={colour.primary}
        />
      }
    >
      <Text style={styles.title}>Documents</Text>
      <Text style={styles.sub}>
        Uploaded by HR. Opening a document requires unlocking with biometrics.
      </Text>

      {error ? <ErrorNotice message={error} /> : null}

      {documents.data ? (
        documents.data.documents.length > 0 ? (
          documents.data.documents.map((d) => (
            <Card key={d.id}>
              <View style={styles.row}>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={styles.name}>{d.name}</Text>
                  <Text style={styles.meta}>
                    {labelForType(d.type)}
                    {d.sizeBytes ? ` · ${formatBytes(d.sizeBytes)}` : ''}
                    {` · ${new Date(d.uploadedAt).toLocaleDateString()}`}
                  </Text>
                </View>
                {d.requiresAcknowledgement ? (
                  <Badge
                    label={d.acknowledgedAt ? 'Acknowledged' : 'Action needed'}
                    tone={d.acknowledgedAt ? 'success' : 'warning'}
                  />
                ) : null}
              </View>

              <Button
                label="Open"
                variant="secondary"
                loading={opening === d.id}
                onPress={() => void open(d.id, d.name)}
              />
            </Card>
          ))
        ) : (
          <EmptyState
            title="No documents yet"
            body="Contracts, policies and letters your HR team uploads will appear here."
          />
        )
      ) : (
        <Card>
          <Skeleton height={20} />
          <Skeleton height={44} />
        </Card>
      )}
    </Screen>
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const styles = StyleSheet.create({
  title: {
    fontSize: font.size.xxl,
    fontWeight: font.weight.bold,
    color: colour.text,
    paddingTop: space.lg,
  },
  sub: { fontSize: font.size.md, color: colour.textMuted, lineHeight: 19 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  name: { fontSize: font.size.md, fontWeight: font.weight.medium, color: colour.text },
  meta: { fontSize: font.size.sm, color: colour.textMuted },
})
