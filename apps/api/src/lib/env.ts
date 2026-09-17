import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),

  /** Absent → PGlite in-memory. Set to a postgres:// URL for a real database. */
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().optional(),

  JWT_SECRET: z.string().min(32).default('dev-only-secret-change-me-in-production-32+'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(900),
  /** 90 days, sliding (spec §9). */
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(90),
  MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().default(15),

  /** local → files under .storage/, s3 → presigned URLs. */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),

  /** console → log the payload, expo → POST to Expo Push. */
  PUSH_DRIVER: z.enum(['console', 'expo']).default('console'),

  // -------------------------------------------------------------------------
  // Email — the magic link is the authentication mechanism, not a notification
  // -------------------------------------------------------------------------

  /**
   * `ses` is the cheap production default; `smtp` covers Resend, Postmark and
   * anything else with credentials, which is what makes it possible to launch
   * before AWS lifts the SES sandbox.
   */
  EMAIL_DRIVER: z.enum(['console', 'ses', 'smtp']).default('console'),
  /** Must be a verified identity on the provider, or everything bounces. */
  EMAIL_FROM: z.string().default('Quanti HR <no-reply@localhost>'),
  AWS_REGION: z.string().default('eu-west-1'),
  /** Routes bounces and complaints to SNS. Without it, a hard bounce is invisible. */
  SES_CONFIGURATION_SET: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),

  // -------------------------------------------------------------------------
  // SMS — phone verification on sign-up
  // -------------------------------------------------------------------------

  SMS_DRIVER: z.enum(['console', 'termii', 'twilio']).default('console'),

  TERMII_API_KEY: z.string().optional(),
  TERMII_API_BASE: z.string().default('https://api.ng.termii.com'),
  /** Must be an approved sender ID; approval takes a day or two. */
  TERMII_SENDER_ID: z.string().default('Quanti'),
  /**
   * `dnd` by default, deliberately. Most Nigerian numbers sit on the
   * do-not-disturb register, and the `generic` channel is accepted, billed and
   * never delivered for those — see the note in `lib/sms.ts`.
   */
  TERMII_CHANNEL: z.enum(['dnd', 'generic', 'whatsapp']).default('dnd'),

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),

  /**
   * Gates org provisioning. Absent → the endpoint refuses to run, so a
   * deployment cannot expose open org creation by forgetting to set it.
   */
  PLATFORM_API_KEY: z.string().min(32).optional(),

  APP_URL: z.string().default('http://localhost:8081'),
  CORS_ORIGINS: z.string().default('*'),

  // -------------------------------------------------------------------------
  // Meeting assistant
  // -------------------------------------------------------------------------

  /**
   * Absent → summarisation is unavailable and the pipeline says so rather than
   * producing an empty summary. A meeting that visibly failed to process is
   * recoverable; one that silently produced nothing is not.
   */
  ANTHROPIC_API_KEY: z.string().optional(),
  MEETING_MODEL: z.string().default('claude-opus-5'),

  /**
   * `fake` serves fixture conference records so the whole ingestion path is
   * exercisable without a Google Cloud project or restricted-scope
   * verification — which is the long lead item in this increment (§4).
   */
  GOOGLE_MEET_DRIVER: z.enum(['fake', 'google']).default('fake'),
  GOOGLE_ACCESS_TOKEN: z.string().optional(),
  GOOGLE_MEET_API_BASE: z.string().default('https://meet.googleapis.com/v2'),
  GOOGLE_CALENDAR_API_BASE: z
    .string()
    .default('https://www.googleapis.com/calendar/v3'),

  /** `none` → in-person capture accepts audio but cannot transcribe it yet. */
  TRANSCRIPTION_DRIVER: z.enum(['none', 'deepgram', 'assemblyai']).default('none'),
  DEEPGRAM_API_KEY: z.string().optional(),
  ASSEMBLYAI_API_KEY: z.string().optional(),

  /**
   * Meet deletes structured transcript entries 30 days after the conference.
   * Ingestion is webhook-driven; the backfill sweep exists for what the webhook
   * missed, and anything still un-ingested at the alert threshold is shouted
   * about rather than quietly left to expire (§2.4).
   */
  MEET_TRANSCRIPT_WINDOW_DAYS: z.coerce.number().int().default(30),
  MEET_TRANSCRIPT_ALERT_DAYS: z.coerce.number().int().default(25),
})

export type Env = z.infer<typeof schema>

let cached: Env | null = null

export function env(): Env {
  if (cached) return cached
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
    throw new Error(`Invalid environment:\n${issues.join('\n')}`)
  }
  if (parsed.data.NODE_ENV === 'production') {
    if (parsed.data.JWT_SECRET.startsWith('dev-only')) {
      throw new Error('JWT_SECRET must be set to a real secret in production')
    }
    if (!parsed.data.DATABASE_URL) {
      throw new Error('DATABASE_URL must be set in production — PGlite is a development driver')
    }
    // The magic link is how people sign in. Booting production with the console
    // driver means an app nobody can log into, and the symptom — "the email
    // never arrives" — points at the mail provider rather than at the config.
    // Better to refuse to start.
    if (parsed.data.EMAIL_DRIVER === 'console') {
      throw new Error(
        'EMAIL_DRIVER must be ses or smtp in production — magic links are the sign-in mechanism',
      )
    }
    if (parsed.data.EMAIL_FROM.includes('localhost')) {
      throw new Error('EMAIL_FROM must be a verified sender address in production')
    }
  }
  cached = parsed.data
  return cached
}

/** Test helper — lets a suite change env between cases. */
export function resetEnvCache(): void {
  cached = null
}
