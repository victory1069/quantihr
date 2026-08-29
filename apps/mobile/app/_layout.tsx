/**
 * Root layout: providers, session restore, biometric gate, persistent tab bar.
 *
 * Routes are flat rather than grouped so the URLs match the deep links in spec
 * §10 exactly — `/checkin`, `/leave/[id]`, `/manage/approvals`. A notification
 * tap and a browser address bar then resolve to the same place with no mapping
 * layer in between.
 */

import { useEffect, useRef, useState } from 'react'
import { AppState, StyleSheet, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { Stack, useRouter, useSegments } from 'expo-router'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { persistQueryClient } from '@tanstack/react-query-persist-client'

import { kv } from '../src/lib/kv'
import { TabBar } from '../src/ui/TabBar'
import { BiometricGate } from '../src/ui/BiometricGate'
import { SyncBanner } from '../src/ui/SyncBanner'
import { colour } from '../src/ui/theme'
import { restoreSession, useSession } from '../src/store/session'
import { drainOutbox } from '../src/api/sync'
import { startSyncLoop } from '../src/api/sync-loop'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Cached data is shown immediately and revalidated behind it; a failed
      // refetch must never blank a screen that already had content (spec §5).
      retry: 2,
      refetchOnWindowFocus: true,
      gcTime: 7 * 24 * 60 * 60 * 1000,
      networkMode: 'offlineFirst',
    },
    mutations: { networkMode: 'offlineFirst' },
  },
})

/** Synchronous persister over the platform KV store, so hydration beats paint. */
persistQueryClient({
  queryClient,
  persister: {
    persistClient: async (client) => {
      kv.set('quanti.query-cache', JSON.stringify(client))
    },
    restoreClient: async () => {
      const raw = kv.get('quanti.query-cache')
      return raw ? JSON.parse(raw) : undefined
    },
    removeClient: async () => kv.remove('quanti.query-cache'),
  },
  maxAge: 7 * 24 * 60 * 60 * 1000,
  dehydrateOptions: {
    // Never persist a mutation; the outbox owns pending writes.
    shouldDehydrateMutation: () => false,
  },
})

export default function RootLayout() {
  const status = useSession((s) => s.status)
  const [bootstrapped, setBootstrapped] = useState(false)
  const router = useRouter()
  const segments = useSegments()
  const redirected = useRef(false)

  useEffect(() => {
    void restoreSession().finally(() => setBootstrapped(true))
  }, [])

  useEffect(() => {
    const stop = startSyncLoop()
    const sub = AppState.addEventListener('change', (state) => {
      focusManager.setFocused(state === 'active')
      if (state === 'active') void drainOutbox()
    })
    return () => {
      stop()
      sub.remove()
    }
  }, [])

  useEffect(() => {
    if (!bootstrapped) return
    const onAuthRoute = segments[0] === 'sign-in' || segments[0] === 'auth'

    if (status === 'signed-out' && !onAuthRoute) {
      redirected.current = true
      router.replace('/sign-in')
    } else if (status === 'authenticated' && onAuthRoute && redirected.current) {
      redirected.current = false
      router.replace('/')
    }
  }, [status, segments, bootstrapped, router])

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="dark" />
        <View style={styles.root}>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colour.bg },
              animation: 'fade',
            }}
          />
          {status === 'authenticated' ? (
            <>
              <SyncBanner />
              <TabBar />
            </>
          ) : null}
        </View>
        <BiometricGate />
      </QueryClientProvider>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colour.bg },
})
