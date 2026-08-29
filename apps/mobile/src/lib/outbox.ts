/**
 * The write outbox (spec §6).
 *
 * Read cache and write queue are deliberately separate mechanisms; conflating
 * them causes bugs. This is the write half: every mutation is durably queued
 * with an idempotency key before it is attempted, so a request that leaves the
 * device exactly once can be retried safely any number of times.
 *
 * SQLite rather than MMKV because draining needs a transaction — claiming a row
 * and recording its outcome must not interleave with another drain.
 */

import * as SQLite from 'expo-sqlite'
import { isPermanent } from '@quanti/shared'

export type OutboxStatus = 'pending' | 'sent' | 'failed'

export interface OutboxRow {
  id: string
  idempotencyKey: string
  endpoint: string
  method: string
  payload: unknown
  createdAt: string
  attempts: number
  lastError: string | null
  status: OutboxStatus
  nextAttemptAt: string
}

export interface EnqueueInput {
  endpoint: string
  method: 'POST' | 'PATCH' | 'DELETE'
  payload: unknown
  /** Stable key so a retry is recognised server-side as the same request. */
  idempotencyKey?: string
}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null

async function database(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync('quanti-outbox.db').then(async (db) => {
      await db.execAsync(`
        pragma journal_mode = WAL;
        create table if not exists outbox (
          id text primary key,
          idempotency_key text not null unique,
          endpoint text not null,
          method text not null,
          payload text not null,
          created_at text not null,
          attempts integer not null default 0,
          last_error text,
          status text not null default 'pending',
          next_attempt_at text not null
        );
        create index if not exists outbox_ready_idx
          on outbox (status, next_attempt_at);
      `)
      return db
    })
  }
  return dbPromise
}

function uuid(): string {
  // `crypto.randomUUID` is present on web and in Hermes with the polyfill;
  // the fallback keeps this working in bare JS contexts (tests included).
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`
}

export async function enqueue(input: EnqueueInput): Promise<OutboxRow> {
  const db = await database()
  const row: OutboxRow = {
    id: uuid(),
    idempotencyKey: input.idempotencyKey ?? uuid(),
    endpoint: input.endpoint,
    method: input.method,
    payload: input.payload,
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    status: 'pending',
    nextAttemptAt: new Date().toISOString(),
  }

  await db.runAsync(
    `insert into outbox
       (id, idempotency_key, endpoint, method, payload, created_at, attempts, status, next_attempt_at)
     values (?, ?, ?, ?, ?, ?, 0, 'pending', ?)`,
    row.id,
    row.idempotencyKey,
    row.endpoint,
    row.method,
    JSON.stringify(row.payload),
    row.createdAt,
    row.nextAttemptAt,
  )

  return row
}

interface RawRow {
  id: string
  idempotency_key: string
  endpoint: string
  method: string
  payload: string
  created_at: string
  attempts: number
  last_error: string | null
  status: OutboxStatus
  next_attempt_at: string
}

function hydrate(r: RawRow): OutboxRow {
  return {
    id: r.id,
    idempotencyKey: r.idempotency_key,
    endpoint: r.endpoint,
    method: r.method,
    payload: JSON.parse(r.payload),
    createdAt: r.created_at,
    attempts: r.attempts,
    lastError: r.last_error,
    status: r.status,
    nextAttemptAt: r.next_attempt_at,
  }
}

export async function pending(): Promise<OutboxRow[]> {
  const db = await database()
  const rows = await db.getAllAsync<RawRow>(
    `select * from outbox where status != 'sent' order by created_at asc`,
  )
  return rows.map(hydrate)
}

/** Rows whose backoff has elapsed, oldest first — ordering is preserved. */
export async function ready(): Promise<OutboxRow[]> {
  const db = await database()
  const rows = await db.getAllAsync<RawRow>(
    `select * from outbox
     where status = 'pending' and next_attempt_at <= ?
     order by created_at asc`,
    new Date().toISOString(),
  )
  return rows.map(hydrate)
}

export async function markSent(id: string): Promise<void> {
  const db = await database()
  await db.runAsync(`update outbox set status = 'sent' where id = ?`, id)
}

/**
 * Exponential backoff, capped at five minutes.
 *
 * A permanent failure (a rejected check-in, an insufficient balance) is marked
 * `failed` and never retried. Retrying those forever is how an outbox silently
 * eats a leave request while appearing to work.
 */
export async function markFailed(
  id: string,
  errorCode: string,
  message: string,
): Promise<'retry' | 'permanent'> {
  const db = await database()
  const row = await db.getFirstAsync<RawRow>(`select * from outbox where id = ?`, id)
  if (!row) return 'permanent'

  const attempts = row.attempts + 1

  if (isPermanent(errorCode)) {
    await db.runAsync(
      `update outbox set status = 'failed', attempts = ?, last_error = ? where id = ?`,
      attempts,
      message,
      id,
    )
    return 'permanent'
  }

  const delayMs = Math.min(300_000, 2 ** attempts * 1000)
  await db.runAsync(
    `update outbox set attempts = ?, last_error = ?, next_attempt_at = ? where id = ?`,
    attempts,
    message,
    new Date(Date.now() + delayMs).toISOString(),
    id,
  )
  return 'retry'
}

export async function discard(id: string): Promise<void> {
  const db = await database()
  await db.runAsync(`delete from outbox where id = ?`, id)
}

export async function clearSent(): Promise<void> {
  const db = await database()
  await db.runAsync(`delete from outbox where status = 'sent'`)
}

/** Anything queued or failed — drives the "pending sync" badge in the UI. */
export async function unsyncedCount(): Promise<number> {
  const db = await database()
  const row = await db.getFirstAsync<{ n: number }>(
    `select count(*) as n from outbox where status != 'sent'`,
  )
  return row?.n ?? 0
}

export async function failed(): Promise<OutboxRow[]> {
  const db = await database()
  const rows = await db.getAllAsync<RawRow>(
    `select * from outbox where status = 'failed' order by created_at asc`,
  )
  return rows.map(hydrate)
}
