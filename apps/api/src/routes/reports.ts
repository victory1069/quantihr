/**
 * Reports for the HR console.
 *
 * One endpoint over four report kinds, because they differ only in which facts
 * get computed — the access rule, the failure behaviour and the analyst
 * contract are identical, and three copies of that would drift.
 *
 * **Who can read these.** HR admins and owners, which is what "HR and Admin"
 * means in this system's role set. Deliberately not managers: these aggregate
 * the whole organisation, and a manager who could call them would see every
 * other team's absence and task figures. Manager-scoped views go through the
 * team endpoints and their direct-report scoping.
 *
 * The figures are computed first and returned whether or not the analyst is
 * reachable. A report that failed because a model call failed would make the
 * numbers hostage to an optional convenience.
 */

import type { FastifyInstance } from 'fastify'
import { schemas, type ReportKind } from '@quanti/shared'
import type { Database, Tx } from '../db/client.js'
import { requireRole, tenant } from '../lib/context.js'
import {
  analyse,
  computeAttendanceFacts,
  computeLeaveFacts,
  computeMeetingsFacts,
  computePerformanceFacts,
} from '../lib/reports.js'

const COMPUTE: Record<ReportKind, (tx: Tx, from: string, to: string) => Promise<object>> = {
  leave: computeLeaveFacts,
  attendance: computeAttendanceFacts,
  performance: computePerformanceFacts,
  meetings: computeMeetingsFacts,
}

export function registerReportRoutes(app: FastifyInstance, _db: Database): void {
  app.get('/v1/admin/reports/:kind', async (request, reply) => {
    requireRole(request, 'hr_admin', 'owner')

    const { kind } = schemas.reports.reportKind
      .transform((k) => ({ kind: k }))
      .parse((request.params as { kind: string }).kind)

    const { from, to } = schemas.reports.reportQuery.parse(request.query)

    const facts = await tenant(request, async (tx) => COMPUTE[kind](tx, from, to))

    // Interpretation is best-effort. If it throws or is unconfigured the report
    // still goes out with `analysis: null`, and the console renders the figures
    // with a line explaining why there is no commentary.
    let analysis = null
    let model: string | null = null
    let costUsd = 0

    try {
      const result = await analyse(kind, facts)
      if (result) {
        analysis = result.analysis
        model = result.model
        costUsd = result.costUsd
      }
    } catch (error) {
      request.log.error({ err: error, kind }, 'report analysis failed')
    }

    return reply.send({
      kind,
      facts,
      analysis,
      model,
      costUsd,
      generatedAt: new Date().toISOString(),
    })
  })
}
