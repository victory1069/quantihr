/**
 * Schema drift.
 *
 * Every other suite builds a fresh database, which is exactly the situation
 * in which `create table if not exists` hides a missing column. This one
 * builds the database from the DDL as it was when Render was first deployed,
 * then applies today's DDL over it — the case that failed in production.
 *
 * If this fails, a column was added to a CREATE without a matching
 * `add column if not exists` in the Additive migrations section.
 */

import { describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

describe('schema drift', () => {
  it('a database built from the pre-onboarding DDL catches up on the next boot', async () => {
    // ad3ba4e is the commit Render was first deployed from.
    const old = execSync('git show ad3ba4e:apps/api/src/db/ddl.sql', {
      encoding: 'utf8',
      cwd: here,
    })
    const current = readFileSync(join(here, '../src/db/ddl.sql'), 'utf8')

    const db = new PGlite()
    await db.exec(old)
    const before = await db.query<{ n: string }>(
      `select count(*)::text as n from information_schema.columns where table_name='organisations' and column_name='onboarding_steps'`,
    )
    expect(before.rows[0]!.n).toBe('0')

    await db.exec(current)
    const after = await db.query<{ n: string }>(
      `select count(*)::text as n from information_schema.columns where table_name='organisations' and column_name in ('onboarding_steps','onboarding_completed_at')`,
    )
    expect(after.rows[0]!.n).toBe('2')

    // And the seed's insert shape now works against it.
    await db.exec(`insert into organisations (name, onboarding_steps) values ('Drift Co', '[]'::jsonb)`)

    // The password columns arrived later still, and the pre-tenant lookup's
    // return type grew with them — which `create or replace` cannot do.
    const lookup = await db.query<{ n: string }>(
      `select count(*)::text as n from information_schema.columns where table_name='users' and column_name in ('password_hash','must_change_password','password_changed_at')`,
    )
    expect(lookup.rows[0]!.n).toBe('3')
    const shape = await db.query<{ cols: string }>(
      `select pg_get_function_result('auth_lookup_user'::regproc) as cols`,
    )
    expect(shape.rows[0]!.cols).toContain('must_change_password')
    await db.close()
  })
})
