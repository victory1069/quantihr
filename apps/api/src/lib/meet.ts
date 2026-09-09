/**
 * Google Meet ingestion (meeting-assistant spec §2).
 *
 * No bot, no headless browser, nothing joins the call as a participant. Google
 * exposes conference records, participant sessions and speaker-attributed
 * transcript entries over REST, and building bot infrastructure would be a
 * large, permanently fragile investment for no gain.
 *
 * Two drivers behind one interface, for the same reason `storage.ts` has two:
 * path A depends on a Google Cloud project and restricted-scope OAuth
 * verification, which is the longest lead item in the increment (§4). The
 * `fake` driver serves fixtures so ingestion, attendance resolution and the
 * whole pipeline are exercisable — and testable — before any of that lands.
 *
 * The REST field mapping below follows the documented v2 shapes. It has not
 * been run against a live Workspace tenant from this codebase, so treat the
 * first real ingestion as the thing that confirms it.
 */

import { env } from './env.js'

export interface ConferenceRecord {
  /** `conferenceRecords/{id}`. */
  name: string
  startTime: Date
  /** `null` while the conference is still running. */
  endTime: Date | null
  spaceName: string | null
}

export interface MeetParticipantSession {
  /** Identifies the person. `null` for anonymous or phone participants. */
  email: string | null
  displayName: string
  joinedAt: Date
  leftAt: Date | null
}

export interface MeetTranscriptEntry {
  /** The speaking participant, as an email where Google resolved one. */
  email: string | null
  displayName: string
  startMs: number
  endMs: number
  text: string
  languageCode: string
}

export interface CalendarInvitee {
  email: string
  responseStatus: 'accepted' | 'declined' | 'tentative' | 'needsAction'
  optional: boolean
}

export interface CalendarEvent {
  id: string
  title: string
  start: Date
  end: Date
  organiserEmail: string | null
  invitees: CalendarInvitee[]
  /** The Meet link's conference id, when the event has one. */
  conferenceId: string | null
}

export interface WorkspaceEligibility {
  eligible: boolean
  edition: string | null
  transcriptionEnabled: boolean | null
  reasons: string[]
}

export interface MeetDriver {
  conferenceRecord(conferenceId: string): Promise<ConferenceRecord | null>
  participantSessions(conferenceId: string): Promise<MeetParticipantSession[]>
  /** `null` when nobody started transcription — the top adoption risk (§2.3). */
  transcriptEntries(conferenceId: string): Promise<MeetTranscriptEntry[] | null>
  calendarEvent(eventId: string): Promise<CalendarEvent | null>
  eligibility(): Promise<WorkspaceEligibility>
}

// ---------------------------------------------------------------------------
// Editions
// ---------------------------------------------------------------------------

/**
 * Transcription requires one of these (§2.3).
 *
 * A customer on Business Starter cannot use path A at all. That belongs in an
 * onboarding eligibility check and in the sales conversation, not in a support
 * ticket three weeks after go-live.
 */
export const TRANSCRIPTION_CAPABLE_EDITIONS = [
  'Business Standard',
  'Business Plus',
  'Enterprise Standard',
  'Enterprise Plus',
  'Education Plus',
]

export function editionSupportsTranscription(edition: string | null): boolean {
  return edition !== null && TRANSCRIPTION_CAPABLE_EDITIONS.includes(edition)
}

// ---------------------------------------------------------------------------
// Fake driver
// ---------------------------------------------------------------------------

interface Fixture {
  record: ConferenceRecord
  sessions: MeetParticipantSession[]
  entries: MeetTranscriptEntry[] | null
}

const fixtures = new Map<string, Fixture>()
const calendarFixtures = new Map<string, CalendarEvent>()
let fixtureEligibility: WorkspaceEligibility = {
  eligible: true,
  edition: 'Business Standard',
  transcriptionEnabled: true,
  reasons: [],
}

export function seedConference(conferenceId: string, fixture: Fixture): void {
  fixtures.set(conferenceId, fixture)
}

export function seedCalendarEvent(event: CalendarEvent): void {
  calendarFixtures.set(event.id, event)
}

export function seedEligibility(value: WorkspaceEligibility): void {
  fixtureEligibility = value
}

export function clearMeetFixtures(): void {
  fixtures.clear()
  calendarFixtures.clear()
  fixtureEligibility = {
    eligible: true,
    edition: 'Business Standard',
    transcriptionEnabled: true,
    reasons: [],
  }
}

const fakeDriver: MeetDriver = {
  async conferenceRecord(conferenceId) {
    return fixtures.get(conferenceId)?.record ?? null
  },
  async participantSessions(conferenceId) {
    return fixtures.get(conferenceId)?.sessions ?? []
  },
  async transcriptEntries(conferenceId) {
    const fixture = fixtures.get(conferenceId)
    return fixture ? fixture.entries : null
  },
  async calendarEvent(eventId) {
    return calendarFixtures.get(eventId) ?? null
  },
  async eligibility() {
    return fixtureEligibility
  },
}

// ---------------------------------------------------------------------------
// Google driver
// ---------------------------------------------------------------------------

async function call<T>(base: string, path: string): Promise<T | null> {
  const token = env().GOOGLE_ACCESS_TOKEN
  if (!token) {
    throw new Error(
      'GOOGLE_ACCESS_TOKEN is not set. Set GOOGLE_MEET_DRIVER=fake for development, ' +
        'or supply an access token minted from the service account or OAuth flow.',
    )
  }

  const response = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  })

  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`Google API ${path} failed: ${response.status} ${await response.text()}`)
  }
  return (await response.json()) as T
}

