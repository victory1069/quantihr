/**
 * Learning & development.
 *
 * An employee plans their training a month or a quarter at a time and
 * submits the plan for their manager's approval. Once approved, each course
 * is followed up on its own: a reminder when it starts, one when it ends
 * asking for proof, and nudges until the proof arrives.
 */

import { z } from 'zod'
import { isoDate, uuid } from './common.js'

export const trainingPeriod = z.enum(['month', 'quarter'])
export const trainingMode = z.enum(['physical', 'virtual'])
export const trainingPlanStatus = z.enum([
  'draft',
  'submitted',
  'approved',
  'declined',
  'changes_requested',
])
export const trainingItemStatus = z.enum(['planned', 'completed', 'missed'])

export const trainingItemInput = z
  .object({
    title: z.string().min(2).max(200),
    provider: z.string().max(200).nullable().optional(),
    mode: trainingMode,
    startDate: isoDate,
    endDate: isoDate,
    /** Why this, this period — what the manager judges the request on. */
    need: z.string().min(10).max(2000),
    /** Kobo, so the sum is exact. Null when unknown or free. */
    costKobo: z.number().int().nonnegative().nullable().optional(),
  })
  .refine((i) => i.endDate >= i.startDate, {
    message: 'The end date has to be on or after the start',
    path: ['endDate'],
  })

/** Creates or replaces the plan for a period while it is still editable. */
export const upsertTrainingPlan = z.object({
  periodType: trainingPeriod,
  /** First day of the month or quarter. */
  periodStart: isoDate,
  items: z.array(trainingItemInput).min(1).max(20),
})

export const trainingPlanDecision = z.object({
  decision: z.enum(['approve', 'decline', 'request_changes']),
  note: z.string().max(2000).optional(),
})

/** Proof of completion: a file, a note, or both. */
export const completeTrainingItem = z
  .object({
    note: z.string().max(2000).optional(),
    proof: z
      .object({
        filename: z.string().min(1).max(200),
        contentType: z.string().min(3).max(120),
        contentBase64: z.string().min(1),
      })
      .optional(),
  })
  .refine((b) => !!b.proof || !!(b.note && b.note.trim().length >= 10), {
    message: 'Attach a certificate or screenshot, or say in a sentence what you completed',
  })

export const trainingItemView = z.object({
  id: uuid,
  title: z.string(),
  provider: z.string().nullable(),
  mode: trainingMode,
  startDate: isoDate,
  endDate: isoDate,
  need: z.string(),
  costKobo: z.number().nullable(),
  status: trainingItemStatus,
  proofDocumentId: uuid.nullable(),
  proofNote: z.string().nullable(),
  completedAt: z.string().nullable(),
})

export const trainingPlanView = z.object({
  id: uuid,
  employeeId: uuid,
  employeeName: z.string(),
  periodType: trainingPeriod,
  periodStart: isoDate,
  /** "September 2026" or "Q4 2026". */
  periodLabel: z.string(),
  status: trainingPlanStatus,
  submittedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  items: z.array(trainingItemView),
})

export type TrainingItemInput = z.infer<typeof trainingItemInput>
export type TrainingItemView = z.infer<typeof trainingItemView>
export type TrainingPlanView = z.infer<typeof trainingPlanView>
export type TrainingPeriod = z.infer<typeof trainingPeriod>
