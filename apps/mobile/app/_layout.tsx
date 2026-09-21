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
import { AppHeader } from '../src/ui/AppHeader'
import { Splash } from '../src/ui/Splash'
import { BiometricGate } from '../src/ui/BiometricGate'
import { SyncBanner } from '../src/ui/SyncBanner'
import { colour } from '../src/ui/theme'
import { restoreSession, useSession } from '../src/store/session'
import { useMe } from '../src/api/queries'
import { listenForNotificationTaps, registerForPush } from '../src/lib/push'
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

/**
 * Keeps the session store's `me` in step with the profile query, for every
 * screen, from the moment the session exists. Before this lived on Home, a
 * screen opened directly — a deep link, a restart on a manager page — saw
 * `me` as null and, for the role-gated ones, denied a manager their own team.
 */
function ProfileSync() {
  const status = useSession((s) => s.status)
  const setMe = useSession((s) => s.setMe)
  const me = useMe({ enabled: status === 'authenticated' })
  const router = useRouter()
  useEffect(() => {
    if (me.data) setMe(me.data)
  }, [me.data, setMe])

  // Push: register the token once a session exists, and act on taps.
  useEffect(() => {
    if (status !== 'authenticated') return
    void registerForPush()
    let stop: (() => void) | undefined
    void listenForNotificationTaps(router).then((s) => {
      stop = s
    })
    return () => stop?.()
  }, [status, router])
  return null
}

export default function RootLayout() {
  const status = useSession((s) => s.status)
  const mustChangePassword = useSession((s) => s.mustChangePassword)
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

  /**
   * Routes that own the whole screen: sign-in, the link exchange, and first-run.
   * Onboarding counts as authenticated but must not show the tab bar — a
   * half-visible shell behind a setup flow invites tapping past it.
   */
  const root = segments[0] as string | undefined
  // Onboarding starts signed out — the invite email, the link, the code all
  // happen before a session exists — so it has to be reachable without one.
  const onAuthRoute = root === 'sign-in' || root === 'auth' || root === 'onboarding'
  // Onboarding, unlock and recovery own the whole screen: a half-visible tab
  // bar behind a setup or lockout flow invites tapping past it.
  // Decision sheets own the screen too: their buttons sit at the bottom,
  // where a floating tab bar would cover them, and the way out is the back
  // control in the sheet, not a tab.
  const decisionSheet =
    (root === 'manage' && segments[1] === 'approvals' && !!segments[2]) ||
    (root === 'manage' && segments[1] === 'training' && !!segments[2]) ||
    (root === 'meetings' && segments[2] === 'review') ||
    (root === 'learning' && !!segments[1])
  const fullScreen =
    onAuthRoute ||
    root === 'welcome' ||
    root === 'onboarding' ||
    root === 'unlock' ||
    root === 'recover' ||
    root === 'change-password' ||
    decisionSheet

  useEffect(() => {
    if (!bootstrapped) return

    if (status === 'signed-out' && !onAuthRoute) {
      redirected.current = true
      router.replace('/sign-in')
    } else if (status === 'authenticated' && mustChangePassword && root !== 'change-password') {
      // A temporary password opens exactly one screen. This catches the
      // case sign-in itself does not: a restored session, or /v1/me
      // reporting the flag after HR reset the password remotely.
      router.replace('/change-password')
    } else if (status === 'authenticated' && onAuthRoute && redirected.current) {
      redirected.current = false
      router.replace('/')
    }
  }, [status, mustChangePassword, root, onAuthRoute, bootstrapped, router])

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <ProfileSync />
        <StatusBar style="light" />
        <View style={styles.root}>
          {status === 'authenticated' && !fullScreen ? <AppHeader /> : null}
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colour.bg },
              // Pushed screens slide up like a sheet, matching how content
              // arrives inside a page; a fade for the tab roots so switching
              // tabs feels like changing what is under the bar, not opening a
              // new thing.
              animation: 'slide_from_bottom',
              animationDuration: 260,
            }}
          />
          {status === 'authenticated' && !fullScreen ? (
            <>
              <SyncBanner />
              <TabBar />
            </>
          ) : null}
        </View>
        <BiometricGate />
        {/* Held above everything until the session has been restored, so the
            first painted frame is real content rather than an empty shell. */}
        <Splash visible={!bootstrapped} />
      </QueryClientProvider>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colour.bg },
})
