/**
 * Keeps `schema.ts` (Drizzle, for typed queries) honest against `ddl.sql`
 * (authoritative, owns RLS and grants).
 *
 * Two sources of truth is a deliberate trade — a schema-diffing tool cannot
 * express the policies this system depends on — but the failure mode is a
 * column added in one file and forgotten in the other, which shows up as a
 * runtime error in a route nobody exercised. This turns that into a CI failure.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { schema } from '../src/db/schema.js'
import type { Database } from '../src/db/client.js'
import { makeDatabase } from './helpers.js'

let db: Database
let live: Map<string, Set<string>>
let rlsByTable: Map<string, { enabled: boolean; forced: boolean }>

const SYSTEM_ORG = '00000000-0000-0000-0000-000000000000'

beforeAll(async () => {
  db = await makeDatabase()

  live = new Map()
  rlsByTable = new Map()

  await db.withTenant(SYSTEM_ORG, async (tx) => {
    const columns = await tx.execute(
      sql.raw(`select table_name, column_name from information_schema.columns
               where table_schema = 'public'`),
    )
    for (const row of rows<{ table_name: string; column_name: string }>(columns)) {
      if (!live.has(row.table_name)) live.set(row.table_name, new Set())
      live.get(row.table_name)!.add(row.column_name)
    }

    const rls = await tx.execute(
      sql.raw(`select relname, relrowsecurity, relforcerowsecurity
               from pg_class c
               join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relkind = 'r'`),
    )
    for (const row of rows<{
      relname: string
      relrowsecurity: boolean
      relforcerowsecurity: boolean
    }>(rls)) {
      rlsByTable.set(row.relname, {
        enabled: row.relrowsecurity,
        forced: row.relforcerowsecurity,
      })
    }
  })
})

afterAll(async () => {
  await db?.close()
})

function rows<T>(result: unknown): T[] {
  const r = result as { rows?: T[] } | T[]
  return Array.isArray(r) ? r : (r.rows ?? [])
}

const drizzleTables = Object.values(schema).map((table) => getTableConfig(table))

describe('drizzle schema matches the live database', () => {
  it.each(drizzleTables.map((t) => t.name))('table %s exists', (name) => {
    expect(live.has(name), `${name} is declared in schema.ts but missing from ddl.sql`).toBe(
      true,
    )
  })

  it.each(drizzleTables.map((t) => [t.name, t] as const))(
    'every column declared on %s exists in the database',
    (name, table) => {
      const actual = live.get(name)
      expect(actual, `${name} missing from database`).toBeDefined()

      const missing = table.columns
        .map((c) => c.name)
        .filter((column) => !actual!.has(column))

      expect(missing, `${name} declares columns absent from ddl.sql`).toEqual([])
    },
  )
})

describe('row-level security is on everywhere it matters', () => {
  const exempt = new Set<string>()

  it.each([...new Set(drizzleTables.map((t) => t.name))].filter((n) => !exempt.has(n)))(
    '%s has RLS enabled and forced',
    (name) => {
      const state = rlsByTable.get(name)
      expect(state, `${name} not found in pg_class`).toBeDefined()
      expect(state!.enabled, `${name} does not have RLS enabled`).toBe(true)
      // FORCE matters because the table owner would otherwise bypass the policy.
      expect(state!.forced, `${name} does not FORCE row level security`).toBe(true)
    },
  )

  it('has a policy on every table with RLS enabled', async () => {
    const policies = await db.withTenant(SYSTEM_ORG, async (tx) => {
      const result = await tx.execute(
        sql.raw(`select tablename from pg_policies where schemaname = 'public'`),
      )
      return rows<{ tablename: string }>(result).map((r) => r.tablename)
    })

    for (const [name, state] of rlsByTable) {
      if (!state.enabled) continue
      // RLS enabled with no policy denies everything — a silent outage, not a
      // security hole, but worth catching before it reaches a customer.
      expect(policies, `${name} has RLS enabled but no policy`).toContain(name)
    }
  })
})
