/**
 * Summary and task extraction (meeting-assistant spec §5.3, §5.4).
 *
 * This is the only file in the pipeline that talks to a model. Everything
 * around it — normalising, redacting, chunking, resolving owners, persisting —
 * is pure and tested without spending a token, which is deliberate: the stages
 * that must be provably correct are the ones that are cheapest to verify.
 *
 * Three things here are load-bearing rather than incidental:
 *
 *   1. **Structured output, not parsed prose.** The response is constrained to
 *      the schema in `@quanti/shared`, so a malformed extraction is an API
 *      error rather than a half-populated meeting record.
 *   2. **The prompt argues against itself.** Over-extraction is the failure
 *      mode that erodes trust fastest, so the instructions spend more words on
 *      what not to produce than on what to produce.
 *   3. **Every call reports its cost.** Meeting volume varies enormously
 *      between customers and tokens are the variable cost driver (§11), so the
 *      figure is measured per meeting from day one rather than estimated later.
 */

import Anthropic from '@anthropic-ai/sdk'
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema'
import {
  ApiError,
  ERROR_CODES,
  chunkTranscript,
  renderSegments,
  schemas,
  type ExtractionOutput,
  type Transcript,
} from '@quanti/shared'
import { env } from './env.js'

/**
 * Per-million-token rates for the models this pipeline may run on.
 *
 * Kept here rather than fetched so a cost figure can be written inside the same
 * transaction as the summary. Stale rates make the telemetry wrong, not the
 * extraction, and the number is recorded alongside the model that produced it
 * so a rate change can be reapplied retrospectively.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
}

export interface ExtractionResult {
  output: ExtractionOutput
  model: string
  chunkCount: number
  usage: Usage
}

const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
}

/**
 * The instructions are mostly prohibitions, and that is the point.
 *
 * A model that invents a plausible action assigns work nobody agreed to, and
 * the host either dispatches it or stops trusting the feature. Both outcomes
 * are worse than an under-extracted summary, so the prompt is written to fail
 * in the direction of omission.
 */
const SYSTEM_PROMPT = `You extract meeting summaries and action items from transcripts.

You are given a speaker-labelled transcript of a workplace meeting. Produce a
summary and a list of action items, in the required output schema.

Rules, in order of importance:

1. Extract only what was actually said. Do not infer an action that nobody
   committed to. If the meeting produced no action items, return an empty list.
   An empty list is a correct answer and is far better than an invented task.

2. Do not assign an owner who was not named. Set owner_confidence to:
   - "explicit" when a person was named and took the task, or took it themselves
     ("I'll do X").
   - "implied" when the owner follows unambiguously from context, such as the
     only person who owns that area saying it will get done.
   - "unclear" when no owner can be determined. Leave owner_stated as an empty
     string. Do not guess, and do not default to the host.

3. Every action must carry a "quote": the verbatim line from the transcript
   where the commitment was made, copied exactly, including any timestamp-free
   wording. Never paraphrase into the quote field. If you cannot point at a
   line, the action does not belong in the list.

4. Speakers labelled like "unknown_1" have not been identified. Use that label
   as owner_stated only if the task is clearly theirs, and set owner_confidence
   to "unclear" so a person resolves it.

5. Dates: put the words spoken into due_stated ("Friday", "end of month"). Put
   a resolved calendar date into due_parsed only when it is unambiguous given
   the meeting date supplied below. Otherwise due_parsed is null.

6. Summarise neutrally. Record decisions and open questions as they were left,
   not as you would resolve them. Do not editorialise about people.

The transcript may contain Nigerian English, Pidgin, and code-switching between
them. Treat these as ordinary speech. Do not translate quotes, do not "correct"
grammar in a quote, and do not treat unfamiliar phrasing as a transcription
error to be smoothed over.`

let cached: Anthropic | null = null

export function anthropic(): Anthropic {
  if (cached) return cached
  const key = env().ANTHROPIC_API_KEY
  if (!key) {
    throw new ApiError(
      ERROR_CODES.MEETING_EXTRACTION_UNAVAILABLE,
      'Summarisation is not configured. Set ANTHROPIC_API_KEY to enable it.',
      503,
    )
  }
  cached = new Anthropic({ apiKey: key })
  return cached
}

/** Test hook — lets a suite inject a stub client so no suite makes a real call. */
export function setAnthropicClient(client: Anthropic | null): void {
  cached = client
}

export function extractionAvailable(): boolean {
  return Boolean(env().ANTHROPIC_API_KEY)
}

