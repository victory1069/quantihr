/**
 * Synchronous key-value storage for the TanStack Query cache persister.
 *
 * This file is the web implementation and the TypeScript source of truth;
 * `kv.native.ts` overrides it on device with MMKV, which Metro picks up
 * automatically via the platform extension. The persister needs synchronous
 * reads to hydrate before first paint — the home screen must never show a
 * full-screen spinner (spec §5) — which is why this is not AsyncStorage.
 */

export interface KeyValueStore {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

function makeMemoryStore(): KeyValueStore {
  const map = new Map<string, string>()
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
  }
}

function makeLocalStorageStore(): KeyValueStore {
  return {
    get(key) {
      try {
        return window.localStorage.getItem(key)
      } catch {
        // Safari private mode and some embedded webviews throw on access.
        return null
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        /* quota or blocked storage — the cache is an optimisation, not state */
      }
    },
    remove(key) {
      try {
        window.localStorage.removeItem(key)
      } catch {
        /* ignore */
      }
    },
  }
}

const available = (() => {
  try {
    return typeof window !== 'undefined' && !!window.localStorage
  } catch {
    return false
  }
})()

export const kv: KeyValueStore = available ? makeLocalStorageStore() : makeMemoryStore()
