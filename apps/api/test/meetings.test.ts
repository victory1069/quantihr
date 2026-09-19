/**
 * Meeting assistant end to end: ingest, summarise, review, dispute.
 *
 * Every model call in this suite goes to a stub. That is not a shortcut — the
 * pipeline is built so the only stage that needs a network is extraction, and a
 * suite that spent real money to assert an owner was resolved correctly would
 * be run less often and would therefore catch less.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import type { Database } from '../src/db/client.js'
import {
  employees,
  leaveRequests,
  meetingActions,
  meetingParticipants,
  meetingTypes,
  meetings,
  notifications,
} from '../src/db/schema.js'
import { setAnthropicClient } from '../src/lib/anthropic.js'
import { resetEnvCache } from '../src/lib/env.js'
import { clearMeetFixtures, seedConference } from '../src/lib/meet.js'
import { ingestConference, resolveOwner, summariseMeeting } from '../src/jobs/meeting-pipeline.js'
import { bearer, makeDatabase, makeOrg, type TestOrg } from './helpers.js'

let db: Database
let app: FastifyInstance
let org: TestOrg
let other: TestOrg

/**
 * The fixture meeting happened yesterday, relative to whenever the suite runs.
 *
 * It used to be a fixed date, which passed for exactly one week: the dispute
 * window is seven days, so the day the fixture aged past it every dispute test
 * started returning 422 with nothing in the code having changed. Anchoring to
 * "yesterday" keeps it inside every window the product has, permanently.
 */
const FIXTURE_DAY = (() => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
})()
const at = (hhmm: string): Date => new Date(`${FIXTURE_DAY}T${hhmm}:00.000Z`)

/**
 * A stub that answers `messages.parse` with a fixed extraction.
 *
 * Shaped as the SDK response rather than as our own type, so the mapping in
 * `lib/anthropic.ts` is exercised rather than bypassed.
 */
function stubModel(output: unknown, overrides: Record<string, unknown> = {}): void {
  setAnthropicClient({
    messages: {
      async parse() {
        return {
          stop_reason: 'end_turn',
          stop_details: null,
          parsed_output: output,
          usage: {
            input_tokens: 4200,
            output_tokens: 380,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 1100,
          },
          ...overrides,
        }
      },
    },
  } as never)
}

const EXTRACTION = {
  summary: {
    overview: 'The team agreed the launch date and split the remaining work.',
    decisions: [
      { decision: 'Launch on the 20th', context: 'QA finishes on the 18th', timestamp_ms: 60_000 },
    ],
    topics: [{ topic: 'Launch', points: ['Date agreed', 'QA window is tight'] }],
    open_questions: ['Who signs off the pricing page?'],
  },
  actions: [
    {
      description: 'Send the QA sign-off checklist',
      owner_stated: 'Staff',
      owner_confidence: 'explicit',
      due_stated: 'Friday',
      due_parsed: '2026-09-11',
      quote: "I'll send the QA sign-off checklist by Friday",
      timestamp_ms: 120_000,
    },
    {
      description: 'Confirm the pricing page copy',
      owner_stated: 'Somebody from marketing',
      owner_confidence: 'implied',
      due_stated: '',
      due_parsed: null,
      quote: 'someone from marketing needs to confirm the pricing copy',
      timestamp_ms: 300_000,
    },
  ],
}

