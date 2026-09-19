/**
 * Proof of completion.
 *
 * A certificate or a screenshot goes on the employee's document record, the
 * same place HR files their contract; a sentence on what was completed is
 * accepted on its own for courses that issue nothing. Either closes the
 * reminders.
 */

import { useState } from 'react'
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { BackLink, Button, Card, ErrorNotice, HeroSheet } from '../../../src/ui/components'
import { Label } from '../../../src/ui/primitives'
import { colour, font, radius, space } from '../../../src/ui/theme'
import { useCompleteTraining, useTrainingPlans } from '../../../src/api/queries'

interface Picked {
  filename: string
  contentType: string
  contentBase64: string
}

export default function TrainingProof() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const plans = useTrainingPlans()
  const complete = useCompleteTraining()
  const [note, setNote] = useState('')
  const [file, setFile] = useState<Picked | null>(null)
  const [error, setError] = useState<string | null>(null)

  const item = plans.data?.plans.flatMap((p) => p.items).find((i) => i.id === id)
  const ready = !!file || note.trim().length >= 10

  const pick = async () => {
    setError(null)
    try {
      const Picker = await import('expo-document-picker')
      const result = await Picker.getDocumentAsync({
        type: ['image/*', 'application/pdf'],
        copyToCacheDirectory: true,
        multiple: false,
      })
      if (result.canceled || !result.assets[0]) return
      const asset = result.assets[0]
      if ((asset.size ?? 0) > 15_000_000) {
        setError('That file is over 15MB. A screenshot or a smaller PDF is fine.')
        return
      }
      let base64: string
      if (Platform.OS === 'web' && asset.file) {
        const buffer = await asset.file.arrayBuffer()
        base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)))
      } else {
        const FS = await import('expo-file-system')
        base64 = await FS.readAsStringAsync(asset.uri, { encoding: 'base64' })
      }
      setFile({
        filename: asset.name,
        contentType: asset.mimeType ?? 'application/octet-stream',
        contentBase64: base64,
      })
    } catch {
      setError('Could not read that file.')
    }
  }

  const submit = async () => {
    if (!id || !ready) return
    setError(null)
    try {
      await complete.mutateAsync({
        id,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(file ? { proof: file } : {}),
      })
      router.replace('/learning')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That could not be saved.')
    }
  }

  return (
    <HeroSheet
      hero={
        <View>
          <BackLink label="Learning" onPress={() => router.back()} />
          <Text style={styles.heroTitle}>{item?.title ?? 'Proof of completion'}</Text>
          <Text style={styles.heroLede}>
            A certificate, a screenshot, or a sentence on what you completed. It goes on your record.
          </Text>
        </View>
      }
    >
      <Card>
        <Label>Certificate or screenshot</Label>
        {file ? (
          <View style={styles.fileRow}>
            <Text style={styles.fileName} numberOfLines={1}>
              {file.filename}
            </Text>
            <Text style={styles.remove} onPress={() => setFile(null)} accessibilityRole="button">
              Remove
            </Text>
          </View>
        ) : (
          <Button label="Choose a file" variant="secondary" onPress={() => void pick()} />
        )}
      </Card>

      <Card>
        <Label>What you completed</Label>
        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder={file ? 'Optional' : 'Required if there is no file — a sentence is enough'}
          placeholderTextColor={colour.textFaint}
          style={styles.input}
          multiline
          accessibilityLabel="What you completed"
        />
      </Card>

      {error ? <ErrorNotice message={error} /> : null}

      <Button
        label="Mark complete"
        disabled={!ready}
        loading={complete.isPending}
        onPress={() => void submit()}
      />
    </HeroSheet>
  )
}

const styles = StyleSheet.create({
  heroTitle: {
    fontSize: font.size.xxl,
    fontWeight: font.weight.bold,
    color: colour.text,
    letterSpacing: font.tracking.tight,
    fontFamily: font.family,
  },
  heroLede: {
    fontSize: font.size.md,
    color: colour.textMuted,
    lineHeight: 21,
    fontFamily: font.family,
    paddingBottom: space.lg,
  },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  fileName: { flex: 1, fontSize: font.size.md, color: colour.text, fontFamily: font.mono },
  remove: { fontSize: font.size.sm, color: colour.danger, fontWeight: font.weight.semibold },
  input: {
    borderWidth: 1,
    borderColor: colour.borderStrong,
    borderRadius: radius.md,
    padding: space.md,
    minHeight: 96,
    fontSize: font.size.md,
    color: colour.text,
    backgroundColor: colour.surfaceSunken,
    textAlignVertical: 'top',
    fontFamily: font.family,
  },
})
