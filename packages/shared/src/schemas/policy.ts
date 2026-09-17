import { z } from 'zod'
import { isoInstant, uuid } from './common.js'

/**
 * The self-service assistant's contract.
 *
 * `answered: false` is a first-class result, not an error. The product spec's
 * non-negotiable is that the assistant says "I don't know" rather than
 * improvise, and an API whose only way to express that is a 4xx would push
 * every client towards rendering it as a failure.
 */

export const policyCitation = z.object({
  document: z.string().describe('The title of the document the excerpt is from.'),
  excerpt: z
    .string()
    .describe('A short verbatim passage from that document that supports the claim.'),
})

export const policyAnswer = z.object({
  answered: z
    .boolean()
    .describe('false when the documents do not cover the question.'),
  answer: z
    .string()
    .describe('The answer, or when not answered, one sentence on what the documents do not cover.'),
  citations: z.array(policyCitation),
})

export type PolicyAnswer = z.infer<typeof policyAnswer>

export const policyAnswerJsonSchema = {
  type: 'object',
  properties: {
    answered: { type: 'boolean' },
    answer: { type: 'string' },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          document: { type: 'string' },
          excerpt: { type: 'string', description: 'Verbatim text from the document.' },
        },
        required: ['document', 'excerpt'],
        additionalProperties: false,
      },
    },
  },
  required: ['answered', 'answer', 'citations'],
  additionalProperties: false,
} as const

export const askRequest = z.object({
  question: z.string().min(3).max(1000),
})

export const askResponse = z.object({
  answered: z.boolean(),
  answer: z.string(),
  citations: z.array(policyCitation),
  /** How many documents were consulted. Zero means "nothing uploaded yet". */
  documentsConsulted: z.number().int(),
  /** `null` when the assistant is unconfigured on this deployment. */
  model: z.string().nullable(),
  answeredAt: isoInstant,
})

export type AskResponse = z.infer<typeof askResponse>

export const uploadPolicy = z.object({
  title: z.string().min(1).max(200),
  filename: z.string().min(1).max(255),
  mimeType: z.string().max(120),
  contentBase64: z.string().min(1),
})

export const policyDocumentView = z.object({
  id: uuid,
  title: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  charCount: z.number().int(),
  status: z.enum(['ready', 'empty']),
  createdAt: isoInstant,
})

export type PolicyDocumentView = z.infer<typeof policyDocumentView>
