/**
 * MMKV-backed store for device builds (spec §2).
 *
 * Metro resolves this file ahead of `kv.ts` on iOS and Android. MMKV needs a
 * dev client build — it is not available in Expo Go — which the spec already
 * assumes.
 *
 * react-native-mmkv v4 is a Nitro module and dropped the v2/v3 surface this
 * once used: `MMKV` is now a type rather than a constructor, instances come
 * from `createMMKV`, and `delete()` was renamed `remove()`. Both of those are
 * runtime failures rather than type errors, and neither shows up on web, since
 * `kv.ts` serves that platform and this file is only resolved on device.
 */

import { createMMKV } from 'react-native-mmkv'
import type { KeyValueStore } from './kv'

const storage = createMMKV({ id: 'quanti-cache' })

export type { KeyValueStore }

export const kv: KeyValueStore = {
  get: (key) => storage.getString(key) ?? null,
  set: (key, value) => storage.set(key, value),
  // v4 returns whether a value was actually removed; the interface is void.
  remove: (key) => void storage.remove(key),
}
