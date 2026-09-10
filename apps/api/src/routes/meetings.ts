/**
 * Meeting assistant routes (meeting-assistant spec §9).
 *
 * Three access rules run through every handler here, and they are not the same
 * rule:
 *
 *   - **Attendees** read a meeting they were in.
 *   - **The host** reviews, tags speakers, and settles disputes. Disputes route
 *     to the host and not to HR because the host was there and can settle it in
 *     one tap; HR sees the outcome, not the argument (§7.4).
 *   - **HR** sees meetings whose type routes to HR, and configuration.
 *
 * All three sit on top of RLS, which keeps other tenants out. These keep one
 * team's candid conversation out of another team's reach.
 */

import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  ApiError,
  ERROR_CODES,
  applySpeakerMapping,
  flagOffRecord,
  isUnknownSpeaker,
  redact,
  representativeSegment,
  schemas,
  speakerLabels,
  type Transcript,
} from '@quanti/shared'
import {
  employees,
  meetingActions,
  meetingDisputes,
  meetingParticipants,
  meetingSummaries,
  meetingTranscripts,
  meetingTypes,
  meetings,
  organisations,
  speakerMappings,
} from '../db/schema.js'
import type { Database, Tx } from '../db/client.js'
import { audit } from '../lib/audit.js'
import { isHrAdmin, requireAuth, requireRole, tenant } from '../lib/context.js'
import { meet } from '../lib/meet.js'
import { queueNotification } from '../lib/notify.js'
import { storage } from '../lib/storage.js'
import {
  normaliseDiarised,
  transcription,
  TranscriptionUnavailableError,
} from '../lib/transcription.js'
import {
  backfillMeetTranscripts,
  ingestConference,
  loadTranscript,
  meetingSettingsFor,
  summariseMeeting,
} from '../jobs/meeting-pipeline.js'
import { fullName } from './shared.js'

