/**
 * MMKV-backed store for device builds (spec §2).
 *
 * Metro resolves this file ahead of `kv.ts` on iOS and Android. MMKV needs a
 * dev client build — it is not available in Expo Go — which the spec already
 * assumes.
 */

import { MMKV } from 'react-native-mmkv'
import type { KeyValueStore } from './kv'

const storage = new MMKV({ id: 'quanti-cache' })

export type { KeyValueStore }

export const kv: KeyValueStore = {
  get: (key) => storage.getString(key) ?? null,
  set: (key, value) => storage.set(key, value),
  remove: (key) => storage.delete(key),
}
