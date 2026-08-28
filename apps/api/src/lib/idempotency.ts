/**
 * Idempotency for the two endpoints the offline outbox retries.
 *
 * The outbox drains with exponential backoff, and a response lost on the way
 * back looks identical to a request that never arrived. Without this, a flaky
 * connection turns one leave request into three (spec §4).
 *
 * The stored `request_hash` guards the other direction: a client that reuses a
 * key for a *different* payload is a bug, and returning the first response
 * silently would hide it. That case is an error, not a cache hit.
 */

import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { ApiError, ERROR_CODES } from '@quanti/shared'
import { idempotencyKeys } from '../db/schema.js'
import type { Tx } from '../db/client.js'

export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex')
}

export interface ReplayHit {
  status: number
  body: unknown
}

/**
 * Returns a previous response for this key, or `null` to proceed.
 * Throws when the key was used for a materially different request.
 */
export async function checkIdempotency(
  tx: Tx,
  orgId: string,
  key: string | undefined,
  endpoint: string,
  payload: unknown,
): Promise<ReplayHit | null> {
  if (!key) return null

  const requestHash = hashPayload(payload)
  const [existing] = await tx
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.orgId, orgId),
        eq(idempotencyKeys.key, key),
        eq(idempotencyKeys.endpoint, endpoint),
      ),
    )
    .limit(1)

  if (!existing) return null

  if (existing.requestHash !== requestHash) {
    throw new ApiError(
      ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
      'This idempotency key was already used for a different request',
      409,
    )
  }

  // An in-flight duplicate (row claimed, response not yet written) is retryable.
  if (existing.responseStatus === null) return null

  return { status: existing.responseStatus, body: existing.responseBody }
}

export async function recordIdempotency(
  tx: Tx,
  orgId: string,
  key: string | undefined,
  endpoint: string,
  payload: unknown,
  status: number,
  body: unknown,
): Promise<void> {
  if (!key) return
  await tx
    .insert(idempotencyKeys)
    .values({
      orgId,
      key,
      endpoint,
      requestHash: hashPayload(payload),
      responseStatus: status,
      responseBody: body as object,
    })
    .onConflictDoUpdate({
      target: [idempotencyKeys.orgId, idempotencyKeys.key, idempotencyKeys.endpoint],
      set: { responseStatus: status, responseBody: body as object },
    })
}

export function idempotencyKeyFrom(headers: Record<string, unknown>): string | undefined {
  const raw = headers['idempotency-key']
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed.length < 8 || trimmed.length > 200) return undefined
  return trimmed
}
