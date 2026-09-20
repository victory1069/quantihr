/**
 * Magic-link authentication (spec §9), plus a password as a second door.
 *
 * The link is the primary path and the recovery path. The password exists so
 * HR can hand a new joiner credentials on paper; a temporary one is issued at
 * creation and must be replaced on first sign-in before anything else opens.
 *
 * The magic-link and refresh lookups are the only places the API works without
 * a tenant claim, and they go through the narrow SECURITY DEFINER functions in
 * ddl.sql rather than a privileged connection.
 */

import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { ApiError, ERROR_CODES, schemas } from '@quanti/shared'
import { devices, employees, magicLinkTokens, refreshTokens, users } from '../db/schema.js'
import type { Database } from '../db/client.js'
import { audit } from '../lib/audit.js'
import { requireAuth } from '../lib/context.js'
import { hashPassword, passwordProblem, verifyPassword } from '../lib/password.js'
import { RateLimiter } from './invite.js'
import { magicLinkEmail, sendEmail } from '../lib/email.js'
import { env } from '../lib/env.js'
import {
  daysFromNow,
  expiryFromNow,
  hashToken,
  randomToken,
  signAccessToken,
} from '../lib/tokens.js'

/**
 * Two limits on password attempts, because one is not enough:
 *
 *   - per account, ten a minute. This is what stops guessing. Enough for fat
 *     fingers, nowhere near enough to make ~62 bits of temporary password or
 *     any real password reachable.
 *   - per IP, sixty a minute. A whole office sits behind one NAT address and
 *     signs in together on a Monday morning; a per-IP limit tight enough to
 *     stop guessing would lock them all out. This one only catches a single
 *     source spraying attempts across many accounts.
 */
const accountLimiter = new RateLimiter(10, 60_000)
const ipLimiter = new RateLimiter(60, 60_000)

/**
 * A real scrypt hash of a random string, verified against when the account
 * does not exist so the failure takes the same time as a wrong password.
 */
const DUMMY_HASH = await hashPassword('not-a-real-account-' + Math.random())