/** Seeds a meeting whose conference the fake Meet driver will serve. */
async function seedMeeting(
  target: TestOrg,
  options: {
    conferenceId: string | null
    actualStart?: Date | null
    actualEnd?: Date | null
    routeToHr?: boolean
    transcript?: boolean
    lateJoin?: boolean
  },
): Promise<string> {
  const meetingId = await db.withTenant(target.orgId, async (tx) => {
    const [row] = await tx
      .insert(meetings)
      .values({
        orgId: target.orgId,
        title: 'Launch sync',
        googleConferenceRecordId: options.conferenceId,
        hostEmployeeId: target.managerEmployeeId,
        scheduledStart: at('10:00'),
        scheduledEnd: at('11:00'),
        source: 'google_meet',
        status: 'scheduled',
        routeToHr: options.routeToHr ?? false,
      })
      .returning()

    for (const employeeId of [target.managerEmployeeId, target.employeeId]) {
      await tx.insert(meetingParticipants).values({
        orgId: target.orgId,
        meetingId: row!.id,
        employeeId,
        inviteStatus: 'accepted',
        isOptional: false,
        expected: true,
      })
    }

    return row!.id
  })

  if (options.conferenceId) {
    seedConference(options.conferenceId, {
      record: {
        name: `conferenceRecords/${options.conferenceId}`,
        startTime: options.actualStart ?? at('10:00'),
        endTime: options.actualEnd ?? at('11:00'),
        spaceName: 'spaces/abc',
      },
      sessions: [
        {
          email: `manager@${target === org ? 'acme' : 'globex'}.test`,
          displayName: 'Manager',
          joinedAt: at('10:00'),
          leftAt: at('11:00'),
        },
        {
          email: `staff@${target === org ? 'acme' : 'globex'}.test`,
          displayName: 'Staff',
          joinedAt: options.lateJoin ? at('10:20') : at('10:01'),
          leftAt: at('11:00'),
        },
      ],
      entries:
        options.transcript === false
          ? null
          : [
              {
                email: `manager@${target === org ? 'acme' : 'globex'}.test`,
                displayName: 'Manager',
                startMs: 0,
                endMs: 5000,
                text: 'Right, are we still good for the 20th?',
                languageCode: 'en-NG',
              },
              {
                email: `staff@${target === org ? 'acme' : 'globex'}.test`,
                displayName: 'Staff',
                startMs: 6000,
                endMs: 12_000,
                text: "I'll send the QA sign-off checklist by Friday",
                languageCode: 'en-NG',
              },
            ],
    })
  }

  return meetingId
}

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key-not-used-a-stub-answers'
  process.env.GOOGLE_MEET_DRIVER = 'fake'
  resetEnvCache()

  db = await makeDatabase()
  org = await makeOrg(db, 'acme')
  other = await makeOrg(db, 'globex')
  app = await buildServer(db)
  await app.ready()
})

afterAll(async () => {
  setAnthropicClient(null)
  await app.close()
  await db.close()
})

beforeEach(async () => {
  clearMeetFixtures()
  stubModel(EXTRACTION)
  await db.withTenant(org.orgId, async (tx) => {
    await tx.delete(meetings)
    await tx.delete(notifications)
    // The excused-attendance case inserts approved leave covering the fixture
    // date. Left behind it silently excuses every later meeting for the same
    // employee, so cases stop being independent. The pending request `makeOrg`
    // seeds for the isolation suite is deliberately kept.
    await tx.delete(leaveRequests).where(eq(leaveRequests.status, 'approved'))
  })
})

