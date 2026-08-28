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

  APP_URL: z.string().default('http://localhost:8081'),
  CORS_ORIGINS: z.string().default('*'),
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
  }
  cached = parsed.data
  return cached
}

/** Test helper — lets a suite change env between cases. */
export function resetEnvCache(): void {
  cached = null
}
