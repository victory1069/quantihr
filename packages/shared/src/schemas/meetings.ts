import { z } from 'zod'
import { isISODate } from '../domain/dates.js'
import { isoDate, isoInstant, uuid } from './common.js'

/**
 * Meeting assistant schemas.
 *
 * Two naming conventions live in this file on purpose. The extraction schema is
 * snake_case because it is the model's output contract and is quoted verbatim
 * from spec §5.3 — renaming its fields would silently desynchronise the prompt,
 * the schema and the spec. Everything else is camelCase like the rest of the
 * API surface, and the pipeline maps between the two in one place.
 */

export const meetingSource = z.enum(['google_meet', 'in_person'])

export const meetingStatus = z.enum([
  /** Created from a calendar event; nothing has happened yet. */
  'scheduled',
  'in_progress',
  /** Capture finished, waiting for transcription or ingestion. */
  'processing',
  /** Summary and actions extracted, waiting on the host. */
  'awaiting_review',
  'ready',
  /** Scheduled, but no conference record ever appeared (§7.3). */
  'did_not_occur',
  'failed',
])

export const meetingAttendanceStatus = z.enum([
  'present',
  'late',
  'absent',
  'excused',
  'void',
])

export const inviteStatus = z.enum(['accepted', 'declined', 'tentative', 'needs_action'])

export const ownerConfidence = z.enum(['explicit', 'implied', 'unclear'])

// ---------------------------------------------------------------------------
// Extraction — the model's output contract (§5.3)
// ---------------------------------------------------------------------------

export const extractedDecision = z.object({
  decision: z.string().describe('The decision that was made, in one sentence.'),
  context: z.string().describe('Why it was made. Empty string if not stated.'),
  timestamp_ms: z.number().int().describe('Where in the meeting this was decided.'),
})

export const extractedTopic = z.object({
  topic: z.string(),
  points: z.array(z.string()),
})

export const extractedSummary = z.object({
  overview: z.string().describe('Two to three sentences. What this meeting was.'),
  decisions: z.array(extractedDecision),
  topics: z.array(extractedTopic),
  open_questions: z.array(z.string()).describe('Questions raised and left unanswered.'),
})

export const extractedAction = z.object({
  description: z.string().describe('The task, as a single imperative sentence.'),

  owner_stated: z
    .string()
    .describe('The name as spoken in the meeting. Empty string if nobody was named.'),

  /**
   * This field does real work in the review UI: explicit owners pre-fill,
   * implied owners pre-fill with a visible flag, and unclear owners present
   * empty with the quote shown. It is what makes host confirmation take
   * fifteen seconds instead of five minutes.
   */
  owner_confidence: ownerConfidence.describe(
    'explicit when someone was named and accepted; implied when it follows from ' +
      'context; unclear when no owner can be determined.',
  ),

  due_stated: z.string().describe('The deadline as spoken, e.g. "Friday". Empty if none.'),

  /**
   * Normalised rather than validated. A model is not a trusted client, and
   * rejecting an entire meeting's extraction because one deadline came back as
   * "next Friday" instead of a date would throw away the other nine actions.
   * Anything that is not a calendar date becomes null, and the host sees
   * `due_stated` with an empty date field.
   */
  due_parsed: z
    .string()
    .nullable()
    .transform((value) => (value && isISODate(value) ? value : null))
    .describe('due_stated resolved to a YYYY-MM-DD date, or null.'),

  /**
   * Non-negotiable. Every action carries the verbatim line it came from, so a
   * host who disagrees can see whether the model misread the room or whether
   * they misremember what they said — and so a hallucinated action is obvious
   * at a glance rather than after it has been dispatched.
   */
  quote: z
    .string()
    .describe('The verbatim line from the transcript where this was committed to.'),

  timestamp_ms: z.number().int(),
})

export const extractionOutput = z.object({
  summary: extractedSummary,
  actions: z.array(extractedAction),
})

