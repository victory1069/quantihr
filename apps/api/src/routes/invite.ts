/**
 * Invite lookup and phone verification (screens L2–L6, L14).
 *
 * Both endpoints are pre-tenant: they run before any session exists, so they go
 * through the narrow SECURITY DEFINER functions in ddl.sql rather than a
 * privileged connection.
 *
 * Both are also rate-limited per IP. `/invite` confirms whether an address
 * belongs to an employee — which the sign-up screen needs and which is
 * otherwise a staff-directory oracle — and `/otp/verify` guesses a six-digit
 * secret. Neither is safe to leave unbounded.
 */

import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { ApiError, ERROR_CODES } from '@quanti/shared'
import { employees, otpCodes, users } from '../db/schema.js'
import type { Database } from '../db/client.js'
import { audit } from '../lib/audit.js'
import { env } from '../lib/env.js'
import { sendSms, verificationSms } from '../lib/sms.js'
import { expiryFromNow, hashToken } from '../lib/tokens.js'

/** Attempts before an OTP is locked out, matching the copy on screen L6. */
const MAX_OTP_ATTEMPTS = 5
const OTP_TTL_SECONDS = 10 * 60
const OTP_LOCKOUT_MINUTES = 15

/**
 * Fixed-window limiter, in memory.
 *
 * Deliberately simple: a single API instance in development, and in production
 * this belongs in front of the app anyway (an ALB rule or a Redis counter).
 * What matters is that neither endpoint ships unbounded.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(key: string): boolean {
    const now = Date.now()
    const entry = this.hits.get(key)

    if (!entry || entry.resetAt < now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    if (entry.count >= this.limit) return false

    entry.count += 1
    return true
  }

  /** Keeps the map from growing without bound on a long-lived process. */
  sweep(): void {
    const now = Date.now()
    for (const [key, entry] of this.hits) if (entry.resetAt < now) this.hits.delete(key)
  }

  reset(): void {
    this.hits.clear()
  }
}

const inviteLimiter = new RateLimiter(10, 60_000)
const otpRequestLimiter = new RateLimiter(5, 60_000)
const otpVerifyLimiter = new RateLimiter(10, 60_000)

/**
 * Test affordance. A suite exercising the OTP lifecycle legitimately exceeds
 * the per-minute budget, and weakening the limiter under NODE_ENV=test would
 * mean shipping a control nothing verifies. Tests clear it between cases and
 * assert the limit separately.
 */
export function resetRateLimits(): void {
  inviteLimiter.reset()
  otpRequestLimiter.reset()
  otpVerifyLimiter.reset()
}

/** `+2348031234541` → `+234 803 •••• 41`. Enough to recognise, not to dial. */
function maskPhone(phone: string | null): string | null {
  if (!phone) return null
  const digits = phone.replace(/\s+/g, '')
  if (digits.length < 6) return '•••• ' + digits.slice(-2)
  return `${digits.slice(0, 4)} ${digits.slice(4, 7)} •••• ${digits.slice(-2)}`
}