const instant = (value: string | undefined | null): Date | null =>
  value ? new Date(value) : null

interface GoogleParticipant {
  name: string
  earliestStartTime?: string
  latestEndTime?: string
  signedinUser?: { user?: string; displayName?: string }
  anonymousUser?: { displayName?: string }
  phoneUser?: { displayName?: string }
}

const googleDriver: MeetDriver = {
  async conferenceRecord(conferenceId) {
    const raw = await call<{
      name: string
      startTime?: string
      endTime?: string
      space?: string
    }>(env().GOOGLE_MEET_API_BASE, `/conferenceRecords/${conferenceId}`)

    if (!raw?.startTime) return null

    return {
      name: raw.name,
      startTime: new Date(raw.startTime),
      endTime: instant(raw.endTime),
      spaceName: raw.space ?? null,
    }
  },

  async participantSessions(conferenceId) {
    const listed = await call<{ participants?: GoogleParticipant[] }>(
      env().GOOGLE_MEET_API_BASE,
      `/conferenceRecords/${conferenceId}/participants`,
    )

    const out: MeetParticipantSession[] = []

    for (const participant of listed?.participants ?? []) {
      const displayName =
        participant.signedinUser?.displayName ??
        participant.anonymousUser?.displayName ??
        participant.phoneUser?.displayName ??
        'Unknown'
      const email = participant.signedinUser?.user ?? null

      // Sessions rather than the participant's own start/end, because someone
      // who dropped and rejoined has several and the earliest join is the one
      // attendance is measured from (§7.3).
      const sessions = await call<{
        participantSessions?: { startTime?: string; endTime?: string }[]
      }>(env().GOOGLE_MEET_API_BASE, `/${participant.name}/participantSessions`)

      const rows = sessions?.participantSessions ?? []

      if (rows.length === 0 && participant.earliestStartTime) {
        out.push({
          email,
          displayName,
          joinedAt: new Date(participant.earliestStartTime),
          leftAt: instant(participant.latestEndTime),
        })
        continue
      }

      for (const session of rows) {
        if (!session.startTime) continue
        out.push({
          email,
          displayName,
          joinedAt: new Date(session.startTime),
          leftAt: instant(session.endTime),
        })
      }
    }

    return out
  },

  async transcriptEntries(conferenceId) {
    const transcripts = await call<{ transcripts?: { name: string }[] }>(
      env().GOOGLE_MEET_API_BASE,
      `/conferenceRecords/${conferenceId}/transcripts`,
    )

    const first = transcripts?.transcripts?.[0]
    // No transcript artifact means nobody started transcription. That is a
    // distinct outcome from an empty transcript and the caller nudges the host
    // rather than reporting a failure.
    if (!first) return null

    const entries = await call<{
      transcriptEntries?: {
        participant?: string
        text?: string
        languageCode?: string
        startTime?: string
        endTime?: string
      }[]
    }>(env().GOOGLE_MEET_API_BASE, `/${first.name}/entries`)

    const rows = entries?.transcriptEntries ?? []
    if (rows.length === 0) return []

    const base = new Date(rows[0]!.startTime ?? 0).getTime()

    return rows.map((entry) => ({
      email: entry.participant ?? null,
      displayName: entry.participant ?? 'Unknown',
      startMs: entry.startTime ? new Date(entry.startTime).getTime() - base : 0,
      endMs: entry.endTime ? new Date(entry.endTime).getTime() - base : 0,
      text: entry.text ?? '',
      languageCode: entry.languageCode ?? 'en',
    }))
  },

  async calendarEvent(eventId) {
    const raw = await call<{
      id: string
      summary?: string
      start?: { dateTime?: string }
      end?: { dateTime?: string }
      organizer?: { email?: string }
      attendees?: { email?: string; responseStatus?: string; optional?: boolean }[]
      conferenceData?: { conferenceId?: string }
    }>(env().GOOGLE_CALENDAR_API_BASE, `/calendars/primary/events/${eventId}`)

    if (!raw?.start?.dateTime || !raw.end?.dateTime) return null

    return {
      id: raw.id,
      title: raw.summary ?? 'Untitled meeting',
      start: new Date(raw.start.dateTime),
      end: new Date(raw.end.dateTime),
      organiserEmail: raw.organizer?.email ?? null,
      conferenceId: raw.conferenceData?.conferenceId ?? null,
      invitees: (raw.attendees ?? [])
        .filter((a): a is { email: string } & typeof a => Boolean(a.email))
        .map((a) => ({
          email: a.email,
          responseStatus:
            (a.responseStatus as CalendarInvitee['responseStatus']) ?? 'needsAction',
          optional: a.optional ?? false,
        })),
    }
  },

  async eligibility() {
    // Edition is not readable from the Meet API itself; it comes from the
    // Admin SDK during onboarding. Until that is wired, report unknown rather
    // than guessing eligible — a wrong "yes" here surfaces as meetings that
    // silently never produce a summary.
    return {
      eligible: false,
      edition: null,
      transcriptionEnabled: null,
      reasons: [
        'Workspace edition has not been checked. Connect the Google Workspace ' +
          'admin account during onboarding to confirm transcription is available.',
      ],
    }
  },
}

export function meet(): MeetDriver {
  return env().GOOGLE_MEET_DRIVER === 'google' ? googleDriver : fakeDriver
}
