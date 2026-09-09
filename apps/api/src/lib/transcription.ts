/**
 * In-person transcription with diarisation (meeting-assistant spec §3, §6).
 *
 * Diarisation separates a recording into distinct speakers. It does not tell
 * you their names — every provider returns `Speaker 0`, `Speaker 1`. That gap
 * is the hard part of path B and it is closed by the host tagging screen, not
 * here. This file's job ends at producing labelled segments.
 *
 * `none` is the default driver and it is honest rather than degraded: it
 * accepts the audio, stores it, and reports that transcription is not
 * configured. A fabricated transcript would be far worse than no transcript,
 * because everything downstream — attendance, actions, the personnel record —
 * would be built on it.
 */

import { unknownSpeaker, type Transcript, type TranscriptSegment } from '@quanti/shared'
import { env } from './env.js'

export interface DiarisedSegment {
  /** Provider speaker index, e.g. 0, 1, 2. */
  speaker: number
  startMs: number
  endMs: number
  text: string
  confidence: number
}

export interface TranscriptionResult {
  language: string
  durationSeconds: number
  segments: DiarisedSegment[]
}

export interface TranscriptionDriver {
  readonly name: string
  available(): boolean
  transcribe(audio: Buffer, contentType: string): Promise<TranscriptionResult>
}

class TranscriptionUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TranscriptionUnavailableError'
  }
}

export { TranscriptionUnavailableError }

const noneDriver: TranscriptionDriver = {
  name: 'none',
  available: () => false,
  async transcribe() {
    throw new TranscriptionUnavailableError(
      'Transcription is not configured. Set TRANSCRIPTION_DRIVER to deepgram or ' +
        'assemblyai with the matching API key to enable in-person capture.',
    )
  },
}

/**
 * Deepgram. Diarisation is a query flag; the response carries per-word speaker
 * indices which are collapsed into turns here.
 *
 * Not exercised against the live service from this codebase — the first real
 * recording is what confirms the mapping.
 */
const deepgramDriver: TranscriptionDriver = {
  name: 'deepgram',
  available: () => Boolean(env().DEEPGRAM_API_KEY),

  async transcribe(audio, contentType) {
    const key = env().DEEPGRAM_API_KEY
    if (!key) throw new TranscriptionUnavailableError('DEEPGRAM_API_KEY is not set')

    const query = new URLSearchParams({
      diarize: 'true',
      punctuate: 'true',
      smart_format: 'true',
      utterances: 'true',
      model: 'nova-2',
    })

    const response = await fetch(`https://api.deepgram.com/v1/listen?${query}`, {
      method: 'POST',
      headers: { authorization: `Token ${key}`, 'content-type': contentType },
      body: new Uint8Array(audio),
    })

    if (!response.ok) {
      throw new Error(`Deepgram failed: ${response.status} ${await response.text()}`)
    }

    const body = (await response.json()) as {
      metadata?: { duration?: number }
      results?: {
        utterances?: {
          speaker?: number
          start?: number
          end?: number
          transcript?: string
          confidence?: number
        }[]
        channels?: { detected_language?: string }[]
      }
    }

    const utterances = body.results?.utterances ?? []

    return {
      language: body.results?.channels?.[0]?.detected_language ?? 'en',
      durationSeconds: Math.round(body.metadata?.duration ?? 0),
      segments: utterances
        .filter((u) => (u.transcript ?? '').trim().length > 0)
        .map((u) => ({
          speaker: u.speaker ?? 0,
          startMs: Math.round((u.start ?? 0) * 1000),
          endMs: Math.round((u.end ?? 0) * 1000),
          text: (u.transcript ?? '').trim(),
          confidence: u.confidence ?? 0,
        })),
    }
  },
}

/**
 * AssemblyAI. Two-step: upload, then poll the transcript job.
 *
 * Also unverified against the live service from here.
 */
const assemblyDriver: TranscriptionDriver = {
  name: 'assemblyai',
  available: () => Boolean(env().ASSEMBLYAI_API_KEY),

  async transcribe(audio) {
    const key = env().ASSEMBLYAI_API_KEY
    if (!key) throw new TranscriptionUnavailableError('ASSEMBLYAI_API_KEY is not set')

    const upload = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: { authorization: key, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(audio),
    })
    if (!upload.ok) {
      throw new Error(`AssemblyAI upload failed: ${upload.status} ${await upload.text()}`)
    }
    const { upload_url: uploadUrl } = (await upload.json()) as { upload_url: string }

    const created = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { authorization: key, 'content-type': 'application/json' },
      body: JSON.stringify({ audio_url: uploadUrl, speaker_labels: true }),
    })
    if (!created.ok) {
      throw new Error(`AssemblyAI create failed: ${created.status} ${await created.text()}`)
    }
    const job = (await created.json()) as { id: string }

    // Polled rather than webhooked because the caller is already a background
    // job; a webhook would add a public endpoint for no gain here.
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5000))

      const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${job.id}`, {
        headers: { authorization: key },
      })
      if (!poll.ok) {
        throw new Error(`AssemblyAI poll failed: ${poll.status} ${await poll.text()}`)
      }

      const result = (await poll.json()) as {
        status: string
        error?: string
        language_code?: string
        audio_duration?: number
        utterances?: {
          speaker?: string
          start?: number
          end?: number
          text?: string
          confidence?: number
        }[]
      }

      if (result.status === 'error') {
        throw new Error(`AssemblyAI failed: ${result.error ?? 'unknown error'}`)
      }
      if (result.status !== 'completed') continue

      return {
        language: result.language_code ?? 'en',
        durationSeconds: Math.round(result.audio_duration ?? 0),
        segments: (result.utterances ?? [])
          .filter((u) => (u.text ?? '').trim().length > 0)
          .map((u) => ({
            // AssemblyAI labels speakers "A", "B", … — normalised to indices so
            // the two providers produce the same downstream shape.
            speaker: u.speaker ? u.speaker.charCodeAt(0) - 65 : 0,
            startMs: u.start ?? 0,
            endMs: u.end ?? 0,
            text: (u.text ?? '').trim(),
            confidence: u.confidence ?? 0,
          })),
      }
    }

    throw new Error('AssemblyAI transcription did not finish in time')
  },
}

export function transcription(): TranscriptionDriver {
  switch (env().TRANSCRIPTION_DRIVER) {
    case 'deepgram':
      return deepgramDriver
    case 'assemblyai':
      return assemblyDriver
    default:
      return noneDriver
  }
}

/**
 * Turns a diarised result into a normalised transcript.
 *
 * Every speaker starts as `unknown_n`. Nothing here guesses at identity: the
 * candidate set is the people who checked into the room, and mapping labels to
 * them is the host's six taps (§6). A product that asks for six taps and then
 * works beats one that guesses and is wrong.
 */
export function normaliseDiarised(
  meetingId: string,
  result: TranscriptionResult,
): Transcript {
  const labels = new Map<number, string>()

  const segments: TranscriptSegment[] = result.segments.map((segment) => {
    if (!labels.has(segment.speaker)) {
      labels.set(segment.speaker, unknownSpeaker(labels.size + 1))
    }
    return {
      speakerId: labels.get(segment.speaker)!,
      speakerConfidence: segment.confidence,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      offRecord: false,
    }
  })

  return {
    meetingId,
    source: 'in_person',
    language: result.language,
    durationSeconds: result.durationSeconds,
    segments,
  }
}
