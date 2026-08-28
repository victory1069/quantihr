/**
 * Database access, and the single place tenant context is established.
 *
 * Every tenant-scoped query in this codebase goes through `withTenant`. It opens
 * a transaction, drops to the non-superuser `quanti_app` role, and sets the
 * `app.org_id` claim the RLS policies read — all with `SET LOCAL`, so both
 * revert on commit and on rollback. Nothing outside this file may issue a bare
 * query against a tenant table.
 *
 * Dev runs on PGlite (real Postgres, WASM, no Docker) and production on a
 * normal connection pool. The two differ in exactly one way that matters:
 * PGlite is a SINGLE connection, so concurrent transactions would interleave
 * their `SET LOCAL ROLE` statements and leak one tenant's context into
 * another's query. The mutex below serialises them. It is not a performance
 * compromise to fix later — without it the isolation guarantee is void.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { schema } from './schema.js'

const here = dirname(fileURLToPath(import.meta.url))

export type Tx = PgDatabase<PgQueryResultHKT, typeof schema>

export interface Database {
  /** Run `fn` with RLS active and `app.org_id` bound to `orgId`. */
  withTenant<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T>
  /**
   * Pre-tenant lookups only (auth bootstrap, job org enumeration). Calls the
   * SECURITY DEFINER functions in ddl.sql — it does not grant blanket access.
   */
  lookup: LookupApi
  applySchema(): Promise<void>
  reset(): Promise<void>
  close(): Promise<void>
  readonly driver: 'pglite' | 'postgres'
}

export interface LookupApi {
  userByEmail(email: string): Promise<{ userId: string; orgId: string } | null>
  magicLink(tokenHash: string): Promise<{
    tokenId: string
    userId: string
    orgId: string
    expiresAt: Date
    usedAt: Date | null
  } | null>
  refreshToken(tokenHash: string): Promise<{
    tokenId: string
    userId: string
    orgId: string
    expiresAt: Date
    revokedAt: Date | null
  } | null>
  orgs(): Promise<{ orgId: string; timezone: string; settings: Record<string, unknown> }[]>
}

/** Serialises transactions on a single-connection driver. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn)
    // Swallow rejection on the chain itself so one failed transaction does not
    // poison every transaction queued behind it.
    this.tail = result.catch(() => undefined)
    return result
  }
}

async function readDdl(): Promise<string> {
  return readFile(join(here, 'ddl.sql'), 'utf8')
}

/**
 * Rows come back with snake_case keys from raw `execute`; the drizzle query
 * builder handles mapping for typed queries. This is for the lookup functions.
 */
function rows<T>(result: unknown): T[] {
  const r = result as { rows?: T[] } | T[]
  return Array.isArray(r) ? r : (r.rows ?? [])
}

export async function createPgliteDatabase(dataDir?: string): Promise<Database> {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')

  const client = dataDir ? new PGlite(dataDir) : new PGlite()
  const db = drizzle(client, { schema })
  const mutex = new Mutex()

  const exec = async (text: string, params: unknown[] = []) =>
    rows<Record<string, unknown>>(await db.execute(sql.raw(bind(text, params))))

  return {
    driver: 'pglite',

    async withTenant<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
      return mutex.run(async () =>
        db.transaction(async (tx) => {
          await tx.execute(sql`set local role quanti_app`)
          await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`)
          return fn(tx as unknown as Tx)
        }),
      )
    },

    lookup: makeLookup(exec, mutex),

    async applySchema() {
      await mutex.run(async () => {
        await client.exec(await readDdl())
      })
    },

    async reset() {
      await mutex.run(async () => {
        await client.exec(`
          drop schema public cascade;
          create schema public;
          grant usage on schema public to quanti_app;
        `)
        await client.exec(await readDdl())
      })
    },

    async close() {
      await client.close()
    },
  }
}

export async function createPostgresDatabase(connectionString: string): Promise<Database> {
  const postgres = (await import('postgres')).default
  const { drizzle } = await import('drizzle-orm/postgres-js')

  const client = postgres(connectionString, { max: 10 })
  const db = drizzle(client, { schema })
  // A real pool gives each transaction its own connection, so no mutex is
  // needed — SET LOCAL cannot leak across connections.
  const noop = { run: <T,>(fn: () => Promise<T>) => fn() }

  const exec = async (text: string, params: unknown[] = []) =>
    rows<Record<string, unknown>>(await db.execute(sql.raw(bind(text, params))))

  return {
    driver: 'postgres',

    async withTenant<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`set local role quanti_app`)
        await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`)
        return fn(tx as unknown as Tx)
      })
    },

    lookup: makeLookup(exec, noop),

    async applySchema() {
      await client.unsafe(await readDdl())
    },

    async reset() {
      throw new Error('reset() is a test affordance and is disabled on the postgres driver')
    },

    async close() {
      await client.end()
    },
  }
}

function makeLookup(
  exec: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
  gate: { run<T>(fn: () => Promise<T>): Promise<T> },
): LookupApi {
  return {
    async userByEmail(email) {
      const r = await gate.run(() => exec('select * from auth_lookup_user($1)', [email]))
      const row = r[0]
      return row ? { userId: String(row.user_id), orgId: String(row.org_id) } : null
    },

    async magicLink(tokenHash) {
      const r = await gate.run(() =>
        exec('select * from auth_lookup_magic_link($1)', [tokenHash]),
      )
      const row = r[0]
      if (!row) return null
      return {
        tokenId: String(row.token_id),
        userId: String(row.user_id),
        orgId: String(row.org_id),
        expiresAt: new Date(row.expires_at as string),
        usedAt: row.used_at ? new Date(row.used_at as string) : null,
      }
    },

    async refreshToken(tokenHash) {
      const r = await gate.run(() =>
        exec('select * from auth_lookup_refresh_token($1)', [tokenHash]),
      )
      const row = r[0]
      if (!row) return null
      return {
        tokenId: String(row.token_id),
        userId: String(row.user_id),
        orgId: String(row.org_id),
        expiresAt: new Date(row.expires_at as string),
        revokedAt: row.revoked_at ? new Date(row.revoked_at as string) : null,
      }
    },

    async orgs() {
      const r = await gate.run(() => exec('select * from list_org_ids()'))
      return r.map((row) => ({
        orgId: String(row.org_id),
        timezone: String(row.timezone),
        settings: (row.settings ?? {}) as Record<string, unknown>,
      }))
    },
  }
}

/**
 * Inlines parameters for the handful of `select * from fn($1)` calls above.
 *
 * Drizzle's `sql.raw` takes no bind parameters, and these four functions are
 * called with values that must still be escaped — a magic-link token hash is
 * attacker-influenced. Only string, number, boolean and null are accepted;
 * anything else throws rather than being coerced into the statement.
 */
function bind(text: string, params: unknown[]): string {
  return text.replace(/\$(\d+)/g, (_, n: string) => {
    const value = params[Number(n) - 1]
    if (value === null || value === undefined) return 'null'
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('Non-finite number in query parameter')
      return String(value)
    }
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
    throw new TypeError(`Unsupported query parameter type: ${typeof value}`)
  })
}

export async function createDatabase(): Promise<Database> {
  const url = process.env.DATABASE_URL
  if (url && url.startsWith('postgres')) return createPostgresDatabase(url)
  return createPgliteDatabase(process.env.PGLITE_DIR)
}