export function registerAuthRoutes(app: FastifyInstance, db: Database): void {
  /**
   * Always responds 200, whether or not the address is known.
   *
   * A different response for an unknown email turns this endpoint into a way to
   * enumerate who works at the company.
   */
  app.post('/v1/auth/magic-link', async (request, reply) => {
    const { email } = schemas.auth.magicLinkRequest.parse(request.body)
    const found = await db.lookup.userByEmail(email)

    let devLink: string | undefined
    if (found) {
      const token = randomToken()
      await db.withTenant(found.orgId, async (tx) => {
        await tx.insert(magicLinkTokens).values({
          orgId: found.orgId,
          userId: found.userId,
          tokenHash: hashToken(token),
          expiresAt: expiryFromNow(env().MAGIC_LINK_TTL_MINUTES * 60),
        })
      })

      const link = `${env().APP_URL}/auth/callback?token=${token}`

      // Sent after the reply, not before it. An SMTP handshake to Resend
      // takes several seconds, and the person is sitting on a button waiting
      // for a response that says nothing about whether the send worked — so
      // there is nothing to gain by making them wait for it. Outcome goes to
      // the log either way.
      const { userId } = found
      void sendEmail({ ...magicLinkEmail(link, env().MAGIC_LINK_TTL_MINUTES), to: email })
        .then((sent) =>
          request.log.info(
            { userId, messageId: sent.messageId, driver: sent.driver },
            'magic link sent',
          ),
        )
        .catch((error: unknown) => {
          // Deliberately not surfaced. Answering differently for a known
          // address than an unknown one is exactly the enumeration oracle the
          // 200-always contract exists to prevent. What stops a failure being
          // silent is this log line and an alert on it.
          request.log.error({ err: error, userId }, 'magic link delivery failed')
        })

      if (env().NODE_ENV !== 'production') {
        request.log.info({ link }, 'magic link issued (development)')
        devLink = link
      }
    }

    return reply.status(200).send({
      sent: true,
      message: 'If that address belongs to an employee, a sign-in link is on its way.',
      // Development only — this is what makes the web preview usable without an
      // email provider. `env()` refuses to start in production with a dev
      // secret, and this branch is unreachable there.
      ...(devLink ? { devLink } : {}),
    })
  })

  app.post('/v1/auth/verify', async (request, reply) => {
    const body = schemas.auth.magicLinkVerify.parse(request.body)
    const link = await db.lookup.magicLink(hashToken(body.token))

    if (!link) {
      throw new ApiError(ERROR_CODES.AUTH_INVALID_TOKEN, 'That sign-in link is not valid', 401)
    }
    if (link.usedAt) {
      throw new ApiError(
        ERROR_CODES.AUTH_MAGIC_LINK_USED,
        'That sign-in link has already been used. Request a new one.',
        401,
      )
    }
    if (link.expiresAt.getTime() < Date.now()) {
      throw new ApiError(
        ERROR_CODES.AUTH_EXPIRED_TOKEN,
        'That sign-in link has expired. Request a new one.',
        401,
      )
    }

    const session = await db.withTenant(link.orgId, async (tx) => {
      await tx
        .update(magicLinkTokens)
        .set({ usedAt: new Date() })
        .where(eq(magicLinkTokens.id, link.tokenId))

      return establishSession(tx, request, { orgId: link.orgId, userId: link.userId }, body)
    })

    return reply.status(200).send(session)
  })

  /**
   * Sliding 90-day refresh (spec §9): an employee who last opened the app four
   * months ago should not hit a login wall. The old token is revoked on use, so
   * a stolen refresh token is good for one rotation at most.
   */
  app.post('/v1/auth/refresh', async (request, reply) => {
    const { refreshToken } = schemas.auth.refreshRequest.parse(request.body)
    const found = await db.lookup.refreshToken(hashToken(refreshToken))

    if (!found || found.revokedAt || found.expiresAt.getTime() < Date.now()) {
      // The client falls back to magic link, never to a password screen.
      throw new ApiError(
        ERROR_CODES.AUTH_EXPIRED_TOKEN,
        'Your session has expired. Sign in again.',
        401,
      )
    }

    const session = await db.withTenant(found.orgId, async (tx) => {
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date(), lastUsedAt: new Date() })
        .where(eq(refreshTokens.id, found.tokenId))

      const [employee] = await tx
        .select()
        .from(employees)
        .where(eq(employees.userId, found.userId))
        .limit(1)

      if (!employee) {
        throw new ApiError(ERROR_CODES.AUTH_FORBIDDEN, 'Employee record not found', 403)
      }

      const bound = await tx
        .select()
        .from(devices)
        .where(and(eq(devices.employeeId, employee.id), eq(devices.approved, true)))
        .limit(1)

      const [account] = await tx
        .select({ mustChangePassword: users.mustChangePassword })
        .from(users)
        .where(eq(users.id, found.userId))
        .limit(1)

      return issueSession(tx, {
        orgId: found.orgId,
        userId: found.userId,
        employeeId: employee.id,
        roles: employee.roles as schemas.Role[],
        deviceId: bound[0]?.deviceId ?? null,
        deviceReviewRequired: false,
        mustChangePassword: account?.mustChangePassword ?? false,
      })
    })

    return reply.status(200).send(session)
  })


  /**
   * Password sign-in.
   *
   * Same device binding and session as the link path, via establishSession,
   * so choosing this door cannot skip the review a second device would get
   * through the other one.
   *
   * One error message for "no such account", "no password set" and "wrong
   * password". Anything more specific is an enumeration oracle, and the
   * magic-link endpoint went to some trouble not to be one.
   */
  app.post('/v1/auth/password', async (request, reply) => {
    const body = schemas.auth.passwordSignIn.parse(request.body)

    // The account key is the normalised email whether or not it exists — a
    // 429 for an unknown address must look the same as one for a real one.
    if (!ipLimiter.check(request.ip) || !accountLimiter.check(body.email.toLowerCase().trim())) {
      throw new ApiError(
        ERROR_CODES.RATE_LIMITED,
        'Too many attempts. Wait a minute and try again.',
        429,
      )
    }
    const found = await db.lookup.userByEmail(body.email)

    const wrong = () =>
      new ApiError(ERROR_CODES.AUTH_INVALID_TOKEN, 'That email or password is not right', 401)

    // Verify against a real hash even when the account is unknown, so the
    // response time does not reveal which addresses exist.
    const ok = await verifyPassword(body.password, found?.passwordHash ?? DUMMY_HASH)
    if (!found || !found.passwordHash || !ok) throw wrong()

    const session = await db.withTenant(found.orgId, async (tx) =>
      establishSession(tx, request, { orgId: found.orgId, userId: found.userId }, body),
    )

    return reply.status(200).send(session)
  })

  /**
   * Change the password. When the current one is temporary the old password
   * is not required — the person just proved they hold it by signing in, and
   * asking for it again is one more thing to mistype off a Post-it.
   */
  app.post('/v1/auth/password/change', async (request, reply) => {
    const auth = requireAuth(request)
    const body = schemas.auth.changePassword.parse(request.body)

    await db.withTenant(auth.orgId, async (tx) => {
      const [account] = await tx
        .select({
          email: users.email,
          passwordHash: users.passwordHash,
          mustChangePassword: users.mustChangePassword,
        })
        .from(users)
        .where(eq(users.id, auth.userId))
        .limit(1)
      if (!account) throw new ApiError(ERROR_CODES.AUTH_FORBIDDEN, 'Account not found', 403)

      if (!account.mustChangePassword && account.passwordHash) {
        if (!body.currentPassword || !(await verifyPassword(body.currentPassword, account.passwordHash))) {
          throw new ApiError(ERROR_CODES.AUTH_INVALID_TOKEN, 'Your current password is not right', 401)
        }
      }

      const problem = passwordProblem(body.newPassword, account.email)
      if (problem) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, problem, 422)

      if (account.passwordHash && (await verifyPassword(body.newPassword, account.passwordHash))) {
        throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'Choose a password you have not used before', 422)
      }

      await tx
        .update(users)
        .set({
          passwordHash: await hashPassword(body.newPassword),
          mustChangePassword: false,
          passwordChangedAt: new Date(),
        })
        .where(eq(users.id, auth.userId))

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'auth.password_changed',
        entityType: 'user',
        entityId: auth.userId,
        ip: request.ip,
      })
    })

    return reply.status(204).send()
  })

  app.post('/v1/auth/device', async (request, reply) => {
    const auth = requireAuth(request)
    const body = schemas.auth.registerDevice.parse(request.body)

    await db.withTenant(auth.orgId, async (tx) => {
      await tx
        .update(users)
        .set({ pushToken: body.pushToken })
        .where(eq(users.id, auth.userId))

      const [existing] = await tx
        .select()
        .from(devices)
        .where(
          and(eq(devices.employeeId, auth.employeeId), eq(devices.deviceId, body.deviceId)),
        )
        .limit(1)

      if (existing) {
        await tx
          .update(devices)
          .set({ pushToken: body.pushToken, lastSeenAt: new Date() })
          .where(eq(devices.id, existing.id))
      }
    })

    return reply.status(204).send()
  })
}


