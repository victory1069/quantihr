import { z } from 'zod'
import { isoInstant, uuid } from './common.js'

export const documentType = z.enum([
  'contract',
  'policy',
  'payslip_placeholder',
  'certificate',
  'letter',
  'other',
])

export const documentItem = z.object({
  id: uuid,
  type: documentType,
  name: z.string(),
  sizeBytes: z.number().int().nullable(),
  uploadedAt: isoInstant,
  uploadedByName: z.string().nullable(),
  requiresAcknowledgement: z.boolean(),
  acknowledgedAt: isoInstant.nullable(),
})

export const documentUrlResponse = z.object({
  url: z.string().url(),
  /** Short TTL — the link is for one open, not for sharing. */
  expiresAt: isoInstant,
})

export const acknowledgeDocument = z.object({ documentId: uuid })

export type DocumentItem = z.infer<typeof documentItem>