export type ExtractionOutput = z.infer<typeof extractionOutput>
export type ExtractedAction = z.infer<typeof extractedAction>
export type ExtractedSummary = z.infer<typeof extractedSummary>

/**
 * The same contract as `extractionOutput`, expressed as JSON Schema.
 *
 * Two representations of one shape is a cost, and it is paid deliberately: the
 * model call constrains its output with this, and the response is then parsed
 * back through the Zod schema above. If the two ever drift, the Zod parse fails
 * loudly on the next extraction rather than quietly writing a half-populated
 * meeting record — which is the failure this duplication is buying protection
 * from, not the one it introduces.
 *
 * `additionalProperties: false` and exhaustive `required` lists are mandatory
 * for structured outputs.
 */
export const extractionJsonSchema = {
  type: 'object',
  properties: {
    summary: {
      type: 'object',
      properties: {
        overview: {
          type: 'string',
          description: 'Two to three sentences describing what this meeting was.',
        },
        decisions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              decision: { type: 'string' },
              context: { type: 'string' },
              timestamp_ms: { type: 'integer' },
            },
            required: ['decision', 'context', 'timestamp_ms'],
            additionalProperties: false,
          },
        },
        topics: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              topic: { type: 'string' },
              points: { type: 'array', items: { type: 'string' } },
            },
            required: ['topic', 'points'],
            additionalProperties: false,
          },
        },
        open_questions: { type: 'array', items: { type: 'string' } },
      },
      required: ['overview', 'decisions', 'topics', 'open_questions'],
      additionalProperties: false,
    },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          owner_stated: {
            type: 'string',
            description: 'The name as spoken. Empty string if nobody was named.',
          },
          owner_confidence: {
            type: 'string',
            enum: ['explicit', 'implied', 'unclear'],
          },
          due_stated: { type: 'string' },
          due_parsed: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'YYYY-MM-DD, or null when the deadline is not unambiguous.',
          },
          quote: {
            type: 'string',
            description: 'The verbatim transcript line this action came from.',
          },
          timestamp_ms: { type: 'integer' },
        },
        required: [
          'description',
          'owner_stated',
          'owner_confidence',
          'due_stated',
          'due_parsed',
          'quote',
          'timestamp_ms',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'actions'],
  additionalProperties: false,
} as const

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Meeting types carry the capture and routing policy.
 *
 * HR routing is per meeting type and never a global default (§8.3). A team
 * working candidly through a problem behaves differently when HR reads the
 * transcript, so making that visible and configurable produces better data than
 * making it silent and universal.
 */
export const upsertMeetingType = z.object({
  id: uuid.optional(),
  name: z.string().min(1),
  captureEnabled: z.boolean().default(true),
  routeToHr: z.boolean().default(false),
  attendanceTracked: z.boolean().default(true),
  retentionDays: z.number().int().min(1).max(3650).default(90),
})

export const meetingTypeView = upsertMeetingType.extend({ id: uuid })

/** Org-level attendance rules (§7.2). Grace defaults to 5 minutes. */
export const meetingSettings = z.object({
  graceMinutes: z.number().int().min(0).max(120).default(5),
  minimumDurationMinutes: z.number().int().min(0).max(120).default(5),
  hostLateToleranceMinutes: z.number().int().min(0).max(120).default(2),
  /** Days an employee has to dispute a meeting attendance record (§7.4). */
  disputeWindowDays: z.number().int().min(1).max(90).default(7),
  transcriptRetentionDays: z.number().int().min(1).max(3650).default(90),
})

export type MeetingSettings = z.infer<typeof meetingSettings>

export const DEFAULT_MEETING_SETTINGS: MeetingSettings = {
  graceMinutes: 5,
  minimumDurationMinutes: 5,
  hostLateToleranceMinutes: 2,
  disputeWindowDays: 7,
  transcriptRetentionDays: 90,
}

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