/**
 * Everything that happens once a credential has been accepted: resolve the
 * employee, bind or review the device, stamp the login, issue the session.
 * Shared by the magic-link and password paths so device binding cannot be
 * bypassed by choosing the other door.
 */
async function establishSession(
  tx: Parameters<Parameters<Database['withTenant']>[1]>[0],
  request: { ip: string },
  ctx: { orgId: string; userId: string },
  body: { deviceId: string; deviceName?: string; platform: 'ios' | 'android' | 'web' },
) {
    const [employee] = await tx
      .select()
      .from(employees)
      .where(eq(employees.userId, ctx.userId))
      .limit(1)

    if (!employee) {
      throw new ApiError(
        ERROR_CODES.AUTH_UNKNOWN_EMAIL,
        'No employee record is linked to this account',
        403,
      )
    }

    const existing = await tx
      .select()
      .from(devices)
      .where(eq(devices.employeeId, employee.id))

    const match = existing.find((d) => d.deviceId === body.deviceId)
    let deviceReviewRequired = false

    if (match) {
      await tx
        .update(devices)
        .set({ lastSeenAt: new Date(), platform: body.platform })
        .where(eq(devices.id, match.id))
      deviceReviewRequired = !match.approved
    } else if (existing.length === 0) {
      // First device through binds automatically (spec §9).
      await tx.insert(devices).values({
        orgId: ctx.orgId,
        employeeId: employee.id,
        deviceId: body.deviceId,
        platform: body.platform,
        name: body.deviceName ?? null,
        approved: true,
        lastSeenAt: new Date(),
      })
      await audit(tx, {
        orgId: ctx.orgId,
        actorUserId: ctx.userId,
        action: 'device.registered',
        entityType: 'device',
        entityId: employee.id,
        after: { deviceId: body.deviceId, platform: body.platform },
        ip: request.ip,
      })
    } else {
      // A second device needs HR approval, otherwise device binding is
      // defeated by signing in again on someone else's phone (spec §9).
      await tx.insert(devices).values({
        orgId: ctx.orgId,
        employeeId: employee.id,
        deviceId: body.deviceId,
        platform: body.platform,
        name: body.deviceName ?? null,
        approved: false,
        approvalRequestedAt: new Date(),
        lastSeenAt: new Date(),
      })
      deviceReviewRequired = true
      await audit(tx, {
        orgId: ctx.orgId,
        actorUserId: ctx.userId,
        action: 'device.review_requested',
        entityType: 'device',
        entityId: employee.id,
        after: { deviceId: body.deviceId, platform: body.platform },
        ip: request.ip,
      })
    }

    await tx
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, ctx.userId))

    await audit(tx, {
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      action: 'auth.logged_in',
      entityType: 'user',
      entityId: ctx.userId,
      ip: request.ip,
    })

    const [account] = await tx
      .select({ mustChangePassword: users.mustChangePassword })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1)

    return issueSession(tx, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      employeeId: employee.id,
      roles: employee.roles as schemas.Role[],
      deviceId: body.deviceId,
      deviceReviewRequired,
      mustChangePassword: account?.mustChangePassword ?? false,
    })
}

interface SessionInput {
  orgId: string
  userId: string
  employeeId: string
  roles: schemas.Role[]
  deviceId: string | null
  deviceReviewRequired: boolean
  mustChangePassword: boolean
}

async function issueSession(
  tx: Parameters<Parameters<Database['withTenant']>[1]>[0],
  input: SessionInput,
) {
  const refresh = randomToken(48)
  await tx.insert(refreshTokens).values({
    orgId: input.orgId,
    userId: input.userId,
    tokenHash: hashToken(refresh),
    expiresAt: daysFromNow(env().REFRESH_TOKEN_TTL_DAYS),
  })

  const accessToken = await signAccessToken({
    userId: input.userId,
    orgId: input.orgId,
    employeeId: input.employeeId,
    roles: input.roles,
    deviceId: input.deviceId,
  })

  return {
    accessToken,
    refreshToken: refresh,
    expiresIn: env().ACCESS_TOKEN_TTL_SECONDS,
    deviceRegistered: input.deviceId !== null,
    deviceReviewRequired: input.deviceReviewRequired,
    mustChangePassword: input.mustChangePassword,
  }
}
