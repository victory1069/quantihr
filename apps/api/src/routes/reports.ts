/**
 * Reports for the HR console.
 *
 * HR-only. These aggregate the whole organisation — a manager who could call
 * them would see every other team's absence pattern, which is not what
 * direct-report scoping is for.
 *
 * The figures are computed first and returned whether or not the analyst is
 * reachable. A report that fails because a model call failed would make the
 * numbers hostage to an optional convenience.
 */

import type { FastifyInstance } from 'fastify'
import { schemas } from '@quanti/shared'
import type { Database } from '../db/client.js'
import { requireRole, tenant } from '../lib/context.js'
import { analyseLeave, computeLeaveFacts } from '../lib/reports.js'

export function registerReportRoutes(app: FastifyInstance, _db: Database): void {
  app.get('/v1/admin/reports/leave', async (request, reply) => {
    requireRole(request, 'hr_admin', 'owner')
    const { from, to } = schemas.reports.reportQuery.parse(request.query)

    const facts = await tenant(request, async (tx) => computeLeaveFacts(tx, from, to))

    // Interpretation is best-effort. If it throws or is unconfigured the report
    // still goes out with `analysis: null`, and the console renders the figures
    // with a line explaining why there is no commentary.
    let analysis = null
    let model: string | null = null
    let costUsd = 0

    try {
      const result = await analyseLeave(facts)
      if (result) {
        analysis = result.analysis
        model = result.model
        costUsd = result.costUsd
      }
    } catch (error) {
      request.log.error({ err: error }, 'leave report analysis failed')
    }

    return reply.send({
      facts,
      analysis,
      model,
      costUsd,
      generatedAt: new Date().toISOString(),
    })
  })
}