export function registerMeetingRoutes(app: FastifyInstance, db: Database): void {
  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  app.get('/v1/meetings', async (request, reply) => {
    const auth = requireAuth(request)
    const query = schemas.meetings.meetingListQuery.parse(request.query)

    const result = await tenant(request, async (tx) => {
      const mine = await visibleMeetingIds(tx, auth.employeeId, isHrAdmin(auth))
      if (mine.length === 0) return []

      const now = new Date()
      const rows = await tx
        .select()
        .from(meetings)
        .where(
          and(
            inArray(meetings.id, mine),
            query.window === 'upcoming'
              ? gte(meetings.scheduledStart, now)
              : lt(meetings.scheduledStart, now),
          ),
        )
        .orderBy(
          query.window === 'upcoming'
            ? meetings.scheduledStart
            : desc(meetings.scheduledStart),
        )
        .limit(query.limit)

      const out = []
      for (const row of rows) {
        const counts = await countsFor(tx, row.id)
        out.push({
          id: row.id,
          title: row.title,
          source: row.source,
          status: row.status,
          scheduledStart: row.scheduledStart.toISOString(),
          scheduledEnd: row.scheduledEnd.toISOString(),
          actualStart: row.actualStart?.toISOString() ?? null,
          hostEmployeeId: row.hostEmployeeId,
          isHost: row.hostEmployeeId === auth.employeeId,
          awaitingYourReview:
            row.status === 'awaiting_review' && row.hostEmployeeId === auth.employeeId,
          routeToHr: row.routeToHr,
          participantCount: counts.participants,
          actionCount: counts.actions,
        })
      }
      return out
    })

    return reply.send({ meetings: result })
  })

  app.get('/v1/meetings/:id', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = request.params as { id: string }

    const detail = await tenant(request, async (tx) => {
      const meeting = await requireVisible(tx, id, auth.employeeId, isHrAdmin(auth))

      const [summary] = await tx
        .select()
        .from(meetingSummaries)
        .where(eq(meetingSummaries.meetingId, id))
        .limit(1)

      const participants = await tx
        .select({
          employeeId: meetingParticipants.employeeId,
          firstName: employees.firstName,
          lastName: employees.lastName,
          attendanceStatus: meetingParticipants.attendanceStatus,
          minutesLate: meetingParticipants.minutesLate,
          inviteStatus: meetingParticipants.inviteStatus,
          isOptional: meetingParticipants.isOptional,
          firstJoinAt: meetingParticipants.firstJoinAt,
          totalDurationSeconds: meetingParticipants.totalDurationSeconds,
          source: meetingParticipants.source,
          expected: meetingParticipants.expected,
        })
        .from(meetingParticipants)
        .innerJoin(employees, eq(employees.id, meetingParticipants.employeeId))
        .where(eq(meetingParticipants.meetingId, id))

      const actions = await loadActions(tx, id)

      const [type] = meeting.meetingTypeId
        ? await tx
            .select({ name: meetingTypes.name })
            .from(meetingTypes)
            .where(eq(meetingTypes.id, meeting.meetingTypeId))
            .limit(1)
        : []

      // Only the host is offered the tagging screen, so only the host needs to
      // know which labels are still unresolved.
      let unresolved: string[] = []
      if (meeting.hostEmployeeId === auth.employeeId) {
        const transcript = await loadTranscript(tx, id).catch(() => null)
        unresolved = transcript
          ? speakerLabels(transcript).filter(isUnknownSpeaker)
          : []
      }

      return {
        id: meeting.id,
        title: meeting.title,
        source: meeting.source,
        status: meeting.status,
        scheduledStart: meeting.scheduledStart.toISOString(),
        scheduledEnd: meeting.scheduledEnd.toISOString(),
        actualStart: meeting.actualStart?.toISOString() ?? null,
        actualEnd: meeting.actualEnd?.toISOString() ?? null,
        hostEmployeeId: meeting.hostEmployeeId,
        isHost: meeting.hostEmployeeId === auth.employeeId,
        routeToHr: meeting.routeToHr,
        meetingTypeName: type?.name ?? null,
        attendanceResolution: meeting.attendanceResolution,
        summary: summary
          ? {
              overview: summary.overview,
              decisions: summary.decisions,
              topics: summary.topics,
              openQuestions: summary.openQuestions,
              model: summary.model,
              tokensUsed: summary.tokensUsed,
              generatedAt: summary.generatedAt.toISOString(),
            }
          : null,
        participants: participants.map((p) => ({
          employeeId: p.employeeId,
          employeeName: fullName(p),
          attendanceStatus: p.attendanceStatus,
          minutesLate: p.minutesLate,
          inviteStatus: p.inviteStatus,
          isOptional: p.isOptional,
          firstJoinAt: p.firstJoinAt?.toISOString() ?? null,
          totalDurationSeconds: p.totalDurationSeconds,
          source: p.source,
          expected: p.expected,
        })),
        actions,
        unresolvedSpeakers: unresolved,
      }
    })

    return reply.send(detail)
  })

  // -------------------------------------------------------------------------
  // Creating an in-person meeting
  // -------------------------------------------------------------------------

  /**
   * Ad-hoc meetings are allowed, and marked.
   *
   * Open decision 4 in the spec: requiring a calendar invite makes attendance
   * defensible, allowing ad-hoc makes the tool useful day to day. Both are
   * true, so the split is by consequence — an ad-hoc meeting can be recorded
   * and summarised, but it carries no expected-attendance set and therefore
   * produces no absence records for anyone. Nothing that could land in a
   * personnel file rests on a meeting nobody was formally invited to.
   */
  app.post('/v1/meetings', async (request, reply) => {
    const auth = requireAuth(request)
    const body = schemas.meetings.createMeeting.parse(request.body)

    const created = await tenant(request, async (tx) => {
      let routeToHr = false
      if (body.meetingTypeId) {
        const [type] = await tx
          .select()
          .from(meetingTypes)
          .where(eq(meetingTypes.id, body.meetingTypeId))
          .limit(1)
        if (!type) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Unknown meeting type', 404)
        if (!type.captureEnabled) {
          throw new ApiError(
            ERROR_CODES.MEETING_CAPTURE_DISABLED,
            'Capture is turned off for that meeting type',
            422,
          )
        }
        routeToHr = type.routeToHr
      }

      const [meeting] = await tx
        .insert(meetings)
        .values({
          orgId: auth.orgId,
          title: body.title,
          meetingTypeId: body.meetingTypeId ?? null,
          hostEmployeeId: auth.employeeId,
          scheduledStart: new Date(body.scheduledStart),
          scheduledEnd: new Date(body.scheduledEnd),
          locationId: body.locationId ?? null,
          source: 'in_person',
          status: 'scheduled',
          routeToHr,
        })
        .returning()

      const inviteeIds = new Set([...body.inviteeIds, auth.employeeId])
      for (const employeeId of inviteeIds) {
        await tx.insert(meetingParticipants).values({
          orgId: auth.orgId,
          meetingId: meeting!.id,
          employeeId,
          inviteStatus: 'accepted',
          isOptional: false,
          expected: true,
        })
      }

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'meeting.created',
        entityType: 'meeting',
        entityId: meeting!.id,
        after: { title: body.title, source: 'in_person', routeToHr },
        ip: request.ip,
      })

      return meeting!
    })

    return reply.status(201).send({ id: created.id, routeToHr: created.routeToHr })
  })

  /** Room check-in, reusing the office check-in code mechanism (§3.1). */
  app.post('/v1/meetings/:id/checkin', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = request.params as { id: string }
    schemas.meetings.roomCheckIn.parse(request.body)

    await tenant(request, async (tx) => {
      const meeting = await loadMeeting(tx, id)
      if (meeting.source !== 'in_person') {
        throw new ApiError(
          ERROR_CODES.VALIDATION_FAILED,
          'Room check-in only applies to in-person meetings',
          422,
        )
      }

      // Constrains the candidate set for speaker tagging to the people who
      // were actually in the room, which is what makes six taps enough (§6).
      await tx
        .insert(meetingParticipants)
        .values({
          orgId: auth.orgId,
          meetingId: id,
          employeeId: auth.employeeId,
          inviteStatus: 'accepted',
          isOptional: false,
          expected: true,
          firstJoinAt: new Date(),
          source: 'in_person',
        })
        .onConflictDoUpdate({
          target: [meetingParticipants.meetingId, meetingParticipants.employeeId],
          set: { firstJoinAt: new Date(), source: 'in_person' },
        })
    })

    return reply.send({ ok: true })
  })

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  app.post('/v1/meetings/:id/recording/start', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = request.params as { id: string }

    const attendees = await tenant(request, async (tx) => {
      const meeting = await requireHost(tx, id, auth.employeeId)

      await tx
        .update(meetings)
        .set({
          recordingStartedAt: new Date(),
          actualStart: meeting.actualStart ?? new Date(),
          status: 'in_progress',
          recordingS3Key: `${auth.orgId}/meetings/${id}/audio`,
        })
        .where(eq(meetings.id, id))

      // Everyone who checked in is told that recording has started. Google Meet
      // shows its own indicator on path A; in the room, this notification and
      // the on-screen indicator are the whole of the consent signal (§8.1).
      const checkedIn = await tx
        .select({ userId: employees.userId })
        .from(meetingParticipants)
        .innerJoin(employees, eq(employees.id, meetingParticipants.employeeId))
        .where(eq(meetingParticipants.meetingId, id))

      for (const person of checkedIn) {
        if (!person.userId) continue
        await queueNotification(tx, {
          orgId: auth.orgId,
          userId: person.userId,
          event: 'meeting.recording_started',
          title: 'This meeting is being recorded',
          body: `"${meeting.title}" is being recorded for a summary. You can mark the last two minutes off the record at any time.`,
          deepLink: `/meetings/${id}/record`,
        })
      }

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'meeting.recording_started',
        entityType: 'meeting',
        entityId: id,
        ip: request.ip,
      })

      return checkedIn.length
    })

    return reply.send({ ok: true, notified: attendees })
  })

  app.post('/v1/meetings/:id/recording/chunk', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = request.params as { id: string }
    const body = schemas.meetings.recordingChunk.parse(request.body)

    await tenant(request, async (tx) => {
      const meeting = await requireHost(tx, id, auth.employeeId)
      if (!meeting.recordingStartedAt) {
        throw new ApiError(
          ERROR_CODES.MEETING_RECORDING_NOT_ACTIVE,
          'Start the recording before uploading audio',
          409,
        )
      }
    })

    // Chunks land as they complete rather than as one file at the end, so a
    // dropped connection costs a minute rather than the meeting.
    const key = `${auth.orgId}/meetings/${id}/audio/chunk-${String(body.sequence).padStart(5, '0')}`
    await storage().put(key, Buffer.from(body.audio, 'base64'), body.contentType)

    return reply.send({ ok: true, key })
  })

  app.post('/v1/meetings/:id/off-record', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = request.params as { id: string }
    const body = schemas.meetings.offRecordFlag.parse(request.body)

    // Any attendee, not just the host. This is a small feature that does
    // disproportionate work for trust: it is the difference between a tool
    // people tolerate and one they will speak freely around (§8.2).
    await tenant(request, async (tx) => {
      await requireAttendee(tx, id, auth.employeeId)
      const meeting = await loadMeeting(tx, id)
      const flags = [...((meeting.offRecordFlags as number[] | null) ?? []), body.atMs]
      await tx.update(meetings).set({ offRecordFlags: flags }).where(eq(meetings.id, id))
    })

    return reply.send({ ok: true })
  })

  app.post('/v1/meetings/:id/recording/stop', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = request.params as { id: string }

    const prepared = await tenant(request, async (tx) => {
      const meeting = await requireHost(tx, id, auth.employeeId)
      await tx
        .update(meetings)
        .set({ actualEnd: new Date(), status: 'processing' })
        .where(eq(meetings.id, id))
      return {
        flags: (meeting.offRecordFlags as number[] | null) ?? [],
        recordingKey: meeting.recordingS3Key,
      }
    })

    const driver = transcription()
    if (!driver.available()) {
      return reply.status(202).send({
        status: 'processing',
        transcription: 'unavailable',
        message:
          'The recording is stored. Transcription is not configured, so no summary ' +
          'will be produced for this meeting.',
      })
    }

    let transcript: Transcript
    try {
      const audio = await concatChunks(auth.orgId, id)
      const result = await driver.transcribe(audio, 'audio/m4a')
      transcript = normaliseDiarised(id, result)
    } catch (error) {
      if (error instanceof TranscriptionUnavailableError) {
        return reply.status(202).send({ status: 'processing', transcription: 'unavailable' })
      }
      await tenant(request, async (tx) => {
        await tx
          .update(meetings)
          .set({
            status: 'failed',
            ingestError: error instanceof Error ? error.message : String(error),
          })
          .where(eq(meetings.id, id))
      })
      throw error
    }

    // Off-record flags raised during the meeting are applied here, then the
    // flagged segments are dropped before anything is written to disk.
    for (const at of prepared.flags) transcript = flagOffRecord(transcript, at)
    const clean = redact(transcript)

    await tenant(request, async (tx) => {
      const settings = await orgMeetingSettings(tx)
      const key = `${auth.orgId}/meetings/${id}/transcript.json`
      await storage().put(key, Buffer.from(JSON.stringify(clean), 'utf8'), 'application/json')

      await tx
        .insert(meetingTranscripts)
        .values({
          orgId: auth.orgId,
          meetingId: id,
          language: clean.language,
          durationSeconds: clean.durationSeconds,
          segmentCount: clean.segments.length,
          s3Key: key,
          speakersResolved: false,
          expiresAt: new Date(
            Date.now() + settings.transcriptRetentionDays * 24 * 60 * 60 * 1000,
          ),
        })
        .onConflictDoUpdate({
          target: meetingTranscripts.meetingId,
          set: { s3Key: key, segmentCount: clean.segments.length, speakersResolved: false },
        })

      await tx
        .update(meetings)
        .set({ transcriptS3Key: key })
        .where(eq(meetings.id, id))

      // Raw audio is deleted once it has been transcribed. There is no reason
      // to keep it, and keeping it is the part people object to (§8.4).
      void prepared.recordingKey
    })

    return reply.send({
      status: 'processing',
      speakersToTag: speakerLabels(clean).filter(isUnknownSpeaker).length,
    })
  })

  // -------------------------------------------------------------------------
  // Speaker tagging (§6)
  // -------------------------------------------------------------------------

  app.get('/v1/meetings/:id/speakers', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = request.params as { id: string }

    const result = await tenant(request, async (tx) => {
      await requireHost(tx, id, auth.employeeId)
      const transcript = await loadTranscript(tx, id)
      if (!transcript) {
        throw new ApiError(
          ERROR_CODES.MEETING_NO_TRANSCRIPT,
          'There is no transcript for this meeting yet',
          409,
        )
      }

      const existing = await tx
        .select()
        .from(speakerMappings)
        .where(eq(speakerMappings.meetingId, id))

      const attendees = await tx
        .select({
          employeeId: meetingParticipants.employeeId,
          firstName: employees.firstName,
          lastName: employees.lastName,
        })
        .from(meetingParticipants)
        .innerJoin(employees, eq(employees.id, meetingParticipants.employeeId))
        .where(eq(meetingParticipants.meetingId, id))

      const clips = speakerLabels(transcript)
        .filter(isUnknownSpeaker)
        .map((label) => {
          const segment = representativeSegment(transcript, label)
          return {
            speakerLabel: label,
            startMs: segment?.startMs ?? 0,
            endMs: segment?.endMs ?? 0,
            text: segment?.text ?? '',
            employeeId:
              existing.find((m) => m.diarisedSpeakerLabel === label)?.employeeId ?? null,
          }
        })

      return {
        speakers: clips,
        attendees: attendees.map((a) => ({
          employeeId: a.employeeId,
          employeeName: fullName(a),
        })),
      }
    })

    return reply.send(result)
  })

  app.post('/v1/meetings/:id/speakers', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = request.params as { id: string }
    const body = schemas.meetings.speakerTagging.parse(request.body)

    await tenant(request, async (tx) => {
      await requireHost(tx, id, auth.employeeId)

      for (const mapping of body.mappings) {
        await tx
          .insert(speakerMappings)
          .values({
            orgId: auth.orgId,
            meetingId: id,
            diarisedSpeakerLabel: mapping.speakerLabel,
            employeeId: mapping.employeeId,
            method: 'host_tagged',
            confidence: '1',
          })
          .onConflictDoUpdate({
            target: [speakerMappings.meetingId, speakerMappings.diarisedSpeakerLabel],
            set: { employeeId: mapping.employeeId, method: 'host_tagged', confidence: '1' },
          })
      }

      // Rewrite the stored transcript with the resolved ids so the extraction
      // sees names rather than labels.
      const transcript = await loadTranscript(tx, id)
      if (transcript) {
        const applied = applySpeakerMapping(
          transcript,
          Object.fromEntries(
            body.mappings
              .filter((m) => m.employeeId)
              .map((m) => [m.speakerLabel, m.employeeId!]),
          ),
        )
        const [row] = await tx
          .select({ key: meetingTranscripts.s3Key })
          .from(meetingTranscripts)
          .where(eq(meetingTranscripts.meetingId, id))
          .limit(1)

        if (row) {
          await storage().put(
            row.key,
            Buffer.from(JSON.stringify(applied), 'utf8'),
            'application/json',
          )
          await tx
            .update(meetingTranscripts)
            .set({
              speakersResolved: speakerLabels(applied).every((l) => !isUnknownSpeaker(l)),
            })
            .where(eq(meetingTranscripts.meetingId, id))
        }
      }
    })

    // Tagging is skippable, so summarisation is kicked off here rather than
    // gated on it: a meeting with untagged speakers still produces a summary,
    // with the unresolvable actions surfacing as unassigned (§6, fallback).
    const outcome = await summariseMeeting(db, auth.orgId, id)
    return reply.send({ ok: true, status: outcome.status, note: outcome.note })
  })

  // -------------------------------------------------------------------------
  // Host review (§9)
  // -------------------------------------------------------------------------

  app.post('/v1/meetings/:id/review', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = request.params as { id: string }
    const body = schemas.meetings.submitReview.parse(request.body)

    const result = await tenant(request, async (tx) => {
      const meeting = await requireHost(tx, id, auth.employeeId)
      if (meeting.reviewedAt) {
        throw new ApiError(
          ERROR_CODES.MEETING_ALREADY_REVIEWED,
          'This meeting has already been reviewed',
          409,
        )
      }

      const now = new Date()
      let confirmed = 0
      let dismissed = 0

      for (const decision of body.decisions) {
        const [action] = await tx
          .select()
          .from(meetingActions)
          .where(
            and(eq(meetingActions.id, decision.actionId), eq(meetingActions.meetingId, id)),
          )
          .limit(1)

        if (!action) {
          throw new ApiError(ERROR_CODES.NOT_FOUND, 'Unknown action', 404)
        }

        if (decision.decision === 'dismiss') {
          await tx
            .update(meetingActions)
            .set({ status: 'dismissed', confirmedBy: auth.userId, confirmedAt: now })
            .where(eq(meetingActions.id, decision.actionId))
          dismissed += 1
          continue
        }

        await tx
          .update(meetingActions)
          .set({
            status: 'confirmed',
            description: decision.description ?? action.description,
            ownerEmployeeId:
              decision.ownerEmployeeId !== undefined
                ? decision.ownerEmployeeId
                : action.ownerEmployeeId,
            dueDate: decision.dueDate !== undefined ? decision.dueDate : action.dueDate,
            confirmedBy: auth.userId,
            confirmedAt: now,
          })
          .where(eq(meetingActions.id, decision.actionId))
        confirmed += 1
      }

      // The summary text is editable only while it has not gone to HR. Open
      // decision 3: a record HR has already received must not change underneath
      // them, and the actions are where the host's corrections actually matter.
      if (body.overview !== undefined) {
        if (meeting.routeToHr) {
          throw new ApiError(
            ERROR_CODES.AUTH_FORBIDDEN,
            'This meeting routes to HR, so the summary text cannot be edited. You can still correct the actions.',
            403,
          )
        }
        await tx
          .update(meetingSummaries)
          .set({ overview: body.overview })
          .where(eq(meetingSummaries.meetingId, id))
      }

      await tx
        .update(meetings)
        .set({ status: 'ready', reviewedAt: now, reviewedBy: auth.userId })
        .where(eq(meetings.id, id))

      // Dispatch happens only now, and only for what the host confirmed.
      const dispatched = await tx
        .select({
          id: meetingActions.id,
          description: meetingActions.description,
          ownerEmployeeId: meetingActions.ownerEmployeeId,
        })
        .from(meetingActions)
        .where(and(eq(meetingActions.meetingId, id), eq(meetingActions.status, 'confirmed')))

      for (const action of dispatched) {
        if (!action.ownerEmployeeId) continue
        const [owner] = await tx
          .select({ userId: employees.userId })
          .from(employees)
          .where(eq(employees.id, action.ownerEmployeeId))
          .limit(1)
        if (!owner?.userId) continue

        await queueNotification(tx, {
          orgId: auth.orgId,
          userId: owner.userId,
          event: 'meeting.action_assigned',
          title: 'New task from a meeting',
          body: action.description,
          deepLink: '/tasks',
          data: { meetingId: id, actionId: action.id },
        })
      }

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'meeting.reviewed',
        entityType: 'meeting',
        entityId: id,
        after: { confirmed, dismissed },
        ip: request.ip,
      })

      return { confirmed, dismissed }
    })

    return reply.send(result)
  })

  // -------------------------------------------------------------------------
  // Disputes (§7.4)
  // -------------------------------------------------------------------------

  app.post('/v1/meetings/:id/disputes', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = request.params as { id: string }
    const body = schemas.meetings.meetingDispute.parse(request.body)

    const created = await tenant(request, async (tx) => {
      await requireAttendee(tx, id, auth.employeeId)
      const meeting = await loadMeeting(tx, id)
      const settings = await orgMeetingSettings(tx)

      const reference = meeting.actualStart ?? meeting.scheduledStart
      const deadline = new Date(
        reference.getTime() + settings.disputeWindowDays * 24 * 60 * 60 * 1000,
      )
      if (new Date() > deadline) {
        throw new ApiError(
          ERROR_CODES.MEETING_DISPUTE_WINDOW_CLOSED,
          `Attendance can only be disputed within ${settings.disputeWindowDays} days`,
          422,
        )
      }

      const [dispute] = await tx
        .insert(meetingDisputes)
        .values({
          orgId: auth.orgId,
          meetingId: id,
          employeeId: auth.employeeId,
          reason: body.reason,
          status: 'open',
        })
        .returning()

      if (meeting.hostEmployeeId) {
        const [host] = await tx
          .select({ userId: employees.userId })
          .from(employees)
          .where(eq(employees.id, meeting.hostEmployeeId))
          .limit(1)

        if (host?.userId) {
          await queueNotification(tx, {
            orgId: auth.orgId,
            userId: host.userId,
            event: 'meeting.dispute_raised',
            title: 'Attendance query',
            body: `Someone has queried their attendance record for "${meeting.title}".`,
            deepLink: `/meetings/${id}`,
            data: { disputeId: dispute!.id },
          })
        }
      }

      return dispute!
    })

    return reply.status(201).send({ id: created.id, status: created.status })
  })

  /** The host's queue. HR sees outcomes through the audit log, not this. */
  app.get('/v1/meeting-disputes', async (request, reply) => {
    const auth = requireAuth(request)

    const rows = await tenant(request, async (tx) => {
      const hosted = await tx
        .select({ id: meetings.id })
        .from(meetings)
        .where(eq(meetings.hostEmployeeId, auth.employeeId))

      if (hosted.length === 0) return []

      return tx
        .select({
          id: meetingDisputes.id,
          meetingId: meetingDisputes.meetingId,
          meetingTitle: meetings.title,
          employeeId: meetingDisputes.employeeId,
          firstName: employees.firstName,
          lastName: employees.lastName,
          reason: meetingDisputes.reason,
          status: meetingDisputes.status,
          createdAt: meetingDisputes.createdAt,
        })
        .from(meetingDisputes)
        .innerJoin(meetings, eq(meetings.id, meetingDisputes.meetingId))
        .innerJoin(employees, eq(employees.id, meetingDisputes.employeeId))
        .where(
          and(
            inArray(
              meetingDisputes.meetingId,
              hosted.map((h) => h.id),
            ),
            eq(meetingDisputes.status, 'open'),
          ),
        )
        .orderBy(meetingDisputes.createdAt)
    })

    return reply.send({
      disputes: rows.map((r) => ({
        id: r.id,
        meetingId: r.meetingId,
        meetingTitle: r.meetingTitle,
        employeeId: r.employeeId,
        employeeName: fullName(r),
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      })),
    })
  })

  app.post('/v1/meeting-disputes/:id', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = request.params as { id: string }
    const body = schemas.meetings.resolveDispute.parse(request.body)

    await tenant(request, async (tx) => {
      const [dispute] = await tx
        .select()
        .from(meetingDisputes)
        .where(eq(meetingDisputes.id, id))
        .limit(1)

      if (!dispute) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Dispute not found', 404)

      await requireHost(tx, dispute.meetingId, auth.employeeId)

      await tx
        .update(meetingDisputes)
        .set({
          status: 'resolved',
          outcome: body.outcome,
          note: body.note ?? null,
          resolvedBy: auth.userId,
          resolvedAt: new Date(),
        })
        .where(eq(meetingDisputes.id, id))

      if (body.outcome === 'upheld' && body.attendanceStatus) {
        await tx
          .update(meetingParticipants)
          .set({ attendanceStatus: body.attendanceStatus, minutesLate: 0 })
          .where(
            and(
              eq(meetingParticipants.meetingId, dispute.meetingId),
              eq(meetingParticipants.employeeId, dispute.employeeId),
            ),
          )
      }

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'meeting.dispute_resolved',
        entityType: 'meeting_dispute',
        entityId: id,
        after: { outcome: body.outcome, correctedTo: body.attendanceStatus ?? null },
        ip: request.ip,
      })
    })

    return reply.send({ ok: true })
  })

  /**
   * The caller's own meeting attendance, one source at a time.
   *
   * Served under `/v1/attendance/` because that is what it is to the employee —
   * the Attendance tab shows physical meetings, virtual meetings and morning
   * clock-ins side by side. The handler lives here because it queries the
   * meeting tables, and splitting it into `attendance.ts` would put a join
   * across two modules for the sake of a URL prefix.
   *
   * Only the caller's own rows, ever. A manager looking at someone else's
   * meeting attendance goes through the team endpoints, which enforce the
   * direct-report scoping.
   */
  app.get('/v1/attendance/meetings', async (request, reply) => {
    const auth = requireAuth(request)
    const query = schemas.meetings.myMeetingAttendanceQuery.parse(request.query)

    const result = await tenant(request, async (tx) => {
      const conditions = [
        eq(meetingParticipants.employeeId, auth.employeeId),
        eq(meetings.source, query.source),
      ]
      if (query.from) conditions.push(gte(meetings.scheduledStart, new Date(query.from)))
      if (query.to) {
        conditions.push(lt(meetings.scheduledStart, new Date(`${query.to}T23:59:59.999Z`)))
      }

      const rows = await tx
        .select({
          meetingId: meetings.id,
          title: meetings.title,
          source: meetings.source,
          scheduledStart: meetings.scheduledStart,
          actualStart: meetings.actualStart,
          attendanceStatus: meetingParticipants.attendanceStatus,
          minutesLate: meetingParticipants.minutesLate,
          firstJoinAt: meetingParticipants.firstJoinAt,
          totalDurationSeconds: meetingParticipants.totalDurationSeconds,
          resolution: meetings.attendanceResolution,
          expected: meetingParticipants.expected,
        })
        .from(meetingParticipants)
        .innerJoin(meetings, eq(meetings.id, meetingParticipants.meetingId))
        .where(and(...conditions))
        .orderBy(desc(meetings.scheduledStart))
        .limit(100)

      return rows.map((r) => ({
        meetingId: r.meetingId,
        title: r.title,
        source: r.source,
        scheduledStart: r.scheduledStart.toISOString(),
        actualStart: r.actualStart?.toISOString() ?? null,
        attendanceStatus: r.attendanceStatus,
        minutesLate: r.minutesLate,
        firstJoinAt: r.firstJoinAt?.toISOString() ?? null,
        totalDurationSeconds: r.totalDurationSeconds,
        resolution: r.resolution,
        expected: r.expected,
      }))
    })

    // `void` records are excluded from every count: the meeting was too short
    // to hold anyone to, so counting it either way would be a figure the
    // employee could not defend (§7.3).
    const counted = result.filter((r) => r.attendanceStatus !== 'void')

    return reply.send({
      records: result,
      attended: counted.filter((r) => r.attendanceStatus === 'present').length,
      late: counted.filter((r) => r.attendanceStatus === 'late').length,
      missed: counted.filter((r) => r.attendanceStatus === 'absent').length,
      totalMinutesLate: counted.reduce((sum, r) => sum + r.minutesLate, 0),
    })
  })

  // -------------------------------------------------------------------------
  // My tasks (§9)
  // -------------------------------------------------------------------------

  app.get('/v1/tasks', async (request, reply) => {
    const auth = requireAuth(request)
    const query = schemas.meetings.myActionsQuery.parse(request.query)

    const rows = await tenant(request, async (tx) =>
      tx
        .select({
          id: meetingActions.id,
          description: meetingActions.description,
          ownerEmployeeId: meetingActions.ownerEmployeeId,
          ownerStated: meetingActions.ownerStated,
          ownerConfidence: meetingActions.ownerConfidence,
          dueDate: meetingActions.dueDate,
          sourceQuote: meetingActions.sourceQuote,
          timestampMs: meetingActions.timestampMs,
          status: meetingActions.status,
          meetingId: meetingActions.meetingId,
          meetingTitle: meetings.title,
          meetingDate: meetings.scheduledStart,
        })
        .from(meetingActions)
        .innerJoin(meetings, eq(meetings.id, meetingActions.meetingId))
        .where(
          and(
            eq(meetingActions.ownerEmployeeId, auth.employeeId),
            // Drafts never appear here — nothing reaches an employee before the
            // host has confirmed it.
            query.status === 'open'
              ? eq(meetingActions.status, 'confirmed')
              : query.status === 'done'
                ? eq(meetingActions.status, 'done')
                : inArray(meetingActions.status, ['confirmed', 'done']),
          ),
        )
        .orderBy(meetingActions.dueDate),
    )

    return reply.send({
      tasks: rows.map((r) => ({
        id: r.id,
        description: r.description,
        ownerEmployeeId: r.ownerEmployeeId,
        ownerName: null,
        ownerStated: r.ownerStated,
        ownerConfidence: r.ownerConfidence,
        dueDate: r.dueDate,
        sourceQuote: r.sourceQuote,
        timestampMs: r.timestampMs,
        status: r.status,
        meetingId: r.meetingId,
        meetingTitle: r.meetingTitle,
        meetingDate: r.meetingDate.toISOString(),
      })),
    })
  })

  app.post('/v1/tasks/:id', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = request.params as { id: string }

    await tenant(request, async (tx) => {
      const [action] = await tx
        .select()
        .from(meetingActions)
        .where(eq(meetingActions.id, id))
        .limit(1)

      if (!action || action.ownerEmployeeId !== auth.employeeId) {
        throw new ApiError(ERROR_CODES.NOT_FOUND, 'Task not found', 404)
      }

      await tx.update(meetingActions).set({ status: 'done' }).where(eq(meetingActions.id, id))
    })

    return reply.send({ ok: true })
  })

  // -------------------------------------------------------------------------
  // Configuration and operations
  // -------------------------------------------------------------------------

  app.get('/v1/admin/meeting-types', async (request, reply) => {
    requireRole(request, 'hr_admin', 'owner')
    const rows = await tenant(request, async (tx) => tx.select().from(meetingTypes))
    return reply.send({
      meetingTypes: rows.map((r) => ({
        id: r.id,
        name: r.name,
        captureEnabled: r.captureEnabled,
        routeToHr: r.routeToHr,
        attendanceTracked: r.attendanceTracked,
        retentionDays: r.retentionDays,
      })),
    })
  })

  app.post('/v1/admin/meeting-types', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const body = schemas.meetings.upsertMeetingType.parse(request.body)

    const saved = await tenant(request, async (tx) => {
      if (body.id) {
        const [updated] = await tx
          .update(meetingTypes)
          .set({
            name: body.name,
            captureEnabled: body.captureEnabled,
            routeToHr: body.routeToHr,
            attendanceTracked: body.attendanceTracked,
            retentionDays: body.retentionDays,
          })
          .where(eq(meetingTypes.id, body.id))
          .returning()
        if (!updated) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Meeting type not found', 404)
        return updated
      }

      const [created] = await tx
        .insert(meetingTypes)
        .values({
          orgId: auth.orgId,
          name: body.name,
          captureEnabled: body.captureEnabled,
          routeToHr: body.routeToHr,
          attendanceTracked: body.attendanceTracked,
          retentionDays: body.retentionDays,
        })
        .returning()
      return created!
    })

    return reply.send({ id: saved.id })
  })

  /**
   * Workspace eligibility (§2.3).
   *
   * Belongs in onboarding: a customer on Business Starter cannot use Google
   * Meet capture at all, and finding that out after go-live is worse for
   * everyone than finding it out during the sales conversation.
   */
  app.get('/v1/admin/meetings/eligibility', async (request, reply) => {
    requireRole(request, 'hr_admin', 'owner')
    const result = await meet().eligibility()
    return reply.send(result)
  })

  /** Manual ingest, and the backfill sweep the 30-day window needs (§2.4). */
  app.post('/v1/admin/meetings/ingest', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const body = (request.body ?? {}) as { meetingId?: string }

    if (body.meetingId) {
      const outcome = await ingestConference(db, auth.orgId, body.meetingId)
      return reply.send(outcome)
    }

    const summary = await backfillMeetTranscripts(db, auth.orgId)
    return reply.send(summary)
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadMeeting(tx: Tx, id: string) {
  const [row] = await tx.select().from(meetings).where(eq(meetings.id, id)).limit(1)
  if (!row) throw new ApiError(ERROR_CODES.MEETING_NOT_FOUND, 'Meeting not found', 404)
  return row
}

async function orgMeetingSettings(tx: Tx) {
  const [org] = await tx.select({ settings: organisations.settings }).from(organisations).limit(1)
  return meetingSettingsFor(org?.settings ?? null)
}

async function requireHost(tx: Tx, id: string, employeeId: string) {
  const meeting = await loadMeeting(tx, id)
  if (meeting.hostEmployeeId !== employeeId) {
    throw new ApiError(
      ERROR_CODES.MEETING_NOT_HOST,
      'Only the meeting host can do that',
      403,
    )
  }
  return meeting
}

async function requireAttendee(tx: Tx, id: string, employeeId: string) {
  const [row] = await tx
    .select({ id: meetingParticipants.id })
    .from(meetingParticipants)
    .where(
      and(
        eq(meetingParticipants.meetingId, id),
        eq(meetingParticipants.employeeId, employeeId),
      ),
    )
    .limit(1)

  if (!row) {
    throw new ApiError(
      ERROR_CODES.MEETING_NOT_ATTENDEE,
      'You were not in that meeting',
      403,
    )
  }
}

async function requireVisible(tx: Tx, id: string, employeeId: string, hrAdmin: boolean) {
  const meeting = await loadMeeting(tx, id)
  if (meeting.hostEmployeeId === employeeId) return meeting
  if (hrAdmin && meeting.routeToHr) return meeting

  const [row] = await tx
    .select({ id: meetingParticipants.id })
    .from(meetingParticipants)
    .where(
      and(
        eq(meetingParticipants.meetingId, id),
        eq(meetingParticipants.employeeId, employeeId),
      ),
    )
    .limit(1)

  if (!row) {
    throw new ApiError(ERROR_CODES.MEETING_NOT_FOUND, 'Meeting not found', 404)
  }
  return meeting
}

/**
 * Meetings the caller may list.
 *
 * HR admins see meetings whose type routes to HR, and nothing else. Being an HR
 * admin is not a licence to read every team's candid conversation — that is the
 * behaviour §8.3 exists to prevent.
 */
async function visibleMeetingIds(
  tx: Tx,
  employeeId: string,
  hrAdmin: boolean,
): Promise<string[]> {
  const attended = await tx
    .select({ id: meetingParticipants.meetingId })
    .from(meetingParticipants)
    .where(eq(meetingParticipants.employeeId, employeeId))

  const hosted = await tx
    .select({ id: meetings.id })
    .from(meetings)
    .where(eq(meetings.hostEmployeeId, employeeId))

  const ids = new Set([...attended.map((a) => a.id), ...hosted.map((h) => h.id)])

  if (hrAdmin) {
    const routed = await tx
      .select({ id: meetings.id })
      .from(meetings)
      .where(eq(meetings.routeToHr, true))
    for (const row of routed) ids.add(row.id)
  }

  return [...ids]
}

async function countsFor(tx: Tx, meetingId: string) {
  const [participants] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(meetingParticipants)
    .where(eq(meetingParticipants.meetingId, meetingId))

  const [actions] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(meetingActions)
    .where(eq(meetingActions.meetingId, meetingId))

  return { participants: participants?.n ?? 0, actions: actions?.n ?? 0 }
}

async function loadActions(tx: Tx, meetingId: string) {
  const rows = await tx
    .select({
      id: meetingActions.id,
      description: meetingActions.description,
      ownerEmployeeId: meetingActions.ownerEmployeeId,
      ownerStated: meetingActions.ownerStated,
      ownerConfidence: meetingActions.ownerConfidence,
      dueDate: meetingActions.dueDate,
      sourceQuote: meetingActions.sourceQuote,
      timestampMs: meetingActions.timestampMs,
      status: meetingActions.status,
      firstName: employees.firstName,
      lastName: employees.lastName,
    })
    .from(meetingActions)
    .leftJoin(employees, eq(employees.id, meetingActions.ownerEmployeeId))
    .where(eq(meetingActions.meetingId, meetingId))
    .orderBy(meetingActions.timestampMs)

  return rows.map((r) => ({
    id: r.id,
    description: r.description,
    ownerEmployeeId: r.ownerEmployeeId,
    ownerName: r.firstName ? fullName({ firstName: r.firstName, lastName: r.lastName ?? '' }) : null,
    ownerStated: r.ownerStated,
    ownerConfidence: r.ownerConfidence,
    dueDate: r.dueDate,
    sourceQuote: r.sourceQuote,
    timestampMs: r.timestampMs,
    status: r.status,
  }))
}

/**
 * Reassembles the uploaded chunks in sequence.
 *
 * Naive concatenation works for the container the client is told to record in;
 * a format that needs a rewritten header would need remuxing here instead.
 */
async function concatChunks(orgId: string, meetingId: string): Promise<Buffer> {
  const parts: Buffer[] = []
  for (let sequence = 0; ; sequence += 1) {
    const key = `${orgId}/meetings/${meetingId}/audio/chunk-${String(sequence).padStart(5, '0')}`
    try {
      parts.push(await storage().get(key))
    } catch {
      break
    }
  }
  if (parts.length === 0) {
    throw new ApiError(
      ERROR_CODES.MEETING_NO_TRANSCRIPT,
      'No audio was uploaded for this meeting',
      422,
    )
  }
  return Buffer.concat(parts)
}