export interface ExtractContext {
  /** Display names by speaker id, so the model sees people rather than uuids. */
  speakerNames: Record<string, string>
  /** The meeting date, so relative deadlines can be resolved. */
  meetingDate: string
  title: string
}

/**
 * Runs the extraction over a redacted transcript.
 *
 * The transcript passed in must already have been through `redact` — this
 * function does not check, because a check that can be satisfied by a caller
 * passing the wrong object is not a safeguard. The pipeline is the single
 * caller and it redacts one stage earlier.
 */
export async function extractMeeting(
  transcript: Transcript,
  context: ExtractContext,
): Promise<ExtractionResult> {
  const model = env().MEETING_MODEL
  const chunks = chunkTranscript(transcript)

  if (chunks.length === 0) {
    throw new ApiError(
      ERROR_CODES.MEETING_NO_TRANSCRIPT,
      'There is nothing to summarise — the transcript is empty',
      422,
    )
  }

  const usage = { ...EMPTY_USAGE }

  // The common case is one chunk, and a chunked meeting must not produce a
  // different shape of result from an unchunked one — so the single-chunk path
  // is the same call, not a special case.
  if (chunks.length === 1) {
    const result = await callModel(
      model,
      buildUserPrompt(renderSegments(chunks[0]!.segments, context.speakerNames), context),
    )
    accumulate(usage, result.usage, model)
    return { output: result.output, model, chunkCount: 1, usage }
  }

  // Summarise each chunk, then summarise the summaries (§5.2 stage 5). Actions
  // are unioned rather than re-derived: a commitment made in chunk 2 is already
  // extracted with its quote, and asking a second pass to re-find it in a
  // summary of a summary is where quotes stop being verbatim.
  const partials: ExtractionOutput[] = []
  for (const chunk of chunks) {
    const result = await callModel(
      model,
      buildUserPrompt(renderSegments(chunk.segments, context.speakerNames), context, {
        index: chunk.index + 1,
        total: chunks.length,
      }),
    )
    accumulate(usage, result.usage, model)
    partials.push(result.output)
  }

  const merged = await mergeSummaries(model, partials, context, usage)
  return { output: merged, model, chunkCount: chunks.length, usage }
}

function buildUserPrompt(
  body: string,
  context: ExtractContext,
  chunk?: { index: number; total: number },
): string {
  const header = [
    `Meeting: ${context.title}`,
    `Date: ${context.meetingDate}`,
    chunk
      ? `This is part ${chunk.index} of ${chunk.total}. Some lines at the start ` +
        `repeat the end of the previous part; do not extract the same action twice.`
      : null,
  ]
    .filter(Boolean)
    .join('\n')

  return `${header}\n\nTranscript:\n${body}`
}

