/**
 * Google sign-in.
 *
 * The client (console or app) obtains an ID token from Google and hands it
 * to us; we verify it with Google and take the verified email. SSO here is
 * an identity check only — it never creates an account. Someone HR has not
 * added has no row to match, and is told so in words that send them to the
 * right person.
 *
 * Verification goes through Google's tokeninfo endpoint rather than a local
 * JWKS cache: one round trip per sign-in, on a "six sessions a year" app, is
 * nothing, and it means no key-rotation code to get wrong.
 */

import { ApiError, ERROR_CODES } from '@quanti/shared'
import { env } from './env.js'

export interface GoogleIdentity {
  email: string
  emailVerified: boolean
  /** The OAuth client the token was issued to. Must be one of ours. */
  audience: string
  name: string | null
}

export type GoogleVerifier = (idToken: string) => Promise<GoogleIdentity>

async function verifyWithGoogle(idToken: string): Promise<GoogleIdentity> {
  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
  )
  if (!res.ok) {
    throw new ApiError(ERROR_CODES.AUTH_INVALID_TOKEN, 'Google did not accept that sign-in', 401)
  }
  const claims = (await res.json()) as {
    email?: string
    email_verified?: string | boolean
    aud?: string
    name?: string
    exp?: string
  }
  if (!claims.email || !claims.aud) {
    throw new ApiError(ERROR_CODES.AUTH_INVALID_TOKEN, 'Google did not accept that sign-in', 401)
  }
  return {
    email: claims.email.toLowerCase().trim(),
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    audience: claims.aud,
    name: claims.name ?? null,
  }
}

let verifier: GoogleVerifier = verifyWithGoogle

/** Test hook. */
export function setGoogleVerifier(fn: GoogleVerifier | null): void {
  verifier = fn ?? verifyWithGoogle
}

export function ssoEnabled(): boolean {
  return allowedAudiences().length > 0
}

export function allowedAudiences(): string[] {
  return (env().GOOGLE_SSO_CLIENT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** A verified Google identity whose token was issued to one of our clients. */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  if (!ssoEnabled()) {
    throw new ApiError(ERROR_CODES.INTERNAL, 'Google sign-in is not enabled on this deployment', 503)
  }
  const identity = await verifier(idToken)
  if (!allowedAudiences().includes(identity.audience)) {
    throw new ApiError(ERROR_CODES.AUTH_INVALID_TOKEN, 'That sign-in was not meant for Quanti', 401)
  }
  if (!identity.emailVerified) {
    throw new ApiError(
      ERROR_CODES.AUTH_INVALID_TOKEN,
      'Google has not verified that email address',
      401,
    )
  }
  return identity
}
