/**
 * Magic-link authentication (spec §9). No passwords in the MVP.
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
import { env } from '../lib/env.js'
import {
  daysFromNow,
  expiryFromNow,
  hashToken,
  randomToken,
  signAccessToken,
} from '../lib/tokens.js'

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
      if (env().NODE_ENV === 'production') {
        // TODO: hand off to the email provider.
        request.log.info({ userId: found.userId }, 'magic link issued')
      } else {
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

      const [employee] = await tx
        .select()
        .from(employees)
        .where(eq(employees.userId, link.userId))
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
          orgId: link.orgId,
          employeeId: employee.id,
          deviceId: body.deviceId,
          platform: body.platform,
          name: body.deviceName ?? null,
          approved: true,
          lastSeenAt: new Date(),
        })
        await audit(tx, {
          orgId: link.orgId,
          actorUserId: link.userId,
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
          orgId: link.orgId,
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
          orgId: link.orgId,
          actorUserId: link.userId,
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
        .where(eq(users.id, link.userId))

      await audit(tx, {
        orgId: link.orgId,
        actorUserId: link.userId,
        action: 'auth.logged_in',
        entityType: 'user',
        entityId: link.userId,
        ip: request.ip,
      })

      return issueSession(tx, {
        orgId: link.orgId,
        userId: link.userId,
        employeeId: employee.id,
        roles: employee.roles as schemas.Role[],
        deviceId: body.deviceId,
        deviceReviewRequired,
      })
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

      return issueSession(tx, {
        orgId: found.orgId,
        userId: found.userId,
        employeeId: employee.id,
        roles: employee.roles as schemas.Role[],
        deviceId: bound[0]?.deviceId ?? null,
        deviceReviewRequired: false,
      })
    })

    return reply.status(200).send(session)
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

interface SessionInput {
  orgId: string
  userId: string
  employeeId: string
  roles: schemas.Role[]
  deviceId: string | null
  deviceReviewRequired: boolean
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
  }
}