describe('conference ingestion', () => {
  it('writes attendance records resolved from participant sessions', async () => {
    const meetingId = await seedMeeting(org, { conferenceId: 'conf-1' })

    const outcome = await ingestConference(db, org.orgId, meetingId)

    expect(outcome.attendanceResolution).toBe('recorded')
    expect(outcome.participantsWritten).toBe(2)

    const rows = await db.withTenant(org.orgId, async (tx) =>
      tx.select().from(meetingParticipants).where(eq(meetingParticipants.meetingId, meetingId)),
    )

    expect(rows.every((r) => r.attendanceStatus === 'present')).toBe(true)
  })

  it('records a late join past the grace period', async () => {
    const meetingId = await seedMeeting(org, { conferenceId: 'conf-2', lateJoin: true })

    await ingestConference(db, org.orgId, meetingId)

    const rows = await db.withTenant(org.orgId, async (tx) =>
      tx.select().from(meetingParticipants).where(eq(meetingParticipants.meetingId, meetingId)),
    )

    const late = rows.find((r) => r.employeeId === org.employeeId)
    expect(late?.attendanceStatus).toBe('late')
    expect(late?.minutesLate).toBe(20)
  })

  it('produces no attendance records when the meeting did not happen', async () => {
    const meetingId = await seedMeeting(org, { conferenceId: 'conf-missing' })

    // Drop the fixture so the driver finds no conference record — the
    // cancelled-but-calendar-never-updated case.
    clearMeetFixtures()

    const outcome = await ingestConference(db, org.orgId, meetingId)

    expect(outcome.attendanceResolution).toBe('did_not_occur')

    const rows = await db.withTenant(org.orgId, async (tx) =>
      tx.select().from(meetingParticipants).where(eq(meetingParticipants.meetingId, meetingId)),
    )
    expect(rows.every((r) => r.attendanceStatus === null)).toBe(true)
  })

  it('excuses someone on approved leave rather than marking them absent', async () => {
    const meetingId = await seedMeeting(org, { conferenceId: 'conf-3' })

    await db.withTenant(org.orgId, async (tx) => {
      await tx.insert(leaveRequests).values({
        orgId: org.orgId,
        employeeId: org.employeeId,
        leaveTypeId: org.leaveTypeId,
        startDate: FIXTURE_DAY,
        endDate: FIXTURE_DAY,
        daysCount: '1',
        status: 'approved',
      })
    })

    // Remove their session so they are a genuine no-show while on leave.
    seedConference('conf-3', {
      record: {
        name: 'conferenceRecords/conf-3',
        startTime: at('10:00'),
        endTime: at('11:00'),
        spaceName: null,
      },
      sessions: [
        {
          email: 'manager@acme.test',
          displayName: 'Manager',
          joinedAt: at('10:00'),
          leftAt: at('11:00'),
        },
      ],
      entries: [],
    })

    await ingestConference(db, org.orgId, meetingId)

    const rows = await db.withTenant(org.orgId, async (tx) =>
      tx.select().from(meetingParticipants).where(eq(meetingParticipants.meetingId, meetingId)),
    )

    expect(rows.find((r) => r.employeeId === org.employeeId)?.attendanceStatus).toBe('excused')
  })

  it('tells the host when nobody started transcription', async () => {
    const meetingId = await seedMeeting(org, { conferenceId: 'conf-4', transcript: false })

    const outcome = await ingestConference(db, org.orgId, meetingId)

    expect(outcome.note).toBe('Nobody started transcription')

    const queued = await db.withTenant(org.orgId, async (tx) => tx.select().from(notifications))
    expect(queued.some((n) => n.event === 'meeting.transcription_missing')).toBe(true)
    void meetingId
  })
})

describe('summarisation', () => {
  it('persists the summary, the draft actions and the cost', async () => {
    const meetingId = await seedMeeting(org, { conferenceId: 'conf-5' })
    await ingestConference(db, org.orgId, meetingId)

    const outcome = await summariseMeeting(db, org.orgId, meetingId)

    expect(outcome.status).toBe('awaiting_review')
    expect(outcome.actionsExtracted).toBe(2)
    // 4200 in + 380 out + 1100 cache write on Opus 5 rates.
    expect(outcome.costUsd).toBeGreaterThan(0)

    const response = await app.inject({
      method: 'GET',
      url: `/v1/meetings/${meetingId}`,
      headers: bearer(org.managerToken),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.summary.overview).toContain('launch date')
    expect(body.summary.tokensUsed).toBe(4580)
    expect(body.actions).toHaveLength(2)
  })

  it('carries the verbatim quote on every action', async () => {
    const meetingId = await seedMeeting(org, { conferenceId: 'conf-6' })
    await ingestConference(db, org.orgId, meetingId)
    await summariseMeeting(db, org.orgId, meetingId)

    const rows = await db.withTenant(org.orgId, async (tx) =>
      tx.select().from(meetingActions).where(eq(meetingActions.meetingId, meetingId)),
    )

    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.sourceQuote.length > 0)).toBe(true)
  })

  it('downgrades an owner it cannot match to an attendee', async () => {
    const meetingId = await seedMeeting(org, { conferenceId: 'conf-7' })
    await ingestConference(db, org.orgId, meetingId)
    await summariseMeeting(db, org.orgId, meetingId)

    const rows = await db.withTenant(org.orgId, async (tx) =>
      tx.select().from(meetingActions).where(eq(meetingActions.meetingId, meetingId)),
    )

    // "Somebody from marketing" matches nobody, so the model's "implied" is
    // downgraded and the review screen presents it empty with the quote.
    const unmatched = rows.find((r) => r.ownerStated === 'Somebody from marketing')
    expect(unmatched?.ownerEmployeeId).toBeNull()
    expect(unmatched?.ownerConfidence).toBe('unclear')

    const matched = rows.find((r) => r.ownerStated === 'Staff')
    expect(matched?.ownerEmployeeId).toBe(org.employeeId)
    expect(matched?.ownerConfidence).toBe('explicit')
  })

  it('notifies the host that a review is waiting', async () => {
    const meetingId = await seedMeeting(org, { conferenceId: 'conf-8' })
    await ingestConference(db, org.orgId, meetingId)
    await summariseMeeting(db, org.orgId, meetingId)

    const queued = await db.withTenant(org.orgId, async (tx) => tx.select().from(notifications))
    expect(queued.some((n) => n.event === 'meeting.review_ready')).toBe(true)
  })

  it('skips summarisation rather than inventing one when no key is configured', async () => {
    delete process.env.ANTHROPIC_API_KEY
    resetEnvCache()

    const meetingId = await seedMeeting(org, { conferenceId: 'conf-9' })
    await ingestConference(db, org.orgId, meetingId)
    const outcome = await summariseMeeting(db, org.orgId, meetingId)

    expect(outcome.actionsExtracted).toBe(0)
    expect(outcome.note).toContain('ANTHROPIC_API_KEY')

    process.env.ANTHROPIC_API_KEY = 'test-key-not-used-a-stub-answers'
    resetEnvCache()
  })
})

