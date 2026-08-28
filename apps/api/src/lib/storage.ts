/**
 * Document storage behind a two-driver interface.
 *
 * Production is S3 with presigned URLs. Development writes under `.storage/` and
 * hands back a short-lived signed local URL, so the document vault is fully
 * exercisable without AWS credentials. Both drivers return a URL with an
 * expiry — the link is for one open, not for sharing (spec §4).
 */

import { createHmac, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { env } from './env.js'

export interface SignedUrl {
  url: string
  expiresAt: Date
}

export interface StorageDriver {
  key(orgId: string, filename: string): string
  put(key: string, body: Buffer, contentType: string): Promise<void>
  get(key: string): Promise<Buffer>
  signedUrl(key: string, ttlSeconds: number): Promise<SignedUrl>
}

const LOCAL_ROOT = resolve(process.cwd(), '.storage')

function signLocal(key: string, expiresAtMs: number): string {
  return createHmac('sha256', env().JWT_SECRET)
    .update(`${key}:${expiresAtMs}`)
    .digest('hex')
}

export function verifyLocalSignature(
  key: string,
  expires: string,
  signature: string,
): boolean {
  const expiresAtMs = Number(expires)
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) return false
  return signLocal(key, expiresAtMs) === signature
}

const localDriver: StorageDriver = {
  key(orgId, filename) {
    // Org id first so a misconfigured bucket policy still segregates tenants.
    return `${orgId}/${randomUUID()}-${filename.replace(/[^\w.\-]/g, '_')}`
  },

  async put(key, body) {
    const path = join(LOCAL_ROOT, key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body)
  },

  async get(key) {
    return readFile(join(LOCAL_ROOT, key))
  },

  async signedUrl(key, ttlSeconds) {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000)
    const signature = signLocal(key, expiresAt.getTime())
    const url = `/v1/documents/download?key=${encodeURIComponent(key)}&expires=${expiresAt.getTime()}&sig=${signature}`
    return { url, expiresAt }
  },
}

const s3Driver: StorageDriver = {
  key: localDriver.key,

  async put() {
    throw new Error(
      'S3 driver is not wired up. Set STORAGE_DRIVER=local for development, or ' +
        'add @aws-sdk/client-s3 and implement put/get/signedUrl before deploying.',
    )
  },
  async get() {
    throw new Error('S3 driver is not wired up')
  },
  async signedUrl() {
    throw new Error('S3 driver is not wired up')
  },
}

export function storage(): StorageDriver {
  return env().STORAGE_DRIVER === 's3' ? s3Driver : localDriver
}
