/**
 * Token minting and verification.
 *
 * Magic-link and refresh tokens are stored as SHA-256 hashes, never in the
 * clear: a database dump should not hand over live sessions. The access token is
 * a signed JWT held in memory on the client and never persisted.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { ERROR_CODES, ApiError, type JwtClaims } from '@quanti/shared'
import { env } from './env.js'

const ISSUER = 'quanti-hr'
const AUDIENCE = 'quanti-hr-client'

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env().JWT_SECRET)
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Constant-time compare, for anywhere a hash is checked outside a SQL lookup. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** A short, unambiguous check-in code: no 0/O, 1/I/L to mistype. */
export function generateCheckinCode(length = 6): string {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i]! % alphabet.length]
  }
  return out
}

export async function signAccessToken(claims: JwtClaims): Promise<string> {
  const ttl = env().ACCESS_TOKEN_TTL_SECONDS
  return new SignJWT({
    orgId: claims.orgId,
    employeeId: claims.employeeId,
    roles: claims.roles,
    deviceId: claims.deviceId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(secretKey())
}

export async function verifyAccessToken(token: string): Promise<JwtClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    })
    return {
      userId: String(payload.sub),
      orgId: String(payload.orgId),
      employeeId: String(payload.employeeId),
      roles: payload.roles as JwtClaims['roles'],
      deviceId: (payload.deviceId as string | null) ?? null,
    }
  } catch (cause) {
    const expired = cause instanceof Error && cause.name === 'JWTExpired'
    throw new ApiError(
      expired ? ERROR_CODES.AUTH_EXPIRED_TOKEN : ERROR_CODES.AUTH_INVALID_TOKEN,
      expired ? 'Session expired' : 'Invalid session token',
      401,
    )
  }
}

export function expiryFromNow(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000)
}

export function daysFromNow(days: number): Date {
  return expiryFromNow(days * 86_400)
}
