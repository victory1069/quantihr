/**
 * Storage driver selection.
 *
 * DOC-02 originally asked for "the s3 driver returns a presigned, expiring
 * URL." It doesn't — `lib/storage.ts`'s s3Driver is a stub that throws on
 * every method, and production runs `STORAGE_DRIVER=local` with no
 * persistent disk, so documents don't survive a redeploy either (DEF-006 in
 * the QA tracker). Both are logged as a known limitation, deferred rather
 * than fixed here. What this file guards instead: whichever driver is
 * selected, a document operation either works or fails loudly — it must
 * never silently drop or misplace what was meant to be stored.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { resetEnvCache } from '../src/lib/env.js'
import { storage } from '../src/lib/storage.js'

afterEach(() => {
  delete process.env.STORAGE_DRIVER
  resetEnvCache()
})

describe('storage driver selection', () => {
  it('defaults to the local driver', () => {
    resetEnvCache()
    expect(storage().key('org-1', 'contract.pdf')).toContain('org-1/')
  })

  it('fails loudly, not silently, on every operation while s3 stays unimplemented', async () => {
    process.env.STORAGE_DRIVER = 's3'
    resetEnvCache()

    // A silent failure here would look like a document that simply never
    // arrived, with nothing in the response to say why. This is the safety
    // net for that — not a substitute for implementing S3 (DEF-006).
    await expect(
      storage().put('key', Buffer.from('x'), 'text/plain'),
    ).rejects.toThrow(/S3 driver is not wired up/)
    await expect(storage().get('key')).rejects.toThrow(/S3 driver is not wired up/)
    await expect(storage().signedUrl('key', 60)).rejects.toThrow(/S3 driver is not wired up/)
  })
})
