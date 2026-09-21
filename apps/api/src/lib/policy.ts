/**
 * The policy corpus and the assistant that answers from it.
 *
 * Three rules from the product spec (§5.6), and how each is met here:
 *
 *   1. **Every answer cites the clause it came from.** The output schema
 *      requires a citation per claim, each one a verbatim excerpt from a named
 *      document. An answer with no citations is the "I don't know" answer.
 *
 *   2. **The assistant says "I don't know" rather than improvising.** The
 *      prompt is mostly prohibitions, `answered: false` is a first-class
 *      result, and the screen renders it as a proper state rather than an
 *      error. The failure mode of this feature is an employee acting on an
 *      invented policy; the fastest route there is an assistant that answers.
 *
 *   3. **The corpus is isolated per organisation.** There is no shared index.
 *      An org's documents are loaded by org_id under RLS and placed whole into
 *      the prompt; another org's rows are not filtered out, they are never
 *      selected. That is a stronger guarantee than a metadata filter on a
 *      vector store, and it is why there is no vector store.
 *
 * **Why the whole corpus rather than retrieval.** A company handbook is tens of
 * thousands of tokens. With a 1M context and cached prefix pricing at roughly a
 * tenth of input rate, loading it whole is cheaper per question than most
 * people expect, gives better citation accuracy than chunked retrieval, and
 * removes an embeddings vendor from the stack entirely. Revisit only if a
 * customer arrives with a document set that genuinely does not fit.
 */

import Anthropic from '@anthropic-ai/sdk'
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema'
import { desc, eq } from 'drizzle-orm'
import mammoth from 'mammoth'
import { extractText, getDocumentProxy } from 'unpdf'
import { ApiError, ERROR_CODES, schemas, type PolicyAnswer } from '@quanti/shared'
import { policyDocuments } from '../db/schema.js'
import type { Tx } from '../db/client.js'
import { anthropic, costOf, extractionAvailable } from './anthropic.js'
import { env } from './env.js'

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export const ACCEPTED_MIME = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
  'text/markdown': 'md',
} as const

export type PolicyFormat = (typeof ACCEPTED_MIME)[keyof typeof ACCEPTED_MIME]

export function formatFor(mime: string, filename: string): PolicyFormat | null {
  const byMime = ACCEPTED_MIME[mime as keyof typeof ACCEPTED_MIME]
  if (byMime) return byMime
  // Browsers are inconsistent about MIME for .md and sometimes send
  // application/octet-stream for anything unusual. The extension is the
  // better signal for the text formats.
  const ext = filename.toLowerCase().split('.').pop()
  if (ext === 'pdf') return 'pdf'
  if (ext === 'docx') return 'docx'
  if (ext === 'txt') return 'txt'
  if (ext === 'md') return 'md'
  return null
}

/**
 * Plain text from an uploaded policy. Never throws on a bad document — an
 * empty string is the honest result, and the assistant treats an empty
 * document as one that says nothing, which is exactly right.
 */
export async function extractPolicyText(buffer: Buffer, format: PolicyFormat): Promise<string> {
  try {
    switch (format) {
      case 'pdf': {
        const pdf = await getDocumentProxy(new Uint8Array(buffer))
        const { text } = await extractText(pdf, { mergePages: true })
        return normalise(text)
      }
      case 'docx': {
        const { value } = await mammoth.extractRawText({ buffer })
        return normalise(value)
      }
      case 'txt':
      case 'md':
        return normalise(buffer.toString('utf8'))
    }
  } catch {
    return ''
  }
}

/** Collapses the whitespace PDFs leave behind without touching the wording. */
function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on what goes into one prompt. Roughly 150k tokens — well
 * inside the window, and past the point where a handbook stops being a
 * handbook. Hitting it means a customer has uploaded something other than
 * policies, and the right response is to say so rather than silently drop
 * the newest documents.
 */
export const CORPUS_CHAR_LIMIT = 600_000

export interface CorpusDocument {
  id: string
  title: string
  text: string
}

