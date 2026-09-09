/**
 * The normalised transcript, and the pure stages that operate on it
 * (meeting-assistant spec §5.1, §5.2, §8.2).
 *
 * Normalising early is the whole point of this file: once a transcript is in
 * this shape, the summarisation stage cannot tell whether it came from the
 * Google Meet API or from a phone on a conference table, and every downstream
 * behaviour is identical for both.
 *
 * Redaction and chunking live here rather than next to the model call because
 * they are the two stages that must be provably correct without spending a
 * token to check. Off-record text reaching a model is unrecoverable.
 */

import type { MeetingSource } from './meeting-attendance.js'

export interface TranscriptSegment {
  /** A resolved employee id, or a placeholder such as `unknown_1`. */
  speakerId: string
  /** 1 for Meet (the API attributes speakers); diarisation confidence otherwise. */
  speakerConfidence: number
  startMs: number
  endMs: number
  text: string
  offRecord: boolean
}

export interface Transcript {
  meetingId: string
  source: MeetingSource
  language: string
  durationSeconds: number
  segments: TranscriptSegment[]
}

/** An unresolved diarisation label, before a host tags it (§6). */
export function unknownSpeaker(index: number): string {
  return `unknown_${index}`
}

export function isUnknownSpeaker(speakerId: string): boolean {
  return /^unknown_\d+$/.test(speakerId)
}

/**
 * Stage 4 — redact.
 *
 * Off-record segments are dropped, not blanked and not marked. Nothing
 * downstream should be able to tell that something was removed, because a gap
 * that is visibly a gap invites reconstruction and defeats the point.
 *
 * This runs before anything reaches the model, and the redacted transcript is
 * what gets persisted: off-record segments are never stored (§8.4).
 */
export function redact(transcript: Transcript): Transcript {
  return {
    ...transcript,
    segments: transcript.segments.filter((s) => !s.offRecord),
  }
}

/** Default off-record window: the last two minutes before the flag (§8.2). */
export const OFF_RECORD_WINDOW_MS = 120_000

/**
 * Marks everything in the trailing window before `flaggedAtMs` as off-record.
 *
 * Any attendee can raise this during the meeting, and it is retroactive by
 * design — people flag a moment after realising it happened, not before.
 * Overlapping segments count as inside the window, so a sentence that straddles
 * the boundary is removed rather than half-kept.
 */
export function flagOffRecord(
  transcript: Transcript,
  flaggedAtMs: number,
  windowMs: number = OFF_RECORD_WINDOW_MS,
): Transcript {
  const from = Math.max(0, flaggedAtMs - windowMs)
  return {
    ...transcript,
    segments: transcript.segments.map((s) =>
      s.offRecord || (s.endMs > from && s.startMs < flaggedAtMs)
        ? { ...s, offRecord: true }
        : s,
    ),
  }
}

export interface TranscriptChunk {
  index: number
  segments: TranscriptSegment[]
  startMs: number
  endMs: number
}

export interface ChunkOptions {
  /**
   * Character budget per chunk. Characters rather than tokens because this
   * stage must not depend on a tokeniser or a network call; the API layer
   * counts real tokens when it needs a cost figure.
   */
  maxChars: number
  /** Segments repeated from the tail of the previous chunk. */
  overlapSegments: number
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  maxChars: 48_000,
  overlapSegments: 4,
}

/**
 * Stage 5 — chunk on speaker-turn boundaries, with overlap.
 *
 * Splitting mid-turn is what produces actions attributed to the wrong person,
 * so a segment is never divided: an oversized single segment gets its own
 * chunk and stays intact. The overlap carries the last few turns forward so a
 * commitment made across a boundary is visible in both halves.
 */
export function chunkTranscript(
  transcript: Transcript,
  options: Partial<ChunkOptions> = {},
): TranscriptChunk[] {
  const { maxChars, overlapSegments } = { ...DEFAULT_CHUNK_OPTIONS, ...options }
  const segments = transcript.segments
  if (segments.length === 0) return []

  const chunks: TranscriptChunk[] = []
  let current: TranscriptSegment[] = []
  let size = 0

  const flush = (): void => {
    if (current.length === 0) return
    chunks.push({
      index: chunks.length,
      segments: current,
      startMs: current[0]!.startMs,
      endMs: current[current.length - 1]!.endMs,
    })
  }

  for (const segment of segments) {
    const cost = segment.text.length + segment.speakerId.length + 4
    if (current.length > 0 && size + cost > maxChars) {
      flush()
      // Carry the tail forward. `slice` on a fresh array keeps the previous
      // chunk's contents untouched.
      current = overlapSegments > 0 ? current.slice(-overlapSegments) : []
      size = current.reduce((n, s) => n + s.text.length + s.speakerId.length + 4, 0)
    }
    current.push(segment)
    size += cost
  }
  flush()

  return chunks
}

/**
 * Renders segments as the speaker-labelled text handed to the model.
 *
 * `names` maps speaker ids to display names. An unmapped id is rendered as-is,
 * which is what makes an untagged in-person meeting still summarisable — the
 * model sees `unknown_2` and the extraction marks the owner unclear rather than
 * guessing at a person.
 */
export function renderSegments(
  segments: TranscriptSegment[],
  names: Record<string, string> = {},
): string {
  return segments
    .map((s) => `[${formatTimestamp(s.startMs)}] ${names[s.speakerId] ?? s.speakerId}: ${s.text}`)
    .join('\n')
}

export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** Distinct speaker labels, in order of first appearance. */
export function speakerLabels(transcript: Transcript): string[] {
  const seen: string[] = []
  for (const segment of transcript.segments) {
    if (!seen.includes(segment.speakerId)) seen.push(segment.speakerId)
  }
  return seen
}

/**
 * The longest uninterrupted segment for a speaker.
 *
 * This is the clip the host hears when tagging speakers (§6, step 2). Longest
 * rather than first, because the first thing anyone says in a meeting is
 * usually "can you hear me", which identifies nobody.
 */
export function representativeSegment(
  transcript: Transcript,
  speakerId: string,
): TranscriptSegment | null {
  let best: TranscriptSegment | null = null
  for (const segment of transcript.segments) {
    if (segment.speakerId !== speakerId) continue
    if (best === null || segment.endMs - segment.startMs > best.endMs - best.startMs) {
      best = segment
    }
  }
  return best
}

/**
 * Applies host speaker tagging to a transcript (§6, step 2).
 *
 * Unmapped labels are left alone rather than dropped — a partially tagged
 * meeting is still worth more than an untagged one, and the actions belonging
 * to the untagged speakers surface as unassigned instead of disappearing.
 */
export function applySpeakerMapping(
  transcript: Transcript,
  mapping: Record<string, string>,
): Transcript {
  return {
    ...transcript,
    segments: transcript.segments.map((s) =>
      mapping[s.speakerId]
        ? { ...s, speakerId: mapping[s.speakerId]!, speakerConfidence: 1 }
        : s,
    ),
  }
}

export function allSpeakersResolved(transcript: Transcript): boolean {
  return transcript.segments.every((s) => !isUnknownSpeaker(s.speakerId))
}
