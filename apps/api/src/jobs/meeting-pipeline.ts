/**
 * The meeting processing pipeline (meeting-assistant spec §5.2).
 *
 * Nine stages: ingest, normalise, resolve speakers, redact, chunk, extract,
 * resolve owners, persist, notify. Only chunk/extract touch a model, and they
 * live in `lib/anthropic.ts`; everything here is orchestration and can be run
 * end to end against the fake Meet driver without a single token being spent.
 *
 * The pipeline never dispatches anything. It writes actions as `draft` and
 * tells the host, because host confirmation before dispatch is the thing
 * standing between an over-extracted action and work nobody agreed to (§13).
 */

import { and, eq, gte, inArray, isNull, lte } from 'drizzle-orm'
import {
  DEFAULT_MEETING_SETTINGS,
  allSpeakersResolved,
  redact,
  resolveAttendance,
  unknownSpeaker,
  type Invitee,
  type InviteStatus,
  type MeetingSettings,
  type ParticipantSession,
  type Transcript,
  type TranscriptSegment,
} from '@quanti/shared'
import {
  employees,
  leaveRequests,
  meetingActions,
  meetingParticipants,
  meetingSummaries,
  meetingTranscripts,
  meetings,
  organisations,
  speakerMappings,
} from '../db/schema.js'
import type { Database, Tx } from '../db/client.js'
import { extractMeeting, extractionAvailable } from '../lib/anthropic.js'
import { env } from '../lib/env.js'
import { meet, type MeetTranscriptEntry } from '../lib/meet.js'
import { queueNotification } from '../lib/notify.js'
import { storage } from '../lib/storage.js'