describe('owner resolution', () => {
  const attendees = [
    { id: 'a', firstName: 'Chidi', lastName: 'Okafor' },
    { id: 'b', firstName: 'Chidi', lastName: 'Nwosu' },
    { id: 'c', firstName: 'Ada', lastName: 'Eze' },
  ]

  it('matches a unique first name', () => {
    expect(resolveOwner('Ada', attendees)).toBe('c')
  })

  it('matches a full name', () => {
    expect(resolveOwner('Chidi Okafor', attendees)).toBe('a')
  })

  it('refuses to choose between two people with the same first name', () => {
    // Assigning work to the wrong Chidi is worse than assigning it to nobody.
    expect(resolveOwner('Chidi', attendees)).toBeNull()
  })

  it('returns null for an empty or unknown name', () => {
    expect(resolveOwner('', attendees)).toBeNull()
    expect(resolveOwner('Someone else', attendees)).toBeNull()
  })
})

describe('host review', () => {
  async function ready(): Promise<string> {
    const meetingId = await seedMeeting(org, { conferenceId: 'conf-review' })
    await ingestConference(db, org.orgId, meetingId)
    await summariseMeeting(db, org.orgId, meetingId)
    return meetingId
  }

  it('confirms and dismisses, and only then assigns the task', async () => {
    const meetingId = await ready()

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/meetings/${meetingId}`,
      headers: bearer(org.managerToken),
    })
    const actions = detail.json().actions as { id: string; ownerEmployeeId: string | null }[]

    // Nothing has reached the assignee yet.
    const before = await app.inject({
      method: 'GET',
      url: '/v1/tasks',
      headers: bearer(org.accessToken),
    })
    expect(before.json().tasks).toHaveLength(0)

    const response = await app.inject({
      method: 'POST',
      url: `/v1/meetings/${meetingId}/review`,
      headers: bearer(org.managerToken),
      payload: {
        decisions: [
          { actionId: actions[0]!.id, decision: 'confirm' },
          { actionId: actions[1]!.id, decision: 'dismiss' },
        ],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ confirmed: 1, dismissed: 1 })

    const after = await app.inject({
      method: 'GET',
      url: '/v1/tasks',
      headers: bearer(org.accessToken),
    })
    expect(after.json().tasks).toHaveLength(1)
    expect(after.json().tasks[0].sourceQuote).toContain('QA sign-off checklist')
  })

  it('applies the host edits on confirm', async () => {
    const meetingId = await ready()
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/meetings/${meetingId}`,
      headers: bearer(org.managerToken),
    })
    const actions = detail.json().actions as { id: string }[]

    await app.inject({
      method: 'POST',
      url: `/v1/meetings/${meetingId}/review`,
      headers: bearer(org.managerToken),
      payload: {
        decisions: [
          {
            actionId: actions[1]!.id,
            decision: 'confirm',
            description: 'Confirm pricing page copy with legal',
            ownerEmployeeId: org.employeeId,
            dueDate: '2026-09-30',
          },
        ],
      },
    })

    const tasks = await app.inject({
      method: 'GET',
      url: '/v1/tasks',
      headers: bearer(org.accessToken),
    })
    const task = tasks.json().tasks[0]
    expect(task.description).toBe('Confirm pricing page copy with legal')
    expect(task.dueDate).toBe('2026-09-30')
  })

  it('refuses a review from anyone but the host', async () => {
    const meetingId = await ready()

    const response = await app.inject({
      method: 'POST',
      url: `/v1/meetings/${meetingId}/review`,
      headers: bearer(org.accessToken),
      payload: { decisions: [] },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('meeting/not-host')
  })

  it('refuses a second review', async () => {
    const meetingId = await ready()
    const payload = { decisions: [] }

    await app.inject({
      method: 'POST',
      url: `/v1/meetings/${meetingId}/review`,
      headers: bearer(org.managerToken),
      payload,
    })
    const second = await app.inject({
      method: 'POST',
      url: `/v1/meetings/${meetingId}/review`,
      headers: bearer(org.managerToken),
      payload,
    })

    expect(second.statusCode).toBe(409)
  })

  it('will not let the host rewrite a summary that goes to HR', async () => {
    const meetingId = await seedMeeting(org, {
      conferenceId: 'conf-hr',
      routeToHr: true,
    })
    await ingestConference(db, org.orgId, meetingId)
    await summariseMeeting(db, org.orgId, meetingId)

    const response = await app.inject({
      method: 'POST',
      url: `/v1/meetings/${meetingId}/review`,
      headers: bearer(org.managerToken),
      payload: { decisions: [], overview: 'Nothing much happened' },
    })

    expect(response.statusCode).toBe(403)
  })
})