async function callModel(
  model: string,
  userPrompt: string,
): Promise<{ output: ExtractionOutput; usage: Anthropic.Usage }> {
  const response = await anthropic()
    .messages.parse({
      model,
      max_tokens: 16000,

      // Adaptive thinking is on by default for this model family and is left
      // on: deciding whether a sentence is a commitment or a musing is exactly
      // the judgement that benefits from it. Effort sits at medium because
      // extraction is high-volume and the top of the range does not pay for
      // itself here — see §11 on cost.
      output_config: {
        effort: 'medium',
        format: jsonSchemaOutputFormat(schemas.meetings.extractionJsonSchema),
      },

      // The system prompt is byte-stable across every chunk and every meeting,
      // so it is worth a cache breakpoint: a chunked one-hour meeting reads it
      // once and pays a tenth of the rate for the rest.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
    })
    .catch((error: unknown) => {
      throw translate(error)
    })

  // A policy decline arrives as a 200 with no usable content, so it has to be
  // checked before the output is read.
  if (response.stop_reason === 'refusal') {
    throw new ApiError(
      ERROR_CODES.MEETING_EXTRACTION_UNAVAILABLE,
      'The summariser declined to process this transcript. A person will need to review it.',
      422,
      { category: response.stop_details?.category ?? null },
    )
  }

  if (response.stop_reason === 'max_tokens') {
    throw new ApiError(
      ERROR_CODES.MEETING_EXTRACTION_UNAVAILABLE,
      'The summary was cut off before it finished. Try again.',
      502,
    )
  }

  if (!response.parsed_output) {
    throw new ApiError(
      ERROR_CODES.MEETING_EXTRACTION_UNAVAILABLE,
      'The summariser returned a response that did not match the expected shape',
      502,
    )
  }

  // Structured output constrains the shape; this checks the meaning — enum
  // membership, integer timestamps, and the date normalisation that turns
  // "next Friday" into null rather than into a bad due date.
  const parsed = schemas.meetings.extractionOutput.safeParse(response.parsed_output)
  if (!parsed.success) {
    throw new ApiError(
      ERROR_CODES.MEETING_EXTRACTION_UNAVAILABLE,
      'The summariser returned a response that failed validation',
      502,
      { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
    )
  }

  return { output: parsed.data, usage: response.usage }
}

/**
 * Second pass over per-chunk summaries.
 *
 * Only the narrative is re-summarised. Actions carry verbatim quotes from the
 * original transcript and are passed through untouched, because a quote that
 * has been through a second model call is no longer a quote.
 */
async function mergeSummaries(
  model: string,
  partials: ExtractionOutput[],
  context: ExtractContext,
  usage: Usage,
): Promise<ExtractionOutput> {
  const rendered = partials
    .map((p, i) => {
      const decisions = p.summary.decisions.map((d) => `- ${d.decision}`).join('\n')
      const topics = p.summary.topics
        .map((t) => `- ${t.topic}: ${t.points.join('; ')}`)
        .join('\n')
      const questions = p.summary.open_questions.map((q) => `- ${q}`).join('\n')
      return [
        `Part ${i + 1}:`,
        p.summary.overview,
        decisions && `Decisions:\n${decisions}`,
        topics && `Topics:\n${topics}`,
        questions && `Open questions:\n${questions}`,
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n')

  const prompt =
    `Meeting: ${context.title}\nDate: ${context.meetingDate}\n\n` +
    `Below are summaries of consecutive parts of one meeting. Combine them into ` +
    `a single summary covering the whole meeting. Merge duplicate decisions and ` +
    `topics that appear in more than one part. Do not invent anything that is ` +
    `not in the parts. Return an empty actions list — the actions are handled ` +
    `separately and must not be re-derived here.\n\n${rendered}`

  const result = await callModel(model, prompt)
  accumulate(usage, result.usage, model)

  return {
    summary: result.output.summary,
    actions: dedupeActions(partials.flatMap((p) => p.actions)),
  }
}

/**
 * Removes the double-extraction the chunk overlap can cause.
 *
 * Matching on the quote rather than the description, because the same
 * commitment summarised twice produces two descriptions but one quoted line.
 */
function dedupeActions(actions: ExtractionOutput['actions']): ExtractionOutput['actions'] {
  const seen = new Set<string>()
  const out: ExtractionOutput['actions'] = []
  for (const action of actions) {
    const key = action.quote.trim().toLowerCase().replace(/\s+/g, ' ')
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    out.push(action)
  }
  return out
}

function accumulate(total: Usage, usage: Anthropic.Usage, model: string): void {
  const input = usage.input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0

  total.inputTokens += input
  total.outputTokens += output
  total.cacheReadTokens += cacheRead
  total.cacheWriteTokens += cacheWrite
  total.costUsd += costOf(model, { input, output, cacheRead, cacheWrite })
}

/** Cache reads bill at a tenth of the input rate, writes at 1.25x. */
export function costOf(
  model: string,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
  const rate = PRICING[model]
  if (!rate) return 0
  const perToken = (n: number, rateUsdPerMillion: number) => (n / 1_000_000) * rateUsdPerMillion
  return (
    perToken(tokens.input, rate.input) +
    perToken(tokens.output, rate.output) +
    perToken(tokens.cacheRead, rate.input * 0.1) +
    perToken(tokens.cacheWrite, rate.input * 1.25)
  )
}

/**
 * Maps SDK errors onto the API's own codes.
 *
 * Rate limits and upstream faults are transient and the job retries them; a bad
 * request is ours and must not be retried forever.
 */
function translate(error: unknown): ApiError {
  if (error instanceof ApiError) return error

  if (error instanceof Anthropic.AuthenticationError) {
    return new ApiError(
      ERROR_CODES.MEETING_EXTRACTION_UNAVAILABLE,
      'The summariser rejected our credentials',
      503,
    )
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ApiError(
      ERROR_CODES.MEETING_EXTRACTION_UNAVAILABLE,
      'The summariser is rate limited; this meeting will be retried',
      429,
    )
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new ApiError(
      ERROR_CODES.MEETING_EXTRACTION_UNAVAILABLE,
      `The summariser rejected the request: ${error.message}`,
      500,
    )
  }
  if (error instanceof Anthropic.APIError) {
    return new ApiError(
      ERROR_CODES.MEETING_EXTRACTION_UNAVAILABLE,
      'The summariser is unavailable; this meeting will be retried',
      502,
    )
  }

  return new ApiError(
    ERROR_CODES.MEETING_EXTRACTION_UNAVAILABLE,
    'The summariser could not be reached',
    502,
  )
}
