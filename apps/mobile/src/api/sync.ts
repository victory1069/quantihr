/**
 * Outbox drain.
 *
 * Rows are attempted strictly oldest-first. Ordering matters: two leave
 * requests queued offline must reach the server in the order they were made, or
 * the second one is validated against a balance the first has not yet reserved.
 *
 * A drain never runs concurrently with itself — a second caller waits for the
 * one in flight instead of racing it and double-sending.
 */

import { ApiError, isPermanent } from '@quanti/shared'
import { request, NetworkError } from './client'
import { markFailed, markSent, ready, type OutboxRow } from '../lib/outbox'

export interface DrainResult {
  attempted: number
  sent: number
  failedPermanently: number
  deferred: number
  /** The response body of the row named by `only`, when it succeeded. */
  result?: unknown
  /** The error that stopped `only` from being sent. */
  error?: ApiError | NetworkError
}

let inFlight: Promise<DrainResult> | null = null

export async function drainOutbox(options: { only?: string } = {}): Promise<DrainResult> {
  if (inFlight && !options.only) return inFlight

  const run = async (): Promise<DrainResult> => {
    const rows = await ready()
    const summary: DrainResult = {
      attempted: 0,
      sent: 0,
      failedPermanently: 0,
      deferred: 0,
    }

    for (const row of rows) {
      summary.attempted += 1
      const outcome = await attempt(row)

      if (outcome.kind === 'sent') {
        summary.sent += 1
        if (options.only === row.id) summary.result = outcome.body
        continue
      }

      if (outcome.kind === 'offline') {
        // Stop the whole drain: the network is down, and continuing would burn
        // attempt counters on rows that never left the device.
        summary.deferred += rows.length - summary.attempted + 1
        if (options.only === row.id) summary.error = outcome.error
        break
      }

      summary.failedPermanently += outcome.permanent ? 1 : 0
      summary.deferred += outcome.permanent ? 0 : 1
      if (options.only === row.id) summary.error = outcome.error
    }

    return summary
  }

  if (options.only) {
    // A user-initiated write drains immediately rather than waiting behind a
    // background sweep, but still after any sweep already running.
    const previous = inFlight ?? Promise.resolve(null)
    const chained = previous.then(run, run)
    return chained
  }

  inFlight = run().finally(() => {
    inFlight = null
  })
  return inFlight
}

type Attempt =
  | { kind: 'sent'; body: unknown }
  | { kind: 'offline'; error: NetworkError }
  | { kind: 'rejected'; permanent: boolean; error: ApiError }

async function attempt(row: OutboxRow): Promise<Attempt> {
  try {
    const body = await request<unknown>(row.endpoint, {
      method: row.method as 'POST',
      body: row.payload,
      idempotencyKey: row.idempotencyKey,
    })
    await markSent(row.id)
    return { kind: 'sent', body }
  } catch (error) {
    if (error instanceof NetworkError) {
      return { kind: 'offline', error }
    }

    if (error instanceof ApiError) {
      const permanent = isPermanent(error.code)
      await markFailed(row.id, error.code, error.message)
      return { kind: 'rejected', permanent, error }
    }

    const wrapped = new ApiError(
      'common/internal',
      error instanceof Error ? error.message : 'Unknown error',
      500,
    )
    await markFailed(row.id, wrapped.code, wrapped.message)
    return { kind: 'rejected', permanent: false, error: wrapped }
  }
}
