/**
 * Platform provisioning — how a new organisation gets onto Quanti.
 *
 * There is deliberately no public signup. One design partner does not need a
 * form that anyone on the internet can create an organisation through, and a
 * form like that needs email verification, rate limits and a story for junk
 * orgs before it is safe to expose. Instead an operator with the platform key
 * creates the organisation and its first HR admin, and that person receives a
 * sign-in link and lands in the setup wizard.
 *
 * **Authentication is a shared secret, not a JWT.** The JWT layer is tenant
 * scoped — every claim carries an org_id — and provisioning happens before an
 * org exists. The key is compared in constant time and the route refuses to
 * run at all when no key is configured, so a deployment cannot accidentally
 * expose an open org-creation endpoint by forgetting an env var.
 *
 * Creation follows the seed's pattern: pre-generate the id, set the tenant
 * claim, then insert. The organisation's own RLS policy has a WITH CHECK on
 * `id = app.org_id`, so the row passes because the claim already names it.
 * No bypass and no privileged connection.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ApiError, DEFAULT_ORG_SETTINGS, ERROR_CODES } from '@quanti/shared'
import { employees, magicLinkTokens, organisations, users, workSchedules } from '../db/schema.js'
import type { Database } from '../db/client.js'
import { audit } from '../lib/audit.js'
import { magicLinkEmail, sendEmail } from '../lib/email.js'
import { env } from '../lib/env.js'
import { expiryFromNow, hashToken, randomToken } from '../lib/tokens.js'

const provisionRequest = z.object({
  name: z.string().min(2).max(120),
  country: z.string().length(2).default('NG'),
  timezone: z.string().min(3).default('Africa/Lagos'),
  admin: z.object({
    firstName: z.string().min(1).max(80),
    lastName: z.string().min(1).max(80),
    email: z.string().email(),
    phone: z.string().max(32).optional(),
  }),
})

/**
 * Compares the presented key against the configured one without leaking the
 * length or a prefix through timing. Both are hashed first so a mismatch in
 * length does not short-circuit before the comparison.
 */
function keyMatches(presented: string | undefined, configured: string): boolean {
  if (!presented) return false
  const a = hashToken(presented)
  const b = hashToken(configured)
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export function registerPlatformRoutes(app: FastifyInstance, db: Database): void {
  app.post('/v1/platform/organisations', async (request, reply) => {
    const configured = env().PLATFORM_API_KEY
    if (!configured) {
      throw new ApiError(
        ERROR_CODES.INTERNAL,
        'Provisioning is not enabled on this deployment. Set PLATFORM_API_KEY.',
        503,
      )
    }

    const presented = request.headers['x-platform-key']
    if (!keyMatches(typeof presented === 'string' ? presented : undefined, configured)) {
      // Same shape as any other unauthenticated call. A distinct message for
      // "wrong key" versus "no key" is a hint nobody outside needs.
      throw new ApiError(ERROR_CODES.AUTH_INVALID_TOKEN, 'Not authorised', 401)
    }

    const body = provisionRequest.parse(request.body)
    const email = body.admin.email.toLowerCase().trim()

    // Email is unique across the platform, not per org: it is the sign-in
    // identity. Checking before the transaction gives a readable error rather
    // than a constraint violation surfaced as a 500.
    const existing = await db.lookup.userByEmail(email)
    if (existing) {
      throw new ApiError(
        ERROR_CODES.VALIDATION_FAILED,
        'That email already belongs to an account on another organisation',
        409,
      )
    }

    const orgId = randomUUID()
    const token = randomToken()

    const result = await db.withTenant(orgId, async (tx) => {
      const [org] = await tx
        .insert(organisations)
        .values({
          id: orgId,
          name: body.name.trim(),
          country: body.country,
          timezone: body.timezone,
          settings: { ...DEFAULT_ORG_SETTINGS },
          onboardingSteps: [],
        })
        .returning()

      // One schedule so the first employee record has something to point at.
      // The wizard lets them change it; an org with no schedule at all cannot
      // compute lateness and every check-in would fail in a confusing way.
      const [schedule] = await tx
        .insert(workSchedules)
        .values({
          orgId,
          name: 'Standard weekday',
          workingDays: [1, 2, 3, 4, 5],
          startTime: '09:00',
          endTime: '17:00',
          gracePeriodMinutes: 10,
          checkinWindowStart: '06:00',
          checkinWindowEnd: '11:00',
        })
        .returning()

      const [user] = await tx
        .insert(users)
        .values({
          orgId,
          email,
          notificationPreferences: {
            leaveDecisions: true,
            checkinReminders: true,
            balanceExpiry: true,
            documents: true,
          },
        })
        .returning()

      const [admin] = await tx
        .insert(employees)
        .values({
          orgId,
          userId: user!.id,
          employeeNumber: 'QH-001',
          firstName: body.admin.firstName.trim(),
          lastName: body.admin.lastName.trim(),
          email,
          phone: body.admin.phone ?? null,
          jobTitle: 'HR Administrator',
          employmentType: 'full_time',
          startDate: new Date().toISOString().slice(0, 10),
          status: 'active',
          workScheduleId: schedule!.id,
          // Owner as well as hr_admin: the first person in is the one who can
          // later hand the org to someone else.
          roles: ['employee', 'hr_admin', 'owner'],
        })
        .returning()

      await tx.insert(magicLinkTokens).values({
        orgId,
        userId: user!.id,
        tokenHash: hashToken(token),
        // Longer than the usual 15 minutes. This link arrives in a welcome
        // email that may not be opened the same hour it is sent.
        expiresAt: expiryFromNow(24 * 60 * 60),
      })

      await audit(tx, {
        orgId,
        actorUserId: null,
        action: 'org.provisioned',
        entityType: 'organisation',
        entityId: orgId,
        after: { name: org!.name, adminEmail: email },
        ip: request.ip,
      })

      return { org: org!, admin: admin!, userId: user!.id }
    })

    const link = `${env().APP_URL}/auth/callback?token=${token}`

    try {
      const sent = await sendEmail({ ...magicLinkEmail(link, 24 * 60), to: email })
      request.log.info(
        { orgId, messageId: sent.messageId, driver: sent.driver },
        'provisioning welcome sent',
      )
    } catch (error) {
      // The org exists either way. The operator gets the link back in the
      // response so they can hand it over by another route if mail failed.
      request.log.error({ err: error, orgId }, 'provisioning welcome failed')
    }

    return reply.status(201).send({
      organisation: {
        id: result.org.id,
        name: result.org.name,
        country: result.org.country,
        timezone: result.org.timezone,
      },
      admin: {
        employeeId: result.admin.id,
        userId: result.userId,
        email,
      },
      // Returned to the operator regardless of environment: this is an
      // authenticated platform call, not the public magic-link endpoint, and
      // the person holding the platform key is the one who would read the
      // mail log anyway.
      signInLink: link,
    })
  })
}
