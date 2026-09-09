import { describe, expect, it } from 'vitest'
import {
  allSpeakersResolved,
  applySpeakerMapping,
  chunkTranscript,
  flagOffRecord,
  formatTimestamp,
  isUnknownSpeaker,
  redact,
  renderSegments,
  representativeSegment,
  speakerLabels,
  type Transcript,
  type TranscriptSegment,
} from '../src/domain/transcript.js'

const segment = (over: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  speakerId: 'emp-1',
  speakerConfidence: 1,
  startMs: 0,
  endMs: 1000,
  text: 'hello',
  offRecord: false,
  ...over,
})

const transcript = (segments: TranscriptSegment[]): Transcript => ({
  meetingId: 'm-1',
  source: 'google_meet',
  language: 'en-NG',
  durationSeconds: 600,
  segments,
})

describe('redaction', () => {
  it('drops off-record segments entirely', () => {
    const t = transcript([
      segment({ text: 'on the record' }),
      segment({ text: 'off the record', offRecord: true }),
    ])

    const out = redact(t)

    expect(out.segments).toHaveLength(1)
    expect(out.segments[0]!.text).toBe('on the record')
  })

  it('leaves no trace that anything was removed', () => {
    const t = transcript([segment({ text: 'a', offRecord: true }), segment({ text: 'b' })])

    // A visible gap invites reconstruction, which defeats the point of the
    // feature — the rendered text must read as though nothing was there.
    expect(renderSegments(redact(t).segments)).not.toMatch(/redact|removed|\[\.\.\.\]/i)
  })

  it('does not mutate the input', () => {
    const t = transcript([segment({ offRecord: true })])
    redact(t)
    expect(t.segments).toHaveLength(1)
  })
})

describe('off-record flagging', () => {
  it('flags the two minutes before the flag was raised', () => {
    const t = transcript([
      segment({ startMs: 0, endMs: 10_000, text: 'early' }),
      segment({ startMs: 200_000, endMs: 210_000, text: 'inside the window' }),
      segment({ startMs: 290_000, endMs: 295_000, text: 'just said' }),
    ])

    const out = flagOffRecord(t, 300_000)

    expect(out.segments[0]!.offRecord).toBe(false)
    expect(out.segments[1]!.offRecord).toBe(true)
    expect(out.segments[2]!.offRecord).toBe(true)
  })

  it('flags a segment that straddles the window boundary', () => {
    const t = transcript([segment({ startMs: 170_000, endMs: 185_000 })])

    // Half-keeping a sentence is worse than dropping it.
    expect(flagOffRecord(t, 300_000).segments[0]!.offRecord).toBe(true)
  })

  it('does not unflag anything already off the record', () => {
    const t = transcript([segment({ startMs: 0, endMs: 1000, offRecord: true })])
    expect(flagOffRecord(t, 300_000).segments[0]!.offRecord).toBe(true)
  })

  it('does not flag anything said after the flag', () => {
    const t = transcript([segment({ startMs: 310_000, endMs: 320_000 })])
    expect(flagOffRecord(t, 300_000).segments[0]!.offRecord).toBe(false)
  })
})

describe('chunking', () => {
  const many = (count: number, chars: number): TranscriptSegment[] =>
    Array.from({ length: count }, (_, i) =>
      segment({
        speakerId: `emp-${i % 3}`,
        startMs: i * 1000,
        endMs: i * 1000 + 900,
        text: 'x'.repeat(chars),
      }),
    )

  it('returns nothing for an empty transcript', () => {
    expect(chunkTranscript(transcript([]))).toEqual([])
  })

  it('returns a single chunk when everything fits', () => {
    const chunks = chunkTranscript(transcript(many(5, 100)))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.segments).toHaveLength(5)
  })

  it('splits on segment boundaries and never mid-turn', () => {
    const segments = many(20, 100)
    const chunks = chunkTranscript(transcript(segments), {
      maxChars: 500,
      overlapSegments: 0,
    })

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      for (const s of chunk.segments) {
        expect(segments).toContainEqual(s)
      }
    }
  })

  it('overlaps the tail of the previous chunk', () => {
    const chunks = chunkTranscript(transcript(many(20, 100)), {
      maxChars: 600,
      overlapSegments: 2,
    })

    expect(chunks.length).toBeGreaterThan(1)
    const firstTail = chunks[0]!.segments.slice(-2)
    expect(chunks[1]!.segments.slice(0, 2)).toEqual(firstTail)
  })

  it('keeps an oversized single segment intact in its own chunk', () => {
    const chunks = chunkTranscript(transcript(many(3, 5000)), {
      maxChars: 1000,
      overlapSegments: 0,
    })

    expect(chunks).toHaveLength(3)
    expect(chunks[0]!.segments).toHaveLength(1)
  })

  it('carries the timing of its contents', () => {
    const chunks = chunkTranscript(transcript(many(4, 100)))
    expect(chunks[0]!.startMs).toBe(0)
    expect(chunks[0]!.endMs).toBe(3900)
  })
})

describe('rendering', () => {
  it('labels each line with the speaker and a timestamp', () => {
    const out = renderSegments([segment({ startMs: 65_000, text: 'ship it' })], {
      'emp-1': 'Chidi',
    })

    expect(out).toBe('[01:05] Chidi: ship it')
  })

  it('falls back to the raw label for an untagged speaker', () => {
    const out = renderSegments([segment({ speakerId: 'unknown_2', text: 'ok' })])
    expect(out).toBe('[00:00] unknown_2: ok')
  })

  it('formats past an hour', () => {
    expect(formatTimestamp(3_725_000)).toBe('1:02:05')
  })
})

describe('speakers', () => {
  it('lists labels in order of first appearance', () => {
    const t = transcript([
      segment({ speakerId: 'b' }),
      segment({ speakerId: 'a' }),
      segment({ speakerId: 'b' }),
    ])

    expect(speakerLabels(t)).toEqual(['b', 'a'])
  })

  it('picks the longest turn as the representative clip', () => {
    const t = transcript([
      segment({ speakerId: 'a', startMs: 0, endMs: 2000, text: 'can you hear me' }),
      segment({ speakerId: 'a', startMs: 5000, endMs: 30_000, text: 'the real point' }),
    ])

    // The first thing anyone says is "can you hear me", which identifies nobody.
    expect(representativeSegment(t, 'a')!.text).toBe('the real point')
  })

  it('recognises unresolved diarisation labels', () => {
    expect(isUnknownSpeaker('unknown_1')).toBe(true)
    expect(isUnknownSpeaker('emp-1')).toBe(false)
  })

  it('applies host tagging and raises confidence to certain', () => {
    const t = transcript([
      segment({ speakerId: 'unknown_1', speakerConfidence: 0.6 }),
      segment({ speakerId: 'unknown_2', speakerConfidence: 0.4 }),
    ])

    const out = applySpeakerMapping(t, { unknown_1: 'emp-7' })

    expect(out.segments[0]!.speakerId).toBe('emp-7')
    expect(out.segments[0]!.speakerConfidence).toBe(1)
    // Partially tagged is still worth more than untagged: the leftover surfaces
    // as unassigned rather than disappearing.
    expect(out.segments[1]!.speakerId).toBe('unknown_2')
    expect(allSpeakersResolved(out)).toBe(false)
  })
})
