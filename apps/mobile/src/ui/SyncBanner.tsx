/**
 * "Waiting to sync" strip.
 *
 * The UI must show a pending state on any record with an unsynced write (spec
 * §6). This is the global version of that: it tells the employee their check-in
 * is queued rather than lost, and separates "not sent yet" from "refused".
 */

import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { colour, font, MAX_CONTENT_WIDTH, space } from './theme'
import { failed, pending, type OutboxRow } from '../lib/outbox'

export function SyncBanner() {
  const [queued, setQueued] = useState<OutboxRow[]>([])
  const [rejected, setRejected] = useState<OutboxRow[]>([])
  const router = useRouter()

  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        const [all, bad] = await Promise.all([pending(), failed()])
        if (!active) return
        setQueued(all.filter((r) => r.status === 'pending'))
        setRejected(bad)
      } catch {
        /* outbox unavailable — not worth surfacing */
      }
    }
    void poll()
    const timer = setInterval(poll, 4000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])

  if (rejected.length > 0) {
    return (
      <Pressable style={[styles.bar, styles.error]} onPress={() => router.push('/profile')}>
        <View style={styles.inner}>
          <Text style={styles.errorText}>
            {rejected.length === 1
              ? rejected[0]!.lastError ?? 'A queued action was refused'
              : `${rejected.length} queued actions were refused`}
          </Text>
          <Text style={styles.link}>Review</Text>
        </View>
      </Pressable>
    )
  }

  if (queued.length === 0) return null

  return (
    <View style={[styles.bar, styles.pending]}>
      <View style={styles.inner}>
        <Text style={styles.pendingText}>
          {queued.length === 1
            ? 'Waiting to sync — it will send when you are back online'
            : `${queued.length} actions waiting to sync`}
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { borderTopWidth: 1, paddingVertical: space.sm, paddingHorizontal: space.lg },
  inner: {
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  pending: { backgroundColor: colour.warningSoft, borderTopColor: colour.warning },
  pendingText: { color: colour.warning, fontSize: font.size.sm, flexShrink: 1 },
  error: { backgroundColor: colour.dangerSoft, borderTopColor: colour.danger },
  errorText: { color: colour.danger, fontSize: font.size.sm, flexShrink: 1 },
  link: { color: colour.danger, fontSize: font.size.sm, fontWeight: font.weight.semibold },
})
