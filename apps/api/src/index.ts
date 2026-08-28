/**
 * Development entrypoint.
 *
 * In production the accrual run and the reminder sweeps belong on pg-boss or
 * SQS (spec §2). Here they run on in-process intervals so a single `npm run api`
 * exercises the whole system — including the jobs — without extra
 * infrastructure. The interval scheduler is explicitly not a production plan.
 */

import { createDatabase } from './db/client.js'
import { buildServer } from './server.js'
import { env } from './lib/env.js'
import { runAccrual } from './jobs/accrual.js'
import { rotateCodes } from './jobs/codes.js'
import { sweepCheckinWindows, sweepPendingApprovals } from './jobs/reminders.js'
import { flushNotifications } from './lib/notify.js'
import { seedIfEmpty } from './db/seed.js'

async function main() {
  const db = await createDatabase()
  await db.applySchema()

  if (env().NODE_ENV !== 'production') {
    await seedIfEmpty(db)
  }

  const app = await buildServer(db)
  await app.listen({ port: env().PORT, host: env().HOST })

  app.log.info(`Quanti HR API on :${env().PORT} (${db.driver})`)

  const timers = [
    // Codes rotate frequently; everything else is a slow sweep.
    setInterval(() => void rotateCodes(db).catch((e) => app.log.error(e)), 60_000),
    setInterval(() => void sweepPendingApprovals(db).catch((e) => app.log.error(e)), 300_000),
    setInterval(() => void sweepCheckinWindows(db).catch((e) => app.log.error(e)), 300_000),
    setInterval(async () => {
      try {
        for (const org of await db.lookup.orgs()) await flushNotifications(db, org.orgId)
      } catch (e) {
        app.log.error(e)
      }
    }, 30_000),
    setInterval(() => void runAccrual(db).catch((e) => app.log.error(e)), 3_600_000),
  ]

  await rotateCodes(db)
  await runAccrual(db)

  const shutdown = async () => {
    for (const t of timers) clearInterval(t)
    await app.close()
    await db.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