function sixDigitCode(): string {
  // Uniform over 000000–999999; leading zeros preserved by padding.
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export function registerInviteRoutes(app: FastifyInstance, db: Database): void {
  setInterval(() => {
    inviteLimiter.sweep()
    otpRequestLimiter.sweep()
    otpVerifyLimiter.sweep()
  }, 300_000).unref()

  /**
   * Does this address have an invite?
   *
   * Returns the employer name and a masked phone tail so screen L3 can lock the
   * email field and L5 can say where the code is going. Never returns a name,
   * a role, or the full number.
   */
  app.get('/v1/auth/invite', async (request, reply) => {
    if (!inviteLimiter.check(request.ip)) {
      throw new ApiError(
        ERROR_CODES.RATE_LIMITED,
        'Too many lookups. Wait a minute and try again.',
        429,
      )
    }

    const query = z
      .object({ email: z.string().email().optional(), token: z.string().optional() })
      .parse(request.query)

    // Invite tokens are not issued yet; email is the only supported lookup.
    if (!query.email) {
      return reply.send({ found: false, orgName: null, email: null, phoneHint: null })
    }

    const rows = await db.lookup.invite(query.email)

    if (!rows) {
      // Screen L14. The invite-only model is explained there rather than
      // implying the user mistyped.
      return reply.send({ found: false, orgName: null, email: null, phoneHint: null })
    }

    if (rows.employeeStatus === 'terminated') {
      return reply.send({
        found: false,
        orgName: rows.orgName,
        email: null,
        phoneHint: null,
        ended: true,
      })
    }

    return reply.send({
      found: true,
      orgName: rows.orgName,
      email: rows.email,
      phoneHint: maskPhone(rows.phone),
    })
  })

  /**
   * Sends a one-time code to the number on the HR record.
   *
   * The employee cannot supply the destination — it comes from the record — so
   * this cannot be used to send SMS to arbitrary numbers.
   */
  app.post('/v1/auth/otp/request', async (request, reply) => {
    if (!otpRequestLimiter.check(request.ip)) {
      throw new ApiError(
        ERROR_CODES.RATE_LIMITED,
        'Too many code requests. Wait a minute and try again.',
        429,
      )
    }

    const body = z.object({ email: z.string().email() }).parse(request.body)
    const found = await db.lookup.userByEmail(body.email)

    // Same non-committal shape as the magic-link endpoint: requesting a code
    // must not reveal more than the invite lookup already does.
    if (!found) {
      return reply.send({ sent: true, phoneHint: null })
    }

    const invite = await db.lookup.invite(body.email)
    if (!invite?.phone) {
      throw new ApiError(
        ERROR_CODES.VALIDATION_FAILED,
        'There is no phone number on your HR record. Ask HR to add one, or use the email link instead.',
        422,
      )
    }

    const code = sixDigitCode()

    await db.withTenant(found.orgId, async (tx) => {
      // Supersede any live code: screen L6 tells the user older codes stop
      // working, so that has to actually be true.
      await tx
        .update(otpCodes)
        .set({ consumedAt: new Date() })
        .where(and(eq(otpCodes.userId, found.userId), isNull(otpCodes.consumedAt)))

      await tx.insert(otpCodes).values({
        orgId: found.orgId,
        userId: found.userId,
        purpose: 'phone_verification',
        codeHash: hashToken(code),
        destination: invite.phone!,
        expiresAt: expiryFromNow(OTP_TTL_SECONDS),
      })
    })

    try {
      const sent = await sendSms({
        to: invite.phone,
        body: verificationSms(code, Math.round(OTP_TTL_SECONDS / 60)),
      })
      request.log.info(
        { userId: found.userId, messageId: sent.messageId, driver: sent.driver },
        'otp sent',
      )
    } catch (error) {
      request.log.error({ err: error, userId: found.userId }, 'otp delivery failed')
      // Unlike the magic-link endpoint, this one may surface a real failure.
      // It has already confirmed membership by returning a phone hint, so there
      // is no enumeration left to protect — and someone stuck on the sign-up
      // screen is better told to fall back to email than left waiting for a
      // code that was never sent.
      throw new ApiError(
        ERROR_CODES.INTERNAL,
        'We could not send the code to your phone. Try the email link instead.',
        502,
      )
    }

    if (env().NODE_ENV !== 'production') {
      request.log.info({ code }, 'otp issued (development)')
    }

    return reply.send({
      sent: true,
      phoneHint: maskPhone(invite.phone),
      // Development only, mirroring the magic-link affordance.
      ...(env().NODE_ENV === 'production' ? {} : { devCode: code }),
    })
  })

  app.post('/v1/auth/otp/verify', async (request, reply) => {
    if (!otpVerifyLimiter.check(request.ip)) {
      throw new ApiError(
        ERROR_CODES.RATE_LIMITED,
        'Too many attempts. Wait a minute and try again.',
        429,
      )
    }

    const body = z
      .object({ email: z.string().email(), code: z.string().length(6) })
      .parse(request.body)

    const found = await db.lookup.userByEmail(body.email)
    if (!found) {
      throw new ApiError(ERROR_CODES.AUTH_INVALID_TOKEN, 'That code is not valid', 401)
    }

    const outcome = await db.withTenant(found.orgId, async (tx) => {
      const [live] = await tx
        .select()
        .from(otpCodes)
        .where(and(eq(otpCodes.userId, found.userId), isNull(otpCodes.consumedAt)))
        .orderBy(desc(otpCodes.createdAt))
        .limit(1)

      if (!live) return { kind: 'none' as const }

      if (live.lockedUntil && live.lockedUntil.getTime() > Date.now()) {
        return { kind: 'locked' as const, until: live.lockedUntil }
      }
      if (live.expiresAt.getTime() < Date.now()) return { kind: 'expired' as const }

      if (live.codeHash !== hashToken(body.code)) {
        const attempts = live.attempts + 1
        const locked = attempts >= MAX_OTP_ATTEMPTS

        await tx
          .update(otpCodes)
          .set({
            attempts,
            lockedUntil: locked ? expiryFromNow(OTP_LOCKOUT_MINUTES * 60) : null,
          })
          .where(eq(otpCodes.id, live.id))

        return {
          kind: 'wrong' as const,
          attemptsLeft: Math.max(0, MAX_OTP_ATTEMPTS - attempts),
          locked,
        }
      }

      await tx
        .update(otpCodes)
        .set({ consumedAt: new Date() })
        .where(eq(otpCodes.id, live.id))

      await audit(tx, {
        orgId: found.orgId,
        actorUserId: found.userId,
        action: 'auth.phone_verified',
        entityType: 'user',
        entityId: found.userId,
        ip: request.ip,
      })

      return { kind: 'ok' as const }
    })

    switch (outcome.kind) {
      case 'ok':
        return reply.send({ verified: true })

      case 'locked':
        // Screen X3: a lockout with a stated end and an alternative route.
        throw new ApiError(
          ERROR_CODES.RATE_LIMITED,
          'Too many wrong codes. Verification is paused for 15 minutes — an email sign-in link still works.',
          429,
          { lockedUntil: outcome.until.toISOString(), alternative: 'magic_link' },
        )

      case 'wrong':
        throw new ApiError(
          ERROR_CODES.AUTH_INVALID_TOKEN,
          outcome.locked
            ? 'Too many wrong codes. Verification is paused for 15 minutes — an email sign-in link still works.'
            : 'That code did not match. Check the most recent message.',
          401,
          { attemptsLeft: outcome.attemptsLeft, locked: outcome.locked },
        )

      case 'expired':
        throw new ApiError(
          ERROR_CODES.AUTH_EXPIRED_TOKEN,
          'That code has expired. Request a new one.',
          401,
        )

      default:
        throw new ApiError(
          ERROR_CODES.AUTH_INVALID_TOKEN,
          'No code is waiting to be verified. Request one first.',
          401,
        )
    }
  })
}
