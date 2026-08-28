/**
 * Document vault — read-only for employees, HR uploads (spec §1, §5).
 *
 * Employees see their own documents plus org-wide ones (`employee_id IS NULL`).
 * The download URL is short-lived and single-purpose; every issue is audited,
 * because "who opened my contract" is a question HR will eventually be asked.
 */

import type { FastifyInstance } from 'fastify'
import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { ApiError, ERROR_CODES, schemas } from '@quanti/shared'
import { documents, employees } from '../db/schema.js'
import type { Database } from '../db/client.js'
import { audit } from '../lib/audit.js'
import { requireAuth, tenant } from '../lib/context.js'
import { storage, verifyLocalSignature } from '../lib/storage.js'
import { fullName } from './shared.js'

const DOWNLOAD_TTL_SECONDS = 120

export function registerDocumentRoutes(app: FastifyInstance, _db: Database): void {
  app.get('/v1/documents', async (request, reply) => {
    const auth = requireAuth(request)

    const rows = await tenant(request, async (tx) => {
      const list = await tx
        .select()
        .from(documents)
        .where(
          or(eq(documents.employeeId, auth.employeeId), isNull(documents.employeeId)),
        )
        .orderBy(desc(documents.uploadedAt))

      return Promise.all(
        list.map(async (d) => {
          let uploadedByName: string | null = null
          if (d.uploadedBy) {
            const [uploader] = await tx
              .select({ firstName: employees.firstName, lastName: employees.lastName })
              .from(employees)
              .where(eq(employees.userId, d.uploadedBy))
              .limit(1)
            uploadedByName = uploader ? fullName(uploader) : null
          }
          return {
            id: d.id,
            type: d.type,
            name: d.name,
            sizeBytes: d.sizeBytes,
            uploadedAt: d.uploadedAt.toISOString(),
            uploadedByName,
            requiresAcknowledgement: d.requiresAcknowledgement,
            acknowledgedAt: d.acknowledgedAt?.toISOString() ?? null,
          }
        }),
      )
    })

    return reply.send({ documents: rows })
  })

  app.get('/v1/documents/:id/url', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = request.params as { id: string }

    const signed = await tenant(request, async (tx) => {
      const [doc] = await tx
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.id, id),
            or(eq(documents.employeeId, auth.employeeId), isNull(documents.employeeId)),
          ),
        )
        .limit(1)

      if (!doc) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Document not found', 404)

      const url = await storage().signedUrl(doc.s3Key, DOWNLOAD_TTL_SECONDS)

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'document.viewed',
        entityType: 'document',
        entityId: doc.id,
        ip: request.ip,
      })

      return url
    })

    return reply.send({ url: signed.url, expiresAt: signed.expiresAt.toISOString() })
  })

  app.post('/v1/documents/:id/acknowledge', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = request.params as { id: string }

    await tenant(request, async (tx) => {
      const [doc] = await tx
        .select()
        .from(documents)
        .where(and(eq(documents.id, id), eq(documents.employeeId, auth.employeeId)))
        .limit(1)

      if (!doc) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Document not found', 404)

      await tx
        .update(documents)
        .set({ acknowledgedAt: new Date() })
        .where(eq(documents.id, id))

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'document.acknowledged',
        entityType: 'document',
        entityId: id,
        ip: request.ip,
      })
    })

    return reply.status(204).send()
  })

  /**
   * Local-storage download endpoint (development).
   *
   * Authenticated by the HMAC signature in the query string rather than a JWT,
   * because the browser and the RN `Linking` handler both open it directly. In
   * production this route is unused — S3 serves the presigned URL itself.
   */
  app.get('/v1/documents/download', async (request, reply) => {
    const query = request.query as { key?: string; expires?: string; sig?: string }
    if (!query.key || !query.expires || !query.sig) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'Malformed download link', 400)
    }
    if (!verifyLocalSignature(query.key, query.expires, query.sig)) {
      throw new ApiError(ERROR_CODES.AUTH_FORBIDDEN, 'That link has expired', 403)
    }

    const body = await storage().get(query.key)
    return reply.header('content-type', 'application/octet-stream').send(body)
  })
}
