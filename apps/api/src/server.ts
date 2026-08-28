import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import type { Database } from './db/client.js'
import { registerAuth } from './lib/context.js'
import { registerErrorHandler } from './lib/errors.js'
import { env } from './lib/env.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerMeRoutes } from './routes/me.js'
import { registerAttendanceRoutes } from './routes/attendance.js'
import { registerLeaveRoutes } from './routes/leave.js'
import { registerTeamRoutes } from './routes/team.js'
import { registerDocumentRoutes } from './routes/documents.js'
import { registerAdminRoutes } from './routes/admin.js'

export async function buildServer(db: Database): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      env().NODE_ENV === 'test'
        ? false
        : { level: env().NODE_ENV === 'production' ? 'info' : 'debug' },
    // The mobile client sends its own request ids so a failed offline write can
    // be traced from the outbox row to the server log.
    requestIdHeader: 'x-request-id',
    trustProxy: true,
  })

  const origins = env().CORS_ORIGINS
  await app.register(cors, {
    origin: origins === '*' ? true : origins.split(',').map((o) => o.trim()),
    credentials: true,
    allowedHeaders: ['content-type', 'authorization', 'idempotency-key', 'x-request-id'],
  })

  registerErrorHandler(app)
  registerAuth(app, db)

  app.get('/health', async () => ({
    status: 'ok',
    driver: db.driver,
    time: new Date().toISOString(),
  }))

  registerAuthRoutes(app, db)
  registerMeRoutes(app, db)
  registerAttendanceRoutes(app, db)
  registerLeaveRoutes(app, db)
  registerTeamRoutes(app, db)
  registerDocumentRoutes(app, db)
  registerAdminRoutes(app, db)

  return app
}