export const meetingListQuery = z.object({
  /** `upcoming` for the schedule, `past` for the archive. */
  window: z.enum(['upcoming', 'past']).default('past'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export const meetingListItem = z.object({
  id: uuid,
  title: z.string(),
  source: meetingSource,
  status: meetingStatus,
  scheduledStart: isoInstant,
  scheduledEnd: isoInstant,
  actualStart: isoInstant.nullable(),
  hostEmployeeId: uuid.nullable(),
  isHost: z.boolean(),
  /** Set when this meeting is waiting on the viewer to review it. */
  awaitingYourReview: z.boolean(),
  routeToHr: z.boolean(),
  participantCount: z.number().int(),
  actionCount: z.number().int(),
})

export const meetingParticipantView = z.object({
  employeeId: uuid,
  employeeName: z.string(),
  attendanceStatus: meetingAttendanceStatus.nullable(),
  minutesLate: z.number().int(),
  inviteStatus,
  isOptional: z.boolean(),
  firstJoinAt: isoInstant.nullable(),
  totalDurationSeconds: z.number().int(),
  source: meetingSource.nullable(),
  expected: z.boolean(),
})

export const meetingActionView = z.object({
  id: uuid,
  description: z.string(),
  ownerEmployeeId: uuid.nullable(),
  ownerName: z.string().nullable(),
  ownerStated: z.string().nullable(),
  ownerConfidence,
  dueDate: isoDate.nullable(),
  sourceQuote: z.string(),
  timestampMs: z.number().int(),
  status: z.enum(['draft', 'confirmed', 'dismissed', 'done']),
})

export const meetingSummaryView = z.object({
  overview: z.string(),
  decisions: z.array(extractedDecision),
  topics: z.array(extractedTopic),
  openQuestions: z.array(z.string()),
  model: z.string(),
  tokensUsed: z.number().int(),
  generatedAt: isoInstant,
})

export const meetingDetail = z.object({
  id: uuid,
  title: z.string(),
  source: meetingSource,
  status: meetingStatus,
  scheduledStart: isoInstant,
  scheduledEnd: isoInstant,
  actualStart: isoInstant.nullable(),
  actualEnd: isoInstant.nullable(),
  hostEmployeeId: uuid.nullable(),
  isHost: z.boolean(),
  routeToHr: z.boolean(),
  meetingTypeName: z.string().nullable(),
  /** `null` until the pipeline has run. */
  summary: meetingSummaryView.nullable(),
  participants: z.array(meetingParticipantView),
  actions: z.array(meetingActionView),
  /** Diarised labels still waiting to be tagged (§6). */
  unresolvedSpeakers: z.array(z.string()),
  /** How the attendance set resolved, for the explanation shown on the record. */
  attendanceResolution: z
    .enum(['did_not_occur', 'too_short', 'recorded'])
    .nullable(),
})

/**
 * Host review (§9, §5.3).
 *
 * The host confirms the set in one call rather than per action, because the
 * target is fifteen seconds for a typical meeting and a round trip per row does
 * not fit inside that.
 */
export const reviewDecision = z.object({
  actionId: uuid,
  decision: z.enum(['confirm', 'dismiss']),
  /** Edits applied on confirm. Absent fields keep the extracted value. */
  description: z.string().min(1).optional(),
  ownerEmployeeId: uuid.nullable().optional(),
  dueDate: isoDate.nullable().optional(),
})

export const submitReview = z.object({
  decisions: z.array(reviewDecision),
  /**
   * Whether the summary text itself was edited. Open decision 3 in the spec is
   * resolved conservatively: the host may edit actions freely, and may edit the
   * summary only while it has not been routed to HR, because a record HR has
   * already received should not change underneath them.
   */
  overview: z.string().optional(),
})

export const speakerTagging = z.object({
  mappings: z.array(
    z.object({
      speakerLabel: z.string().min(1),
      employeeId: uuid.nullable(),
    }),
  ),
})

export const speakerClip = z.object({
  speakerLabel: z.string(),
  startMs: z.number().int(),
  endMs: z.number().int(),
  text: z.string(),
  /** Employee already mapped to this label, if any. */
  employeeId: uuid.nullable(),
})

export const createMeeting = z.object({
  title: z.string().min(1),
  meetingTypeId: uuid.nullable().optional(),
  scheduledStart: isoInstant,
  scheduledEnd: isoInstant,
  locationId: uuid.nullable().optional(),
  /** Employee ids expected to attend. */
  inviteeIds: z.array(uuid).default([]),
})

export const meetingDispute = z.object({
  reason: z.string().min(1).max(2000),
})

export const resolveDispute = z.object({
  outcome: z.enum(['upheld', 'rejected']),
  note: z.string().max(2000).optional(),
  /** Correction applied when the dispute is upheld. */
  attendanceStatus: meetingAttendanceStatus.optional(),
})

export const roomCheckIn = z.object({
  /** Reuses the office check-in code mechanism (§3.1). */
  code: z.string().min(4),
})

export const offRecordFlag = z.object({
  /** Milliseconds from the start of the recording. */
  atMs: z.number().int().min(0),
})

export const recordingChunk = z.object({
  sequence: z.number().int().min(0),
  /** Base64 audio. Chunked every 60s so a dropped connection loses one minute. */
  audio: z.string().min(1),
  contentType: z.string().default('audio/m4a'),
  durationMs: z.number().int().min(0),
})

/**
 * The caller's own attendance across meetings, one source at a time.
 *
 * Split by source because the Attendance tab presents physical and virtual
 * meetings separately: they are gathered by completely different mechanisms —
 * a room code versus a conference record — and they fail in different ways, so
 * mixing them into one list would make a gap impossible to interpret.
 */
export const myMeetingAttendanceQuery = z.object({
  source: meetingSource,
  from: isoDate.optional(),
  to: isoDate.optional(),
})

export const myMeetingAttendanceRow = z.object({
  meetingId: uuid,
  title: z.string(),
  source: meetingSource,
  scheduledStart: isoInstant,
  actualStart: isoInstant.nullable(),
  attendanceStatus: meetingAttendanceStatus.nullable(),
  minutesLate: z.number().int(),
  firstJoinAt: isoInstant.nullable(),
  totalDurationSeconds: z.number().int(),
  /** Carried so the row can explain itself when nothing was recorded. */
  resolution: z.enum(['did_not_occur', 'too_short', 'recorded']).nullable(),
  expected: z.boolean(),
})

export const myMeetingAttendanceResponse = z.object({
  records: z.array(myMeetingAttendanceRow),
  attended: z.number().int(),
  late: z.number().int(),
  missed: z.number().int(),
  totalMinutesLate: z.number().int(),
})

export const myActionsQuery = z.object({
  status: z.enum(['open', 'done', 'all']).default('open'),
})

export const myActionItem = meetingActionView.extend({
  meetingId: uuid,
  meetingTitle: z.string(),
  meetingDate: isoInstant,
})

/**
 * Workspace eligibility (§2.3).
 *
 * Path A is unavailable on Business Starter, and silently failing for those
 * customers is worse than telling them at onboarding, so this is a first-class
 * response rather than an error.
 */
export const meetEligibility = z.object({
  eligible: z.boolean(),
  edition: z.string().nullable(),
  reasons: z.array(z.string()),
  transcriptionEnabled: z.boolean().nullable(),
})

export type MeetingListItem = z.infer<typeof meetingListItem>
export type MeetingDetail = z.infer<typeof meetingDetail>
export type MeetingActionView = z.infer<typeof meetingActionView>
export type MeetingParticipantView = z.infer<typeof meetingParticipantView>
export type MeetingSummaryView = z.infer<typeof meetingSummaryView>
export type MyActionItem = z.infer<typeof myActionItem>
export type SubmitReview = z.infer<typeof submitReview>
export type SpeakerClip = z.infer<typeof speakerClip>
export type MeetingTypeView = z.infer<typeof meetingTypeView>
export type MeetEligibility = z.infer<typeof meetEligibility>