export interface PipelineOutcome {
  meetingId: string
  status: string
  /** `null` when the meeting produced no attendance records at all. */
  attendanceResolution: string | null
  participantsWritten: number
  actionsExtracted: number
  costUsd: number
  note?: string
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function meetingSettingsFor(orgSettings: unknown): MeetingSettings {
  const raw = (orgSettings as { meetings?: Partial<MeetingSettings> } | null)?.meetings
  return { ...DEFAULT_MEETING_SETTINGS, ...(raw ?? {}) }
}

// ---------------------------------------------------------------------------
// Stage 1–2: ingest and normalise
// ---------------------------------------------------------------------------

/**
 * Pulls a Google Meet conference into our own shape.
 *
 * Attendance is resolved here rather than at read time and the outcome is
 * stored, so the record an employee disputes cannot change underneath the
 * dispute.
 */
export async function ingestConference(
  db: Database,
  orgId: string,
  meetingId: string,
): Promise<PipelineOutcome> {
  return db.withTenant(orgId, async (tx) => {
    const meeting = await loadMeeting(tx, meetingId)
    const settings = await loadSettings(tx)

    if (!meeting.googleConferenceRecordId) {
      throw new Error(`Meeting ${meetingId} has no conference record id to ingest`)
    }

    const driver = meet()
    const record = await driver.conferenceRecord(meeting.googleConferenceRecordId)

    // No conference record: the meeting did not happen. The attendance engine
    // makes the same call, but short-circuiting here also skips the transcript
    // fetch and the model call for something that never occurred.
    if (!record) {
      await tx
        .update(meetings)
        .set({
          status: 'did_not_occur',
          attendanceResolution: 'did_not_occur',
          ingestCompletedAt: new Date(),
        })
        .where(eq(meetings.id, meetingId))

      return {
        meetingId,
        status: 'did_not_occur',
        attendanceResolution: 'did_not_occur',
        participantsWritten: 0,
        actionsExtracted: 0,
        costUsd: 0,
        note: 'No conference record — no attendance records were produced',
      }
    }

    const sessions = await driver.participantSessions(meeting.googleConferenceRecordId)
    const roster = await loadRoster(tx)
    const byEmail = new Map(roster.map((e) => [e.email.toLowerCase(), e]))

    const participantSessions: ParticipantSession[] = []
    for (const session of sessions) {
      const employee = session.email ? byEmail.get(session.email.toLowerCase()) : undefined
      // An unmatched participant is a guest from outside the org. They are not
      // an employee and get no attendance record; dropping them here is the
      // only place that decision is made.
      if (!employee) continue
      participantSessions.push({
        employeeId: employee.id,
        joinedAt: session.joinedAt,
        leftAt: session.leftAt,
        source: 'google_meet',
      })
    }

    const invitees = await loadInvitees(tx, meetingId, record.startTime)

    const resolved = resolveAttendance({
      window: {
        scheduledStart: meeting.scheduledStart,
        scheduledEnd: meeting.scheduledEnd,
        actualStart: record.startTime,
        actualEnd: record.endTime,
      },
      invitees,
      sessions: participantSessions,
      rules: settings,
    })

    await writeAttendance(tx, orgId, meetingId, resolved.records)

    // Stage 2 — normalise. From here nothing downstream can tell which capture
    // path produced the transcript.
    const entries = await driver.transcriptEntries(meeting.googleConferenceRecordId)
    let transcriptWritten = false

    if (entries === null) {
      // Nobody started transcription. This is the single biggest adoption risk
      // in path A, so the host is told why there is no summary rather than
      // left to discover it (§2.3).
      await notifyHost(tx, orgId, meeting.hostEmployeeId, {
        event: 'meeting.transcription_missing',
        title: 'No transcript for that meeting',
        body: `"${meeting.title}" was not transcribed, so there is no summary. Turn on transcription when you start the next one.`,
        deepLink: `/meetings/${meetingId}`,
      })
    } else if (entries.length > 0) {
      const transcript = normaliseMeetEntries(meetingId, entries, byEmail)
      await persistTranscript(tx, orgId, meetingId, transcript, settings)
      transcriptWritten = true
    }

    const status = transcriptWritten ? 'processing' : 'ready'

    await tx
      .update(meetings)
      .set({
        actualStart: record.startTime,
        actualEnd: record.endTime,
        attendanceResolution: resolved.resolution,
        status,
        ingestCompletedAt: new Date(),
        ingestError: null,
      })
      .where(eq(meetings.id, meetingId))

    return {
      meetingId,
      status,
      attendanceResolution: resolved.resolution,
      participantsWritten: resolved.records.length,
      actionsExtracted: 0,
      costUsd: 0,
      ...(entries === null ? { note: 'Nobody started transcription' } : {}),
    }
  })
}

/**
 * Maps Meet transcript entries onto the normalised shape.
 *
 * Speaker resolution is trivial on this path — Google attributes every entry to
 * a participant, so confidence is 1 and there is nothing for a host to tag.
 * Someone Google could not resolve to an employee keeps a stable `unknown_n`
 * label so their lines are still summarised and their actions surface as
 * unassigned rather than vanishing.
 */
export function normaliseMeetEntries(
  meetingId: string,
  entries: MeetTranscriptEntry[],
  byEmail: Map<string, { id: string }>,
): Transcript {
  const unknowns = new Map<string, string>()

  const segments: TranscriptSegment[] = entries
    .filter((entry) => entry.text.trim().length > 0)
    .map((entry) => {
      const employee = entry.email ? byEmail.get(entry.email.toLowerCase()) : undefined
      let speakerId: string
      if (employee) {
        speakerId = employee.id
      } else {
        const key = entry.email ?? entry.displayName
        if (!unknowns.has(key)) unknowns.set(key, unknownSpeaker(unknowns.size + 1))
        speakerId = unknowns.get(key)!
      }

      return {
        speakerId,
        speakerConfidence: employee ? 1 : 0,
        startMs: entry.startMs,
        endMs: entry.endMs,
        text: entry.text.trim(),
        offRecord: false,
      }
    })

  const durationMs = segments.length > 0 ? segments[segments.length - 1]!.endMs : 0

  return {
    meetingId,
    source: 'google_meet',
    language: entries[0]?.languageCode ?? 'en',
    durationSeconds: Math.round(durationMs / 1000),
    segments,
  }
}

// ---------------------------------------------------------------------------
// Stage 4 & 8: persistence
// ---------------------------------------------------------------------------

/**
 * Writes the transcript, redacted.
 *
 * Redaction happens before the artifact is stored, not before it is read. An
 * off-record segment that reaches disk has already outlived its promise, and
 * §8.4 is explicit that off-record segments are never persisted.
 */
async function persistTranscript(
  tx: Tx,
  orgId: string,
  meetingId: string,
  transcript: Transcript,
  settings: MeetingSettings,
): Promise<void> {
  const clean = redact(transcript)
  const key = `${orgId}/meetings/${meetingId}/transcript.json`

  await storage().put(key, Buffer.from(JSON.stringify(clean), 'utf8'), 'application/json')

  const expiresAt = new Date(
    Date.now() + settings.transcriptRetentionDays * 24 * 60 * 60 * 1000,
  )

  await tx
    .insert(meetingTranscripts)
    .values({
      orgId,
      meetingId,
      language: clean.language,
      durationSeconds: clean.durationSeconds,
      segmentCount: clean.segments.length,
      s3Key: key,
      speakersResolved: allSpeakersResolved(clean),
      expiresAt,
    })
    .onConflictDoUpdate({
      target: meetingTranscripts.meetingId,
      set: {
        language: clean.language,
        durationSeconds: clean.durationSeconds,
        segmentCount: clean.segments.length,
        s3Key: key,
        speakersResolved: allSpeakersResolved(clean),
        expiresAt,
      },
    })

  await tx
    .update(meetings)
    .set({ transcriptS3Key: key })
    .where(eq(meetings.id, meetingId))
}

export async function loadTranscript(
  tx: Tx,
  meetingId: string,
): Promise<Transcript | null> {
  const [row] = await tx
    .select()
    .from(meetingTranscripts)
    .where(eq(meetingTranscripts.meetingId, meetingId))
    .limit(1)

  if (!row) return null
  const body = await storage().get(row.s3Key)
  return JSON.parse(body.toString('utf8')) as Transcript
}

async function writeAttendance(
  tx: Tx,
  orgId: string,
  meetingId: string,
  records: {
    employeeId: string
    status: string
    minutesLate: number
    firstJoinAt: Date | null
    lastLeaveAt: Date | null
    totalDurationSeconds: number
    source: string | null
    isOptional: boolean
    inviteStatus: string
    expected: boolean
  }[],
): Promise<void> {
  for (const record of records) {
    await tx
      .insert(meetingParticipants)
      .values({
        orgId,
        meetingId,
        employeeId: record.employeeId,
        inviteStatus: record.inviteStatus,
        isOptional: record.isOptional,
        expected: record.expected,
        firstJoinAt: record.firstJoinAt,
        lastLeaveAt: record.lastLeaveAt,
        totalDurationSeconds: record.totalDurationSeconds,
        attendanceStatus: record.status,
        minutesLate: record.minutesLate,
        source: record.source,
      })
      .onConflictDoUpdate({
        target: [meetingParticipants.meetingId, meetingParticipants.employeeId],
        set: {
          inviteStatus: record.inviteStatus,
          isOptional: record.isOptional,
          expected: record.expected,
          firstJoinAt: record.firstJoinAt,
          lastLeaveAt: record.lastLeaveAt,
          totalDurationSeconds: record.totalDurationSeconds,
          attendanceStatus: record.status,
          minutesLate: record.minutesLate,
          source: record.source,
        },
      })
  }
}

// ---------------------------------------------------------------------------
// Stage 3–9: summarise
// ---------------------------------------------------------------------------

/**
 * Runs redaction, extraction, owner resolution and persistence.
 *
 * Separate from ingestion so a transcript that arrives from either capture path
 * enters at the same point, and so a failed model call can be retried without
 * re-pulling the conference.
 */
export async function summariseMeeting(
  db: Database,
  orgId: string,
  meetingId: string,
): Promise<PipelineOutcome> {
  if (!extractionAvailable()) {
    return {
      meetingId,
      status: 'processing',
      attendanceResolution: null,
      participantsWritten: 0,
      actionsExtracted: 0,
      costUsd: 0,
      note: 'ANTHROPIC_API_KEY is not set — summarisation was skipped',
    }
  }

  const prepared = await db.withTenant(orgId, async (tx) => {
    const meeting = await loadMeeting(tx, meetingId)
    const transcript = await loadTranscript(tx, meetingId)
    if (!transcript) return null

    // Stage 3 — speaker resolution. Meet transcripts arrive resolved; in-person
    // ones carry whatever the host tagged, and anything untagged stays as an
    // `unknown_n` label the model is told not to guess at.
    const mappings = await tx
      .select()
      .from(speakerMappings)
      .where(eq(speakerMappings.meetingId, meetingId))

    const applied = mappings.reduce<Record<string, string>>((acc, m) => {
      if (m.employeeId) acc[m.diarisedSpeakerLabel] = m.employeeId
      return acc
    }, {})

    const roster = await loadRoster(tx)
    const names: Record<string, string> = {}
    for (const employee of roster) {
      names[employee.id] = `${employee.firstName} ${employee.lastName}`.trim()
    }
    for (const [label, employeeId] of Object.entries(applied)) {
      names[label] = names[employeeId] ?? label
    }

    return { meeting, transcript, names, roster }
  })

  if (!prepared) {
    return {
      meetingId,
      status: 'ready',
      attendanceResolution: null,
      participantsWritten: 0,
      actionsExtracted: 0,
      costUsd: 0,
      note: 'No transcript to summarise',
    }
  }

  // Stage 4 — redact. The stored transcript is already clean; running it again
  // costs nothing and means a transcript that arrived by another route cannot
  // skip the step.
  const clean = redact(prepared.transcript)

  const result = await extractMeeting(clean, {
    speakerNames: prepared.names,
    meetingDate: prepared.meeting.scheduledStart.toISOString().slice(0, 10),
    title: prepared.meeting.title,
  })

  return db.withTenant(orgId, async (tx) => {
    await tx
      .insert(meetingSummaries)
      .values({
        orgId,
        meetingId,
        overview: result.output.summary.overview,
        decisions: result.output.summary.decisions,
        topics: result.output.summary.topics,
        openQuestions: result.output.summary.open_questions,
        model: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        tokensUsed: result.usage.inputTokens + result.usage.outputTokens,
        costUsd: result.usage.costUsd.toFixed(6),
        chunkCount: result.chunkCount,
      })
      .onConflictDoUpdate({
        target: meetingSummaries.meetingId,
        set: {
          overview: result.output.summary.overview,
          decisions: result.output.summary.decisions,
          topics: result.output.summary.topics,
          openQuestions: result.output.summary.open_questions,
          model: result.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          tokensUsed: result.usage.inputTokens + result.usage.outputTokens,
          costUsd: result.usage.costUsd.toFixed(6),
          chunkCount: result.chunkCount,
          generatedAt: new Date(),
        },
      })

    // Re-running extraction replaces the drafts but never touches an action the
    // host already confirmed or dismissed — their decision outranks a rerun.
    await tx
      .delete(meetingActions)
      .where(
        and(eq(meetingActions.meetingId, meetingId), eq(meetingActions.status, 'draft')),
      )

    // Stage 7 — owner resolution.
    const attendees = await tx
      .select({
        id: meetingParticipants.employeeId,
        firstName: employees.firstName,
        lastName: employees.lastName,
      })
      .from(meetingParticipants)
      .innerJoin(employees, eq(employees.id, meetingParticipants.employeeId))
      .where(eq(meetingParticipants.meetingId, meetingId))

    for (const action of result.output.actions) {
      const ownerEmployeeId = resolveOwner(action.owner_stated, attendees)
      await tx.insert(meetingActions).values({
        orgId,
        meetingId,
        description: action.description,
        ownerEmployeeId,
        ownerStated: action.owner_stated || null,
        // An owner the model named but we could not match to an attendee is
        // downgraded to unclear, so the review screen presents it empty with
        // the quote rather than pre-filling a person nobody can verify.
        ownerConfidence:
          action.owner_confidence !== 'unclear' && !ownerEmployeeId
            ? 'unclear'
            : action.owner_confidence,
        dueDate: action.due_parsed,
        sourceQuote: action.quote,
        timestampMs: action.timestamp_ms,
        status: 'draft',
      })
    }

    await tx
      .update(meetings)
      .set({ status: 'awaiting_review' })
      .where(eq(meetings.id, meetingId))

    const [meeting] = await tx
      .select({ hostEmployeeId: meetings.hostEmployeeId, title: meetings.title })
      .from(meetings)
      .where(eq(meetings.id, meetingId))
      .limit(1)

    // Stage 9 — notify. Nothing is dispatched until the host confirms.
    await notifyHost(tx, orgId, meeting?.hostEmployeeId ?? null, {
      event: 'meeting.review_ready',
      title: 'Meeting summary ready',
      body: `"${meeting?.title ?? 'Your meeting'}" has ${result.output.actions.length} action${
        result.output.actions.length === 1 ? '' : 's'
      } waiting for your review.`,
      deepLink: `/meetings/${meetingId}/review`,
    })

    return {
      meetingId,
      status: 'awaiting_review',
      attendanceResolution: null,
      participantsWritten: 0,
      actionsExtracted: result.output.actions.length,
      costUsd: result.usage.costUsd,
    }
  })
}

/**
 * Maps a spoken name onto an attendee.
 *
 * Constrained to people who were actually in the meeting, which is what makes
 * a first name enough. Anything ambiguous returns null rather than picking one
 * — assigning work to the wrong Chidi is worse than assigning it to nobody and
 * letting the host choose.
 */
export function resolveOwner(
  stated: string,
  attendees: { id: string; firstName: string; lastName: string }[],
): string | null {
  const needle = stated.trim().toLowerCase()
  if (!needle) return null

  const candidates = attendees.filter((a) => {
    const first = a.firstName.toLowerCase()
    const last = a.lastName.toLowerCase()
    const full = `${first} ${last}`
    return needle === first || needle === last || needle === full
  })

  return candidates.length === 1 ? candidates[0]!.id : null
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

export interface BackfillSummary {
  orgId: string
  ingested: number
  failed: number
  /** Meetings past the alert threshold with no transcript. These get loud. */
  expiring: { meetingId: string; title: string; daysOld: number }[]
}

/**
 * Catches conferences the webhook missed, inside the 30-day window (§2.4).
 *
 * Ingestion is event-driven; this exists because a dropped webhook is silent
 * and the structured transcript entries are deleted 30 days after the
 * conference ends. Anything still un-ingested at the alert threshold is
 * reported rather than left to expire quietly.
 */
export async function backfillMeetTranscripts(
  db: Database,
  orgId: string,
  now: Date = new Date(),
): Promise<BackfillSummary> {
  const windowDays = env().MEET_TRANSCRIPT_WINDOW_DAYS
  const alertDays = env().MEET_TRANSCRIPT_ALERT_DAYS
  const dayMs = 24 * 60 * 60 * 1000
  const windowStart = new Date(now.getTime() - windowDays * dayMs)

  const pending = await db.withTenant(orgId, async (tx) =>
    tx
      .select({
        id: meetings.id,
        title: meetings.title,
        scheduledStart: meetings.scheduledStart,
        conferenceId: meetings.googleConferenceRecordId,
      })
      .from(meetings)
      .where(
        and(
          isNull(meetings.ingestCompletedAt),
          gte(meetings.scheduledStart, windowStart),
          lte(meetings.scheduledStart, now),
          eq(meetings.source, 'google_meet'),
        ),
      ),
  )

  const summary: BackfillSummary = { orgId, ingested: 0, failed: 0, expiring: [] }

  for (const row of pending) {
    const daysOld = Math.floor((now.getTime() - row.scheduledStart.getTime()) / dayMs)

    if (!row.conferenceId) {
      // Scheduled, never happened, never will. Not a failure.
      continue
    }

    try {
      await ingestConference(db, orgId, row.id)
      summary.ingested += 1
    } catch (error) {
      summary.failed += 1
      await db.withTenant(orgId, async (tx) => {
        await tx
          .update(meetings)
          .set({ ingestError: error instanceof Error ? error.message : String(error) })
          .where(eq(meetings.id, row.id))
      })
    }

    if (daysOld >= alertDays) {
      summary.expiring.push({ meetingId: row.id, title: row.title, daysOld })
    }
  }

  return summary
}

/**
 * Deletes transcripts past their retention date (§8.4).
 *
 * Summaries and confirmed actions are business records and survive; the
 * transcript is the sensitive artifact and it is the one that goes.
 */
export async function enforceTranscriptRetention(
  db: Database,
  orgId: string,
  now: Date = new Date(),
): Promise<number> {
  return db.withTenant(orgId, async (tx) => {
    const expired = await tx
      .select({ id: meetingTranscripts.id, meetingId: meetingTranscripts.meetingId })
      .from(meetingTranscripts)
      .where(lte(meetingTranscripts.expiresAt, now))

    for (const row of expired) {
      await tx.delete(meetingTranscripts).where(eq(meetingTranscripts.id, row.id))
      await tx
        .update(meetings)
        .set({ transcriptS3Key: null })
        .where(eq(meetings.id, row.meetingId))
    }

    return expired.length
  })
}

// ---------------------------------------------------------------------------
// Shared loaders
// ---------------------------------------------------------------------------

async function loadMeeting(tx: Tx, meetingId: string) {
  const [row] = await tx.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1)
  if (!row) throw new Error(`Meeting ${meetingId} not found`)
  return row
}

async function loadSettings(tx: Tx): Promise<MeetingSettings> {
  const [org] = await tx.select({ settings: organisations.settings }).from(organisations).limit(1)
  return meetingSettingsFor(org?.settings ?? null)
}

async function loadRoster(tx: Tx) {
  return tx
    .select({
      id: employees.id,
      email: employees.email,
      firstName: employees.firstName,
      lastName: employees.lastName,
    })
    .from(employees)
}

/**
 * Builds the expected-attendance set (§7.1).
 *
 * Approved leave is looked up against the day the conference actually ran, so
 * someone whose leave was approved after the invite went out is still excused
 * rather than absent.
 */
async function loadInvitees(
  tx: Tx,
  meetingId: string,
  on: Date,
): Promise<Invitee[]> {
  const rows = await tx
    .select({
      employeeId: meetingParticipants.employeeId,
      inviteStatus: meetingParticipants.inviteStatus,
      isOptional: meetingParticipants.isOptional,
    })
    .from(meetingParticipants)
    .where(eq(meetingParticipants.meetingId, meetingId))

  if (rows.length === 0) return []

  const date = on.toISOString().slice(0, 10)
  const onLeave = await tx
    .select({ employeeId: leaveRequests.employeeId })
    .from(leaveRequests)
    .where(
      and(
        inArray(
          leaveRequests.employeeId,
          rows.map((r) => r.employeeId),
        ),
        eq(leaveRequests.status, 'approved'),
        lte(leaveRequests.startDate, date),
        gte(leaveRequests.endDate, date),
      ),
    )

  const excused = new Set(onLeave.map((r) => r.employeeId))

  return rows.map((row) => ({
    employeeId: row.employeeId,
    inviteStatus: row.inviteStatus as InviteStatus,
    isOptional: row.isOptional,
    onApprovedLeave: excused.has(row.employeeId),
  }))
}

async function notifyHost(
  tx: Tx,
  orgId: string,
  hostEmployeeId: string | null,
  message: {
    event: 'meeting.review_ready' | 'meeting.transcription_missing'
    title: string
    body: string
    deepLink: string
  },
): Promise<void> {
  if (!hostEmployeeId) return

  const [host] = await tx
    .select({ userId: employees.userId })
    .from(employees)
    .where(eq(employees.id, hostEmployeeId))
    .limit(1)

  if (!host?.userId) return

  await queueNotification(tx, {
    orgId,
    userId: host.userId,
    event: message.event,
    title: message.title,
    body: message.body,
    deepLink: message.deepLink,
  })
}

/** Convenience for the webhook path: ingest, then summarise if there is one. */
export async function processMeeting(
  db: Database,
  orgId: string,
  meetingId: string,
): Promise<PipelineOutcome> {
  const ingested = await ingestConference(db, orgId, meetingId)
  if (ingested.status !== 'processing') return ingested

  const summarised = await summariseMeeting(db, orgId, meetingId)
  return { ...ingested, ...summarised, participantsWritten: ingested.participantsWritten }
}
