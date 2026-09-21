/**
 * Policy library (HR) and the self-service assistant (everyone).
 *
 * Upload is HR-only and stores two things: the original file, so it can be
 * shown or re-extracted later, and the extracted text, which is what the
 * assistant actually reads. Extraction happens at upload rather than at
 * question time so a bad PDF is discovered by the person who can fix it — HR,
 * looking at a document that reports itself as empty — rather than by an
 * employee whose question just quietly gets no answer.
 *
 * Asking is open to any employee of the org. Which org is decided by the
 * tenant claim and enforced by RLS on every row the corpus is built from.
 */

import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { ApiError, ERROR_CODES, schemas } from '@quanti/shared'
import { policyDocuments } from '../db/schema.js'
import type { Database } from '../db/client.js'
import { audit } from '../lib/audit.js'
import { requireAuth, requireRole, tenant } from '../lib/context.js'
import {
  answerFromCorpus,
  extractPolicyText,
  extractionAvailableForPolicy,
  formatFor,
  loadCorpus,
} from '../lib/policy.js'
import { storage } from '../lib/storage.js'

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

export function registerPolicyRoutes(app: FastifyInstance, _db: Database): void {
  app.get('/v1/admin/policies', async (request, reply) => {
    requireRole(request, 'hr_admin', 'owner')

    const rows = await tenant(request, async (tx) =>
      tx
        .select({
          id: policyDocuments.id,
          title: policyDocuments.title,
          filename: policyDocuments.filename,
          mimeType: policyDocuments.mimeType,
          charCount: policyDocuments.charCount,
          status: policyDocuments.status,
          createdAt: policyDocuments.createdAt,
        })
        .from(policyDocuments)
        .orderBy(policyDocuments.createdAt),
    )

    return reply.send({
      documents: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      totalChars: rows.reduce((sum, r) => sum + r.charCount, 0),
    })
  })

  app.post('/v1/admin/policies', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const body = schemas.policy.uploadPolicy.parse(request.body)

    const format = formatFor(body.mimeType, body.filename)
    if (!format) {
      throw new ApiError(
        ERROR_CODES.VALIDATION_FAILED,
        'Upload a PDF, Word document (.docx), or plain text file',
        422,
      )
    }

    const buffer = Buffer.from(body.contentBase64, 'base64')
    if (buffer.byteLength > MAX_UPLOAD_BYTES) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'That file is larger than 15MB', 413)
    }

    const text = await extractPolicyText(buffer, format)

    const key = `policies/${auth.orgId}/${Date.now()}-${body.filename.replace(/[^\w.-]+/g, '_')}`
    await storage().put(key, buffer, body.mimeType)

    const row = await tenant(request, async (tx) => {
      const [inserted] = await tx
        .insert(policyDocuments)
        .values({
          orgId: auth.orgId,
          title: body.title.trim(),
          filename: body.filename,
          mimeType: body.mimeType,
          storageKey: key,
          bodyText: text,
          charCount: text.length,
          // "empty" is surfaced, not hidden: HR sees a document that produced
          // no text and can re-save it as a text-based PDF. Left silent, the
          // assistant would simply never cite it and nobody would know why.
          status: text.length > 0 ? 'ready' : 'empty',
          uploadedBy: auth.userId,
        })
        .returning()

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'policy.uploaded',
        entityType: 'policy_document',
        entityId: inserted!.id,
        after: { title: inserted!.title, chars: inserted!.charCount },
        ip: request.ip,
      })

      return inserted!
    })

    return reply.status(201).send({
      id: row.id,
      title: row.title,
      filename: row.filename,
      mimeType: row.mimeType,
      charCount: row.charCount,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    })
  })

  app.delete('/v1/admin/policies/:id', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const { id } = request.params as { id: string }

    await tenant(request, async (tx) => {
      const [row] = await tx
        .select({ id: policyDocuments.id, title: policyDocuments.title })
        .from(policyDocuments)
        .where(eq(policyDocuments.id, id))
        .limit(1)
      if (!row) throw new ApiError(ERROR_CODES.NOT_FOUND, 'No such document', 404)

      await tx.delete(policyDocuments).where(eq(policyDocuments.id, id))
      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'policy.removed',
        entityType: 'policy_document',
        entityId: id,
        before: { title: row.title },
        ip: request.ip,
      })
    })

    return reply.status(204).send()
  })

  /**
   * The employee-facing question.
   *
   * Every employee of the org, no role check: the whole point of self-service
   * is that the person with the question does not have to ask anyone.
   */
  app.post('/v1/ask', async (request, reply) => {
    requireAuth(request)
    const { question } = schemas.policy.askRequest.parse(request.body)

    const docs = await tenant(request, async (tx) => loadCorpus(tx))

    // Both of these are proper answers rather than errors. The screen has a
    // designed state for "nothing to search" and for "assistant not connected",
    // and neither should read as something having gone wrong.
    if (docs.length === 0) {
      return reply.send({
        answered: false,
        answer:
          'No policy documents have been uploaded yet, so there is nothing to answer from. Ask HR directly for now.',
        citations: [],
        documentsConsulted: 0,
        model: null,
        answeredAt: new Date().toISOString(),
      })
    }

    if (!extractionAvailableForPolicy()) {
      return reply.send({
        answered: false,
        answer: 'The assistant is not connected on this deployment. Ask HR directly for now.',
        citations: [],
        documentsConsulted: docs.length,
        model: null,
        answeredAt: new Date().toISOString(),
      })
    }

    const result = await answerFromCorpus(question, docs)
    if (!result) {
      return reply.send({
        answered: false,
        answer: 'I could not produce a reliable answer to that. Ask HR directly.',
        citations: [],
        documentsConsulted: docs.length,
        model: null,
        answeredAt: new Date().toISOString(),
      })
    }

    request.log.info(
      {
        documents: docs.length,
        answered: result.answer.answered,
        citations: result.answer.citations.length,
        costUsd: result.costUsd,
        cacheHit: result.cacheHit,
      },
      'policy question answered',
    )

    return reply.send({
      ...result.answer,
      documentsConsulted: docs.length,
      model: result.model,
      answeredAt: new Date().toISOString(),
    })
  })
}