export async function loadCorpus(tx: Tx): Promise<CorpusDocument[]> {
  const rows = await tx
    .select({
      id: policyDocuments.id,
      title: policyDocuments.title,
      text: policyDocuments.bodyText,
    })
    .from(policyDocuments)
    .where(eq(policyDocuments.status, 'ready'))
    .orderBy(desc(policyDocuments.createdAt))

  return rows.filter((r) => r.text.length > 0)
}

/**
 * Renders the corpus for the prompt. Each document is fenced and titled so a
 * citation can name it, and the model is told the boundaries explicitly rather
 * than left to infer where one policy ends and the next begins.
 */
export function renderCorpus(docs: CorpusDocument[]): string {
  return docs
    .map(
      (d, i) =>
        `<document index="${i + 1}" title="${d.title.replace(/"/g, "'")}">\n${d.text}\n</document>`,
    )
    .join('\n\n')
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You answer employees' questions about their own company's HR policies.

You are given the company's policy documents in full. Answer ONLY from them.

Rules, in order of importance:

1. If the documents do not answer the question, say so. Set "answered" to
   false and explain in one sentence what the documents do not cover. Do not
   guess, do not draw on general knowledge of employment law or of what other
   companies do, and do not extrapolate from a related clause. An employee will
   act on what you say about their pay, their leave or their standing, and an
   invented answer is worse than none.

2. Every claim in your answer must be supported by a citation. A citation is
   the document's title and a short verbatim excerpt — the actual words from
   the document, not a paraphrase. If you cannot quote it, do not claim it.

3. Never state a figure that is not in the documents. If the handbook says
   "annual leave is 20 days" quote that; do not compute what that is per
   month unless the document does.

4. When a policy has conditions — notice periods, eligibility, exceptions —
   include them. A correct answer that omits the condition that applies to
   this person is a wrong answer.

5. Do not offer opinions on whether a policy is fair, legal or typical. If
   asked, say that is a question for HR.

6. Plain, direct language. Address the employee as "you". No preamble.`

/** Same switch as the meeting summariser: one key gates every model call. */
export const extractionAvailableForPolicy = extractionAvailable

export interface AnswerResult {
  answer: PolicyAnswer
  model: string
  costUsd: number
  cacheHit: boolean
}

export async function answerFromCorpus(
  question: string,
  docs: CorpusDocument[],
): Promise<AnswerResult | null> {
  if (!extractionAvailable()) return null

  const corpus = renderCorpus(docs)
  if (corpus.length > CORPUS_CHAR_LIMIT) {
    throw new ApiError(
      ERROR_CODES.VALIDATION_FAILED,
      'The policy library is too large to search at once. Ask HR to remove documents that are not policies.',
      413,
    )
  }

  const model = env().MEETING_MODEL

  const response = await anthropic()
    .messages.parse({
      model,
      max_tokens: 4000,
      output_config: {
        effort: 'medium',
        format: jsonSchemaOutputFormat(schemas.policy.policyAnswerJsonSchema),
      },
      // Two cached blocks. The rules never change, so they are one block that
      // every org shares; the corpus changes per org and when a document is
      // uploaded, so it is a second block that caches per org. The question
      // is the only thing outside the cached prefix.
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        {
          type: 'text',
          text: `The company's policy documents:\n\n${corpus}`,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: question }],
    })
    .catch((error: unknown) => {
      if (error instanceof Anthropic.APIError) {
        throw new ApiError(
          ERROR_CODES.MEETING_EXTRACTION_UNAVAILABLE,
          'The assistant is unavailable right now. Ask HR directly for the time being.',
          502,
        )
      }
      throw error
    })

  if (response.stop_reason === 'refusal' || !response.parsed_output) return null

  const parsed = schemas.policy.policyAnswer.safeParse(response.parsed_output)
  if (!parsed.success) return null

  // Belt and braces on rule 2: an answer that claims to have answered but
  // cites nothing is downgraded to "not answered" before it reaches anyone.
  const answer =
    parsed.data.answered && parsed.data.citations.length === 0
      ? { ...parsed.data, answered: false }
      : parsed.data

  const usage = response.usage
  return {
    answer,
    model,
    costUsd: costOf(model, {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    }),
    cacheHit: (usage.cache_read_input_tokens ?? 0) > 0,
  }
}