describe('disputes', () => {
  it('routes to the host, who can correct the record', async () => {
    const meetingId = await seedMeeting(org, { conferenceId: 'conf-d', lateJoin: true })
    await ingestConference(db, org.orgId, meetingId)

    const raised = await app.inject({
      method: 'POST',
      url: `/v1/meetings/${meetingId}/disputes`,
      headers: bearer(org.accessToken),
      payload: { reason: 'I was in the room from the start, my laptop died' },
    })
    expect(raised.statusCode).toBe(201)

    // The host, not HR, sees it.
    const queue = await app.inject({
      method: 'GET',
      url: '/v1/meeting-disputes',
      headers: bearer(org.managerToken),
    })
    expect(queue.json().disputes).toHaveLength(1)

    const resolved = await app.inject({
      method: 'POST',
      url: `/v1/meeting-disputes/${queue.json().disputes[0].id}`,
      headers: bearer(org.managerToken),
      payload: { outcome: 'upheld', attendanceStatus: 'present' },
    })
    expect(resolved.statusCode).toBe(200)

    const rows = await db.withTenant(org.orgId, async (tx) =>
      tx.select().from(meetingParticipants).where(eq(meetingParticipants.meetingId, meetingId)),
    )
    expect(rows.find((r) => r.employeeId === org.employeeId)?.attendanceStatus).toBe('present')
  })

  it('refuses a dispute from someone who was not in the meeting', async () => {
    const meetingId = await seedMeeting(org, { conferenceId: 'conf-d2' })
    await ingestConference(db, org.orgId, meetingId)

    await db.withTenant(org.orgId, async (tx) => {
      await tx
        .delete(meetingParticipants)
        .where(eq(meetingParticipants.employeeId, org.employeeId))
    })

    const response = await app.inject({
      method: 'POST',
      url: `/v1/meetings/${meetingId}/disputes`,
      headers: bearer(org.accessToken),
      payload: { reason: 'nope' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('meeting/not-attendee')
  })

  it('closes the window after the configured number of days', async () => {
    const meetingId = await seedMeeting(org, { conferenceId: 'conf-d3' })
    await ingestConference(db, org.orgId, meetingId)

    await db.withTenant(org.orgId, async (tx) => {
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
      await tx
        .update(meetings)
        .set({ actualStart: old, scheduledStart: old })
        .where(eq(meetings.id, meetingId))
    })

    const response = await app.inject({
      method: 'POST',
      url: `/v1/meetings/${meetingId}/disputes`,
      headers: bearer(org.accessToken),
      payload: { reason: 'too late' },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('meeting/dispute-window-closed')
  })
})

describe('my meeting attendance', () => {
  it('returns only the caller own rows, split by source', async () => {
    const meetingId = await seedMeeting(org, { conferenceId: 'conf-att', lateJoin: true })
    await ingestConference(db, org.orgId, meetingId)

    const virtual = await app.inject({
      method: 'GET',
      url: '/v1/attendance/meetings?source=google_meet',
      headers: bearer(org.accessToken),
    })

    expect(virtual.statusCode).toBe(200)
    const body = virtual.json()
    expect(body.records).toHaveLength(1)
    expect(body.records[0].title).toBe('Launch sync')
    expect(body.records[0].attendanceStatus).toBe('late')
    expect(body.records[0].minutesLate).toBe(20)
    expect(body.late).toBe(1)

    // The same meeting must not surface under the in-person tab.
    const physical = await app.inject({
      method: 'GET',
      url: '/v1/attendance/meetings?source=in_person',
      headers: bearer(org.accessToken),
    })
    expect(physical.json().records).toHaveLength(0)
  })

  it('excludes voided meetings from every count', async () => {
    // A meeting that collapsed after three minutes voids for everyone, so it
    // can be neither attended nor missed.
    const meetingId = await seedMeeting(org, {
      conferenceId: 'conf-void',
      actualEnd: at('10:03'),
    })
    await ingestConference(db, org.orgId, meetingId)

    const response = await app.inject({
      method: 'GET',
      url: '/v1/attendance/meetings?source=google_meet',
      headers: bearer(org.accessToken),
    })

    const body = response.json()
    expect(body.records[0].attendanceStatus).toBe('void')
    expect(body.attended).toBe(0)
    expect(body.late).toBe(0)
    expect(body.missed).toBe(0)
  })

  it('does not leak another employee attendance', async () => {
    const meetingId = await seedMeeting(org, { conferenceId: 'conf-leak', lateJoin: true })
    await ingestConference(db, org.orgId, meetingId)

    // The manager was on time; the staff member was 20 minutes late. The
    // manager's own view must show their own row, not the staff member's.
    const response = await app.inject({
      method: 'GET',
      url: '/v1/attendance/meetings?source=google_meet',
      headers: bearer(org.managerToken),
    })

    expect(response.json().records).toHaveLength(1)
    expect(response.json().records[0].attendanceStatus).toBe('present')
    expect(response.json().records[0].minutesLate).toBe(0)
  })
})

describe('visibility', () => {
  it('hides a meeting from another tenant', async () => {
    const meetingId = await seedMeeting(org, { conferenceId: 'conf-iso' })
    await ingestConference(db, org.orgId, meetingId)

    const response = await app.inject({
      method: 'GET',
      url: `/v1/meetings/${meetingId}`,
      headers: bearer(other.accessToken),
    })

    expect(response.statusCode).toBe(404)
  })

  it('hides a meeting from someone in the org who was not in it', async () => {
    const meetingId = await seedMeeting(org, { conferenceId: 'conf-out' })

    const outsiderId = await db.withTenant(org.orgId, async (tx) => {
      await tx
        .delete(meetingParticipants)
        .where(eq(meetingParticipants.employeeId, org.employeeId))
      const [row] = await tx
        .select({ id: employees.id })
        .from(employees)
        .where(eq(employees.id, org.employeeId))
        .limit(1)
      return row!.id
    })

    const response = await app.inject({
      method: 'GET',
      url: `/v1/meetings/${meetingId}`,
      headers: bearer(org.accessToken),
    })

    expect(response.statusCode).toBe(404)
    void outsiderId
  })

  it('lists a meeting for the people who were in it', async () => {
    const meetingId = await seedMeeting(org, { conferenceId: 'conf-list' })
    await ingestConference(db, org.orgId, meetingId)

    const response = await app.inject({
      method: 'GET',
      url: '/v1/meetings?window=past',
      headers: bearer(org.accessToken),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().meetings.map((m: { id: string }) => m.id)).toContain(meetingId)
    void meetingId
  })
})

describe('meeting types', () => {
  it('carries the HR routing decision onto meetings created under it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/meeting-types',
      headers: bearer(org.managerToken),
      payload: { name: 'Disciplinary', routeToHr: true, retentionDays: 365 },
    })

    // The seeded manager is not an HR admin, so this must be refused.
    expect(created.statusCode).toBe(403)

    const typeId = await db.withTenant(org.orgId, async (tx) => {
      const [row] = await tx
        .insert(meetingTypes)
        .values({ orgId: org.orgId, name: 'One to one', routeToHr: true })
        .returning()
      return row!.id
    })

    const meeting = await app.inject({
      method: 'POST',
      url: '/v1/meetings',
      headers: bearer(org.managerToken),
      payload: {
        title: 'Weekly one to one',
        meetingTypeId: typeId,
        scheduledStart: at('14:00').toISOString(),
        scheduledEnd: at('14:30').toISOString(),
        inviteeIds: [org.employeeId],
      },
    })

    expect(meeting.statusCode).toBe(201)
    expect(meeting.json().routeToHr).toBe(true)
  })
})

describe('meeting check-in codes', () => {
  async function inPersonMeeting(): Promise<string> {
    return db.withTenant(org.orgId, async (tx) => {
      const [row] = await tx
        .insert(meetings)
        .values({
          orgId: org.orgId,
          title: 'Shift briefing',
          hostEmployeeId: org.managerEmployeeId,
          scheduledStart: new Date(Date.now() + 10 * 60_000),
          scheduledEnd: new Date(Date.now() + 70 * 60_000),
          source: 'in_person',
          status: 'scheduled',
        })
        .returning()
      return row!.id
    })
  }

  it('lets the host generate a code with a venue', async () => {
    const meetingId = await inPersonMeeting()

    const response = await app.inject({
      method: 'POST',
      url: `/v1/meetings/${meetingId}/checkin-code`,
      headers: bearer(org.managerToken),
      payload: { venue: 'Boardroom, 3rd floor', agenda: 'Weekly rota' },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.code).toMatch(/^[A-Z2-9]{6}$/)
    expect(body.venue).toBe('Boardroom, 3rd floor')
    // Unambiguous alphabet: someone is reading this across a room.
    expect(body.code).not.toMatch(/[O0I1]/)
  })

  it('refuses a code to someone who is neither host nor HR', async () => {
    const meetingId = await inPersonMeeting()

    const response = await app.inject({
      method: 'POST',
      url: `/v1/meetings/${meetingId}/checkin-code`,
      headers: bearer(org.accessToken),
      payload: {},
    })

    expect(response.statusCode).toBe(403)
  })

  it('refuses a check-in before any code has been issued', async () => {
    const meetingId = await inPersonMeeting()

    const response = await app.inject({
      method: 'POST',
      url: `/v1/meetings/${meetingId}/checkin`,
      headers: bearer(org.accessToken),
      payload: { code: 'ABC123' },
    })

    expect(response.statusCode).toBe(409)
  })

  it('rejects the wrong code and accepts the right one', async () => {
    const meetingId = await inPersonMeeting()
    const issued = await app.inject({
      method: 'POST',
      url: `/v1/meetings/${meetingId}/checkin-code`,
      headers: bearer(org.managerToken),
      payload: {},
    })
    const code = issued.json().code as string

    // Previously any six characters were accepted, which made the room code
    // decorative — anyone with the meeting id could put themselves in the room.
    const wrong = await app.inject({
      method: 'POST',
      url: `/v1/meetings/${meetingId}/checkin`,
      headers: bearer(org.accessToken),
      payload: { code: 'ZZZZZZ' },
    })
    expect(wrong.statusCode).toBe(422)
    expect(wrong.json().code).toBe('checkin/code-invalid')

    const right = await app.inject({
      method: 'POST',
      url: `/v1/meetings/${meetingId}/checkin`,
      headers: bearer(org.accessToken),
      payload: { code: code.toLowerCase() },
    })
    expect(right.statusCode).toBe(200)
  })

  it('rejects an expired code', async () => {
    const meetingId = await inPersonMeeting()
    const issued = await app.inject({
      method: 'POST',
      url: `/v1/meetings/${meetingId}/checkin-code`,
      headers: bearer(org.managerToken),
      payload: {},
    })
    const code = issued.json().code as string

    await db.withTenant(org.orgId, async (tx) => {
      await tx
        .update(meetings)
        .set({ checkinCodeExpiresAt: new Date(Date.now() - 60_000) })
        .where(eq(meetings.id, meetingId))
    })

    const response = await app.inject({
      method: 'POST',
      url: `/v1/meetings/${meetingId}/checkin`,
      headers: bearer(org.accessToken),
      payload: { code },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json().code).toBe('checkin/code-stale')
  })

  it('lists codes for the host and hides other hosts meetings', async () => {
    await inPersonMeeting()

    const asHost = await app.inject({
      method: 'GET',
      url: '/v1/meetings/checkin-codes',
      headers: bearer(org.managerToken),
    })
    expect(asHost.json().meetings.length).toBeGreaterThan(0)

    // The staff member hosts nothing, so they see nothing — not an error.
    const asStaff = await app.inject({
      method: 'GET',
      url: '/v1/meetings/checkin-codes',
      headers: bearer(org.accessToken),
    })
    expect(asStaff.statusCode).toBe(200)
    expect(asStaff.json().meetings).toEqual([])
  })
})

describe('invitations', () => {
  it('invites people as required or optional and tells each of them', async () => {
    const start = new Date(Date.now() + 86_400_000)
    const end = new Date(start.getTime() + 3_600_000)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/meetings',
      headers: bearer(org.managerToken),
      payload: {
        title: 'Ops weekly',
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
        source: 'google_meet',
        invitees: [{ employeeId: org.employeeId, optional: true }],
      },
    })
    expect(res.statusCode).toBe(201)
    const id = res.json().id as string

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/meetings/${id}`,
      headers: bearer(org.accessToken),
    })
    const me = detail.json().participants.find((p: { employeeId: string }) => p.employeeId === org.employeeId)
    expect(me.inviteStatus).toBe('needs_action')
    expect(me.isOptional).toBe(true)
    expect(me.expected).toBe(false)
    expect(detail.json().source).toBe('google_meet')

    const inbox = await app.inject({
      method: 'GET',
      url: '/v1/notifications',
      headers: bearer(org.accessToken),
    })
    const invite = inbox.json().notifications.find((n: { event: string }) => n.event === 'meeting.invited')
    expect(invite).toBeTruthy()
    expect(invite.body).toContain('Virtual')
    expect(invite.body).toContain('Optional')
    expect(invite.data.actions).toEqual(['accept', 'decline'])
  })

  it('records the answer, and a required decline reaches the host', async () => {
    const start = new Date(Date.now() + 86_400_000)
    const created = await app.inject({
      method: 'POST',
      url: '/v1/meetings',
      headers: bearer(org.managerToken),
      payload: {
        title: 'Budget review',
        scheduledStart: start.toISOString(),
        scheduledEnd: new Date(start.getTime() + 1_800_000).toISOString(),
        invitees: [{ employeeId: org.employeeId, optional: false }],
      },
    })
    const id = created.json().id as string

    const rsvp = await app.inject({
      method: 'POST',
      url: `/v1/meetings/${id}/rsvp`,
      headers: bearer(org.accessToken),
      payload: { response: 'declined' },
    })
    expect(rsvp.statusCode).toBe(204)

    const detail = await app.inject({ method: 'GET', url: `/v1/meetings/${id}`, headers: bearer(org.managerToken) })
    const me = detail.json().participants.find((p: { employeeId: string }) => p.employeeId === org.employeeId)
    expect(me.inviteStatus).toBe('declined')

    const hostInbox = await app.inject({ method: 'GET', url: '/v1/notifications', headers: bearer(org.managerToken) })
    expect(hostInbox.json().notifications.some((n: { event: string }) => n.event === 'meeting.rsvp')).toBe(true)

    // Someone who was not invited cannot answer.
    const outsider = await app.inject({
      method: 'POST',
      url: `/v1/meetings/${id}/rsvp`,
      headers: bearer(other.accessToken),
      payload: { response: 'accepted' },
    })
    expect(outsider.statusCode).toBe(404)
  })
})
