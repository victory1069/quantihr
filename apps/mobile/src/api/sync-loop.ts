/**
 * Background outbox drain.
 *
 * Two triggers: a slow interval, and the connection coming back. NetInfo gives
 * the second one, which is what makes a queued check-in land seconds after the
 * employee walks back into signal rather than on the next tick.
 */

import NetInfo from '@react-native-community/netinfo'
import { drainOutbox } from './sync'

const INTERVAL_MS = 30_000

export function startSyncLoop(): () => void {
  let stopped = false

  const timer = setInterval(() => {
    if (!stopped) void drainOutbox().catch(() => undefined)
  }, INTERVAL_MS)

  const unsubscribe = NetInfo.addEventListener((state) => {
    if (stopped) return
    if (state.isConnected && state.isInternetReachable !== false) {
      void drainOutbox().catch(() => undefined)
    }
  })

  return () => {
    stopped = true
    clearInterval(timer)
    unsubscribe()
  }
}
